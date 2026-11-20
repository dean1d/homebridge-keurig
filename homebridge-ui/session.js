'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { authorization, callbackCode, redirect } = require('../login');
const { KeurigCloud, exchange, saveSession, checkStorage } = require('../cloud');
const { controlCatalog } = require('../controls');

class KeurigUiSession {
  constructor(directory, configPath = path.join(directory, 'config.json')) {
    this.directory = directory;
    this.configPath = configPath;
  }

  async config() {
    try {
      const config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
      return config.platforms?.find(item => item.platform === 'KeurigSmart') || {};
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async status() {
    try {
      const session = JSON.parse(await fs.readFile(path.join(this.directory, 'keurig-session.json'), 'utf8'));
      return { signedIn: !!session.access, needsRefresh: session.expires < Date.now() + 15000 };
    } catch (error) { if (error.code === 'ENOENT') return { signedIn: false }; throw error; }
  }

  async begin() {
    await checkStorage(this.directory);
    const cloud = new KeurigCloud(this.directory, await this.config());
    this.flow = { ...authorization(cloud.config.clientId), clientId: cloud.config.clientId,
      expires: Date.now() + 10 * 60 * 1000 };
    // Keep an existing browser session from redirecting before Network is recording.
    this.flow.url.searchParams.set('prompt', 'login');
    return { url: this.flow.url.href, callback: redirect };
  }

  async finish(input) {
    const flow = this.flow;
    if (!flow || flow.expires < Date.now()) throw new Error('Sign-in expired. Start a new sign-in.');
    if (typeof input !== 'string' || input.length > 8192) throw new Error('Paste the complete Keurig callback URL.');
    const code = callbackCode(input, flow);
    this.flow = undefined;
    const tokens = await exchange({ grant_type: 'authorization_code', client_id: flow.clientId,
      redirect_uri: redirect, code_verifier: flow.verifier, code });
    await saveSession(this.directory, flow.clientId, tokens);
    return { signedIn: true };
  }

  async discover() {
    const config = await this.config();
    const cloud = new KeurigCloud(this.directory, config);
    const session = JSON.parse(await fs.readFile(path.join(this.directory, 'keurig-session.json'), 'utf8'));
    if (!session.access || session.clientId !== cloud.config.clientId || session.expires < Date.now() + 15000) {
      throw new Error('The session needs refresh. Start the Keurig child bridge to refresh it, then check again.');
    }
    // Settings checks never rotate tokens alongside a running plugin.
    cloud.token = async () => session.access;
    const devices = await cloud.devices();
    let favorites = [];
    let favoritesUnavailable = false;
    try { favorites = await cloud.favorites(); } catch { favoritesUnavailable = true; }
    const catalog = new Map();
    for (const device of devices) {
      for (const control of controlCatalog(device.model, favorites)) catalog.set(control.subtype, control);
    }
    return {
      devices: devices.map(device => ({ name: device.registration?.name || 'Keurig', model: device.model })),
      controls: [...catalog.values()], favoritesUnavailable,
    };
  }
}

function safeUiError(error) {
  if (error.code === 'ENOENT') return 'No saved Keurig session was found. Sign in first.';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return 'Homebridge cannot read or write its Keurig session. Check storage permissions.';
  if (error instanceof SyntaxError) return 'A local configuration or session file is invalid JSON.';
  if (error.cause || error.name === 'TypeError') return 'Could not reach Keurig. Check the Homebridge server connection.';
  return error.message || 'The Keurig request failed.';
}

module.exports = { KeurigUiSession, safeUiError };
