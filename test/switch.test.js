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
