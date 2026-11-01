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

  /** Keep only the first `n` blocks that follow each other from height 1 (drops duplicates, gaps and everything after a bad block). */
  keepSequential(n) {
    const keep = [];
    let next = 1;
    try { for (const rec of this.load()) { if (keep.length >= n) break; if (rec.block.header.height === next) { keep.push(JSON.stringify(rec)); next++; } } } catch { /* use what could be read */ }
    this.close();
    fs.writeFileSync(this.file + '.tmp', keep.length ? keep.join('\n') + '\n' : '');
    fs.renameSync(this.file + '.tmp', this.file);
    this.fd = fs.openSync(this.file, 'a');
  }

  append(block, commit) {
    fs.writeSync(this.fd, JSON.stringify({ block, commit }) + '\n');
    fs.fsyncSync(this.fd);
  }

  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }
}

module.exports = { BlockStore };
