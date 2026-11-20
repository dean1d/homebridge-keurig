'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function setup(modern = true) {
  let Platform;
  require('../index')({ registerPlatform(_plugin, _name, implementation) { Platform = implementation; } });
  const calls = { registered: [], updated: [], removed: [], state: [], warnings: [] };
  const api = {
    user: { storagePath: () => '' }, on() {}, updatePlatformAccessories() {},
    hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
    isMatterEnabled: () => true, versionGreaterOrEqual: () => modern,
    matter: {
      uuid: { generate: text => text }, deviceTypes: { OnOffOutlet: { name: 'Outlet', code: 266 } },
      registerPlatformAccessories: async (_plugin, _platform, records) => calls.registered.push(records),
      updatePlatformAccessories: async records => calls.updated.push(records),
      unregisterPlatformAccessories: async (_plugin, _platform, records) => calls.removed.push(records),
      updateAccessoryState: async (...args) => calls.state.push(args),
    },
  };
  const platform = new Platform({ info() {}, warn: text => calls.warnings.push(text) }, {}, api);
  platform.cloud.confirmBrew = async () => {};
  const accessory = { UUID: 'hap-cafe', displayName: 'KCafe SMART', context: { deviceId: 'cafe' } };
  const control = { subtype: 'shot-2', name: 'Brew 2 oz Shot', mode: 'shot', size: 2 };
  const record = { accessory, device: { id: 'cafe', model: 'K27' }, controls: [control], state: { on: true } };
  return { platform, api, calls, accessory, control, record };
}

test('Matter and HAP share one brew operation and persist the guard for Matter-only restarts', async t => {
  const { platform, calls, accessory, control, record } = setup();
  t.after(() => platform.matter.stop());
  await platform.matter.sync([record]);
  const endpoint = calls.registered[0][0];
  assert.equal(endpoint._associatedPlugin, 'homebridge-keurig');
  assert.equal(endpoint._associatedPlatform, 'KeurigSmart');
  assert.equal(endpoint.deviceType.name, 'Outlet');
  const gate = Promise.withResolvers();
  let commands = 0;
  platform.cloud.startBrew = async (_id, _preset, submitted) => {
    commands++;
    await submitted({ pod: 'UNKNOWN' });
    await gate.promise;
  };
  const matter = endpoint.handlers.onOff.on();
  const hap = platform.brew(accessory, 'cafe', control);
  gate.resolve();
  await Promise.all([matter, hap]);
  assert.equal(commands, 1);
  assert.deepEqual(calls.warnings, []);
  assert.ok(calls.updated.some(records => records[0].context.brewState.nextBrew > Date.now()));
  const restarted = setup().platform;
  t.after(() => restarted.matter.stop());
  restarted.configureMatterAccessory(JSON.parse(JSON.stringify(endpoint)));
  assert.equal(restarted.matter.restoredState('cafe').lastBrewAccepted, true);
});

test('Matter requires Homebridge 2.5 and restores handlers through registration', async t => {
  for (const modern of [false, true]) {
    const { platform, calls, record } = setup(modern);
    t.after(() => platform.matter.stop());
    const cached = platform.matter.accessory(record, record.controls[0]);
    delete cached.handlers;
    platform.configureMatterAccessory(cached);
    await platform.matter.sync([record]);
    if (!modern) {
      assert.equal(calls.registered.length, 0);
      assert.match(calls.warnings[0], /requires Homebridge 2.5/);
      continue;
    }
    const restored = calls.registered[0][0];
    assert.equal(typeof restored.handlers.onOff.on, 'function');
    await platform.matter.sync([record]);
    assert.equal(calls.registered.length + calls.updated.length, 1);
    await platform.matter.sync([{ ...record, controls: [] }]);
    assert.equal(calls.removed[0][0].UUID, cached.UUID);
  }
});

test('Matter momentary off does not brew and reset publishes false after a command', async t => {
  const { platform, calls, record } = setup();
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', callback => {
    const timer = { unref() {}, callback }; timers.push(timer); return timer;
  });
  await platform.matter.sync([record]);
  const endpoint = calls.registered[0][0];
  let commands = 0;
  platform.cloud.startBrew = async (_id, _preset, submitted) => { commands++; await submitted({ pod: 'POD' }); };
  await endpoint.handlers.onOff.off();
  assert.equal(commands, 0);
  await endpoint.handlers.onOff.on();
  assert.equal(commands, 1);
  await timers[0].callback();
  assert.deepEqual(calls.state.at(-1)[2], { onOff: false });
  platform.matter.stop();
});

test('Matter stays optional and preserves real brew errors', async t => {
  const { platform, api, calls, record } = setup();
  t.after(() => platform.matter.stop());
  api.isMatterEnabled = () => false;
  await platform.matter.sync([record]);
  assert.equal(calls.registered.length, 0);
  api.isMatterEnabled = () => true;
  await platform.matter.sync([record]);
  platform.cloud.startBrew = async () => { throw new Error('Brewer is locked'); };
  await assert.rejects(calls.registered[0][0].handlers.onOff.on(), /Keurig command failed/);
  assert.match(calls.warnings[0], /Brewer is locked/);
});
