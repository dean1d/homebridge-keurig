'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const defaults = require('./settings');

const issuer = 'https://login.keurig.com';
const base = 'https://iot.keurig.com/connected-platform/';

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
  } finally {
    await fs.rm(temp, { force: true });
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
      throw error;
    }
    if (session.clientId !== this.config.clientId) throw new Error('OAuth client changed. Sign in again.');
    if (session.access && session.expires > Date.now() + 60000) return session.access;
    if (!session.refresh) throw new Error('Refresh token missing. Sign in again.');
    const tokens = await exchange({ client_id: session.clientId, grant_type: 'refresh_token', refresh_token: session.refresh });
    return (await saveSession(this.directory, session.clientId, tokens, session.refresh)).access;
  }

  async request(route, payload) {
    const headers = {
      Authorization: 'Bearer ' + await this.token(),
      'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
    };
    if (payload) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method: payload ? 'POST' : 'GET', headers, redirect: 'error',
      signal: AbortSignal.timeout(15000), body: payload && JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('Keurig brewer API returned HTTP ' + response.status);
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
    const brew = value('brew_state');
    return {
      on: power !== 'STANDBY',
      ready: power === 'IDLE' && brew?.current === 'BREW_READY' && !brew.error && !brew.lock_cause &&
        value('lid_recog_result')?.pm_content === 'POD',
    };
  }

  command(id, command_name, params) {
    return this.request('api/acsm/v1/devices/' + encodeURIComponent(id) + '/commands', { command_name, params });
  }
}

module.exports = { KeurigCloud, exchange, saveSession, issuer };
