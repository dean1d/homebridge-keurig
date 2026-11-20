'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { controlCatalog, enabledControls, selectedControls } = require('../controls');

test('explicit checkboxes expose only selected supported controls and retain the 8 oz subtype', () => {
  const config = { controls: { power: false, brew: true, 'shot-2': true, 'coffee-6': false, invented: true } };
  assert.deepEqual(enabledControls(config, 'K27').map(control => control.subtype), ['brew', 'shot-2']);
  assert.deepEqual(enabledControls(config, 'K29').map(control => control.subtype), ['brew']);
  assert.deepEqual(enabledControls(config, 'unverified'), []);
  assert.deepEqual(enabledControls({ controls: {} }, 'K27'), []);
});

test('legacy settings migrate the same selections and model-specific options exclude invalid water sizes', () => {
  const config = { enableBrew: true, enableHotWater: true, enableFavorites: true };
  const favorites = [{ id: 'mine', name: 'Morning', deviceModel: 'K27' }, { id: 'other', deviceModel: 'K29' }];
  const catalog = controlCatalog('K27', favorites);
  const legacy = enabledControls(config, 'K27', favorites).map(control => control.subtype);
  const migrated = selectedControls(config, catalog);
  assert.deepEqual(enabledControls({ controls: migrated }, 'K27', favorites).map(control => control.subtype), legacy);
  assert.ok(legacy.includes('favorite-mine'));
  assert.equal(legacy.includes('favorite-other'), false);
  assert.equal(catalog.some(control => control.subtype === 'water-4'), false);
  assert.equal(controlCatalog('K28').some(control => control.mode === 'shot'), false);
  assert.equal(legacy.includes('iced-enhanced-8'), false);
  assert.deepEqual(enabledControls({}, 'K27').map(control => control.subtype), ['power']);
});

test('each app favorite can be enabled independently', () => {
  const favorites = [{ id: 'a', name: 'Morning' }, { id: 'b', name: 'Evening' }];
  const controls = enabledControls({ controls: { 'favorite-b': true } }, 'K27', favorites);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].favoriteId, 'b');
});
