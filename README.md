# homebridge-keurig

<p align="center">
  <img src="assets/keuriglogo_0.jpg" alt="Keurig logo" width="180" />
</p>

[![npm version](https://img.shields.io/npm/v/homebridge-keurig)](https://www.npmjs.com/package/homebridge-keurig)
[![npm weekly downloads](https://img.shields.io/npm/dw/homebridge-keurig)](https://www.npmjs.com/package/homebridge-keurig)

Control a Keurig SMART brewer from HomeKit and Matter. Connect your Keurig account in Homebridge and select the buttons you want to see.

## Requirements

- Node.js 22.12 or later and Homebridge 1.8 or later
- Homebridge 2.5 or later for Matter
- A Keurig account with a Wi-Fi brewer already registered in the Keurig app

## Installation and setup

If your brewer has an accented **é** in its default name, rename it in the Keurig app before Homebridge discovers it. For example, change **K-Café SMART** to **K-Cafe SMART**. If you already added the brewer to a controller, you can rename its existing tile there.

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

## Apple Home and Matter

**For Apple Home, we recommend HomeKit (HAP).** HomeKit groups your selected controls under one brewer accessory, so your coffee, hot water, and power controls can stay together in a single tile.

**You can use HomeKit and Matter at the same time.** Keep the HomeKit pairing in Apple Home and enable Matter on the Keurig child bridge to share the same brewer with other Matter platforms. Matter requires Homebridge 2.5 or later. After enabling it, restart the child bridge and use its Matter QR code to pair with your other platform. Matter shows each selected control as a separate named on/off outlet. Brew buttons reset after use, and both transports share the same readiness checks and duplicate protection.

Manage both transports in the Homebridge bridge settings. Use one pairing method per controller to avoid duplicate tiles. [Homebridge pairing guide](https://github.com/homebridge/homebridge/wiki/Connecting-Homebridge-To-HomeKit)

## Manual configuration

This example exposes Power, 8 oz coffee, and 6 oz hot water. The legacy key **brew** keeps the identity of the existing 8 oz switch.

~~~json
{
  "platforms": [
    {
      "platform": "KeurigSmart",
      "name": "Keurig",
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

## Start over with a fresh sign-in

The saved Keurig session is separate from the plugin configuration and cached accessories. Uninstalling the plugin does not remove it.

1. Stop the Keurig child bridge, or stop Homebridge if the plugin runs on the main bridge. Close any open Keurig settings dialog.
2. In the Homebridge host terminal, delete the saved session from the directory containing Homebridge's config.json. For a standard Linux installation, run:

   ~~~sh
   rm -f -- /var/lib/homebridge/keurig-session.json
   ~~~

   For the official Docker image, use /homebridge/keurig-session.json. This clears the plugin's local sign-in.
3. If you also want to reset accessory choices and pairings, remove the Keurig platform entry and its cached accessories through Homebridge. Remove the Keurig child bridge from your HomeKit or Matter controller if you paired it there.
4. Reopen Keurig settings after reinstalling. It should offer **Start sign-in**. Use a private browser tab if you also want Keurig to prompt for credentials instead of using an existing browser session.

## Development

~~~sh
npm ci
npm test
npm pack
~~~

The cloud client, controls catalog, Matter publisher, and Homebridge settings UI live in separate modules. Tests use simulated Keurig responses.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Credits

- [AdamSand10](https://github.com/AdamSand10) for the [Home Assistant Keurig integration](https://github.com/AdamSand10/homeassistant-keurig), which served as a reference for communicating with the brewer.
- [arketec](https://github.com/arketec) for the [OAuth contribution](https://github.com/AdamSand10/homeassistant-keurig/pull/1) that informed this plugin's browser sign-in.

## Disclaimer

- This independent project is not affiliated with, endorsed by, or supported by Keurig or Keurig Dr Pepper.
- The plugin uses an undocumented Keurig cloud interface that can change without notice.
- Remote brewing dispenses hot liquid. Use a suitable cup, prepare the brewer before starting a brew, and follow Keurig's operating instructions.

## Support & Donations

This plugin is free and open source. If it saved you some time or frustration and you'd like to say thanks, any support is greatly appreciated!

<a href="https://buymeacoffee.com/dean1d" target="_blank">
  <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-dean1d-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" />
</a>

<a href="https://cash.app/$dkoenigBOA" target="_blank">
  <img src="https://img.shields.io/badge/Cash%20App-%24dkoenigBOA-00C244?style=for-the-badge&logo=cash-app&logoColor=white" alt="Cash App" />
</a>

<a href="https://venmo.com/u/Dean1d" target="_blank">
  <img src="https://img.shields.io/badge/Venmo-Dean1d-3D95CE?style=for-the-badge&logo=venmo&logoColor=white" alt="Venmo" />
</a>
