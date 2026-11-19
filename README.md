# Homebridge for Keurig SMART

Experimental Homebridge platform for Keurig SMART brewers, including the K-Café SMART. It exposes a named Power switch and polls reported state every minute. A K-Café SMART user has verified sign-in, discovery, and power control. Brew presets still need live verification.

With **Expose coffee sizes, Over Ice and Cancel Brew** enabled, the plugin adds momentary switches for **Brew 4 / 6 / 8 / 10 / 12 oz Coffee**, **Brew Over Ice 6 oz**, and **Cancel Brew**. Coffee size presets use the configured temperature and strength (Hot and Balanced by default). Keurig app favorites appear as **Brew [favorite name]** and use each favorite's saved size, temperature and strength. Create favorites in the Keurig app for additional combinations. Favorites refresh every minute.

Optional settings expose **BrewID** recommended recipes for each size and **Hot Water** sizes. BrewID requires a recognized pod recipe for that size. Hot water requires an empty pod holder. K-Café shot and frother command formats still need protocol verification.

The existing 8 oz service is retained when upgrading, with its name set to Brew 8 oz Coffee. Apple Home may retain a user-assigned label. Within the accessory settings, choose **Show as Separate Tiles** if you want each switch displayed individually.

Brew actions check the machine's ready state and its reported locks and errors. Coffee requires a loaded pod when Keurig reports occupancy. Some K-Café SMART responses have a null pod-recognition field even with a pod loaded. The plugin displays that as UNKNOWN and permits a coffee request when the brewer reports BREW_READY with no lock or error, following the community client's behavior. An explicit EMPTY reading blocks coffee. Hot water requires an explicit EMPTY reading.

A request wakes a sleeping brewer and briefly waits for readiness. If preparation or warming takes longer, power the brewer on, prepare it, and try the brew preset again. A shared 60-second guard prevents another preset from duplicating a recent request. Logs distinguish requests accepted by the API from brewing observed afterward and include the machine's brew, pod, lock and error states when preparation fails.

API rejections include the returned validation message with credentials and identifiers redacted. An explicit HTTP 400 or 422 brew rejection uses a two-second debounce instead of the 60-second guard. Accepted requests and ambiguous failures such as timeouts retain the longer guard. This diagnostic change helps investigate model-specific brew rejections. A successful app brew alongside a plugin HTTP 400 still requires the detailed validation message to determine the command change.

Browser sign-in follows the [Home Assistant OAuth pull request](https://github.com/AdamSand10/homeassistant-keurig/pull/1) at revision 3af466915dd191d160ff3d0f0b5adcaddaedd215. Public web client settings come from that reference. You sign in to Keurig in your browser, then paste the callback URL into your local terminal. The plugin verifies its state and exchanges the code using PKCE. No separate OAuth registration is needed for this flow. Keurig's undocumented service may change.

## Test your account on this PC

Use Node.js 22.12 or newer. Open PowerShell in this project folder and run:

~~~powershell
npm run login -- .test-homebridge
~~~

1. Open browser developer tools with F12, select **Network**, and enable **Preserve log**.
2. Open the sign-in link printed in the terminal using that browser tab and sign in to Keurig.
3. In Network, find the request to **https://www.keurig.com/authCallBack** whose URL contains **code=**. Open the request's Headers and copy the complete **Request URL**. The website may redirect further or show an error. The Network tab keeps the callback request.
4. Paste the URL into the waiting terminal promptly. Treat the callback as private account data and keep it out of chat, screenshots, and issue reports.
5. A successful test prints the registered brewer's name, model and power state.

Toggle power in the Keurig app and run:

~~~powershell
npm run login -- .test-homebridge --check
~~~

The check reads brewer state using the saved session. It sends no appliance commands. Run it again after an hour to exercise automatic token refresh, then restart the command and confirm the session is retained.

## Install from npm on Docker / NAS

In Homebridge UI, search the Plugins page for **homebridge-keurig** and install it. If the package does not appear in search yet, open the Homebridge UI terminal and run:

~~~sh
npm --prefix /homebridge install homebridge-keurig
~~~

Then follow the sign-in steps below, starting with step 3. Use a Keurig child bridge for the first test. The storage path assumes the official Homebridge Docker image.

## Install a local package on Docker / NAS

These commands assume the official Homebridge Docker image with persistent storage mounted at **/homebridge**, as documented in the [Docker image setup](https://github.com/homebridge/docker-homebridge). Substitute the configured storage path for another image.

1. Copy **homebridge-keurig-0.2.2.tgz** from this project to the NAS folder mapped to **/homebridge** in your container. Use your NAS file manager or network share.
2. Open Homebridge UI on the other computer and choose **Terminal**. Confirm **/homebridge/config.json** exists, then install:

~~~sh
npm --prefix /homebridge install /homebridge/homebridge-keurig-0.2.2.tgz
~~~

3. Run sign-in in that terminal:

~~~sh
node /homebridge/node_modules/homebridge-keurig/login.js /homebridge
~~~

Open the printed link in a browser on this PC and follow the callback-copy steps above. Paste the callback into the waiting Homebridge terminal. The helper saves the session inside the container's persistent storage and prints brewer status.

4. Open the KeurigSmart plugin settings, set a name and click Save to add its platform entry. Leave enableBrew off, enable a child bridge, and restart it. Pair the child bridge in Apple Home using its QR code. Test power before enabling brewing.

To read state again from the terminal:

~~~sh
node /homebridge/node_modules/homebridge-keurig/login.js /homebridge --check
~~~

If reauthorizing an existing installation, stop its Keurig child bridge while the login command runs.

## Package and other Homebridge installations

Publishing to npm or GitHub is optional for testing. Build the package with:

~~~powershell
npm test
npm pack
~~~

Copy **homebridge-keurig-0.2.2.tgz** to the Homebridge host. From the folder containing that file, a standard Linux hb-service installation can install it with:

~~~sh
npm --prefix /var/lib/homebridge install ./homebridge-keurig-0.2.2.tgz
~~~

Use the service user's normal permissions. Docker and NAS installations should run the install inside the Homebridge container and use its plugin and storage paths. Windows installations should use their configured plugin directory.

Add the platform in Homebridge UI, or merge this entry into the existing platforms array in config.json:

~~~json
{
  "platform": "KeurigSmart",
  "name": "Keurig",
  "enableBrew": false
}
~~~

Stop the Keurig child bridge during sign-in. From a terminal on the host, run the installed login helper as the service user. For a standard Linux hb-service installation:

~~~sh
node /var/lib/homebridge/node_modules/homebridge-keurig/login.js /var/lib/homebridge
~~~

Open the displayed link on your PC and copy the callback from its browser back into the host terminal. The storage argument must point to the directory holding Homebridge's config.json. The helper saves keurig-session.json there. Alternatively, transfer your successfully tested session from .test-homebridge into that storage directory while the Keurig child bridge is stopped. Keep the session private to the service user. Run only one plugin instance against a session file because refresh tokens rotate.

Start the Keurig child bridge, add its bridge to Apple Home when prompted, and test power. Change power from the Keurig app and allow about 60 seconds for the Home tile to update. Once power and session persistence work, prepare water, a fresh pod, and a suitable mug, then enable the optional brew switch and try one brew. The plugin requires a ready brewer with a recognized loaded pod. Each brew request has a 60-second duplicate guard. API command failures are returned to HomeKit.

## Development and distribution

For a one-off HTTP 400 investigation, the development source includes a diagnostic command. It reads the existing Homebridge session without refreshing tokens. Its default mode reads status. Adding **--brew 4** explicitly requests one 4 oz coffee, with the normal readiness checks, and prints the response content type, byte count and redacted body if the request is rejected. Prepare a fresh pod and suitable mug before using that option. It sends no automatic retries and does not update the installed plugin.

~~~sh
npm exec --yes --package=github:dean1d/homebridge-keurig#main -- homebridge-keurig-diagnose /var/lib/homebridge --brew 4
~~~

The plugin has no runtime npm dependencies. npm test uses simulated Keurig responses. The package has been loaded against Homebridge 2.0.2 locally. Brew confirmation remains part of your acceptance test.

Source and issue reports belong at [dean1d/homebridge-keurig](https://github.com/dean1d/homebridge-keurig). The plugin is MIT licensed. The first npm release is experimental and still needs a live account and brewer acceptance test.

The earlier Python checker uses the retired password endpoint. Use the Node browser sign-in helper above.
