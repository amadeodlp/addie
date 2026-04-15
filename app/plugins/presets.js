/**
 * presets.js — Plugin preset registry for pre-configured VST/AU devices.
 *
 * Addie ships .adg presets (Instrument Racks wrapping third-party plugins
 * with their Ableton Configure lists pre-populated). This module manages
 * the registry and intercepts browser_insert actions to load the
 * pre-configured version instead of the raw plugin.
 *
 * Presets live in:
 *   <appRoot>/presets/<name>.adg
 *
 * They are installed to:
 *   <userLibrary>/Addie/<name>.adg
 *
 * Registry file:
 *   <appRoot>/presets/registry.json
 *   Maps plugin names to preset file names:
 *   { "Diva": "Addie - Diva", "Serum": "Addie - Serum" }
 */

const fs   = require('fs');
const path = require('path');

let _root     = null;
let _registry = {};

function init(appRoot) {
  _root = appRoot;
  const registryPath = path.join(appRoot, 'presets', 'registry.json');
  try {
    if (fs.existsSync(registryPath)) {
      _registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      console.log(`[presets] Loaded registry: ${Object.keys(_registry).length} plugins`);
    }
  } catch (e) {
    console.warn('[presets] Could not load registry:', e.message);
  }
}

/**
 * Check if we have a pre-configured preset for a given device name.
 * Returns the preset name to use in browser_insert, or null if none.
 *
 * Matching is fuzzy: "Diva", "diva", "Diva(x64)" all match registry key "Diva".
 */
function getPresetName(deviceName) {
  if (!deviceName || !Object.keys(_registry).length) return null;

  const query = deviceName.toLowerCase().trim();

  // Exact match first
  for (const [pluginName, presetName] of Object.entries(_registry)) {
    if (query === pluginName.toLowerCase()) return presetName;
  }

  // Partial match — "diva" matches "Diva(x64)"
  for (const [pluginName, presetName] of Object.entries(_registry)) {
    if (query.includes(pluginName.toLowerCase()) ||
        pluginName.toLowerCase().includes(query)) {
      return presetName;
    }
  }

  return null;
}

/**
 * Install preset .adg files into the user's Ableton User Library.
 * Called during onboarding alongside the control surface install.
 *
 * @param {string} userLibraryPath - Path to Ableton's User Library folder
 * @returns {{ ok: boolean, installed: number, error?: string }}
 */
function installPresets(userLibraryPath) {
  if (!_root) return { ok: false, installed: 0, error: 'presets module not initialized' };

  const srcDir  = path.join(_root, 'presets');
  const destDir = path.join(userLibraryPath, 'Addie');

  if (!fs.existsSync(srcDir)) return { ok: true, installed: 0 };

  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    return { ok: false, installed: 0, error: 'Could not create Addie folder in User Library: ' + e.message };
  }

  let installed = 0;
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.adg'));

  for (const file of files) {
    try {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
      installed++;
    } catch (e) {
      console.warn(`[presets] Could not copy ${file}:`, e.message);
    }
  }

  console.log(`[presets] Installed ${installed} preset(s) to ${destDir}`);
  return { ok: true, installed };
}

/**
 * Get the registry for display/debug.
 */
function getRegistry() {
  return { ..._registry };
}

module.exports = { init, getPresetName, installPresets, getRegistry };
