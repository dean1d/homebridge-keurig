#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { exchange, saveSession, issuer, KeurigCloud, checkStorage, storageError } = require('./cloud');
const defaults = require('./settings');

const redirect = defaults.redirect;

function authorization(clientId = defaults.clientId) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const url = new URL('/authorize', issuer);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect,
    scope: 'openid profile email offline_access', audience: 'customers-apis',
    code_challenge_method: 'S256', code_challenge: crypto.hash('sha256', verifier, 'base64url'), state,
  }).toString();
  return { verifier, state, url };
}

function callbackCode(input, flow) {
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Paste the complete Keurig callback URL.'); }
  const callback = new URL(redirect);
  if (url.origin !== callback.origin || url.pathname !== callback.pathname ||
      url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== flow.state) {
    throw new Error('That callback does not match this sign-in attempt. Start the login command again.');
  }
  if (url.searchParams.has('error')) throw new Error('Keurig sign-in was declined or incomplete.');
  if (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) {
    throw new Error('The callback has no authorization code. Copy the request URL containing code=.');
  }
  return url.searchParams.get('code');
}

async function inspect(cloud) {
  const devices = await cloud.devices();
  if (!devices.length) throw new Error('Sign-in succeeded, but this account returned no brewers.');
  for (const device of devices) {
    const state = await cloud.state(device.id);
    console.log('Found ' + (device.registration?.name || 'Keurig') + ' | model ' + device.model +
      ' | power ' + (state.on ? 'on' : 'off') + ' | ready to brew ' + state.ready);
    console.log('Brewer state ' + state.brewer + ' | pod ' + state.pod +
      ' | lock ' + (state.lock || 'none') + ' | error ' + (state.error || 'none'));
  }
}

async function login(directory, checkOnly = false) {
  if (!directory) throw new Error('Usage: homebridge-keurig-login "<storage directory>" [--check]');
  let platform = {};
  try {
    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    platform = config.platforms?.find(p => p.platform === 'KeurigSmart') || {};
  } catch (err) {
    if (err.code !== 'ENOENT') throw storageError(err, 'reading config.json', directory);
  }
  const cloud = new KeurigCloud(directory, platform);
  if (checkOnly) {
    await inspect(cloud);
    return;
  }
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
  // Fail before the user signs in if the session cannot be saved.
  await checkStorage(directory);
  const flow = authorization(cloud.config.clientId);
  console.log('Open browser developer tools, select Network, and enable Preserve log.');
  console.log('Open this link in that browser and sign in to Keurig:\n' + flow.url.href);
  console.log('Find the request to ' + redirect + ' containing code=, then copy its complete Request URL.');
  console.log('Paste it here promptly. Keep the URL private.');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let code;
  try {
    const input = await terminal.question('Keurig callback URL: ');
    code = callbackCode(input, flow);
  } finally {
    terminal.close();
  }
  console.log('Exchanging the authorization code with Keurig...');
  const tokens = await exchange({ grant_type: 'authorization_code', client_id: cloud.config.clientId,
    redirect_uri: redirect, code_verifier: flow.verifier, code });
  console.log('Saving the Keurig session...');
  await saveSession(directory, cloud.config.clientId, tokens);
  console.log('Sign-in saved. Checking registered brewers...');
  await inspect(cloud);
  console.log('Account check passed. Start or restart the Keurig Homebridge platform.');
}

if (require.main === module) {
  login(process.argv[2], process.argv.includes('--check')).catch(err => {
    // Raw network errors may contain an authenticated URL. Print only our messages or a type.
    console.error(err.cause || err.code ? 'Keurig check failed (' + (err.code || err.name) + ').' : err.message);
    process.exitCode = 1;
  });
}
module.exports = { authorization, callbackCode, inspect, redirect };
