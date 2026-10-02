#!/usr/bin/env node
/**
 * ZCAC inline plugin installer.
 * Registers the plugin directory as a ZCode inline plugin source.
 *
 * Usage:
 *   node scripts/install-inline.js [path-to-zcac-package]
 *   (default: assumes this repo is cloned, uses packages/zcac/plugin)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
const pluginDir = path.resolve(
  args[0] || path.join(__dirname, "..", "packages", "zcac", "plugin"),
);

if (!fs.existsSync(path.join(pluginDir, ".zcode-plugin", "plugin.json"))) {
  console.error(`Error: plugin manifest not found at ${pluginDir}/.zcode-plugin/plugin.json`);
  console.error("Make sure you've built the orchestrator first: pnpm --filter zcac build");
  process.exit(1);
}

const configDir = path.join(os.homedir(), ".zcode", "cli");
const configPath = path.join(configDir, "config.json");

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  // First-time config; start fresh
}

config.plugins = config.plugins || {};
const existing = config.plugins.dirs || [];
const normalized = path.resolve(pluginDir);

if (existing.includes(normalized)) {
  console.log(`Already registered: ${normalized}`);
  process.exit(0);
}

config.plugins.dirs = [...existing, normalized];

fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`✅ Registered ZCAC plugin: ${normalized}`);
console.log("Restart ZCode to pick up the plugin.");
console.log("Then try: /cluster hello world test");
