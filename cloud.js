'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const defaults = require('./settings');
const { setTimeout: sleep } = require('node:timers/promises');

const sizes = [4, 6, 8, 10, 12];
const temperatures = { Warm: 187, Warmer: 191, Hot: 194, Hotter: 197, 'Extra Hot': 200, 'Max Hot': 204 };
const strengths = { Balanced: 4435, Rich: 3942, Robust: 3449, Strong: 2957, Intense: 2464 };

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
      for (const key of ['code', 'message', 'detail']) collect(value[key], depth + 1);
    }
  }
  if (data && typeof data === 'object') {
    for (const key of ['code', 'error', 'message', 'error_description', 'detail', 'title']) {
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
      const detail = errorDetail(data, [token, this.config.subscriptionKey]);
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
    validateRecipe(params);
    await submitted(state);
    await this.command(id, 'brew', params);
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

module.exports = { KeurigCloud, exchange, saveSession, issuer, checkStorage, storageError, sizes, temperatures, strengths, errorDetail };
