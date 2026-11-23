'use strict';

const { KeurigCloud } = require('./cloud');
const { enabledControls } = require('./controls');
const { KeurigMatter } = require('./matter');

const plugin = 'homebridge-keurig';
const platform = 'KeurigSmart';

class KeurigPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = new Map();
    this.deviceAccessories = new Map();
    this.powerStates = new Map();
    this.matter = new KeurigMatter(this);
    this.operations = new Map();
    this.blockedWrites = new Map();
    this.preparationFailures = new Map();
    this.cloud = new KeurigCloud(api.user.storagePath(), config);
    api.on('didFinishLaunching', () => {
      log.info('Starting Keurig platform v' + require('./package.json').version + '. Session storage: ' + api.user.storagePath());
      this.poll();
    });
    api.on('shutdown', () => { this.stopped = true; clearTimeout(this.timer); this.matter.stop(); });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
    if (accessory.context.deviceId) {
      accessory.context.model ||= accessory.getService(this.api.hap.Service.AccessoryInformation)
        ?.getCharacteristic(this.api.hap.Characteristic.Model).value;
      this.deviceAccessories.set(accessory.context.deviceId, accessory);
      if (accessory.context.model) {
        this.cloud.models.set(accessory.context.deviceId, accessory.context.model);
        this.bind(accessory, accessory.context.deviceId);
      }
    }
  }

  configureMatterAccessory(accessory) { this.matter.configure(accessory); }

  powerOn(id) { return this.powerStates.get(id)?.on ?? false; }

  bind(accessory, id) {
    const { Service, Characteristic } = this.api.hap;
    const controls = enabledControls(this.config, accessory.context.model, accessory.context.favorites || []);
    const wanted = new Set(controls.map(control => control.subtype));
    for (const service of [...accessory.services]) {
      if (service.UUID === Service.Switch.UUID && !wanted.has(service.subtype)) accessory.removeService(service);
    }
    for (const control of controls) {
      const action = accessory.getServiceById(Service.Switch, control.subtype) ||
        accessory.addService(Service.Switch, control.name, control.subtype);
      this.nameService(action, control.name);
      action.getCharacteristic(Characteristic.On)
        .onGet(control.mode === 'power' ? () => this.powerOn(id) : () => false)
        .onSet(async on => {
          if (control.mode !== 'power' && !on) return;
          try { await this.executeControl(accessory, id, control, on); }
          finally {
            if (control.mode !== 'power') {
              setTimeout(() => action.updateCharacteristic(Characteristic.On, false), 150).unref();
            }
          }
        });
    }
  }

  async executeControl(accessory, id, control, on = true) {
    if (control.mode === 'power' || control.mode === 'cancel') {
      try {
        await this.cloud.command(id, control.mode === 'cancel' ? 'cancel_brew' : on ? 'idle' : 'standby');
        if (control.mode === 'cancel') this.log.info('Cancel brew requested.');
        else {
          this.powerStates.set(id, { on });
          accessory.getServiceById?.(this.api.hap.Service.Switch, 'power')
            ?.updateCharacteristic(this.api.hap.Characteristic.On, on);
        }
      } catch (error) { throw this.brewFailure(control, error); }
      return;
    }
    return this.brew(accessory, id, control);
  }

  async saveContext(accessory) {
    if (this.accessories.has(accessory.UUID)) this.api.updatePlatformAccessories([accessory]);
    await this.matter.persist(accessory);
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
    const previousFailure = this.preparationFailures.get(id);
    if (previousFailure?.subtype === preset.subtype && Date.now() < previousFailure.until) {
      return Promise.reject(previousFailure.error);
    }
    this.preparationFailures.delete(id);
    this.blockedWrites.delete(id);
    const operation = { subtype: preset.subtype, submitted: false };
    const promise = this.performBrew(accessory, id, preset, operation)
      .catch(error => {
        const failure = this.brewFailure(preset, error);
        if (!operation.submitted) {
          // Some controllers retry a failed write after its handler has finished.
          // Retain the failure briefly without retrying preparation or claiming success.
          this.preparationFailures.set(id, { subtype: preset.subtype, until: Date.now() + 10000, error: failure });
        }
        throw failure;
      })
      .finally(() => this.operations.delete(id));
    operation.promise = promise;
    this.operations.set(id, operation);
    return promise;
  }

  async performBrew(accessory, id, preset, operation) {
    try {
      this.log.info('Checking brewer readiness for ' + preset.name + ' on ' + accessory.displayName);
      await this.cloud.startBrew(id, preset, async state => {
        if (state.pod === 'UNKNOWN') {
          this.log.info(preset.name + ': pod recognition is unavailable. Brewer reports ready.');
        }
        accessory.context.nextBrew = Date.now() + 60000;
        accessory.context.lastBrewRejected = false;
        accessory.context.lastBrewAccepted = false;
        accessory.context.lastBrewPreset = preset.subtype;
        await this.saveContext(accessory);
        operation.submitted = true;
        this.log.info('Sending ' + preset.name + ' command to ' + accessory.displayName);
      });
      accessory.context.lastBrewAccepted = true;
      accessory.context.lastBrewAcceptedAt = Date.now();
      await this.saveContext(accessory).catch(() => this.log.warn('Could not save the accepted brew state.'));
      this.log.info(preset.name + ': request accepted. Checking brewer state...');
      // Confirm in the background so HomeKit can acknowledge the momentary switch promptly.
      this.cloud.confirmBrew(id)
        .then(() => this.log.info(preset.name + ': brewer confirmed brewing.'))
        .catch(err => this.log.warn(preset.name + ': ' + err.message));
    } catch (err) {
      if (operation.submitted && [400, 422].includes(err.status)) {
        // Keep a short debounce for repeated writes after a definite rejection.
        accessory.context.nextBrew = Date.now() + 2000;
        accessory.context.lastBrewRejected = true;
        await this.saveContext(accessory).catch(() => this.log.warn('Could not save the rejected brew state.'));
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

  async poll() {
    let failed = false;
    try {
      const devices = await this.cloud.devices();
      let favorites;
      const needsFavorites = this.config.controls
        ? Object.entries(this.config.controls).some(([key, enabled]) => key.startsWith('favorite-') && enabled === true)
        : this.config.enableBrew && this.config.enableFavorites !== false;
      if (needsFavorites) {
        try { favorites = (await this.cloud.favorites()).map(({ id, name, deviceModel }) => ({ id, name, deviceModel })); }
        catch (err) { this.log.warn('Keurig favorites: ' + err.message); }
      }
      const seen = new Set();
      const records = [];
      for (const device of devices) {
        if (this.stopped) return;
        seen.add(device.id);
        const uuid = this.api.hap.uuid.generate(plugin + ':' + device.id);
        let accessory = this.deviceAccessories.get(device.id) || this.accessories.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(device.registration?.name || 'Keurig', uuid);
          accessory.context = { ...(this.matter.restoredState(device.id) || {}), deviceId: device.id };
          this.deviceAccessories.set(device.id, accessory);
        }
        const restored = this.matter.restoredState(device.id);
        if ((restored?.nextBrew || 0) > (accessory.context.nextBrew || 0)) {
          accessory.context = { ...accessory.context, ...restored, deviceId: device.id };
        }
        const model = device.model || accessory.context.model;
        accessory.context.model = model;
        if (model) this.cloud.models.set(device.id, model);
        if (favorites) accessory.context.favorites = favorites.filter(favorite =>
          !favorite.deviceModel || favorite.deviceModel === model);
        accessory.context.favorites ||= [];
        const controls = enabledControls(this.config, model, accessory.context.favorites);
        const publishHap = this.api.isHapEnabled?.() !== false && !this.api.isHapExternalsOnly?.() && controls.length > 0;
        if (publishHap) {
          const { Service, Characteristic } = this.api.hap;
          accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Keurig')
            .setCharacteristic(Characteristic.Model, String(model || 'SMART'))
            .setCharacteristic(Characteristic.SerialNumber, String(device.serialNumber || device.id));
          this.bind(accessory, device.id);
          if (!this.accessories.has(uuid)) {
            this.api.registerPlatformAccessories(plugin, platform, [accessory]);
            this.accessories.set(uuid, accessory);
            this.log.info('Discovered ' + accessory.displayName + '. Published ' + controls.length + ' selected HomeKit controls.');
          } else this.api.updatePlatformAccessories([accessory]);
        } else if (this.accessories.has(uuid)) {
          this.api.unregisterPlatformAccessories(plugin, platform, [accessory]);
          this.accessories.delete(uuid);
        }
        const record = { device: { ...device, model }, accessory, controls };
        try {
          const previousPower = this.powerStates.get(device.id);
          const { on } = await this.cloud.state(device.id);
          // An acknowledged power write takes precedence over a poll already in flight.
          if (this.powerStates.get(device.id) === previousPower) this.powerStates.set(device.id, { on });
          if (publishHap) accessory.getServiceById(this.api.hap.Service.Switch, 'power')
            ?.updateCharacteristic(this.api.hap.Characteristic.On, this.powerOn(device.id));
        } catch (err) {
          failed = true;
          this.log.warn('Keurig status: ' + err.message);
        }
        records.push(record);
      }
      for (const [id, accessory] of this.deviceAccessories) {
        if (!seen.has(id)) {
          if (this.accessories.has(accessory.UUID)) {
            this.api.unregisterPlatformAccessories(plugin, platform, [accessory]);
            this.accessories.delete(accessory.UUID);
          }
          this.deviceAccessories.delete(id);
          this.powerStates.delete(id);
          this.preparationFailures.delete(id);
        }
      }
      if (!this.stopped) await this.matter.sync(records);
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
