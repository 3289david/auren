'use strict';
// Append-only block log (one JSON object per line). State is rebuilt by replaying and re-verifying it.
const fs = require('node:fs');
const path = require('node:path');

class BlockStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    this.fd = fs.openSync(file, 'a');
  }

  *load() {
    const text = fs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try { yield JSON.parse(lines[i]); } catch (e) {
        if (i >= lines.length - 2) return; // torn final write after a crash: ignore it
        throw new Error(`corrupt block log at line ${i + 1}`);
      }
    }
  }

  append(block, commit) {
    fs.writeSync(this.fd, JSON.stringify({ block, commit }) + '\n');
    fs.fsyncSync(this.fd);
  }

  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }
}

module.exports = { BlockStore };
