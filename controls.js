'use strict';

const { sizes } = require('./cloud');
const modern = new Set(['K27', 'K27C', 'K28', 'K28C', 'K28B']);
const supported = new Set([...modern, 'K29', 'K29C']);

function controlCatalog(model, favorites = []) {
  const controls = [{ subtype: 'power', name: 'Power', mode: 'power', group: 'Power' }];
  if (!supported.has(model)) return controls;
  controls.push(...sizes.map(size => ({ subtype: size === 8 ? 'brew' : 'coffee-' + size,
    name: 'Brew ' + size + ' oz Coffee', size, mode: 'coffee', group: 'Coffee' })));
  if (['K27', 'K27C'].includes(model)) {
    controls.push(...[2, 4].map(size => ({ subtype: 'shot-' + size, name: 'Brew ' + size + ' oz Shot',
      size, mode: 'shot', group: 'Shots' })));
  }
  controls.push({ subtype: 'iced', name: 'Brew Over Ice 6 oz', mode: 'iced', group: 'Over Ice' });
  if (modern.has(model)) {
    controls.push(...[8, 10, 12].map(size => ({ subtype: 'iced-enhanced-' + size,
      name: 'Brew Over Ice Enhanced ' + size + ' oz', mode: 'iced-enhanced', size,
      group: 'Over Ice', newControl: true })));
  }
  controls.push(...sizes.filter(size => !modern.has(model) || size >= 6).map(size => ({
    subtype: 'water-' + size, name: 'Dispense ' + size + ' oz Hot Water', mode: 'water', size, group: 'Hot Water',
  })));
  controls.push(...sizes.map(size => ({ subtype: 'recommended-' + size, name: 'BrewID ' + size + ' oz Coffee',
    mode: 'recommended', size, group: 'BrewID' })));
  controls.push(...favorites.filter(favorite => !favorite.deviceModel || favorite.deviceModel === model)
    .map(favorite => ({ subtype: 'favorite-' + favorite.id, name: 'Brew ' + (favorite.name || 'Favorite'),
      mode: 'favorite', favoriteId: favorite.id, group: 'App Favorites' })));
  controls.push({ subtype: 'cancel', name: 'Cancel Brew', mode: 'cancel', group: 'Power' });
  return controls;
}

function legacyEnabled(config, control) {
  if (control.mode === 'power') return true;
  if (!config.enableBrew || control.newControl) return false;
  if (control.mode === 'water') return !!config.enableHotWater;
  if (control.mode === 'recommended') return !!config.enableRecommended;
  if (control.mode === 'favorite') return config.enableFavorites !== false;
  return true;
}

function enabledControls(config, model, favorites = []) {
  const explicit = config.controls && typeof config.controls === 'object' && !Array.isArray(config.controls);
  return controlCatalog(model, favorites).filter(control => explicit
    ? config.controls[control.subtype] === true : legacyEnabled(config, control))
    .map(control => ({ ...control, temperature: config.brewTemperature || 'Hot', strength: config.brewStrength || 'Balanced' }));
}

function selectedControls(config, catalog) {
  if (config.controls && typeof config.controls === 'object' && !Array.isArray(config.controls)) return { ...config.controls };
  return Object.fromEntries(catalog.map(control => [control.subtype, legacyEnabled(config, control)]));
}

module.exports = { controlCatalog, enabledControls, selectedControls };
