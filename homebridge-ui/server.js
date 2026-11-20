'use strict';

const { KeurigUiSession, safeUiError } = require('./session');

(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');
  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      const session = new KeurigUiSession(this.homebridgeStoragePath, this.homebridgeConfigPath);
      const route = (name, handler) => this.onRequest(name, async payload => {
        try { return await handler(payload); }
        catch (error) { throw new RequestError(safeUiError(error), {}); }
      });
      route('/status', () => session.status());
      route('/auth/start', () => session.begin());
      route('/auth/finish', payload => session.finish(payload.callback));
      route('/discover', () => session.discover());
      this.ready();
    }
  }
  new UiServer();
})().catch(() => { console.error('The Keurig settings server could not start.'); process.exitCode = 1; });
