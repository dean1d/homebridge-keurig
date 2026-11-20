'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { authorization, callbackCode, redirect } = require('../login');
const { KeurigCloud, saveSession, checkStorage, errorDetail } = require('../cloud');

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
  cloud.models.set('demo', 'K29');
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
  cloud.models.set('demo', 'K29');
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
  cloud.models.set('demo', 'K29');
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

test('K-Cafe null and missing recognition allow coffee only while the brewer is ready', async () => {
  const cloud = new KeurigCloud('', {});
  cloud.models.set('demo', 'K29');
  const properties = [
    { name: 'appl_state', value: { current: 'IDLE' } },
    { name: 'brew_state', value: { current: 'BREW_READY', lock_cause: null, error: null } },
    { name: 'lid_recog_result', value: { pm_content: null } },
  ];
  const commands = [];
  cloud.request = async (_route, payload) => {
    if (payload) commands.push(payload);
    else return properties;
  };
  for (const podValue of [null, undefined]) {
    properties[2].value.pm_content = podValue;
    const state = await cloud.state('demo');
    assert.equal(state.pod, 'UNKNOWN');
    assert.equal(state.ready, true);
    await cloud.startBrew('demo', { mode: 'coffee', size: 6 }, async submittedState => {
      assert.equal(submittedState.pod, 'UNKNOWN');
    });
    assert.equal(commands.at(-1).command_name, 'brew');
    assert.equal(commands.at(-1).params.size, 6);
    const count = commands.length;
    await assert.rejects(cloud.startBrew('demo', { mode: 'water', size: 6 }, async () => {}), /Remove the pod/);
    assert.equal(commands.length, count);
  }
  properties[1].value.current = 'BREW_LOCKED';
  properties[1].value.lock_cause = 'PM_NOT_READY';
  await assert.rejects(cloud.startBrew('demo', { mode: 'coffee', size: 6 }, async () => {}), /PM_NOT_READY/);
  properties[1].value.current = 'BREW_READY';
  properties[1].value.lock_cause = null;
  properties[1].value.error = 'ADD_WATER';
  await assert.rejects(cloud.startBrew('demo', { mode: 'coffee', size: 6 }, async () => {}), /ADD_WATER/);
  assert.equal(commands.length, 2);
});

test('confirmation never retries a brew command', async () => {
  const cloud = new KeurigCloud('', {});
  cloud.models.set('demo', 'K29');
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

test('K27 guid recognition identifies empty holders for hot water and blocks loaded pods', async () => {
  const cloud = new KeurigCloud('', {});
  cloud.models.set('cafe', 'K27');
  const properties = [
    { name: 'appl_state', value: { current: 'IDLE' } },
    { name: 'brew_state', value: { current: 'BREW_READY', lock_cause: '', error: '' } },
    { name: 'lid_recog_result', value: { pm_content: null, guid: '900-000' } },
  ];
  const commands = [];
  cloud.request = async (_route, payload) => { if (payload) commands.push(payload); else return properties; };
  for (const guid of ['900-000', '900-0000', { id: '900-000' }, { id: '900-0000' }]) {
    properties[2].value.guid = guid;
    assert.equal((await cloud.state('cafe')).pod, 'EMPTY');
    await cloud.startBrew('cafe', { mode: 'water', size: 6 }, async () => {});
    assert.equal(commands.at(-1).params.brew_type, 1);
    await assert.rejects(cloud.startBrew('cafe', { mode: 'coffee', size: 6 }, async () => {}), /Load a pod/);
  }
  const count = commands.length;
  for (const guid of ['coffee-pod', { id: 'coffee-pod' }]) {
    properties[2].value.guid = guid;
    assert.equal((await cloud.state('cafe')).pod, 'POD');
    await assert.rejects(cloud.startBrew('cafe', { mode: 'water', size: 6 }, async () => {}), /Remove the pod/);
  }
  assert.equal(commands.length, count);
});

test('K27 discovery selects v2 enums and sends one custom brew without legacy units', async t => {
  const cloud = new KeurigCloud('', {});
  cloud.token = async () => 'example-token';
  const commands = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/profile')) return Response.json({ customerID: 'customer' });
    if (url.includes('/devices?')) return Response.json({ devices: [{ id: 'cafe', model: 'K27' }] });
    if (url.endsWith('/properties')) return Response.json([
      { name: 'appl_state', value: { current: 'IDLE' } },
      { name: 'brew_state', value: { current: 'BREW_READY', lock_cause: '', error: '' } },
      { name: 'lid_recog_result', value: { pm_content: null } },
    ]);
    assert.ok(url.endsWith('/cafe/commands'));
    commands.push(JSON.parse(options.body));
    return new Response(null, { status: 202 });
  });
  let submitted = 0;
  await cloud.startBrew('cafe', { mode: 'coffee', size: 6, temperature: 'Hot', strength: 'Balanced' },
    async () => { submitted++; });
  assert.equal(submitted, 1);
  // Keurig's K27 mapping defines 6 oz = 3, Hot = 3, Balanced = 1, Custom = 13.
  assert.deepEqual(commands, [{ command_name: 'brew', params: {
    recipe_format_version: '2.0', size: 3, temperature: 3, strength: 1, brew_type: 13,
    extensions: { key1: 'value1' },
  } }]);
});

test('v2 sizes, temperatures, strengths, shots, iced, BrewID and saved favorites retain their meaning', async () => {
  const cloud = new KeurigCloud('', {});
  cloud.models.set('cafe', 'K27');
  let pod = 'UNKNOWN';
  cloud.state = async () => ({ on: true, ready: true, pod,
    recipes: [{ size: 4, temperature: 7, strength: 4 }] });
  const commands = [];
  cloud.command = async (...args) => commands.push(args);
  const submit = async () => {};
  for (const [ounces, code] of [[4, 2], [6, 3], [8, 4], [10, 5], [12, 6]]) {
    await cloud.startBrew('cafe', { mode: 'coffee', size: ounces, temperature: 'Extra Hot', strength: 'Intense' }, submit);
    assert.equal(commands.at(-1)[2].size, code);
    assert.equal(commands.at(-1)[2].temperature, 4);
    assert.equal(commands.at(-1)[2].strength, 5);
  }
  await cloud.startBrew('cafe', { mode: 'shot', size: 4 }, submit);
  assert.equal(commands.at(-1)[2].size, 2);
  assert.equal(commands.at(-1)[2].brew_type, 6);
  assert.equal(commands.at(-1)[2].strength, 0);
  assert.equal(commands.at(-1)[2].temperature, 0);
  await cloud.startBrew('cafe', { mode: 'iced' }, submit);
  assert.equal(commands.at(-1)[2].brew_type, 5);
  assert.equal(commands.at(-1)[2].size, 3);
  assert.equal(commands.at(-1)[2].temperature, 2);
  await cloud.startBrew('cafe', { mode: 'iced-enhanced', size: 10 }, submit);
  assert.deepEqual(commands.at(-1)[2], { recipe_format_version: '2.0', size: 5, brew_type: 17,
    extensions: { key1: 'value1' } });
  await cloud.startBrew('cafe', { mode: 'recommended', size: 8 }, submit);
  assert.equal(commands.at(-1)[2].brew_type, 11);
  assert.equal(commands.at(-1)[2].strength, 4);
  cloud.favorites = async () => [{ id: 'favorite', deviceModel: 'K27', recipe: {
    recipe_format_version: '2.0', size: 5, temperature: 6, strength: 2, brew_type: 12,
  } }];
  await cloud.startBrew('cafe', { mode: 'favorite', favoriteId: 'favorite' }, submit);
  assert.equal(commands.at(-1)[2].size, 5);
  assert.equal(commands.at(-1)[2].temperature, 6);
  assert.equal(commands.at(-1)[2].brew_type, 12);
  pod = 'EMPTY';
  await cloud.startBrew('cafe', { mode: 'water', size: 12 }, submit);
  assert.equal(commands.at(-1)[2].size, 6);
  assert.equal(commands.at(-1)[2].brew_type, 1);
});

test('unknown models, incompatible favorites and invalid v2 recipes send no commands', async () => {
  const cloud = new KeurigCloud('', {});
  cloud.models.set('cafe', 'unverified');
  cloud.state = async () => ({ on: true, ready: true, pod: 'UNKNOWN', recipes: [] });
  let commands = 0;
  cloud.command = async () => { commands++; };
  const submit = async () => { throw new Error('must not submit'); };
  await assert.rejects(cloud.startBrew('cafe', { mode: 'coffee', size: 6 }, submit), /format is not verified/);
  cloud.models.set('cafe', 'K27');
  cloud.favorites = async () => [{ id: 'wrong', deviceModel: 'K28', recipe: {} }];
  await assert.rejects(cloud.startBrew('cafe', { mode: 'favorite', favoriteId: 'wrong' }, submit), /unavailable/);
  cloud.favorites = async () => [{ id: 'old', size: 8, temperature: 194, flowRate: 4435 }];
  await assert.rejects(cloud.startBrew('cafe', { mode: 'favorite', favoriteId: 'old' }, submit), /version 2.0 recipe/);
  cloud.favorites = async () => [{ id: 'bad', recipe: {
    recipe_format_version: '2.0', size: 8, temperature: 194, strength: 4435, brew_type: 12,
  } }];
  await assert.rejects(cloud.startBrew('cafe', { mode: 'favorite', favoriteId: 'bad' }, submit), /unsupported size/);
  await assert.rejects(cloud.startBrew('cafe', { mode: 'coffee', size: 7 }, submit), /unsupported size/);
  await assert.rejects(cloud.startBrew('cafe', { mode: 'shot', size: 6 }, submit), /unsupported size/);
  cloud.models.set('cafe', 'K28');
  await assert.rejects(cloud.startBrew('cafe', { mode: 'shot', size: 4 }, submit), /not supported/);
  assert.equal(commands, 0);
});

test('Keurig errors[].description is visible with the device identifier redacted', async t => {
  const cloud = new KeurigCloud('', {});
  cloud.token = async () => 'example';
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    statusCode: 400, statusDescription: 'BadRequest', errors: [{ name: 'brew',
      description: "The device command 'brew' is not supported (DeviceId='short-private-id')",
    }],
  }, { status: 400 }));
  await assert.rejects(cloud.command('short-private-id', 'brew', {}), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /The device command 'brew' is not supported/);
    assert.equal(error.message.includes('short-private-id'), false);
    return true;
  });
});

test('HTTP rejection preserves useful API detail and status without logging credentials', async t => {
  const cloud = new KeurigCloud('', { subscriptionKey: 'sensitive-key' });
  cloud.token = async () => 'sensitive-token';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({
      message: ['params.temp is invalid', 'sensitive-token sensitive-key user@example.com https://example.com/private'],
      access_token: 'do-not-log-this',
      errors: { size: ['size must be supported by this model'] },
    }, { status: 400 });
  });
  await assert.rejects(cloud.command('demo', 'brew', { size: 4 }), error => {
    assert.equal(error.status, 400);
    assert.match(error.message, /params.temp is invalid/);
    assert.match(error.message, /size must be supported/);
    for (const secret of ['sensitive-token', 'sensitive-key', 'user@example.com', 'https://example.com', 'do-not-log-this']) {
      assert.equal(error.message.includes(secret), false);
    }
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(errorDetail('<html>private page</html>'), '');
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
