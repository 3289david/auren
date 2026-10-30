#!/usr/bin/env python3
"""Download the Node.js runtime for Android (Termux build, same Node line as desktop) and its libraries.

Usage: python android/fetch_runtime.py <aarch64|x86_64> <out-dir>

Writes <out-dir>/bin/node and <out-dir>/lib/*.so*. Only the files the node binary needs are kept.
Packages come from packages.termux.dev (the Termux project builds Node against Android's libc).
"""
import io, os, re, shutil, sys, tarfile, urllib.request

BASE = "https://packages.termux.dev/apt/termux-main/"
SKIP = {"termux-exec", "termux-tools", "termux-keyring", "termux-licenses", "apt", "dpkg", "bash", "coreutils", "npm"}


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def read_index(arch):
    text = get(f"{BASE}dists/stable/main/binary-{arch}/Packages").decode("utf8", "replace")
    pkgs = {}
    for block in text.split("\n\n"):
        f = dict(m.groups() for m in re.finditer(r"^([A-Za-z0-9-]+): (.*)$", block, re.M))
        if "Package" in f:
            pkgs[f["Package"]] = f
    return pkgs


def closure(pkgs, root):
    seen, order, todo = set(), [], [root]
    while todo:
        p = todo.pop()
        if p in seen or p in SKIP or p not in pkgs:
            continue
        seen.add(p)
        order.append(p)
        for dep in pkgs[p].get("Depends", "").split(","):
            name = dep.split("|")[0].strip().split(" ")[0]
            if name:
                todo.append(name)
    return order


def deb_data(blob):
    """Return the data.tar.* member of a .deb (an `ar` archive) as bytes."""
    assert blob[:8] == b"!<arch>\n"
    i = 8
    while i < len(blob):
        name = blob[i:i + 16].decode().strip()
        size = int(blob[i + 48:i + 58])
        body = blob[i + 60:i + 60 + size]
        i += 60 + size + (size % 2)
        if name.startswith("data.tar"):
            return name, body
    raise RuntimeError("no data member")


def needed(elf):
    """DT_NEEDED library names of a 64-bit little-endian ELF file."""
    import struct
    if elf[:4] != b"\x7fELF" or elf[4] != 2:
        return []
    shoff, = struct.unpack_from("<Q", elf, 0x28)
    shentsize, shnum = struct.unpack_from("<HH", elf, 0x3A)
    secs = [struct.unpack_from("<IIQQQQIIQQ", elf, shoff + i * shentsize) for i in range(shnum)]
    out = []
    for s in secs:
        if s[1] == 6:  # SHT_DYNAMIC
            strtab = secs[s[6]]
            sbase = strtab[4]
            for off in range(s[4], s[4] + s[5], 16):
                tag, val = struct.unpack_from("<qQ", elf, off)
                if tag == 1:  # DT_NEEDED
                    end = elf.index(b"\0", sbase + val)
                    out.append(elf[sbase + val:end].decode())
    return out


def main():
    arch, out = sys.argv[1], sys.argv[2]
    pkgs = read_index(arch)
    names = closure(pkgs, "nodejs")
    print("packages:", ", ".join(names))
    prefix = "data/data/com.termux/files/usr/"
    files = {}   # relative path -> bytes
    links = {}   # relative path -> link target
    for n in names:
        blob = get(BASE + pkgs[n]["Filename"])
        name, data = deb_data(blob)
        mode = "r:xz" if name.endswith(".xz") else "r:gz" if name.endswith(".gz") else "r:*"
        with tarfile.open(fileobj=io.BytesIO(data), mode=mode) as tf:
            for m in tf.getmembers():
                p = m.name.lstrip("./")
                if not p.startswith(prefix):
                    continue
                rel = p[len(prefix):]
                if not (rel == "bin/node" or rel.startswith("lib/")):
                    continue
                if m.issym():
                    links[rel] = os.path.normpath(os.path.join(os.path.dirname(rel), m.linkname)).replace("\\", "/")
                elif m.isfile():
                    files[rel] = tf.extractfile(m).read()
    for rel, tgt in links.items():   # Android app dirs and APKs cannot hold symlinks: copy the target's bytes
        seen = 0
        while tgt in links and seen < 8:
            tgt = links[tgt]; seen += 1
        if tgt in files:
            files[rel] = files[tgt]
    # keep only what node loads: walk the DT_NEEDED entries from bin/node through the libraries
    by_name = {os.path.basename(r): r for r in files if r.startswith("lib/") and "/" not in r[4:]}
    keep, todo = {"bin/node"}, ["bin/node"]
    while todo:
        for need in needed(files[todo.pop()]):
            r = by_name.get(need)
            if r and r not in keep:
                keep.add(r); todo.append(r)
    files = {r: b for r, b in files.items() if r in keep}
    shutil.rmtree(out, ignore_errors=True)
    for rel, b in files.items():
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(b)
    # keep only libraries reachable from node (NEEDED entries), trimming unrelated Termux libs
    print("wrote", len(os.listdir(os.path.join(out, "lib"))), "libs,", os.path.getsize(os.path.join(out, "bin", "node")) // 1048576, "MB node")


if __name__ == "__main__":
    main()
