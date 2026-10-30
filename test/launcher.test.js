'use strict';
// The user-facing launcher (bin/auren.js): clear refusals, no stray side effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bin = path.join(__dirname, '..', 'bin', 'auren.js');
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 20000 });

test('help and version work without any setup', () => {
  assert.match(run('help').stdout, /auren join <mainnet\|testnet\|devnet>/);
  assert.match(run('version').stdout, /^\d+\.\d+\.\d+/);
  assert.match(run('help').stdout, /one mainnet, one testnet and one devnet/);
});

test('joining mainnet is refused clearly (it has not launched)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-launch-'));
  const r = run('join', 'mainnet', '--home', home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has not been launched/);
  assert.equal(fs.readdirSync(home).length, 0, 'nothing was created');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an unknown network name is refused and the choices are listed', () => {
  const r = run('join', 'myownnet');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mainnet, testnet, devnet|devnet, testnet, mainnet|testnet/);
});

test('status reports "not running" (exit 1) when no node is listening', () => {
  const r = run('status', '--network', 'testnet', '--home', path.join(os.tmpdir(), 'auren-none'), '--port', '59999');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not running/);
});

test('shipped files: launchers, installers and the user guide exist', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['auren', 'auren.cmd', 'install/windows/Run-AUREN-Node.cmd', 'install/windows/Install-AUREN.ps1', 'install/android/termux-setup.sh', 'website/run-a-node.html', 'docs/RUN-A-NODE.md', 'docs/GETTING-STARTED.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
});
