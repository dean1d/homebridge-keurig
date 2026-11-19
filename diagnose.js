#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { KeurigCloud } = require('./cloud');

function redactResponse(body, secrets = []) {
  let text = body;
  try {
    text = JSON.stringify(JSON.parse(body), (key, value) =>
      /token|password|secret|authorization|cookie|subscription|serial|customer|device.?id|email/i.test(key)
        ? '[redacted]' : value);
  } catch {
    // Error responses can be plain text, XML, HTML or empty.
  }
  for (const secret of secrets.filter(value => typeof value === 'string' && value)) {
    text = text.split(secret).join('[redacted]');
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address redacted]')
    .replace(/[a-z0-9_.=-]{32,}/gi, '[identifier redacted]')
    .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 2000) || '<empty body>';
}

async function diagnose(directory, brewSize) {
  if (!directory || (brewSize !== undefined && brewSize !== '4')) {
    throw new Error('Usage: homebridge-keurig-diagnose <storage directory> [--brew 4]');
  }
  const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  const platform = config.platforms?.find(item => item.platform === 'KeurigSmart') || {};
  const cloud = new KeurigCloud(directory, platform);
  const session = JSON.parse(await fs.readFile(path.join(directory, 'keurig-session.json'), 'utf8'));
  if (session.clientId !== cloud.config.clientId || !session.access || session.expires < Date.now() + 15000) {
    throw new Error('The saved access token needs refresh. Let the running plugin refresh it, then run this diagnostic again.');
  }
  // Keep rotation in the running plugin so this diagnostic cannot race its refresh.
  cloud.token = async () => session.access;
  const secrets = [session.access, session.refresh, cloud.config.subscriptionKey];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (!response.ok && new URL(url).hostname === 'iot.keurig.com') {
      const body = await response.clone().text();
      console.log('RESPONSE ' + response.status + ' | type ' + (response.headers.get('content-type') || '<unset>') +
        ' | bytes ' + Buffer.byteLength(body));
      console.log('REDACTED BODY ' + redactResponse(body, secrets));
    }
    return response;
  };
  try {
    const devices = await cloud.devices();
    if (devices.length !== 1) throw new Error('This diagnostic requires exactly one registered brewer.');
    const device = devices[0];
    secrets.push(device.id, device.serialNumber);
    const state = await cloud.state(device.id);
    console.log('MODEL ' + device.model);
    console.log('STATE ' + JSON.stringify({ power: state.appliance, brewer: state.brewer,
      pod: state.pod, lock: state.lock, error: state.error }));
    if (brewSize === undefined) {
      console.log('Read-only diagnostic finished.');
      return;
    }
    console.log('Requesting one 4 oz coffee at Hot / Balanced. The pod and cup must be prepared.');
    await cloud.startBrew(device.id, { mode: 'coffee', size: 4 }, async () => {});
    console.log('Brew request accepted. Checking reported state...');
    await cloud.confirmBrew(device.id);
    console.log('Brewer reported brewing.');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const brewIndex = args.indexOf('--brew');
  if (brewIndex >= 0 && args[brewIndex + 1] !== '4') {
    console.error('The brew diagnostic supports --brew 4 only.');
    process.exitCode = 1;
  } else {
    diagnose(args[0], brewIndex < 0 ? undefined : args[brewIndex + 1]).catch(error => {
      console.error(error instanceof SyntaxError ? 'A local JSON file could not be read.' : error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { diagnose, redactResponse };
