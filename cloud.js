'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const defaults = require('./settings');
const { setTimeout: sleep } = require('node:timers/promises');

const sizes = [4, 6, 8, 10, 12];
const temperatures = { Warm: 187, Warmer: 191, Hot: 194, Hotter: 197, 'Extra Hot': 200, 'Max Hot': 204 };
const strengths = { Balanced: 4435, Rich: 3942, Robust: 3449, Strong: 2957, Intense: 2464 };

// Protocol values from Keurig's public K27/K28 RemoteBrew capability mapping,
// checked against Android app 2.2622.0 on 2026-11-19. Values are enums, not units.
const v2Models = new Set(['K27', 'K27C', 'K28', 'K28C', 'K28B']);
const v2Temperatures = { Warm: 5, Warmer: 6, Hot: 3, Hotter: 7, 'Extra Hot': 4, 'Max Hot': 8 };
const v2Strengths = { Balanced: 1, Rich: 2, Robust: 3, Strong: 4, Intense: 5 };

function recipeVersion(model) {
  if (v2Models.has(model)) return '2.0';
  if (['K29', 'K29C'].includes(model)) return '1.0';
  throw new Error('Brew recipe format is not verified for model ' + (model || 'UNKNOWN') + '.');
}

function validateV2Recipe(recipe, model) {
  const allowedSizes = ['K27', 'K27C'].includes(model) ? [1, 2, 3, 4, 5, 6] : [3, 4, 5, 6];
  if (recipe.recipe_format_version !== '2.0' || !allowedSizes.includes(recipe.size) ||
      ![1, 2, 5, 6, 7, 11, 12, 13, 17].includes(recipe.brew_type) ||
      (recipe.brew_type === 6
        ? ![1, 2].includes(recipe.size) || recipe.strength !== 0 || recipe.temperature !== 0
        : ![1, 2, 3, 4, 5].includes(recipe.strength) || ![2, 3, 4, 5, 6, 7, 8].includes(recipe.temperature))) {
    throw new Error('This brew recipe has unsupported size, temperature or strength settings for ' + model + '.');
  }
  return recipe;
}

function validateRecipe(recipe) {
  if (!sizes.includes(recipe.size) || !Number.isFinite(recipe.temp) || recipe.temp < 150 || recipe.temp > 212 ||
      !Number.isFinite(recipe.flow_rate) || recipe.flow_rate <= 0 || recipe.flow_rate > 10000) {
    throw new Error('This brew recipe has unsupported size, temperature or strength settings.');
  }
  return recipe;
}

function describeState(state) {
  return 'power=' + state.appliance + ', brewer=' + state.brewer + ', pod=' + state.pod +
    ', lock=' + (state.lock || 'none') + ', error=' + (state.error || 'none');
}

const issuer = 'https://login.keurig.com';
const base = 'https://iot.keurig.com/connected-platform/';

function errorDetail(data, secrets = []) {
  const messages = [];
  function collect(value, depth = 0) {
    if (depth > 3 || messages.length >= 20) return;
    if (typeof value === 'string' || typeof value === 'number') messages.push(String(value));
    else if (Array.isArray(value)) value.slice(0, 5).forEach(item => collect(item, depth + 1));
    else if (value && typeof value === 'object') {
      for (const key of ['code', 'message', 'description', 'detail']) collect(value[key], depth + 1);
    }
  }
  if (data && typeof data === 'object') {
    for (const key of ['code', 'error', 'message', 'error_description', 'statusDescription', 'detail', 'title']) {
      collect(data[key]);
    }
    if (data.errors && typeof data.errors === 'object') {
      for (const value of Object.values(data.errors).slice(0, 5)) collect(value);
    }
  }
  let text = [...new Set(messages)].join(' | ');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[a-z0-9_=-]{32,}/gi, '[identifier redacted]')
    .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 700);
}

function storageError(error, operation, directory) {
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
    return new Error('Keurig storage permission error (' + error.code + ') while ' + operation +
      ' in ' + path.resolve(directory) + '. Run the helper as the Homebridge service user and verify that user can read and write this storage directory.');
  }
  return error;
}

async function checkStorage(directory) {
  const probe = path.join(directory, '.keurig-write-check-' + randomUUID());
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
    await fs.rm(probe);
  } catch (error) {
    throw storageError(error, 'checking write access', directory);
  }
}

async function exchange(fields) {
  const response = await fetch(issuer + '/oauth/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams(fields),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (data?.error === 'invalid_grant') throw new Error('Authorization expired or revoked. Sign in again.');
    throw new Error('Keurig token exchange returned HTTP ' + response.status);
  }
  const tokens = await response.json();
  if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
      !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) {
    throw new Error('Keurig returned an incomplete token response.');
  }
  return tokens;
}

async function saveSession(directory, clientId, tokens, previousRefresh) {
  const refresh = tokens.refresh_token ?? previousRefresh;
  if (typeof refresh !== 'string' || !refresh) throw new Error('Keurig did not grant offline access.');
  const session = { clientId, access: tokens.access_token, refresh, expires: Date.now() + tokens.expires_in * 1000 };
  const file = path.join(directory, 'keurig-session.json');
  const temp = file + '.' + randomUUID();
  try {
    await fs.writeFile(temp, JSON.stringify(session), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } catch (error) {
    throw storageError(error, 'saving keurig-session.json', directory);
  } finally {
    // Preserve the save failure if cleanup is also denied.
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  return session;
}

class KeurigCloud {
  constructor(directory, config) {
    this.directory = directory;
    this.config = { ...defaults, ...config };
    this.config.clientId ||= defaults.clientId;
    this.config.subscriptionKey ||= defaults.subscriptionKey;
    this.models = new Map();
  }

  async token() {
    // Serialize the read, refresh, and atomic save. Refresh tokens may be single-use.
    this.pending ??= this.loadToken().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async loadToken() {
    let session;
    try {
      session = JSON.parse(await fs.readFile(path.join(this.directory, 'keurig-session.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Keurig sign-in required. Run npm run login for this Homebridge storage folder.');
      throw storageError(error, 'reading keurig-session.json', this.directory);
    }
    if (session.clientId !== this.config.clientId) throw new Error('OAuth client changed. Sign in again.');
    if (session.access && session.expires > Date.now() + 60000) return session.access;
    if (!session.refresh) throw new Error('Refresh token missing. Sign in again.');
    const tokens = await exchange({ client_id: session.clientId, grant_type: 'refresh_token', refresh_token: session.refresh });
    return (await saveSession(this.directory, session.clientId, tokens, session.refresh)).access;
  }

  async request(route, payload) {
    const token = await this.token();
    const headers = {
      Authorization: 'Bearer ' + token,
      'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
    };
    if (payload) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method: payload ? 'POST' : 'GET', headers, redirect: 'error',
      signal: AbortSignal.timeout(15000), body: payload && JSON.stringify(payload),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const deviceId = route.match(/\/devices\/([^/?]+)/)?.[1];
      const detail = errorDetail(data, [token, this.config.subscriptionKey, deviceId && decodeURIComponent(deviceId)]);
      const error = new Error('Keurig brewer API returned HTTP ' + response.status + (detail ? ' (' + detail + ')' : ''));
      error.status = response.status;
      throw error;
    }
    if (!payload) return response.json();
  }

  async devices() {
    const profile = await this.request('api/usdm/v1/user/profile');
    if (!profile.customerID) throw new Error('The Keurig profile has no customer ID.');
    const list = await this.request('api/alcm/v1/devices?customerId=' + encodeURIComponent(profile.customerID));
    if (!Array.isArray(list.devices) || list.devices.some(d => !d?.id)) throw new Error('Unexpected Keurig device list.');
    this.models = new Map(list.devices.map(device => [device.id, device.model]));
    return list.devices;
  }

  async state(id) {
    const properties = await this.request('api/acsm/v1/devices/' + encodeURIComponent(id) + '/properties');
    const value = name => properties.find(p => p.name === name)?.value;
    const power = value('appl_state')?.current;
    if (!['IDLE', 'BREW', 'STANDBY'].includes(power)) throw new Error('Brewer power state is unavailable.');
    const brew = value('brew_state') || {};
    const pod = value('lid_recog_result') || {};
    return {
      on: power !== 'STANDBY',
      ready: power !== 'STANDBY' && brew.current === 'BREW_READY' && !brew.error && !brew.lock_cause,
      appliance: power, brewer: brew.current, pod: pod.pm_content ?? 'UNKNOWN',
      lock: brew.lock_cause, error: brew.error, recipes: pod.pod_details?.recipes || [],
    };
  }

  async favorites() {
    const favorites = await this.request('api/usdm/v1/presets');
    if (!Array.isArray(favorites)) throw new Error('Unexpected Keurig favorites response.');
    return favorites.filter(favorite => favorite && typeof favorite.id === 'string' && favorite.id);
  }

  async waitForState(id, predicate, attempts = 10, delay = 1500) {
    let state;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(delay);
      state = await this.state(id);
      if (predicate(state)) return state;
    }
    throw new Error('Brewer did not reach the expected state (' + describeState(state) + ').');
  }

  async startBrew(id, preset, submitted) {
    if (!this.models.has(id)) await this.devices();
    const model = this.models.get(id);
    const version = recipeVersion(model);
    let state = await this.state(id);
    if (!state.on) {
      await this.command(id, 'idle');
      state = await this.waitForState(id, current => current.on && current.ready, 3, 1000);
    }
    if (!state.ready) throw new Error('Brewer is not ready (' + describeState(state) + ').');
    if (preset.mode === 'water') {
      if (state.pod !== 'EMPTY') throw new Error('Remove the pod for hot water (' + describeState(state) + ').');
    } else if (state.pod === 'EMPTY') {
      throw new Error('Load a pod and lower the handle (' + describeState(state) + ').');
    }
    let params;
    if (version === '2.0') {
      params = await this.v2Recipe(model, preset, state);
    } else {
      params = await this.legacyRecipe(preset, state);
    }
    await submitted(state);
    await this.command(id, 'brew', params);
  }

  async v2Recipe(model, preset, state) {
    let params = { recipe_format_version: '2.0', size: preset.size / 2,
      temperature: v2Temperatures[preset.temperature || 'Hot'],
      strength: v2Strengths[preset.strength || 'Balanced'], brew_type: 13 };
    switch (preset.mode) {
      case 'shot':
        if (!['K27', 'K27C'].includes(model)) throw new Error('Shots are not supported by this brewer.');
        params = { ...params, brew_type: 6, strength: 0, temperature: 0 };
        break;
      case 'water':
        params = { ...params, brew_type: 1, strength: 1 };
        break;
      case 'iced':
        params = { ...params, size: 3, temperature: 2, strength: 5, brew_type: 5 };
        break;
      case 'recommended': {
        const recipe = state.recipes.find(recipe => recipe.size === params.size);
        if (!recipe) throw new Error('BrewID has no recommended recipe for ' + preset.size + ' oz.');
        params = { ...params, temperature: recipe.temperature, strength: recipe.strength, brew_type: 11 };
        break;
      }
      case 'favorite': {
        const favorite = (await this.favorites()).find(favorite => favorite.id === preset.favoriteId &&
          (!favorite.deviceModel || favorite.deviceModel === model));
        if (!favorite) throw new Error('This favorite is unavailable for this brewer in the Keurig app.');
        const recipe = favorite.recipe;
        if (recipe?.recipe_format_version !== '2.0') {
          throw new Error('This favorite does not contain a version 2.0 recipe. Save it for this brewer in the Keurig app.');
        }
        params = { recipe_format_version: '2.0', size: recipe.size,
          temperature: recipe.temperature, strength: recipe.strength, brew_type: recipe.brew_type };
        break;
      }
    }
    // The current mobile client includes this fixed extension object on v2 brews.
    return { ...validateV2Recipe(params, model), extensions: { key1: 'value1' } };
  }

  async legacyRecipe(preset, state) {
    if (preset.mode === 'shot') throw new Error('Shots are not supported by this brewer.');
    let params = { size: preset.size, temp: temperatures[preset.temperature || 'Hot'],
      flow_rate: strengths[preset.strength || 'Balanced'], brew_type: 'NORMAL',
      enhanced: true, category: 'CUSTOM' };
    switch (preset.mode) {
      case 'water':
        params = { ...params, brew_type: 'HOT_WATER', category: 'WATER', flow_rate: strengths.Balanced };
        break;
      case 'iced':
        params = { ...params, size: 6, temp: 201, flow_rate: strengths.Intense, brew_type: 'ICED', category: 'ICED' };
        break;
      case 'recommended': {
        const recipe = state.recipes.find(recipe => recipe.size === preset.size);
        if (!recipe) throw new Error('BrewID has no recommended recipe for ' + preset.size + ' oz.');
        params = { ...params, temp: recipe.temp, flow_rate: recipe.flow_rate, category: 'MASTER' };
        break;
      }
      case 'favorite': {
        const favorite = (await this.favorites()).find(favorite => favorite.id === preset.favoriteId);
        if (!favorite) throw new Error('This favorite was removed from the Keurig app.');
        params = { ...params, size: favorite.size, temp: favorite.temperature,
          flow_rate: favorite.flowRate, category: 'FAVORITE' };
        break;
      }
    }
    return validateRecipe(params);
  }

  async confirmBrew(id) {
    try {
      return await this.waitForState(id, current =>
        current.appliance === 'BREW' || ['BREW_IN_PROGRESS', 'BREW_SUCCESSFUL'].includes(current.brewer));
    } catch (err) {
      throw new Error('Brew request sent, but the start could not be confirmed. Check the brewer before retrying. ' + err.message);
    }
  }

  command(id, command_name, params) {
    return this.request('api/acsm/v1/devices/' + encodeURIComponent(id) + '/commands', { command_name, params });
  }
}

module.exports = { KeurigCloud, exchange, saveSession, issuer, checkStorage, storageError, sizes, temperatures, strengths, errorDetail, recipeVersion };
