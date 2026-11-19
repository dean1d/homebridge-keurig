'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { diagnose, redactResponse } = require('../diagnose');
const { saveSession } = require('../cloud');
const defaults = require('../settings');

test('response capture supports alternate JSON fields, plain text and empty bodies', () => {
  assert.equal(redactResponse(''), '<empty body>');
  assert.match(redactResponse('Invalid brew parameters'), /Invalid brew parameters/);
  const body = JSON.stringify({ Message: 'Invalid brew parameters', Extra: {
    refresh_token: 'private-refresh', Message: 'private-access user@example.com 192.168.1.1',
  } });
  const text = redactResponse(body, ['private-access']);
  assert.match(text, /Invalid brew parameters/);
  for (const secret of ['private-refresh', 'private-access', 'user@example.com', '192.168.1.1']) {
    assert.equal(text.includes(secret), false);
  }
});

test('one-off brew diagnostic captures the 400 body and sends exactly one brew', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'keurig-diagnostic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ platforms: [] }));
  await saveSession(directory, defaults.clientId,
    { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 });
  const output = [];
  t.mock.method(console, 'log', line => output.push(line));
  let brews = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/profile')) return Response.json({ customerID: 'customer' });
    if (url.includes('/devices?')) return Response.json({ devices: [{ id: 'private-device', model: 'K-Cafe SMART' }] });
    if (url.endsWith('/properties')) return Response.json([
      { name: 'appl_state', value: { current: 'IDLE' } },
      { name: 'brew_state', value: { current: 'BREW_READY' } },
      { name: 'lid_recog_result', value: { pm_content: null } },
    ]);
    assert.equal(url.endsWith('/commands'), true);
    assert.equal(JSON.parse(options.body).params.size, 4);
    brews++;
    return Response.json({ Message: 'Invalid brew parameters', Extra: { deviceId: 'private-device' } }, { status: 400 });
  });
  await diagnose(directory);
  assert.equal(brews, 0);
  await assert.rejects(diagnose(directory, '4'), /HTTP 400/);
  assert.equal(brews, 1);
  assert.ok(output.some(line => line.startsWith('RESPONSE 400 | type application/json | bytes ')));
  assert.ok(output.some(line => line.startsWith('REDACTED BODY ') && line.includes('Invalid brew parameters')));
  assert.equal(output.join('\n').includes('private-device'), false);
});
