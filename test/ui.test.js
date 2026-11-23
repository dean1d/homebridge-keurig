'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
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

test('settings save retains selected switches, default edits and child bridge settings after reopening', async () => {
  const source = await fs.readFile(path.join(__dirname, '../homebridge-ui/public/settings.js'), 'utf8');
  const schema = require('../config.schema.json');
  let saved = [{ platform: 'KeurigSmart', name: 'Keurig', _bridge: { username: 'test' }, controls: { power: true } }];
  const catalog = [{ subtype: 'shot-2', name: 'Brew 2 oz Shot', group: 'Shots' }];

  async function open() {
    const elements = new Map();
    const element = () => ({
      children: [], add() {}, addEventListener(event, handler) { this[event] = handler; },
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
    });
    const get = id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    };
    let pending = structuredClone(saved);
    let saveDisabled = false;
    const ui = {
      getPluginConfig: async () => structuredClone(pending),
      getPluginConfigSchema: async () => schema,
      updatePluginConfig: async next => { pending = structuredClone(next); },
      disableSaveButton: () => { saveDisabled = true; },
      enableSaveButton: () => { saveDisabled = false; },
      showSchemaForm() { throw new Error('The generated form can discard controls'); },
      request: async route => route === '/status'
        ? { signedIn: true } : { controls: catalog, devices: [{ model: 'K27', name: 'Cafe' }] },
    };
    vm.runInNewContext(source, {
      window: { homebridge: ui }, document: { getElementById: get, createElement: element }, Option: class {},
    });
    await new Promise(resolve => setImmediate(resolve));
    return {
      checkbox: get('controls').children[0].children[1].children[0],
      strength: get('brewStrength'),
      save() { assert.equal(saveDisabled, false); saved = structuredClone(pending); },
    };
  }

  const settings = await open();
  settings.checkbox.checked = true;
  const edit = settings.checkbox.change();
  settings.strength.value = 'Strong';
  settings.strength.change();
  await edit;
  await new Promise(resolve => setImmediate(resolve));
  settings.save();
  assert.deepEqual(saved[0].controls, { power: true, 'shot-2': true });
  assert.deepEqual(saved[0]._bridge, { username: 'test' });
  const reopened = await open();
  assert.equal(reopened.checkbox.checked, true);
  assert.equal(reopened.strength.value, 'Strong');
});
