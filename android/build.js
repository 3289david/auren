#!/usr/bin/env node
'use strict';
// Build the Android apps with the plain Android SDK command-line tools (no Gradle, no npm):
//   dist/android/AUREN-Wallet-<version>.apk   the wallet and explorer
//   dist/android/AUREN-Node-<version>.apk     a full node (bundled Node.js runtime) with the wallet and explorer
//
// Needs: JDK 17+, the Android SDK (platform android-34 and build-tools), Python 3 (to fetch the Node.js runtime).
// Usage: node android/build.js [wallet|node|all]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const version = require('../src/node').VERSION;
const win = process.platform === 'win32';
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(win ? process.env.LOCALAPPDATA : os.homedir(), win ? 'Android/Sdk' : 'Android/Sdk');
const newest = (d) => fs.readdirSync(d).filter((n) => /^[\d.]+$/.test(n) || /^android-\d+$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const bt = path.join(sdk, 'build-tools', newest(path.join(sdk, 'build-tools')));
const platDirs = fs.readdirSync(path.join(sdk, 'platforms')).filter((n) => /^android-\d+$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const androidJar = path.join(sdk, 'platforms', platDirs.includes('android-34') ? 'android-34' : platDirs[platDirs.length - 1], 'android.jar');
const tool = (n) => path.join(bt, n + (win ? (n === 'd8' || n === 'apksigner' ? '.bat' : '.exe') : ''));
const only = process.argv[2] || 'all';
const out = path.join(root, 'dist', 'android');
// The Android tools mishandle non-ASCII paths on Windows, so everything is built in the temp folder.
const work = path.join(os.tmpdir(), 'auren-android-build');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: win && /\.bat$/.test(cmd), ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed (${r.status})`);
}
const copyTree = (from, to, skip = () => false) => {
  if (!fs.existsSync(from) || skip(from)) return;
  if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) copyTree(path.join(from, n), path.join(to, n), skip); } else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
};
const skipDev = (p) => /(^|[\\/])(_private|downloads|node_modules|\.devnet)([\\/]|$)/.test(p);
const zip = (dir, file) => run('jar', ['--create', '--no-manifest', '--file', file, '-C', dir, '.']);

function manifest(flavor, pkg, label) {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}" android:versionCode="${version.split('.').reduce((a, n) => a * 100 + Number(n), 0)}" android:versionName="${version}">
  <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="28"/>
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
  <uses-permission android:name="android.permission.WAKE_LOCK"/>
  <application android:label="${label}" android:icon="@mipmap/ic_launcher" android:usesCleartextTraffic="true" android:allowBackup="false" android:largeHeap="true">
    <meta-data android:name="auren.mode" android:value="${flavor}"/>
    <activity android:name="app.auren.MainActivity" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden">
      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
    </activity>
    <activity android:name="app.auren.ViewActivity" android:exported="false" android:configChanges="orientation|screenSize|keyboardHidden"/>
    <service android:name="app.auren.NodeService" android:exported="false"/>
  </application>
</manifest>
`;
}

function keystore() {
  const ks = path.join(out, 'auren-release.jks');
  if (!fs.existsSync(ks)) run('keytool', ['-genkeypair', '-keystore', ks, '-storepass', 'auren-build', '-keypass', 'auren-build', '-alias', 'auren', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=AUREN, O=AUREN']);
  return ks;
}

function build(flavor) {
  const pkg = flavor === 'wallet' ? 'app.auren.wallet' : 'app.auren.node';
  const label = flavor === 'wallet' ? 'AUREN Wallet' : 'AUREN Node';
  const dir = path.join(work, flavor);
  fs.rmSync(dir, { recursive: true, force: true });
  const assets = path.join(dir, 'assets'), classes = path.join(dir, 'classes'), dex = path.join(dir, 'dex');
  fs.mkdirSync(assets, { recursive: true }); fs.mkdirSync(classes, { recursive: true }); fs.mkdirSync(dex, { recursive: true });

  if (flavor === 'wallet') {
    // aapt2 on Windows stores nested asset paths with backslashes, so the site is bundled flat as web_<file>
    for (const n of fs.readdirSync(path.join(root, 'website'))) if (fs.statSync(path.join(root, 'website', n)).isFile()) fs.copyFileSync(path.join(root, 'website', n), path.join(assets, 'web_' + n));
    fs.copyFileSync(path.join(root, 'networks', 'networks.json'), path.join(assets, 'networks.json'));
  } else {
    const app = path.join(dir, 'app');
    for (const r of ['bin', 'src', 'website', 'networks/networks.json', 'networks/devnet', 'networks/testnet/genesis.json', 'networks/testnet/network.json', 'networks/mainnet', 'package.json']) copyTree(path.join(root, r), path.join(app, r), skipDev);
    zip(app, path.join(assets, 'auren.zip'));
    for (const [arch, abi] of [['aarch64', 'arm64-v8a'], ['x86_64', 'x86_64']]) {
      const rt = path.join(work, 'runtime-' + abi);
      if (!fs.existsSync(path.join(rt, 'bin', 'node'))) run(process.env.PYTHON || (win ? 'python' : 'python3'), ['-I', path.join(__dirname, 'fetch_runtime.py'), arch, rt]);
      zip(rt, path.join(assets, `runtime-${abi}.zip`));
    }
  }

  fs.writeFileSync(path.join(dir, 'AndroidManifest.xml'), manifest(flavor, pkg, label));
  const flat = path.join(dir, 'res.zip');
  const resDir = path.join(dir, 'res-src'); copyTree(path.join(__dirname, 'res'), resDir);
  run(tool('aapt2'), ['compile', '--dir', resDir, '-o', flat]);
  const base = path.join(dir, 'base.apk');
  run(tool('aapt2'), ['link', '-o', base, '-I', androidJar, '--manifest', path.join(dir, 'AndroidManifest.xml'), '-A', assets, flat, '--min-sdk-version', '24', '--target-sdk-version', '28']);

  const srcDir = path.join(dir, 'src'); copyTree(path.join(__dirname, 'src'), srcDir);
  const srcs = []; (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.java') && srcs.push(p); } })(srcDir);
  run('javac', ['-source', '11', '-target', '11', '-Xlint:-options', '-classpath', androidJar, '-d', classes, ...srcs]);
  const cls = []; (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : cls.push(p); } })(classes);
  run(tool('d8'), ['--release', '--min-api', '24', '--lib', androidJar, '--output', dex, ...cls]);
  run(tool('aapt'), ['add', base, 'classes.dex'], { cwd: dex });

  const aligned = path.join(dir, 'aligned.apk');
  run(tool('zipalign'), ['-f', '-p', '4', base, aligned]);
  const finalName = `AUREN-${flavor === 'wallet' ? 'Wallet' : 'Node'}-${version}.apk`;
  const tmpFinal = path.join(dir, finalName);
  const final = path.join(out, `AUREN-${flavor === 'wallet' ? 'Wallet' : 'Node'}-${version}.apk`);
  run(tool('apksigner'), ['sign', '--ks', keystore(), '--ks-pass', 'pass:auren-build', '--key-pass', 'pass:auren-build', '--ks-key-alias', 'auren', '--out', tmpFinal, aligned]);
  run(tool('apksigner'), ['verify', tmpFinal]);
  fs.copyFileSync(tmpFinal, final);
  console.log(`${path.basename(final)}  ${(fs.statSync(final).size / 1048576).toFixed(1)} MB`);
}

fs.mkdirSync(out, { recursive: true });
for (const f of only === 'all' ? ['wallet', 'node'] : [only]) build(f);
