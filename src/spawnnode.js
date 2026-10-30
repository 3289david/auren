'use strict';
// Start a child "node" process for a script. Inside a packaged .exe (single executable) the program is its own
// interpreter, so the script is passed through AUREN_RUN_SCRIPT and the exe's launcher runs it.
let isSea = false;
try { isSea = require('node:sea').isSea(); } catch { /* older Node: not a single executable */ }

function nodeArgs(script, args = [], env = process.env) {
  if (isSea) return { cmd: process.execPath, args, env: { ...env, AUREN_RUN_SCRIPT: script } };
  return { cmd: process.execPath, args: [script, ...args], env };
}
const spawnNode = (cp, fn, script, args, opts = {}) => {
  const a = nodeArgs(script, args, opts.env || process.env);
  return cp[fn](a.cmd, a.args, { ...opts, env: a.env });
};
module.exports = { isSea, nodeArgs, spawnNode };
