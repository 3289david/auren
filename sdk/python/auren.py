"""AUREN SDK for Python: talk to a node, make a wallet, sign and send payments. No dependencies.

    from auren import Client, Wallet

    node = Client("http://127.0.0.1:9650")
    wallet = Wallet.generate("daur")            # or Wallet.from_seed("<64 hex>", "daur")
    print(wallet.address)
    print(node.balance(wallet.address))
    wallet.transfer(node, "daur1...", "1.5")    # amounts are in AUR
    wallet.register_name(node, "alice", years=1)

Pure-Python Ed25519 is slow (milliseconds per signature) but fine for wallets and bots.
"""
import hashlib
import json
import os
import time
import urllib.request

__all__ = ["Client", "Wallet", "AUR", "to_sparks", "from_sparks", "RpcError"]

AUR = 10 ** 9  # sparks per AUR


def to_sparks(amount) -> int:
    """'1.5' -> 1500000000. Strings or ints only, so no float rounding."""
    s = str(amount).strip()
    whole, _, frac = s.partition(".")
    if not whole.isdigit() or (frac and not frac.isdigit()) or len(frac) > 9:
        raise ValueError("amount must be a plain number with at most 9 decimals")
    return int(whole) * AUR + int((frac + "000000000")[:9])


def from_sparks(sparks) -> str:
    s = int(sparks)
    whole, frac = divmod(s, AUR)
    return f"{whole}.{frac:09d}".rstrip("0").rstrip(".") if frac else str(whole)


class RpcError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


# ----------------------------------------------------------------- Ed25519 (RFC 8032)
_P = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _inv(x):
    return pow(x, _P - 2, _P)


def _xrecover(y):
    xx = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P != 0:
        x = x * _I % _P
    return _P - x if x % 2 else x


_BY = 4 * _inv(5) % _P
_B = (_xrecover(_BY), _BY, 1, _xrecover(_BY) * _BY % _P)


def _add(p, q):
    a = (p[1] - p[0]) * (q[1] - q[0]) % _P
    b = (p[1] + p[0]) * (q[1] + q[0]) % _P
    c = 2 * p[3] * q[3] * _D % _P
    d = 2 * p[2] * q[2] % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(s, p):
    q = (0, 1, 1, 0)
    while s:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _enc(p):
    zi = _inv(p[2])
    x, y = p[0] * zi % _P, p[1] * zi % _P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _h(m):
    return int.from_bytes(hashlib.sha512(m).digest(), "little")


def _expand(seed):
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def ed25519_public(seed: bytes) -> bytes:
    a, _ = _expand(seed)
    return _enc(_mul(a, _B))


def ed25519_sign(seed: bytes, msg: bytes) -> bytes:
    a, prefix = _expand(seed)
    pub = _enc(_mul(a, _B))
    r = _h(prefix + msg) % _L
    big_r = _enc(_mul(r, _B))
    s = (r + _h(big_r + pub + msg) * a) % _L
    return big_r + s.to_bytes(32, "little")


# ----------------------------------------------------------------- bech32 addresses
_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            if (b >> i) & 1:
                chk ^= gen[i]
    return chk


def _convert(data, frm, to, pad=True):
    acc, bits, out, maxv = 0, 0, [], (1 << to) - 1
    for v in data:
        acc = (acc << frm) | v
        bits += frm
        while bits >= to:
            bits -= to
            out.append((acc >> bits) & maxv)
    if pad and bits:
        out.append((acc << (to - bits)) & maxv)
    return out


def address_from_pub(pub: bytes, prefix: str, scheme: int = 0) -> str:
    h = hashlib.sha256(bytes([scheme]) + pub).digest()[:20]
    data = _convert([scheme] + list(h), 8, 5)
    hrp = [ord(c) >> 5 for c in prefix] + [0] + [ord(c) & 31 for c in prefix]
    mod = _polymod(hrp + data + [0] * 6) ^ 1
    check = [(mod >> 5 * (5 - i)) & 31 for i in range(6)]
    return prefix + "1" + "".join(_CHARSET[d] for d in data + check)


# ----------------------------------------------------------------- client
def _canon(x) -> str:
    """Canonical JSON used for signing and hashing: sorted keys, no spaces."""
    return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Client:
    """JSON-RPC client for an AUREN node."""

    def __init__(self, url, timeout=15):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def call(self, method, params=None):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
        req = urllib.request.Request(self.url + "/rpc", body, {"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            j = json.loads(r.read())
        if "error" in j:
            raise RpcError(j["error"].get("message", "error"), j["error"].get("data"))
        return j["result"]

    def get(self, path):
        with urllib.request.urlopen(self.url + path, timeout=self.timeout) as r:
            return json.loads(r.read())

    def status(self):
        return self.call("aur_status")

    def account(self, address):
        return self.call("aur_getAccount", [address])

    def balance(self, address) -> str:
        """Spendable balance in AUR, as a decimal string."""
        return from_sparks(self.account(address)["spendable"])

    def fee_quote(self):
        return self.call("aur_feeQuote")

    def send_raw(self, tx):
        return self.call("aur_sendTx", [tx])

    def simulate(self, tx):
        return self.call("aur_simulate", [tx])

    def get_tx(self, tx_hash):
        return self.call("aur_getTx", [tx_hash])

    def resolve_name(self, name):
        return self.call("aur_resolveDomain", [name])

    def wait(self, tx_hash, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            t = self.get_tx(tx_hash)
            if t and t.get("status") == "confirmed":
                return t
            time.sleep(0.5)
        raise TimeoutError("transaction was not included in time")


class Wallet:
    """A software wallet (Ed25519). Keep the seed secret."""

    def __init__(self, seed: bytes, prefix: str):
        if len(seed) != 32:
            raise ValueError("seed must be 32 bytes")
        self.seed, self.prefix = seed, prefix
        self.pub = ed25519_public(seed)
        self.address = address_from_pub(self.pub, prefix)

    @classmethod
    def generate(cls, prefix):
        return cls(os.urandom(32), prefix)

    @classmethod
    def from_seed(cls, seed_hex, prefix):
        return cls(bytes.fromhex(seed_hex), prefix)

    @property
    def seed_hex(self):
        return self.seed.hex()

    def build(self, client, tx_type, body, tip=1000, fee_multiplier=2):
        st = client.status()
        if st["addressPrefix"] != self.prefix:
            raise ValueError(f"wallet prefix {self.prefix} does not match network prefix {st['addressPrefix']}")
        acct = client.account(self.address)
        base = int(client.fee_quote()["quote"][tx_type]["baseFee"])
        tx = {
            "chainId": st["chainId"], "type": tx_type, "from": self.address, "nonce": acct["pendingNonce"],
            "maxFee": str(base * fee_multiplier + tip), "tip": str(tip), "body": body, "v": 1, "pub": self.pub.hex(),
        }
        tx["sig"] = ed25519_sign(self.seed, b"AUREN/tx/v1\0" + _canon(tx).encode()).hex()
        return tx

    def send(self, client, tx_type, body, wait=True, **opts):
        tx = self.build(client, tx_type, body, **opts)
        sim = client.simulate(tx)
        if not sim.get("ok"):
            raise RpcError(f"would fail: {sim.get('code')}", sim.get("code"))
        h = client.send_raw(tx)["hash"]
        if not wait:
            return {"hash": h}
        t = client.wait(h)
        r = t.get("receipt") or {}
        if r.get("status") != 1:
            raise RpcError(f"failed: {r.get('code')}", r.get("code"))
        return t

    # ---- everyday actions (amounts in AUR)
    def transfer(self, client, to, amount, **o):
        return self.send(client, "transfer", {"to": to, "amount": str(to_sparks(amount))}, **o)

    def stake(self, client, validator, amount, **o):
        return self.send(client, "delegate", {"validator": validator, "amount": str(to_sparks(amount))}, **o)

    def unstake(self, client, validator, amount, **o):
        return self.send(client, "undelegate", {"validator": validator, "amount": str(to_sparks(amount))}, **o)

    def claim_rewards(self, client, validator, **o):
        return self.send(client, "claim", {"validator": validator}, **o)

    def register_name(self, client, name, years=1, **o):
        """'alice' or 'alice.aur' (the .aur namespace), or 'alice.david' under a TLD someone created."""
        return self.send(client, "registerDomain", {"name": name.removesuffix(".aur"), "years": years}, **o)

    def set_name_target(self, client, name, target, **o):
        return self.send(client, "setDomainTarget", {"name": name.removesuffix(".aur"), "target": target}, **o)

    def create_tld(self, client, tld, price="1", owner_share_percent=80, open=True, **o):
        return self.send(client, "registerTld", {"tld": tld, "open": bool(open), "price": str(to_sparks(price)), "ownerShareBps": int(owner_share_percent * 100)}, **o)

    def register_node(self, client, payout=None, **o):
        return self.send(client, "registerNode", {"payout": payout or self.address}, **o)
