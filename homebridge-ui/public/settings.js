'use strict';

(() => {
  const ui = window.homebridge;
  let config;
  let catalog = [];
  let canEditControls = true;
  let queue = Promise.resolve();
  let pendingEdits = 0;
  const $ = id => document.getElementById(id);
  const notice = (message, failed = false) => {
    $('notice').className = 'alert ' + (failed ? 'alert-danger' : 'alert-info');
    $('notice').textContent = message;
  };
  const perform = async (button, work) => {
    button.disabled = true;
    try { await work(); }
    catch (error) { notice(error.message || 'The request failed.', true); }
    finally { button.disabled = false; }
  };
  function editConfig(edit) {
    pendingEdits++;
    ui.disableSaveButton();
    queue = queue.catch(() => {}).then(async () => {
      const blocks = await ui.getPluginConfig();
      const current = blocks.find(item => item.platform === 'KeurigSmart') || config;
      const next = { ...current, ...edit(current) };
      await ui.updatePluginConfig(blocks.includes(current) ? blocks.map(item => item === current ? next : item) : [...blocks, next]);
      config = next;
    }).finally(() => {
      if (--pendingEdits === 0) ui.enableSaveButton();
    });
    return queue;
  }
  function legacyEnabled(control, settings = config) {
    if (control.mode === 'power') return true;
    if (!settings.enableBrew || control.newControl) return false;
    if (control.mode === 'water') return !!settings.enableHotWater;
    if (control.mode === 'recommended') return !!settings.enableRecommended;
    if (control.mode === 'favorite') return settings.enableFavorites !== false;
    return true;
  }
  function renderControls() {
    $('controls').replaceChildren();
    const groups = new Map();
    for (const [index, control] of catalog.entries()) {
      if (!groups.has(control.group)) {
        const section = document.createElement('fieldset');
        section.className = 'mb-3';
        const title = document.createElement('legend');
        title.className = 'h6'; title.textContent = control.group;
        section.append(title); groups.set(control.group, section); $('controls').append(section);
      }
      const row = document.createElement('div'); row.className = 'form-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.className = 'form-check-input'; checkbox.id = 'control-' + index;
      checkbox.checked = config.controls ? config.controls[control.subtype] === true : legacyEnabled(control);
      checkbox.disabled = !canEditControls;
      checkbox.addEventListener('change', () => {
        const enabled = checkbox.checked;
        return perform(checkbox, async () => {
          try {
            await editConfig(current => {
              const selected = current.controls || Object.fromEntries(catalog.map(item => [item.subtype, legacyEnabled(item, current)]));
              return { controls: { ...selected, [control.subtype]: enabled } };
            });
          } catch (error) {
            checkbox.checked = config.controls ? config.controls[control.subtype] === true : legacyEnabled(control);
            throw error;
          }
        });
      });
      const label = document.createElement('label'); label.className = 'form-check-label';
      label.htmlFor = checkbox.id; label.textContent = control.name;
      row.append(checkbox, label); groups.get(control.group).append(row);
    }
  }
  async function discover() {
    const result = await ui.request('/discover');
    catalog = result.controls;
    canEditControls = !(result.favoritesUnavailable && !config.controls && config.enableBrew && config.enableFavorites !== false);
    $('brewer-summary').textContent = result.devices.length
      ? result.devices.map(device => device.name + ' (' + device.model + ')').join(', ')
      : 'No brewers were returned by this account.';
    renderControls();
    notice(!canEditControls ? 'Brewer connected. Refresh favorites before editing controls so your active favorites carry over.'
      : result.favoritesUnavailable ? 'Brewer connected. Favorites are temporarily unavailable. Your selections are saved.'
      : 'Connected. Choose your controls below, save, and restart the Keurig child bridge.');
  }
  $('start-login').addEventListener('click', () => perform($('start-login'), async () => {
    await queue;
    await ui.savePluginConfig();
    const result = await ui.request('/auth/start');
    $('login-link').href = result.url;
    $('login-flow').hidden = false;
    notice('Open the Keurig sign-in link and follow the callback steps below.');
  }));
  $('finish-login').addEventListener('click', () => perform($('finish-login'), async () => {
    const callback = $('callback').value;
    $('callback').value = '';
    await ui.request('/auth/finish', { callback });
    $('login-flow').hidden = true;
    notice('Sign-in saved. Checking your brewer…');
    await discover();
  }));
  $('check-connection').addEventListener('click', () => perform($('check-connection'), discover));
  (async () => {
    const blocks = await ui.getPluginConfig();
    config = blocks.find(item => item.platform === 'KeurigSmart');
    if (!config) {
      config = { platform: 'KeurigSmart', name: 'Keurig', controls: { power: true } };
      await ui.updatePluginConfig([...blocks, config]);
    }
    // The generated schema form can replace config fields absent from its layout.
    const { schema } = await ui.getPluginConfigSchema();
    for (const key of ['name', 'brewTemperature', 'brewStrength']) {
      const input = $(key);
      const field = schema.properties[key];
      for (const value of field.enum || []) input.add(new Option(value, value));
      input.value = config[key] || field.default;
      input.addEventListener('change', () => {
        const value = input.value.trim() || field.default;
        input.value = value;
        editConfig(() => ({ [key]: value })).catch(error => {
          input.value = config[key] || field.default;
          notice(error.message || 'The setting could not be updated.', true);
        });
      });
    }
    const status = await ui.request('/status');
    if (status.signedIn && !status.needsRefresh) await discover();
    else notice(status.signedIn ? 'Sign-in saved. Start the Keurig bridge to refresh the session, then check the connection.'
      : 'Start sign-in to connect your Keurig account.');
  })().catch(error => notice(error.message || 'Settings could not be loaded.', true));
})();
