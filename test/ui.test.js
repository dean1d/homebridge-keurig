'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { KeurigUiSession } = require('../homebridge-ui/session');
const { saveSession } = require('../cloud');
const defaults = require('../settings');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keurig-ui-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ platforms: [{ platform: 'KeurigSmart' }] }));
  return root;
}

test('UI OAuth validates state, saves tokens only on the host and never returns them to the browser', async t => {
  const root = await directory(t);
  const session = new KeurigUiSession(root);
  assert.deepEqual(await session.status(), { signedIn: false });
  const begin = await session.begin();
  const authorization = new URL(begin.url);
  assert.equal(authorization.origin, 'https://login.keurig.com');
  const callback = new URL(defaults.redirect);
  callback.search = new URLSearchParams({ code: 'one-time-code', state: 'wrong' });
  await assert.rejects(session.finish(callback.href), /does not match/);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://login.keurig.com/oauth/token');
    assert.equal(options.body.get('code'), 'one-time-code');
    assert.ok(options.body.get('code_verifier'));
    exchanges++;
    return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 });
  });
  assert.deepEqual(await session.finish(callback.href), { signedIn: true });
  assert.deepEqual(await session.status(), { signedIn: true, needsRefresh: false });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'keurig-session.json'))).refresh, 'private-refresh');
  await assert.rejects(session.finish(callback.href), /expired/);
  assert.equal(exchanges, 1);
});

test('UI discovery is read-only, loads model controls and favorites, and does not rotate tokens', async t => {
  const root = await directory(t);
  await saveSession(root, defaults.clientId, { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 });
  const session = new KeurigUiSession(root);
  const before = await fs.readFile(path.join(root, 'keurig-session.json'), 'utf8');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer private-access');
    if (url.endsWith('/profile')) return Response.json({ customerID: 'customer' });
    if (url.includes('/devices?')) return Response.json({ devices: [{ id: 'cafe', model: 'K27' }] });
    assert.ok(url.endsWith('/presets'));
    return Response.json([{ id: 'morning', name: 'Morning', deviceModel: 'K27' }]);
  });
  const result = await session.discover();
  assert.ok(result.controls.some(control => control.subtype === 'favorite-morning'));
  assert.ok(result.controls.some(control => control.subtype === 'shot-2'));
  for (const secret of ['private-access', 'private-refresh', 'customer']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await fs.readFile(path.join(root, 'keurig-session.json'), 'utf8'), before);
});
