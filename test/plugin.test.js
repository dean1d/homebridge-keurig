'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { authorization, callbackCode, redirect } = require('../login');
const { KeurigCloud, saveSession, checkStorage } = require('../cloud');

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

test('brewer state preserves pod and lock information for actionable brew errors', async () => {
  const cloud = new KeurigCloud('', {});
  const props = [
    { name: 'appl_state', value: { current: 'IDLE' } },
    { name: 'brew_state', value: { current: 'BREW_READY' } },
    { name: 'lid_recog_result', value: { pm_content: 'POD' } },
  ];
  cloud.request = async () => props;
  assert.equal((await cloud.state('demo')).ready, true);
  assert.equal((await cloud.state('demo')).pod, 'POD');
  props[1].value.lock_cause = 'PM_NOT_READY';
  assert.equal((await cloud.state('demo')).ready, false);
  delete props[1].value.lock_cause;
  props[2].value.pm_content = 'EMPTY';
  assert.equal((await cloud.state('demo')).pod, 'EMPTY');
  props[0].value.current = 'STANDBY';
  assert.equal((await cloud.state('demo')).on, false);
});

test('all coffee sizes, iced, water, BrewID and favorites send their own recipe', async () => {
  const cloud = new KeurigCloud('', {});
  let pod = 'PUNCHED';
  cloud.state = async () => ({ on: true, ready: true, pod,
    recipes: [{ size: 8, temp: 197, flow_rate: 2957 }] });
  cloud.favorites = async () => [{ id: 'mine', size: 10, temperature: 200, flowRate: 2464 }];
  const commands = [];
  cloud.command = async (...args) => commands.push(args);
  let submissions = 0;
  const submit = async () => { submissions++; };
  for (const size of [4, 6, 8, 10, 12]) {
    await cloud.startBrew('demo', { mode: 'coffee', size, strength: 'Strong', temperature: 'Extra Hot' }, submit);
    assert.deepEqual(commands.at(-1), ['demo', 'brew', {
      size, temp: 200, flow_rate: 2957, brew_type: 'NORMAL', enhanced: true, category: 'CUSTOM',
    }]);
  }
  await cloud.startBrew('demo', { mode: 'iced' }, submit);
  assert.equal(commands.at(-1)[2].brew_type, 'ICED');
  assert.equal(commands.at(-1)[2].size, 6);
  await cloud.startBrew('demo', { mode: 'recommended', size: 8 }, submit);
  assert.equal(commands.at(-1)[2].category, 'MASTER');
  assert.equal(commands.at(-1)[2].flow_rate, 2957);
  await cloud.startBrew('demo', { mode: 'favorite', favoriteId: 'mine' }, submit);
  assert.equal(commands.at(-1)[2].size, 10);
  assert.equal(commands.at(-1)[2].category, 'FAVORITE');
  pod = 'EMPTY';
  await cloud.startBrew('demo', { mode: 'water', size: 12 }, submit);
  assert.equal(commands.at(-1)[2].brew_type, 'HOT_WATER');
  assert.equal(submissions, 9);
});

test('brew refusal, missing recipes and wake-up failures send no brew command', async () => {
  const cloud = new KeurigCloud('', {});
  const state = { on: true, ready: false, appliance: 'IDLE', brewer: 'BREW_LOCKED',
    pod: 'PUNCHED', lock: 'PM_NOT_CYCLED', recipes: [] };
  cloud.state = async () => state;
  const commands = [];
  cloud.command = async (...args) => commands.push(args);
  const submitted = async () => { throw new Error('must not submit'); };
  await assert.rejects(cloud.startBrew('demo', { mode: 'coffee', size: 8 }, submitted), /PM_NOT_CYCLED/);
  state.ready = true;
  state.pod = 'EMPTY';
  await assert.rejects(cloud.startBrew('demo', { mode: 'coffee', size: 8 }, submitted), /Load a pod/);
  state.pod = 'PUNCHED';
  await assert.rejects(cloud.startBrew('demo', { mode: 'water', size: 8 }, submitted), /Remove the pod/);
  await assert.rejects(cloud.startBrew('demo', { mode: 'recommended', size: 8 }, submitted), /no recommended recipe/);
  assert.equal(commands.length, 0);
  state.on = false;
  cloud.waitForState = async () => { throw new Error('wake timeout'); };
  await assert.rejects(cloud.startBrew('demo', { mode: 'coffee', size: 8 }, submitted), /wake timeout/);
  assert.deepEqual(commands, [['demo', 'idle']]);
});

test('confirmation never retries a brew command', async () => {
  const cloud = new KeurigCloud('', {});
  let commands = 0;
  cloud.command = async () => { commands++; };
  cloud.waitForState = async (_id, predicate) => {
    assert.equal(predicate({ appliance: 'IDLE', brewer: 'BREW_READY' }), false);
    assert.equal(predicate({ appliance: 'BREW', brewer: 'BREW_IN_PROGRESS' }), true);
    throw new Error('no start event');
  };
  await assert.rejects(cloud.confirmBrew('demo'), /start could not be confirmed/);
  assert.equal(commands, 0);
});

test('denied session storage identifies the directory before browser sign-in', async t => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  t.mock.method(fs, 'mkdir', async () => { throw denied; });
  await assert.rejects(checkStorage('/homebridge'), error =>
    error.message.includes('EACCES') && error.message.includes('checking write access') &&
    error.message.includes('homebridge'));
});

test('cleanup permission failure preserves the original session save error', async t => {
  t.mock.method(fs, 'writeFile', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  t.mock.method(fs, 'rm', async () => { throw Object.assign(new Error('cleanup denied'), { code: 'EPERM' }); });
  await assert.rejects(saveSession('/homebridge', 'client',
    { access_token: 'example', refresh_token: 'example', expires_in: 3600 }),
    /EACCES.*saving keurig-session.json/);
});
