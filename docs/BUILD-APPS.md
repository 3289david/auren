# Build the apps yourself

Downloads are on the [releases page](https://github.com/3289david/auren/releases/latest). To build them from source:

```bash
node scripts/package.js        # auren-<version>.zip and .tar.gz (needs only Node.js to run)
node scripts/build-exe.js      # AUREN-Node-<version>.exe and AUREN-Wallet-<version>.exe (build on the target OS)
node android/build.js          # AUREN-Node-<version>.apk and AUREN-Wallet-<version>.apk
```

Outputs go to `dist/`. Nothing from npm ends up inside the apps.

## Windows (and Mac, Linux) single-file apps

`build-exe.js` uses Node's single executable support: it copies the `node` binary on your machine and injects the AUREN program into it.

- **AUREN-Node**: double-click for a menu (join the testnet, earn AUR), or run it with arguments like the `auren` command: `AUREN-Node.exe join testnet --earn`.
- **AUREN-Wallet**: starts the wallet on `http://127.0.0.1:8787` and opens your browser. Keys are stored in the browser on your computer.

The first run unpacks the program into `%LOCALAPPDATA%\AUREN`. The files are not code-signed, so Windows SmartScreen may warn. Choose More info, then Run anyway. Needs network access once at build time to fetch the `postject` injector.

## Android apps

`android/build.js` uses only the Android SDK command-line tools (aapt2, javac, d8, zipalign, apksigner): no Gradle. It needs the JDK, the Android SDK (platform 34 and build-tools) and Python 3.

- **AUREN Wallet**: a WebView around the bundled wallet and explorer, served from `http://127.0.0.1:38787` inside the app. Keys stay in the app's storage.
- **AUREN Node**: bundles the Node.js runtime for Android (the Termux build, arm64 and x86_64) and runs `auren join` as a foreground service. Choose the network, turn on Earn, tap Start. It also opens the wallet and explorer served by the node. It needs a 64-bit phone.

The node app targets Android API 28 so that the bundled runtime may start from the app's private folder, as Termux does. APKs are signed with a key generated on your machine (`dist/android/auren-release.jks`, never committed). Android asks you to allow installs from the source.

Android phones cannot reach `127.0.0.1` on your PC. To join a devnet running on your computer, enter its LAN address (for example `http://192.168.1.20:9650`) as the peer.
