'use strict';

const { KeurigCloud } = require('./cloud');

const plugin = 'homebridge-keurig';
const platform = 'KeurigSmart';

class KeurigPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = new Map();
    this.cloud = new KeurigCloud(api.user.storagePath(), config);
    api.on('didFinishLaunching', () => {
      this.poll();
    });
    api.on('shutdown', () => { this.stopped = true; clearTimeout(this.timer); });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
    if (accessory.context.deviceId) this.bind(accessory, accessory.context.deviceId);
  }

  bind(accessory, id) {
    const { Service, Characteristic } = this.api.hap;
    const power = accessory.getServiceById(Service.Switch, 'power') ||
      accessory.addService(Service.Switch, accessory.displayName, 'power');
    power.getCharacteristic(Characteristic.On)
      .onGet(async () => (await this.cloud.state(id)).on)
      .onSet(async on => { await this.cloud.command(id, on ? 'idle' : 'standby'); });

    let brew = accessory.getServiceById(Service.Switch, 'brew');
    if (!this.config.enableBrew) {
      if (brew) accessory.removeService(brew);
      return;
    }
    brew ??= accessory.addService(Service.Switch, 'Brew Coffee', 'brew');
    // Block duplicate writes during preflight, command submission and acceptance.
    let pending = false;
    let nextBrew = 0;
    brew.getCharacteristic(Characteristic.On).onGet(() => false).onSet(async on => {
      if (!on) return;
      if (pending || Date.now() < nextBrew) throw new Error('A brew was recently requested.');
      pending = true;
      try {
        if (!(await this.cloud.state(id)).ready) throw new Error('The brewer must be ready with a fresh pod loaded.');
        nextBrew = Date.now() + 60000;
        await this.cloud.command(id, 'brew', { size: 8, brew_type: 'NORMAL', flow_rate: 4435, temp: 194,
          enhanced: true, category: 'CUSTOM' });
      } finally {
        pending = false;
        setTimeout(() => brew.updateCharacteristic(Characteristic.On, false), 150).unref();
      }
    });
  }

  async poll() {
    let failed = false;
    try {
      const devices = await this.cloud.devices();
      const seen = new Set();
      for (const device of devices) {
        if (this.stopped) return;
        const uuid = this.api.hap.uuid.generate(plugin + ':' + device.id);
        seen.add(uuid);
        let accessory = this.accessories.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(device.registration?.name || 'Keurig', uuid);
          accessory.context.deviceId = device.id;
          const { Service, Characteristic } = this.api.hap;
          accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Keurig')
            .setCharacteristic(Characteristic.Model, String(device.model || 'SMART'))
            .setCharacteristic(Characteristic.SerialNumber, String(device.serialNumber || device.id));
          this.bind(accessory, device.id);
          this.api.registerPlatformAccessories(plugin, platform, [accessory]);
          this.accessories.set(uuid, accessory);
        }
        const { Service, Characteristic } = this.api.hap;
        const power = accessory.getServiceById(Service.Switch, 'power');
        try {
          power.updateCharacteristic(Characteristic.On, (await this.cloud.state(device.id)).on);
        } catch (err) {
          power.updateCharacteristic(Characteristic.On, err);
          failed = true;
          this.log.warn('Keurig status: ' + err.message);
        }
      }
      for (const [uuid, accessory] of this.accessories) {
        if (!seen.has(uuid)) {
          this.api.unregisterPlatformAccessories(plugin, platform, [accessory]);
          this.accessories.delete(uuid);
        }
      }
    } catch (err) {
      failed = true;
      this.log.warn('Keurig discovery: ' + err.message);
    } finally {
      this.delay = failed ? Math.min((this.delay || 30000) * 2, 3600000) : 60000;
      if (!this.stopped) this.timer = setTimeout(() => this.poll(), this.delay);
    }
  }
}

module.exports = api => api.registerPlatform(plugin, platform, KeurigPlatform);
