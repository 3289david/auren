'use strict';
// Raw Ethereum transactions (legacy EIP-155, EIP-2930, EIP-1559) -> AUREN transaction envelope.
// The chain recomputes the envelope from the raw bytes and requires it to equal the submitted transaction, so
// nothing about a MetaMask-signed transaction can be altered without invalidating the signature.
const { keccak256 } = require('./keccak');
const rlp = require('./rlp');
const { recover, N } = require('./secp256k1');
const { pubToAddress } = require('../address');
const { TxInvalid } = require('../util');
const { WEI } = require('./host');

const big = (b) => rlp.bufToBig(b);
const hex = (b) => Buffer.from(b).toString('hex');

/** Parse and verify a raw transaction. Returns decoded fields and the recovered 64-byte public key (hex). */
function parseRaw(rawHex) {
  if (typeof rawHex !== 'string' || !/^(0x)?([0-9a-f]{2})+$/i.test(rawHex) || rawHex.length > 2 * 131072 + 1000) throw new TxInvalid('BAD_RAW', 'malformed raw transaction');
  const raw = Buffer.from(rawHex.replace(/^0x/i, ''), 'hex');
  const first = raw[0];
  let f, sigHashInput, type, chainId, nonce, maxPrio, maxFee, gasLimit, to, value, data, acl, v, r, s;
  const need = (n) => { if (!Array.isArray(f) || f.length !== n) throw new TxInvalid('BAD_RAW', 'wrong field count'); };
  try {
    if (first >= 0xc0) { // legacy
      f = rlp.decode(raw); need(9);
      type = 0; nonce = big(f[0]); maxFee = maxPrio = big(f[1]); gasLimit = big(f[2]); to = f[3]; value = big(f[4]); data = f[5]; v = big(f[6]); r = big(f[7]); s = big(f[8]);
      if (v < 35n) throw new TxInvalid('BAD_RAW', 'transactions without EIP-155 replay protection are not accepted');
      chainId = (v - 35n) / 2n;
      sigHashInput = rlp.encode([f[0], f[1], f[2], f[3], f[4], f[5], chainId, 0, 0]);
      v = (v - 35n) % 2n;
      acl = [];
    } else if (first === 1 || first === 2) {
      f = rlp.decode(raw.subarray(1));
      type = first;
      if (first === 1) { need(11); chainId = big(f[0]); nonce = big(f[1]); maxFee = maxPrio = big(f[2]); gasLimit = big(f[3]); to = f[4]; value = big(f[5]); data = f[6]; acl = f[7]; v = big(f[8]); r = big(f[9]); s = big(f[10]); sigHashInput = Buffer.concat([Buffer.from([1]), rlp.encode(f.slice(0, 8))]); }
      else { need(12); chainId = big(f[0]); nonce = big(f[1]); maxPrio = big(f[2]); maxFee = big(f[3]); gasLimit = big(f[4]); to = f[5]; value = big(f[6]); data = f[7]; acl = f[8]; v = big(f[9]); r = big(f[10]); s = big(f[11]); sigHashInput = Buffer.concat([Buffer.from([2]), rlp.encode(f.slice(0, 9))]); }
    } else throw new TxInvalid('BAD_RAW', 'unsupported transaction type');
  } catch (e) { if (e instanceof TxInvalid) throw e; throw new TxInvalid('BAD_RAW', e.message); }
  if (acl.length) throw new TxInvalid('BAD_RAW', 'access lists are not supported');
  if (to.length !== 0 && to.length !== 20) throw new TxInvalid('BAD_RAW', 'bad recipient');
  if (v > 1n) throw new TxInvalid('BAD_RAW', 'bad signature recovery id');
  if (s > N / 2n) throw new TxInvalid('BAD_RAW', 'high-s signatures are not accepted');
  const pub = recover(keccak256(sigHashInput), r, s, Number(v));
  if (!pub) throw new TxInvalid('BAD_SIGNATURE', 'cannot recover signer');
  return { type, chainId, nonce, maxPrio, maxFee, gasLimit, to: to.length ? hex(to) : null, value, data: hex(data), pub: hex(pub), hash: '0x' + hex(keccak256(raw)) };
}

/** Build the AUREN envelope for a raw transaction. Throws TxInvalid if it is not valid for this network. */
function envelopeFromRaw(rawHex, params, chainId) {
  const p = parseRaw(rawHex);
  if (p.chainId !== BigInt(params.evmChainId)) throw new TxInvalid('WRONG_CHAIN', `transaction is for EVM chain ${p.chainId}, this network is ${params.evmChainId}`);
  if (p.gasLimit < 21000n || p.gasLimit > BigInt(params.limits.compute)) throw new TxInvalid('BAD_BODY', 'gas limit out of range');
  if (p.value % WEI !== 0n) throw new TxInvalid('BAD_BODY', `value must be a multiple of 1e9 wei (1 spark)`);
  if (p.nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new TxInvalid('BAD_NONCE');
  const gl = p.gasLimit;
  return {
    v: 1, chainId, type: 'evm', scheme: 4, from: pubToAddress(p.pub, params.addressPrefix, 4), pub: p.pub, nonce: Number(p.nonce),
    maxFee: ((p.maxFee / WEI) * gl).toString(), tip: ((p.maxPrio / WEI) * gl).toString(),
    body: { to: p.to, value: p.value.toString(), data: p.data, gasLimit: Number(gl) },
    sig: { raw: '0x' + hex(Buffer.from(rawHex.replace(/^0x/i, ''), 'hex')) },
  };
}

module.exports = { parseRaw, envelopeFromRaw };
