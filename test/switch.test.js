'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function setup() {
  let Platform;
  require('../index')({ registerPlatform(_plugin, _name, implementation) { Platform = implementation; } });
  const warnings = [];
  const messages = [];
  const api = {
    user: { storagePath: () => '' }, on() {}, updatePlatformAccessories() {},
    hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
  };
  const platform = new Platform({ info: text => messages.push(text), warn: text => warnings.push(text) }, {}, api);
  const accessory = { context: {}, displayName: 'KCafe SMART' };
  const preset = { name: 'Brew 2 oz Shot', subtype: 'shot-2', mode: 'shot', size: 2 };
  platform.cloud.confirmBrew = async () => {};
  return { platform, accessory, preset, warnings, messages };
}

test('HomeKit Power reads use the last poll and accepted writes without contacting Keurig', async t => {
  const { platform, accessory, warnings } = setup();
  const power = { onGet(handler) { this.read = handler; return this; }, onSet(handler) { this.write = handler; } };
  const service = { UUID: 'switch', subtype: 'power', getCharacteristic: () => power, updateCharacteristic() {} };
  const info = { setCharacteristic() { return this; } };
  Object.assign(accessory, {
    UUID: 'cafe', services: [service], context: { deviceId: 'cafe', model: 'K27' },
    getService: () => info, getServiceById: () => service,
  });
  Object.assign(platform.api.hap, {
    Service: { Switch: { UUID: 'switch' }, AccessoryInformation: 'info' },
    Characteristic: { On: 'on' }, uuid: { generate: () => 'cafe' },
  });
  platform.nameService = () => {};
  platform.configureAccessory(accessory);
  platform.cloud.devices = async () => [{ id: 'cafe', model: 'K27' }];
  t.after(() => clearTimeout(platform.timer));
  const poll = async () => { clearTimeout(platform.timer); await platform.poll(); };
  let reads = 0;
  platform.cloud.state = async () => { reads++; return { on: true }; };
  assert.equal(await power.read(), false);
  await poll();
  assert.equal(await power.read(), true);
  assert.equal(await power.read(), true);
  assert.equal(reads, 1);

  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  platform.cloud.state = () => { started.resolve(); return pending.promise; };
  const inFlightPoll = poll();
  await started.promise;
  platform.cloud.command = async (_id, command) => assert.equal(command, 'standby');
  await power.write(false);
  pending.resolve({ on: true });
  await inFlightPoll;
  assert.equal(await power.read(), false);
  platform.cloud.state = async () => { throw new Error('cloud timeout'); };
  await poll();
  assert.equal(await power.read(), false);
  assert.deepEqual(warnings, ['Keurig status: cloud timeout']);
});

test('same-tap writes share one in-flight brew and acknowledge accepted repeats without false errors', async () => {
  const { platform, accessory, preset, warnings, messages } = setup();
  const gate = Promise.withResolvers();
  let commands = 0;
  let confirmations = 0;
  platform.cloud.startBrew = async (_id, _preset, submitted) => {
    commands++;
    await submitted({ pod: 'UNKNOWN' });
    await gate.promise;
  };
  platform.cloud.confirmBrew = async () => { confirmations++; };
  const writes = Array.from({ length: 10 }, () => platform.brew(accessory, 'cafe', preset));
  assert.ok(writes.every(promise => promise === writes[0]));
  assert.equal(commands, 1);
  gate.resolve();
  await Promise.all(writes);
  await Promise.all(Array.from({ length: 10 }, () => platform.brew(accessory, 'cafe', preset)));
  assert.equal(commands, 1);
  assert.equal(confirmations, 1);
  assert.deepEqual(warnings, []);
  assert.equal(messages.filter(message => message.includes('request accepted')).length, 1);
});

test('restart with a partial discovery response keeps selected HomeKit and Matter controls', async t => {
  const { platform, accessory } = setup();
  platform.config.controls = { power: true, 'shot-2': true };
  const services = new Map();
  const info = { setCharacteristic() { return this; } };
  Object.assign(accessory, {
    UUID: 'cafe', context: { deviceId: 'cafe', model: 'K27' },
    getService: () => info,
    getServiceById: (_type, subtype) => services.get(subtype),
    addService(_type, _name, subtype) {
      const on = { onGet() { return this; }, onSet() {} };
      const service = { UUID: 'switch', subtype, getCharacteristic: () => on, updateCharacteristic() {} };
      services.set(subtype, service);
      return service;
    },
    removeService: service => services.delete(service.subtype),
  });
  Object.defineProperty(accessory, 'services', { get: () => [...services.values()] });
  Object.assign(platform.api.hap, {
    Service: { Switch: { UUID: 'switch' }, AccessoryInformation: 'info' },
    Characteristic: { On: 'on' }, uuid: { generate: () => 'cafe' },
  });
  platform.nameService = () => {};
  platform.configureAccessory(accessory);
  platform.cloud.request = async route => route.endsWith('/profile')
    ? { customerID: 'customer' } : { devices: [{ id: 'cafe' }] };
  platform.cloud.state = async () => ({ on: true });
  platform.matter.sync = async ([record]) => {
    assert.equal(record.device.model, 'K27');
    assert.deepEqual(record.controls.map(control => control.subtype), ['power', 'shot-2']);
  };
  t.after(() => clearTimeout(platform.timer));
  await platform.poll();
  assert.equal(accessory.context.model, 'K27');
  assert.equal(platform.cloud.models.get('cafe'), 'K27');
  assert.deepEqual([...services.keys()], ['power', 'shot-2']);
});

test('another preset remains blocked, and deliberate later taps still report the cooldown once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { platform, accessory, preset, warnings } = setup();
  let commands = 0;
  platform.cloud.startBrew = async (_id, _preset, submitted) => {
    commands++;
    await submitted({ pod: 'POD' });
  };
  await platform.brew(accessory, 'cafe', preset);
  const other = { ...preset, name: 'Brew 6 oz Coffee', subtype: 'coffee-6' };
  for (let i = 0; i < 10; i++) await assert.rejects(platform.brew(accessory, 'cafe', other));
  assert.equal(commands, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignored: A brew was recently requested/);
  t.mock.timers.tick(3000);
  await assert.rejects(platform.brew(accessory, 'cafe', preset));
  await assert.rejects(platform.brew(accessory, 'cafe', other));
  assert.equal(warnings.length, 2);
  assert.equal(commands, 1);
  t.mock.timers.tick(57000);
  await platform.brew(accessory, 'cafe', preset);
  assert.equal(commands, 2);
});

test('concurrent repeats share a real rejection and report the underlying error only once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { platform, accessory, preset, warnings } = setup();
  const gate = Promise.withResolvers();
  let commands = 0;
  platform.cloud.startBrew = async (_id, _preset, submitted) => {
    commands++;
    await submitted({ pod: 'UNKNOWN' });
    await gate.promise;
    throw Object.assign(new Error('Keurig rejected this recipe'), { status: 400 });
  };
  const writes = Array.from({ length: 10 }, () => platform.brew(accessory, 'cafe', preset));
  const results = Promise.allSettled(writes);
  gate.resolve();
  assert.ok((await results).every(result => result.status === 'rejected'));
  assert.equal(commands, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed: Keurig rejected this recipe/);
  assert.equal(accessory.context.lastBrewAccepted, false);
  assert.equal(accessory.context.nextBrew, 102000);
  await assert.rejects(platform.brew(accessory, 'cafe', preset));
  assert.equal(commands, 1);
});

test('uncertain submissions retain the full guard and cannot be acknowledged as an accepted repeat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { platform, accessory, preset } = setup();
  let commands = 0;
  platform.cloud.startBrew = async (_id, _preset, submitted) => {
    commands++;
    await submitted({ pod: 'UNKNOWN' });
    throw new Error('Request timed out');
  };
  await assert.rejects(platform.brew(accessory, 'cafe', preset));
  assert.equal(accessory.context.nextBrew, 160000);
  assert.equal(accessory.context.lastBrewAccepted, false);
  await assert.rejects(platform.brew(accessory, 'cafe', preset));
  assert.equal(commands, 1);
});

test('a restart preserves the accepted repeat window and cooldown without resending a brew', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { platform, accessory, preset } = setup();
  platform.cloud.startBrew = async (_id, _preset, submitted) => submitted({ pod: 'POD' });
  await platform.brew(accessory, 'cafe', preset);
  const restarted = setup().platform;
  let commands = 0;
  restarted.cloud.startBrew = async () => { commands++; };
  await restarted.brew(accessory, 'cafe', preset);
  t.mock.timers.tick(3000);
  await assert.rejects(restarted.brew(accessory, 'cafe', preset));
  assert.equal(commands, 0);
});

test('sequential retries after a failed wake-up check share one failure and send zero brew commands', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { platform, accessory, preset, warnings, messages } = setup();
  platform.cloud.models.set('cafe', 'K27');
  const state = { on: false, ready: false, appliance: 'STANDBY', brewer: 'BREW_LOCKED',
    pod: 'UNKNOWN', lock: 'PM_NOT_CYCLED', recipes: [] };
  let checks = 0;
  platform.cloud.state = async () => { checks++; return { ...state }; };
  const commands = [];
  platform.cloud.command = async (_id, command) => {
    commands.push(command);
    if (command === 'idle') { state.on = true; state.appliance = 'IDLE'; }
  };
  platform.cloud.waitForState = async () => {
    throw new Error('Brewer did not reach the expected state (power=IDLE, brewer=BREW_LOCKED, lock=PM_NOT_CYCLED).');
  };
  let originalError;
  await assert.rejects(platform.brew(accessory, 'cafe', preset), error => {
    originalError = error;
    return true;
  });
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(500);
    await assert.rejects(platform.brew(accessory, 'cafe', preset), error => error === originalError);
  }
  assert.deepEqual(commands, ['idle']);
  assert.equal(checks, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PM_NOT_CYCLED/);
  assert.equal(messages.filter(message => message.startsWith('Checking brewer readiness')).length, 1);
  assert.equal(messages.some(message => message.startsWith('Sending ')), false);
  // A fresh user action after preparation and the short retry window can brew.
  t.mock.timers.tick(6500);
  state.ready = true;
  state.brewer = 'BREW_READY';
  state.lock = '';
  await platform.brew(accessory, 'cafe', preset);
  assert.deepEqual(commands, ['idle', 'brew']);
  assert.equal(checks, 2);
  assert.equal(messages.filter(message => message.startsWith('Sending ')).length, 1);
});

test('cached preparation failure does not block a different preset or hide its result', async () => {
  const { platform, accessory, preset, warnings } = setup();
  let attempts = 0;
  platform.cloud.startBrew = async (_id, selected, submitted) => {
    attempts++;
    if (selected.subtype === preset.subtype) throw new Error('Recipe unavailable');
    await submitted({ pod: 'POD' });
  };
  await assert.rejects(platform.brew(accessory, 'cafe', preset));
  await assert.rejects(platform.brew(accessory, 'cafe', preset));
  assert.equal(attempts, 1);
  const other = { ...preset, subtype: 'coffee-6', name: 'Brew 6 oz Coffee' };
  await platform.brew(accessory, 'cafe', other);
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
  assert.equal(accessory.context.lastBrewAccepted, true);
  await assert.rejects(platform.brew(accessory, 'cafe', preset));
  assert.equal(attempts, 2);
});
