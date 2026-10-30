'use strict';
// Network generator: builds genesis files and ready-to-run validator homes for devnet and testnet.
// (Mainnet is assembled with scripts/genesis-ceremony.js from validator-submitted gentxs instead.)
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('./crypto');
const { pubToAddress } = require('./address');
const { AUR, canon, sha256hex } = require('./util');
const { validateGenesis } = require('./genesis');

const FIXED_DEVNET_TIME = 1767225600000; // 2026-01-01T00:00:00Z

const NETWORKS = {
  devnet: {
    chainId: 'auren-devnet-1', prefix: 'daur', minStake: 1000n, stake: 1000000n,
    params: {
      blockTimeMs: 1000, roundTimeoutMs: 3000, blocksPerYear: 31536000, maxValidators: 21,
      maxVotingPowerBps: 10000, unbondingBlocks: 60, jailBlocks: 30,
      slashing: { doubleSignBps: 500, downtimeBps: 10, downtimeWindow: 100, maxMissedBps: 5000 },
      evmChainId: 77001,
      security: { minDelayBlocks: 30, limitWindowBlocks: 60, maxGuardians: 9 },
      governance: { votingBlocks: 60, timelockBlocks: 20, deposit: (100n * AUR).toString(), quorumBps: 3340, thresholdBps: 5000, vetoBps: 3340 },
      domain: { maxYears: 10 },
      tld: { price: (100n * AUR).toString(), maxOwnerShareBps: 9000 },
    },
  },
  testnet: {
    chainId: 'auren-testnet-1', prefix: 'taur', minStake: 10000n, stake: 1000000n,
    params: {
      blockTimeMs: 2000, roundTimeoutMs: 4000, maxValidators: 100, maxVotingPowerBps: 10000,
      unbondingBlocks: 43200, jailBlocks: 1800,
      slashing: { doubleSignBps: 500, downtimeBps: 10, downtimeWindow: 1000, maxMissedBps: 5000 },
      evmChainId: 77002,
      security: { minDelayBlocks: 1800, limitWindowBlocks: 43200, maxGuardians: 9 },
      tld: { price: (1000n * AUR).toString(), maxOwnerShareBps: 9000 },
    },
  },
};

function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', mode ? { mode } : undefined);
}

/**
 * @param {object} o { network, validators, deterministic, genesisTime, outDir, homesDir, basePort }
 * @returns {{genesis, keys}} keys include operator/consensus/faucet/named accounts (secrets: keep private on testnet)
 */
function generate({ network, validators = 4, deterministic = false, genesisTime, outDir, homesDir, basePort = 9650, hosts = null }) {
  if (hosts) validators = hosts.length;
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network} (devnet|testnet)`);
  const kp = (label) => (deterministic ? Keypair.fromPassphrase(`auren/${network}/${label}`) : Keypair.generate());
  const addr = (k) => pubToAddress(k.pub, net.prefix);

  const named = {};
  for (const name of network === 'devnet' ? ['alice', 'bob', 'carol', 'dave', 'faucet'] : ['faucet', 'treasury']) named[name] = kp(`account/${name}`);
  const vals = Array.from({ length: validators }, (_, i) => ({ op: kp(`operator/${i}`), cons: kp(`consensus/${i}`), moniker: `${network}-validator-${i}` }));

  const accounts = [];
  const bal = (n) => (n * AUR).toString();
  for (const [name, k] of Object.entries(named)) accounts.push({ address: addr(k), balance: bal(name === 'faucet' ? 100000000n : name === 'treasury' ? 200000000n : 1000000n) });
  for (const v of vals) accounts.push({ address: addr(v.op), balance: bal(100000n) });
  accounts.sort((a, b) => (a.address < b.address ? -1 : 1));

  const genesis = {
    chainId: net.chainId, network,
    genesisTime: genesisTime ?? (deterministic ? FIXED_DEVNET_TIME : Date.now() + 5 * 60 * 1000),
    params: { addressPrefix: net.prefix, minSelfStake: bal(net.minStake), ...net.params },
    accounts,
    validators: vals.map((v) => ({ operator: addr(v.op), consPub: v.cons.pub, moniker: v.moniker, commissionBps: 500, selfStake: bal(net.stake) })),
  };
  validateGenesis(genesis);
  const hash = sha256hex(canon(genesis));

  if (outDir) {
    writeJson(path.join(outDir, 'genesis.json'), genesis);
    writeJson(path.join(outDir, 'network.json'), {
      chainId: net.chainId, network, addressPrefix: net.prefix, genesisHash: hash, genesisTime: genesis.genesisTime,
      validators: genesis.validators.map((v) => ({ operator: v.operator, moniker: v.moniker, consPub: v.consPub })),
    });
  }
  if (homesDir) {
    // hosts: ["1.2.3.4", "node2.example.org:9650", ...] -> real machines; otherwise local ports
    const hp = (i) => { if (!hosts) return { host: '127.0.0.1', port: basePort + i }; const [h, p] = hosts[i].split(':'); return { host: h, port: Number(p || basePort) }; };
    const urls = vals.map((_, i) => `http://${hp(i).host}:${hp(i).port}`);
    vals.forEach((v, i) => {
      const home = path.join(homesDir, `node${i}`);
      writeJson(path.join(home, 'genesis.json'), genesis);
      writeJson(path.join(home, 'priv_validator_key.json'), { seed: v.cons.seedHex, pub: v.cons.pub }, 0o600);
      writeJson(path.join(home, 'config.json'), {
        moniker: v.moniker, rpcHost: hosts ? '0.0.0.0' : process.env.AUREN_BIND || '127.0.0.1', rpcPort: hp(i).port, selfUrl: urls[i], operator: addr(v.op), peers: urls.filter((_, j) => j !== i),
      });
    });
    writeJson(path.join(homesDir, 'faucet.json'), { seed: named.faucet.seedHex }, 0o600);
    writeJson(path.join(homesDir, 'accounts.json'), {
      network, prefix: net.prefix,
      named: Object.fromEntries(Object.entries(named).map(([n, k]) => [n, { address: addr(k), seed: k.seedHex }])),
      operators: vals.map((v) => ({ moniker: v.moniker, address: addr(v.op), seed: v.op.seedHex })),
    }, 0o600);
  }
  return { genesis, hash, named, vals, prefix: net.prefix };
}

module.exports = { generate, NETWORKS };
