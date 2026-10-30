#!/usr/bin/env node
'use strict';
// Generate reference docs from the source so they cannot drift: docs/parameters.md, docs/transactions.md.
// Run before build-docs: node scripts/gen-reference.js
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS } = require('../src/params');
const { TYPES } = require('../src/tx');
const { GOV_PARAMS } = require('../src/gov');

const docs = path.join(__dirname, '..', 'docs');
const AUR = 1000000000n;
const aur = (v) => { const b = BigInt(v); const w = b / AUR, f = (b % AUR).toString().padStart(9, '0').replace(/0+$/, ''); return (f ? `${w}.${f}` : `${w}`) + ' AUR'; };

// ---- parameters
const AMOUNTS = new Set(['minSelfStake', 'deposit', 'price', 'price3', 'price4', 'price5', 'bond']);
const WHAT = {
  addressPrefix: 'Address prefix of the network',
  minSelfStake: 'Smallest self-stake to become a validator',
  blockTimeMs: 'Target time between blocks',
  roundTimeoutMs: 'Time before consensus moves to the next round',
  blocksPerYear: 'Blocks in a year (used for issuance and name expiry)',
  maxValidators: 'Most validators in the active set',
  maxVotingPowerBps: 'Cap on one validator\'s share of voting power (basis points)',
  maxCommissionBps: 'Highest commission a validator may charge (basis points)',
  unbondingBlocks: 'Blocks before unstaked coins return',
  jailBlocks: 'Blocks a validator is paused after downtime',
  limits: 'Most resource units per block',
  initialBaseFee: 'Starting fee per resource unit, in sparks',
  minBaseFee: 'Lowest fee per resource unit, in sparks',
  baseFeeChangeDenominator: 'Fee moves by at most 1/N per block',
  issuance: 'New AUR per year (ppm of supply), decay per year, and floor',
  slashing: 'Penalties for double signing and downtime',
  security: 'Account protection limits',
  evmChainId: 'Chain ID for Ethereum tools',
  governance: 'Voting rules',
  domain: 'Name prices by length (3, 4, 5+ letters) and the longest registration',
  tld: 'Cost to create a name ending, and the most an ending owner may keep',
  node: 'Node rewards: bond, epoch length, share of issuance',
};
const fmt = (k, v) => {
  if (typeof v === 'object' && v !== null) return '';
  if (AMOUNTS.has(k)) return aur(v);
  return String(v);
};
const rows = [];
(function walk(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) { rows.push([key, '', WHAT[k] || '']); walk(v, key); } else rows.push([key, fmt(k, v), prefix ? '' : (WHAT[k] || '')]);
  }
})(DEFAULTS, '');
const govKeys = Object.keys(GOV_PARAMS || {});
fs.writeFileSync(path.join(docs, 'parameters.md'), `# Network parameters

Every setting of the network, with its default. A network's genesis file may override any of them; some can be changed later by a governance vote (see [Governance](governance.md)). This page is generated from the source (\`src/params.js\`), so it always matches the code.

Amounts shown in AUR are stored as sparks (1 AUR = 1,000,000,000 sparks). Fees are in sparks per resource unit.

| Parameter | Default | What it does |
|---|---|---|
${rows.map(([k, v, w]) => `| \`${k}\` | ${v ? '`' + v + '`' : ''} | ${w} |`).join('\n')}

## Changeable by governance

${govKeys.map((k) => `- \`${k}\``).join('\n') || '(none)'}

The devnet and testnet override some defaults (shorter epochs and lower bonds so they are easy to try); see \`src/netgen.js\`.
`);

// ---- transactions
const BODY = {
  transfer: '`to`, `amount`', delegate: '`validator`, `amount`', undelegate: '`validator`, `amount`', claim: '`validator`',
  createValidator: '`consPub`, `commissionBps`, `moniker`, `amount`', unjail: '(none)',
  registerNode: '`payout`', unregisterNode: '(none)', nodeProof: '`epoch`, `digest`',
  registerTld: '`tld`, `open`, `price`, `ownerShareBps`', setTldPolicy: '`tld`, `open`, `price`, `ownerShareBps`', transferTld: '`tld`, `newOwner`',
  registerDomain: '`name`, `years`', setDomainTarget: '`name`, `target`', transferDomain: '`name`, `newOwner`', setRecord: '`name`, `key`, `value`', setPrimary: '`name`',
  evm: '`to`, `data`, `value`, `gasLimit` (use the Ethereum RPC)', submitProposal: '`title`, `description`, `changes`', vote: '`id`, `option`',
  setSecurity: '`guardians`, `threshold`, `delayBlocks`, `dailyLimit`', securityCancel: '`account`', recoveryApprove: '`account`, `newPub`', recoveryCancel: '(none)',
};
const WHATTX = {
  transfer: 'Send AUR', delegate: 'Stake with a validator', undelegate: 'Start unstaking', claim: 'Collect staking rewards', createValidator: 'Become a validator', unjail: 'Return a paused validator',
  registerNode: 'Bond a node to earn node rewards', unregisterNode: 'Stop earning and unbond', nodeProof: 'Prove a node stores the chain this epoch',
  registerTld: 'Create a name ending', setTldPolicy: 'Change an ending\'s price or rules', transferTld: 'Hand an ending to someone else',
  registerDomain: 'Register a name', setDomainTarget: 'Point a name at an address', transferDomain: 'Give a name away', setRecord: 'Set a record on a name', setPrimary: 'Set your primary name',
  evm: 'Call or deploy a smart contract', submitProposal: 'Propose a network change', vote: 'Vote on a proposal',
  setSecurity: 'Set trusted helpers, delay and daily limit', securityCancel: 'Cancel a waiting security change', recoveryApprove: 'Help recover an account', recoveryCancel: 'Cancel a recovery',
};
const floor = (c) => ((BigInt(c.compute) * BigInt(DEFAULTS.minBaseFee.compute) + BigInt(c.state) * BigInt(DEFAULTS.minBaseFee.state)));
const txRows = Object.entries(TYPES).map(([k, v]) => {
  const dyn = typeof v.cost === 'function';
  return `| \`${k}\` | ${WHATTX[k] || ''} | ${BODY[k] || ''} | ${dyn ? 'by gas' : v.cost.compute.toLocaleString('en-US')} | ${dyn ? '' : v.cost.state.toLocaleString('en-US')} | ${dyn ? 'by gas' : (Number(floor(v.cost)) / 1e9).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} |`;
});
fs.writeFileSync(path.join(docs, 'transactions.md'), `# Transaction types

Every action on AUREN is a transaction of one of these types. Generated from the source (\`src/tx.js\`).

**Cost** has two parts, a compute cost and a state cost, each priced by its own fee level. The last column is the fee at the lowest fee level, in AUR. Fees are burned. How to build and sign one: [Integrate](integrate.md).

| Type | What it does | Body fields | Compute | State | Fee at the floor (AUR) |
|---|---|---|---:|---:|---:|
${txRows.join('\n')}

Common to every transaction: \`chainId\`, \`type\`, \`from\`, \`nonce\`, \`maxFee\`, \`tip\`, \`body\`, \`v\`, \`pub\`, \`sig\`.
`);

// ---- error codes
const CODES = {
  ALREADY_PROVEN: 'This node already proved storage this epoch', AMOUNT_TOO_SMALL: 'The amount rounds to nothing', BAD_BODY: 'A field in the transaction body is missing or invalid',
  BAD_FEE: 'Fee fields are invalid', BAD_FROM: 'The sender address is invalid', BAD_NONCE: 'The payment number is wrong (use pendingNonce)', BAD_PROOF: 'The storage proof does not match',
  BAD_PUB: 'The public key is invalid', BAD_RAW: 'The raw Ethereum transaction could not be read', BAD_SCHEME: 'Unknown signature type', BAD_SIGNATURE: 'The signature does not match',
  BAD_TX: 'The transaction is malformed', BAD_VERSION: 'Unsupported transaction version', CONSENSUS_KEY_IN_USE: 'That validator key is already used', DAILY_LIMIT_EXCEEDED: 'Over the account\'s daily limit',
  EXCEEDS_STAKE: 'You asked to unstake more than you have', FEE_TOO_LOW: 'maxFee is below the current fee', INSUFFICIENT_BALANCE: 'Not enough balance', INSUFFICIENT_BOND: 'Not enough to lock the node bond',
  INSUFFICIENT_DEPOSIT: 'The proposal deposit is too small', INSUFFICIENT_FEE_FUNDS: 'Not enough balance to pay the fee', INTRINSIC_GAS_TOO_LOW: 'Gas limit below the minimum for a contract call',
  MEMPOOL_FULL: 'The node is too busy; try again or another node', NAME_DOES_NOT_RESOLVE_TO_YOU: 'You can only make a primary name that points to you', NAME_NOT_FOUND: 'No such name',
  NAME_TAKEN: 'Someone already owns that name', NODE_EXISTS: 'This node is already registered', NODE_TOO_NEW: 'Bonded after the epoch began; earns from the next epoch', NONCE_TOO_HIGH: 'The payment number skips ahead',
  NONCE_TOO_LOW: 'The payment number was already used', NOT_AUTHORIZED: 'The signing key is not allowed to act for this account', NOT_A_NODE: 'This address is not a registered node', NOT_DELEGATED: 'You have no stake with that validator',
  NOT_GUARDIAN: 'Only a trusted helper can do this', NOT_JAILED: 'The validator is not paused', NOT_OWNER: 'Only the owner can do this', NO_PENDING_RECOVERY: 'There is no recovery in progress',
  NO_SECURITY_CONFIG: 'The account has no protection settings', NO_SUCH_PROPOSAL: 'No such proposal', NO_SUCH_VALIDATOR: 'No such validator', REPLACEMENT_UNDERPRICED: 'To replace a waiting payment, pay a higher tip',
  STAKE_BELOW_MINIMUM: 'Below the minimum validator stake', STILL_JAILED: 'The pause period has not ended', TLD_NOT_FOUND: 'That name ending does not exist', TLD_RESTRICTED: 'Only the owner can register under that ending',
  TLD_TAKEN: 'Someone already owns that ending', TOO_MANY_RECORDS: 'A name holds at most 16 records', UNKNOWN_TYPE: 'Unknown transaction type', VALIDATOR_EXISTS: 'That validator already exists',
  VALIDATOR_TOMBSTONED: 'The validator was banned for cheating', VOTING_CLOSED: 'Voting on this proposal has ended', WRONG_CHAIN: 'Signed for a different network', WRONG_EPOCH: 'That epoch is not the current one',
};
const used = new Set();
for (const f of fs.readdirSync(path.join(__dirname, '..', 'src'))) {
  const p = path.join(__dirname, '..', 'src', f);
  if (fs.statSync(p).isFile()) for (const m of fs.readFileSync(p, 'utf8').matchAll(/Tx(?:Fail|Invalid)\('([A-Z_]+)'/g)) used.add(m[1]);
}
const list = [...used].sort();
fs.writeFileSync(path.join(docs, 'errors.md'), `# Error codes

What the network says when something does not work. A transaction can be **rejected** before it is included (it never costs anything), or **fail** after inclusion (the fee is still charged). The wallet shows these in plain words; this page is for developers. Generated from the source.

| Code | Meaning |
|---|---|
${list.map((c) => `| \`${c}\` | ${CODES[c] || ''} |`).join('\n')}

How to see the code: \`aur_simulate\` returns \`code\` for a payment that would fail, and a confirmed transaction's \`receipt.code\` is \`OK\` or one of the above.
`);
console.log(`wrote parameters.md (${rows.length} rows), transactions.md (${txRows.length} types), errors.md (${list.length} codes)`);
