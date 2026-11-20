# homebridge-keurig

[![npm version](https://img.shields.io/npm/v/homebridge-keurig)](https://www.npmjs.com/package/homebridge-keurig)
[![npm weekly downloads](https://img.shields.io/npm/dw/homebridge-keurig)](https://www.npmjs.com/package/homebridge-keurig)

Control a Keurig SMART brewer from HomeKit and Matter. Connect your Keurig account in Homebridge and select the buttons you want to see.

## Requirements

- Node.js 22.12 or later and Homebridge 1.8 or later
- Homebridge 2.5 or later for Matter
- A Keurig account with a Wi-Fi brewer already registered in the Keurig app

## Installation and setup

1. Search for **homebridge-keurig** in Homebridge's **Plugins** page and install it.
2. Open **Settings** on the Keurig plugin card. If you already signed in, choose **Check connection & refresh favorites**. Otherwise, choose **Start sign-in** and follow the browser steps. Paste the Keurig callback URL into plugin settings and keep it private.
3. Check the controls you want. Options reflect your brewer model and include individual Keurig app favorites.
4. Save and restart the Keurig child bridge, or restart Homebridge if the plugin runs on the main bridge.

Before replacing a saved sign-in, stop the Keurig bridge so it cannot refresh the old session during sign-in.

## Controls

| Group | Options |
| --- | --- |
| Power | Power and Cancel Brew |
| Coffee | 4, 6, 8, 10 and 12 oz, using the temperature and strength selected in Settings |
| Shots | 2 and 4 oz on K-Café SMART K27 and K27C |
| Over Ice | 6 oz, plus Enhanced 8, 10 and 12 oz on supported models |
| Hot Water | Model-specific sizes, starting at 6 oz on K27 and K28 |
| BrewID | Recommended recipes by size, when the brewer reports a pod recipe |
| App Favorites | One checkbox for each compatible favorite saved in the Keurig app |

A new setup starts with Power selected. Existing installations continue using their legacy selections until you customize them. Brew controls support K27/K27C, K28/K28C/K28B, and K29/K29C. Frother commands remain unverified.

## Matter

On Homebridge 2.5 or later, enable Matter in the Keurig child bridge settings, restart it, and pair using its Matter QR code. Each selected control appears as a named on/off outlet. Brew buttons reset after use. HomeKit and Matter share the readiness checks and duplicate protection.

See [Homebridge's pairing guide](https://github.com/homebridge/homebridge/wiki/Connecting-Homebridge-To-HomeKit) for bridge setup. To avoid duplicate tiles in the same controller, pair it using one transport.

## Manual configuration

This example exposes Power, 8 oz coffee, and 6 oz hot water. The legacy key **brew** keeps the identity of the existing 8 oz switch.

~~~json
{
  "platforms": [
    {
      "platform": "KeurigSmart",
      "name": "Keurig",
      "enableHomeKit": true,
      "enableMatter": true,
      "brewTemperature": "Hot",
      "brewStrength": "Balanced",
      "controls": { "power": true, "brew": true, "water-6": true }
    }
  ]
}
~~~

## Troubleshooting

- **Hot water still reports an unknown pod.** Remove the pod, close the handle, and wait for the brewer to report ready. If the plugin still cannot confirm an empty holder, it blocks dispensing. Start with 6 oz on K27.
- **The log shows PM_NOT_CYCLED.** Open the handle, prepare or replace the pod, and close the handle. Wait 10 seconds from the first failure before trying the same preset again.
- **Did it send a brew?** Look for **Sending … command**, followed by **request accepted** and **brewer confirmed brewing**. A failed readiness check can wake the brewer, but sends no brew command.
- **Favorites are missing.** Save the favorite in the Keurig app, choose **Check connection & refresh favorites**, then select it and save.
- **Terminal sign-in.** Run the installed helper as the Homebridge service user with the directory containing Homebridge's config.json. This is typically /var/lib/homebridge on Linux or /homebridge in Docker.

~~~sh
homebridge-keurig-login /var/lib/homebridge
homebridge-keurig-diagnose /var/lib/homebridge
~~~

The diagnostic reads status by default. Adding **--brew 4** explicitly requests one 4 oz coffee. The plugin uses undocumented Keurig endpoints.

## Development

~~~sh
npm ci
npm test
npm pack
~~~

The cloud client, controls catalog, Matter publisher, and Homebridge settings UI live in separate modules. Tests use simulated Keurig responses.

See [CHANGELOG.md](CHANGELOG.md) for release notes.
