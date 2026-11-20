'use strict';

const { version } = require('./package.json');
const plugin = 'homebridge-keurig';
const platformName = 'KeurigSmart';

class KeurigMatter {
  constructor(platform) {
    this.platform = platform;
    this.api = platform.api;
    this.cached = new Map();
    this.timers = new Set();
    this.power = new Map();
  }

  enabled() {
    return this.api.isMatterEnabled?.() === true && !this.api.isMatterExternalsOnly?.() &&
      !!this.api.matter && this.api.versionGreaterOrEqual?.('2.5.0') === true;
  }

  configure(accessory) { this.cached.set(accessory.UUID, accessory); }

  restoredState(id) {
    return [...this.cached.values()].filter(accessory => accessory.context?.deviceId === id)
      .map(accessory => accessory.context.brewState).filter(Boolean)
      .sort((a, b) => (b.nextBrew || 0) - (a.nextBrew || 0))[0];
  }

  async persist(accessory) {
    if (!this.enabled()) return;
    const records = [...this.cached.values()].filter(record => record.context?.deviceId === accessory.context.deviceId);
    for (const record of records) record.context.brewState = accessory.context;
    if (records.length) await this.api.matter.updatePlatformAccessories(records);
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  reset(uuid, accessory, control) {
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      if (this.platform.stopped || !this.enabled()) return;
      try {
        await this.api.matter.updateAccessoryState(uuid, 'onOff', { onOff: false });
        accessory.getServiceById?.(this.api.hap.Service.Switch, control.subtype)
          ?.updateCharacteristic(this.api.hap.Characteristic.On, false);
      } catch {
        this.platform.log.warn('Matter could not reset ' + control.name + '.');
      }
    }, 1000);
    timer.unref();
    this.timers.add(timer);
  }

  accessory(record, control) {
    const { device, accessory } = record;
    const matter = this.api.matter;
    const uuid = matter.uuid.generate(plugin + ':matter:' + device.id + ':' + control.subtype);
    const run = async on => {
      if (control.mode !== 'power' && !on) return;
      try {
        await this.platform.executeControl(accessory, device.id, control, on);
        if (control.mode === 'power') this.power.set(device.id, on);
      } catch {
        const Failure = matter.status?.Failure;
        throw Failure ? new Failure('Keurig command failed. Check the Homebridge log.')
          : new Error('Keurig command failed. Check the Homebridge log.');
      } finally {
        if (control.mode !== 'power') this.reset(uuid, accessory, control);
      }
    };
    return {
      UUID: uuid,
      displayName: matterLabel(accessory.displayName, control.name),
      // A controllable plug-in unit, as used by the Tempur-Pedic plugin.
      // Matter OnOffSwitch represents an input controller, not a controllable load.
      deviceType: matter.deviceTypes.OnOffOutlet,
      serialNumber: uuid,
      manufacturer: 'Keurig', model: String(device.model || 'SMART'), firmwareRevision: version,
      context: { deviceId: device.id, subtype: control.subtype, brewState: accessory.context },
      clusters: { onOff: { onOff: control.mode === 'power' ? (this.power.get(device.id) || false) : false } },
      handlers: { onOff: {
        on: () => run(true), off: () => run(false),
        toggle: () => run(control.mode === 'power' ? !this.power.get(device.id) : true),
      } },
      _associatedPlugin: plugin, _associatedPlatform: platformName,
    };
  }

  async sync(records) {
    if (!this.enabled()) {
      if (!this.warned && this.api.isMatterEnabled?.() && !this.api.isMatterExternalsOnly?.() &&
          !this.api.versionGreaterOrEqual?.('2.5.0')) {
        this.warned = true;
        this.platform.log.warn('Keurig Matter requires Homebridge 2.5.0 or later.');
      }
      return;
    }
    const matter = this.api.matter;
    const desired = records.flatMap(record => record.controls.map(control => this.accessory(record, control)));
    const signature = JSON.stringify(desired.map(record => [record.UUID, record.displayName, record.model]));
    if (signature !== this.signature) {
      const wanted = new Set(desired.map(record => record.UUID));
      const stale = [...this.cached.values()].filter(record => !wanted.has(record.UUID));
      if (stale.length) await matter.unregisterPlatformAccessories(plugin, platformName, stale);
      // Register cached definitions too so Homebridge can restore their command handlers.
      if (desired.length) await matter.registerPlatformAccessories(plugin, platformName, desired);
      this.cached = new Map(desired.map(record => [record.UUID, record]));
      this.signature = signature;
      this.platform.log.info('Published ' + desired.length + ' selected Matter controls.');
    }
    // Reset momentary states restored from cache and publish polled power state.
    for (const record of records) {
      if (record.state) this.power.set(record.device.id, record.state.on);
    }
    for (const accessory of this.cached.values()) {
      const power = accessory.context.subtype === 'power';
      await matter.updateAccessoryState(accessory.UUID, 'onOff', {
        onOff: power ? (this.power.get(accessory.context.deviceId) || false) : false,
      });
    }
  }
}

function matterLabel(brewer, control) {
  const label = control.replace('Brew Over Ice Enhanced ', 'Over Ice Enhanced ')
    .replace('Dispense ', '').slice(0, 32);
  const prefix = brewer.slice(0, Math.max(0, 31 - label.length)).trimEnd();
  return prefix ? prefix + ' ' + label : label;
}

module.exports = { KeurigMatter };
