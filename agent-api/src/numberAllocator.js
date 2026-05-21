const fs = require("fs");
const path = require("path");

const DYNAMIC_DIR = process.env.DYNAMIC_CONF_DIR || "/etc/asterisk/dynamic";
const EXT_FILE = path.join(DYNAMIC_DIR, "extensions_dynamic.conf");
const MIN_EXT = 6000;
const MAX_EXT = 6999;

/**
 * Reads already-allocated extension numbers from extensions_dynamic.conf.
 * @returns {Set<number>}
 */
function getUsedNumbers() {
  const used = new Set();
  if (!fs.existsSync(EXT_FILE)) return used;
  const content = fs.readFileSync(EXT_FILE, "utf8");
  const matches = content.matchAll(/^exten\s*=>\s*(\d+),/gm);
  for (const m of matches) used.add(parseInt(m[1], 10));
  return used;
}

/**
 * Returns the lowest free extension number between MIN_EXT and MAX_EXT.
 * Throws if the range is exhausted.
 * @returns {number}
 */
function allocate() {
  const used = getUsedNumbers();
  for (let n = MIN_EXT; n <= MAX_EXT; n++) {
    if (!used.has(n)) return n;
  }
  throw new Error(`No free extension numbers in range ${MIN_EXT}-${MAX_EXT}`);
}

/**
 * Returns the extension number currently used by agentId, or null.
 * @param {string} agentId
 * @returns {number|null}
 */
function findByAgent(agentId) {
  if (!fs.existsSync(EXT_FILE)) return null;
  const content = fs.readFileSync(EXT_FILE, "utf8");
  const re = new RegExp(`; agent:${agentId}\\nexten\\s*=>\\s*(\\d+),`);
  const m = content.match(re);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { allocate, findByAgent, getUsedNumbers };
