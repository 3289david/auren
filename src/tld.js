'use strict';
// Names are "label.tld". A bare label means ".aur" (the built-in, protocol-owned TLD). Anyone can register their own
// TLD (burning a fee), set it open or restricted, price it, and earn a share of registrations under it.
// Real-world TLDs are reserved so an AUREN name can never be confused with a DNS name.

const LABEL_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const TLD_RE = /^[a-z][a-z0-9]{2,23}$/; // 3-24 chars: this also keeps every 2-letter country code out

// A safety fence, not a trademark system: major generic TLDs, crypto naming suffixes and tech/finance words people
// would assume are controlled elsewhere. Country codes are excluded by length.
const RESERVED = new Set(`
aur taur daur com net org edu gov mil int info biz name pro mobi asia tel travel jobs museum aero coop xxx
app dev page new how foo cloud online site tech store shop blog link live news media email web website space
xyz top club vip win bid loan work click download stream review party science trade date faith racing cricket
icu cyou buzz fun life world today global group company inc ltd llc bank money cash pay finance financial
insurance loans credit exchange market trading invest fund capital crypto coin coins token tokens nft nfts dao
defi eth ether ethereum btc bitcoin sol solana bnb ada xrp doge usdt usdc dai wallet bitcoin blockchain chain
web3 meta zil luxe kred bit onion local localhost internal invalid example test lan home corp mail
google apple amazon microsoft meta facebook twitter youtube github openai binance coinbase tesla
`.split(/\s+/).filter(Boolean));

function parseName(full) {
  if (typeof full !== 'string') return null;
  const parts = full.split('.');
  if (parts.length === 1) return { label: parts[0], tld: 'aur' };
  if (parts.length === 2) return { label: parts[0], tld: parts[1] };
  return null;
}
const domKey = (n) => (n.tld === 'aur' ? n.label : `${n.label}.${n.tld}`);
const fullName = (n) => `${n.label}.${n.tld}`;
/** Syntactic check of a full name; returns {label, tld} or null. (Registration adds look-alike rules.) */
function nameValid(full) {
  const n = parseName(full);
  return n && LABEL_RE.test(n.label) && (n.tld === 'aur' || TLD_RE.test(n.tld)) ? n : null;
}
/** A TLD that can be newly registered (existing=true: only the syntax matters). */
function tldOk(t, existing = false) {
  if (typeof t !== 'string' || !TLD_RE.test(t) || t.includes('xn--')) return false;
  return existing ? t !== 'aur' : !RESERVED.has(t);
}

module.exports = { parseName, domKey, fullName, nameValid, tldOk, RESERVED, LABEL_RE, TLD_RE };
