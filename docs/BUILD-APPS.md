# Build the apps yourself

Downloads are on the [releases page](https://github.com/3289david/auren/releases/latest). To build them from source:

```bash
node scripts/package.js        # auren-<version>.zip and .tar.gz (needs only Node.js to run)
node scripts/build-exe.js      # AUREN-Node / Wallet / Miner .exe (build on the target OS)
node android/build.js          # AUREN-Node / Wallet / Miner .apk
node scripts/build-miner-mac.js  # AUREN-Miner-<version>-mac-arm64.tar.gz and -x64.tar.gz (any OS)
```

Outputs go to `dist/`. Nothing from npm ends up inside the apps.

## Windows (and Mac, Linux) single-file apps

`build-exe.js` uses Node's single executable support: it copies the `node` binary on your machine and injects the AUREN program into it.

- **AUREN-Node**: opens a window with Start and Stop, the network and the node's status. It opens no console window. (With arguments it still works as the `auren` command: `AUREN-Node.exe join testnet`, but then it has no terminal output because it is a windowed program; use the package and `node bin/auren.js` for terminal use.)
- **AUREN-Miner**: the same window plus earnings.
- **AUREN-Wallet**: opens the wallet in its own window with no console (Edge or Chrome app mode; your default browser otherwise). Closing the window quits the app. Keys are stored on your computer.

The first run unpacks the program into `%LOCALAPPDATA%\AUREN`. The files are not code-signed, so Windows SmartScreen may warn. Choose More info, then Run anyway. Needs network access once at build time to fetch the `postject` injector.

## Android apps

`android/build.js` uses only the Android SDK command-line tools (aapt2, javac, d8, zipalign, apksigner): no Gradle. It needs the JDK, the Android SDK (platform 34 and build-tools) and Python 3.

- **AUREN Wallet**: a WebView around the bundled wallet and explorer. The pages ship inside the app. Keys stay in the app's storage.
- **AUREN Node**: a full node. The app carries its own Node.js runtime for Android (arm64 and x86_64) as native libraries, so nothing else needs to be installed, and runs `auren join` as a foreground service.
- **AUREN Miner**: the same engine with a one-button screen that shows your earnings (tickets, random-draw wins, balance).

Both apps target Android 14 (API 34). The Node.js runtime is packaged as `lib*.so` files, the only place Android lets apps run programs from on every version, and the build patches library names so they fit. APKs are signed with a key generated on your machine (`dist/android/auren-release.jks`, never committed). Android asks you to allow installs from the source.

