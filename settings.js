'use strict';

// Public application configuration documented in the OAuth protocol reference.
// https://github.com/AdamSand10/homeassistant-keurig/pull/1
// Pinned reference: arketec/homeassistant-keurig-oauth@3af466915dd191d160ff3d0f0b5adcaddaedd215
// These identify Keurig's web application. User tokens live only in the session file.
module.exports = {
  clientId: 'kqRwx9GzIfhobyPbap2DvfSaWWGSNayu',
  subscriptionKey: '7a278473f01745d99c1b1c2692c5a110',
  redirect: 'https://www.keurig.com/authCallBack',
};
