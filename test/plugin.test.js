'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { authorization, callbackCode, redirect } = require('../login');
const { KeurigCloud, saveSession } = require('../cloud');

test('browser login binds a fresh PKCE verifier and state to the Keurig callback', () => {
  const flow = authorization('test-client');
  const params = flow.url.searchParams;
  assert.equal(flow.url.origin, 'https://login.keurig.com');
  assert.equal(params.get('redirect_uri'), redirect);
  assert.equal(params.get('code_challenge'), crypto.hash('sha256', flow.verifier, 'base64url'));
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('state'), flow.state);
  assert.notEqual(authorization('test-client').state, flow.state);
  assert.equal(flow.url.href.includes(flow.verifier), false);
});

test('pasted callback must match this attempt and the registered Keurig address', () => {
  const flow = authorization();
  const good = new URL(redirect);
  good.search = new URLSearchParams({ code: 'example', state: flow.state });
  assert.equal(callbackCode(good.href, flow), 'example');
  assert.throws(() => callbackCode(good.href, authorization()), /does not match/);
  assert.throws(() => callbackCode(good.href.replace('www.keurig.com', 'example.com'), flow), /does not match/);
  assert.throws(() => callbackCode(good.href + '&code=second', flow), /no authorization code/);
  assert.throws(() => callbackCode(redirect + '?state=' + flow.state + '&error=access_denied', flow), /declined/);
});

test('concurrent discovery shares a refresh and restart reuses the rotated session', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keurig-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { clientId: 'client', subscriptionKey: 'example' };
  await saveSession(dir, config.clientId, { access_token: 'expired', refresh_token: 'first', expires_in: 1 });
  let refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://login.keurig.com/oauth/token') {
      assert.equal(options.body.get('refresh_token'), 'first');
      refreshes++;
      return Response.json({ access_token: 'active', refresh_token: 'rotated', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer active');
    if (url.endsWith('/user/profile')) return Response.json({ customerID: 'user1' });
    assert.ok(url.endsWith('/devices?customerId=user1'));
    return Response.json({ devices: [{ id: 'brewer1' }] });
  });
  const cloud = new KeurigCloud(dir, config);
  const [devices] = await Promise.all([cloud.devices(), cloud.devices()]);
  assert.equal(devices[0].id, 'brewer1');
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'keurig-session.json'))).refresh, 'rotated');
  assert.equal(await new KeurigCloud(dir, config).token(), 'active');
  assert.equal(refreshes, 1);
});

test('brew readiness requires a fresh pod and a ready, unlocked machine', async () => {
  const cloud = new KeurigCloud('', {});
  const props = [
    { name: 'appl_state', value: { current: 'IDLE' } },
    { name: 'brew_state', value: { current: 'BREW_READY' } },
    { name: 'lid_recog_result', value: { pm_content: 'POD' } },
  ];
  cloud.request = async () => props;
  assert.deepEqual(await cloud.state('demo'), { on: true, ready: true });
  props[1].value.lock_cause = 'PM_NOT_READY';
  assert.equal((await cloud.state('demo')).ready, false);
  delete props[1].value.lock_cause;
  props[2].value.pm_content = 'EMPTY';
  assert.equal((await cloud.state('demo')).ready, false);
  props[0].value.current = 'STANDBY';
  assert.equal((await cloud.state('demo')).on, false);
});
