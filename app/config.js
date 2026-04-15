const { machineIdSync } = require('node-machine-id');
const fs   = require('fs');
const path = require('path');

const DEFAULTS = {
  machineId: null,
  model: {
    apiKey:   '',
    endpoint: '',
    modelId:  '',
  },
  ports: {
    ui:           3000,
    pythonBridge: 3001,
  },
  activeProject: 'default',
};

function loadConfig(root) {
  const configPath = getConfigPath(root);
  let config = JSON.parse(JSON.stringify(DEFAULTS));

  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = deepMerge(config, saved);
    } catch (e) {
      console.warn('[config] Could not parse config.json, using defaults.');
    }
  }

  config.machineId = machineIdSync();
  saveConfig(config, root);
  return config;
}

function saveConfig(config, root) {
  fs.writeFileSync(getConfigPath(root), JSON.stringify(config, null, 2));
}

function getConfigPath(root) {
  return path.join(root || path.join(__dirname, '..'), 'config.json');
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (typeof override[key] === 'object' && override[key] !== null && !Array.isArray(override[key])) {
      result[key] = deepMerge(base[key] || {}, override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

module.exports = { loadConfig, saveConfig };
