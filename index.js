'use strict';

const { KeurigCloud, sizes } = require('./cloud');

const plugin = 'homebridge-keurig';
const platform = 'KeurigSmart';

class KeurigPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = new Map();
    this.operations = new Map();
    this.blockedWrites = new Map();
    this.cloud = new KeurigCloud(api.user.storagePath(), config);
    api.on('didFinishLaunching', () => {
      log.info('Starting Keurig platform v' + require('./package.json').version + '. Session storage: ' + api.user.storagePath());
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
      accessory.addService(Service.Switch, 'Power', 'power');
    this.nameService(power, 'Power');
    power.getCharacteristic(Characteristic.On)
      .onGet(async () => (await this.cloud.state(id)).on)
      .onSet(async on => {
        try { await this.cloud.command(id, on ? 'idle' : 'standby'); }
        catch (err) {
          this.log.warn('Power failed: ' + err.message);
          throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    const presets = this.presets(accessory.context.favorites || [], accessory.context.model);
    const wanted = new Set(['power', ...presets.map(preset => preset.subtype)]);
    for (const service of [...accessory.services]) {
      if (service.UUID === Service.Switch.UUID && !wanted.has(service.subtype)) accessory.removeService(service);
    }
    for (const preset of presets) {
      const action = accessory.getServiceById(Service.Switch, preset.subtype) ||
        accessory.addService(Service.Switch, preset.name, preset.subtype);
      this.nameService(action, preset.name);
      action.getCharacteristic(Characteristic.On).onGet(() => false).onSet(async on => {
        if (!on) return;
        try {
          if (preset.mode === 'cancel') {
            try {
              await this.cloud.command(id, 'cancel_brew');
              this.log.info('Cancel brew requested.');
            } catch (err) {
              throw this.brewFailure(preset, err);
            }
            return;
          }
          await this.brew(accessory, id, preset);
        } finally {
          setTimeout(() => action.updateCharacteristic(Characteristic.On, false), 150).unref();
        }
      });
    }
  }

  brewFailure(preset, error) {
    this.log.warn(preset.name + ' failed: ' + error.message);
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  brew(accessory, id, preset) {
    const active = this.operations.get(id);
    // Repeated writes from one tap share the original result, including failures.
    if (active?.subtype === preset.subtype) return active.promise;
    const guarded = Date.now() < (accessory.context.nextBrew || 0);
    if (guarded && accessory.context.lastBrewAccepted && accessory.context.lastBrewPreset === preset.subtype &&
        Date.now() < (accessory.context.lastBrewAcceptedAt || 0) + 2000) {
      return Promise.resolve();
    }
    if (active || guarded) {
      const guard = active || accessory.context.nextBrew;
      let blocked = this.blockedWrites.get(id);
      if (!blocked || blocked.guard !== guard) {
        blocked = { guard, subtypes: new Set() };
        this.blockedWrites.set(id, blocked);
      }
      if (!blocked.subtypes.has(preset.subtype)) {
        this.log.warn(preset.name + ' ignored: ' + (accessory.context.lastBrewRejected
          ? 'The last request was rejected. Wait a moment before trying another preset.'
          : 'A brew was recently requested. Check the brewer before trying another preset.'));
        blocked.subtypes.add(preset.subtype);
      }
      return Promise.reject(new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
    this.blockedWrites.delete(id);
    const promise = this.performBrew(accessory, id, preset)
      .catch(error => { throw this.brewFailure(preset, error); })
      .finally(() => this.operations.delete(id));
    this.operations.set(id, { subtype: preset.subtype, promise });
    return promise;
  }

  async performBrew(accessory, id, preset) {
    let submitted = false;
    try {
      this.log.info('Requesting ' + preset.name + ' on ' + accessory.displayName);
      await this.cloud.startBrew(id, preset, async state => {
        if (state.pod === 'UNKNOWN') {
          this.log.info(preset.name + ': pod recognition is unavailable. Brewer reports ready.');
        }
        accessory.context.nextBrew = Date.now() + 60000;
        accessory.context.lastBrewRejected = false;
        accessory.context.lastBrewAccepted = false;
        accessory.context.lastBrewPreset = preset.subtype;
        this.api.updatePlatformAccessories([accessory]);
        submitted = true;
      });
      accessory.context.lastBrewAccepted = true;
      accessory.context.lastBrewAcceptedAt = Date.now();
      this.api.updatePlatformAccessories([accessory]);
      this.log.info(preset.name + ': request accepted. Checking brewer state...');
      // Confirm in the background so HomeKit can acknowledge the momentary switch promptly.
      this.cloud.confirmBrew(id)
        .then(() => this.log.info(preset.name + ': brewer confirmed brewing.'))
        .catch(err => this.log.warn(preset.name + ': ' + err.message));
    } catch (err) {
      if (submitted && [400, 422].includes(err.status)) {
        // Keep a short debounce for repeated writes after a definite rejection.
        accessory.context.nextBrew = Date.now() + 2000;
        accessory.context.lastBrewRejected = true;
        this.api.updatePlatformAccessories([accessory]);
      }
      throw err;
    }
  }

  nameService(service, name) {
    const { Characteristic } = this.api.hap;
    service.displayName = name;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, name);
  }

  presets(favorites, model) {
    if (!this.config.enableBrew) return [];
    const temperature = this.config.brewTemperature || 'Hot';
    const strength = this.config.brewStrength || 'Balanced';
    const presets = sizes.map(size => ({
      subtype: size === 8 ? 'brew' : 'coffee-' + size,
      name: 'Brew ' + size + ' oz Coffee', size, mode: 'coffee', temperature, strength,
    }));
    presets.push({ subtype: 'iced', name: 'Brew Over Ice 6 oz', mode: 'iced' },
      { subtype: 'cancel', name: 'Cancel Brew', mode: 'cancel' });
    if (['K27', 'K27C'].includes(model)) {
      presets.push(...[2, 4].map(size => ({ subtype: 'shot-' + size,
        name: 'Brew ' + size + ' oz Shot', size, mode: 'shot' })));
    }
    if (this.config.enableRecommended) {
      presets.push(...sizes.map(size => ({ subtype: 'recommended-' + size,
        name: 'BrewID ' + size + ' oz Coffee', size, mode: 'recommended' })));
    }
    if (this.config.enableHotWater) {
      presets.push(...sizes.map(size => ({ subtype: 'water-' + size,
        name: 'Dispense ' + size + ' oz Hot Water', size, mode: 'water', temperature })));
    }
    if (this.config.enableFavorites !== false) {
      presets.push(...favorites.map(favorite => ({ subtype: 'favorite-' + favorite.id,
        name: 'Brew ' + (favorite.name || 'Favorite'), mode: 'favorite', favoriteId: favorite.id })));
    }
    return presets;
  }

  async poll() {
    let failed = false;
    try {
      const devices = await this.cloud.devices();
      let favorites;
      if (this.config.enableBrew && this.config.enableFavorites !== false) {
        try { favorites = (await this.cloud.favorites()).map(({ id, name, deviceModel }) => ({ id, name, deviceModel })); }
        catch (err) { this.log.warn('Keurig favorites: ' + err.message); }
      }
      const seen = new Set();
      for (const device of devices) {
        if (this.stopped) return;
        const uuid = this.api.hap.uuid.generate(plugin + ':' + device.id);
        const deviceFavorites = favorites?.filter(favorite => !favorite.deviceModel || favorite.deviceModel === device.model);
        seen.add(uuid);
        let accessory = this.accessories.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(device.registration?.name || 'Keurig', uuid);
          accessory.context.deviceId = device.id;
          accessory.context.model = device.model;
          const { Service, Characteristic } = this.api.hap;
          accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Keurig')
            .setCharacteristic(Characteristic.Model, String(device.model || 'SMART'))
            .setCharacteristic(Characteristic.SerialNumber, String(device.serialNumber || device.id));
          accessory.context.favorites = deviceFavorites || [];
          this.bind(accessory, device.id);
          this.api.registerPlatformAccessories(plugin, platform, [accessory]);
          this.accessories.set(uuid, accessory);
          this.log.info('Discovered ' + accessory.displayName + '. Published Power and configured brew presets.');
        } else if (accessory.context.model !== device.model ||
            (deviceFavorites && JSON.stringify(deviceFavorites) !== JSON.stringify(accessory.context.favorites))) {
          accessory.context.model = device.model;
          if (deviceFavorites) accessory.context.favorites = deviceFavorites;
          this.bind(accessory, device.id);
          this.api.updatePlatformAccessories([accessory]);
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
