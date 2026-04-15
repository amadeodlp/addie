/**
 * bridge.js — Addie Bridge detector and setup guide.
 *
 * Polls the Python control surface /health endpoint.
 * When it responds, the bridge is up. When it stops responding, it's gone.
 *
 * The watchdog runs every 4 seconds. This is intentionally slow —
 * the Python bridge is stable once Live has loaded the script.
 *
 * Busy-awareness: when the bridge is executing actions (heavy plugin loads,
 * multi-command sequences), health pings can time out because Ableton's main
 * thread is blocked. The watchdog now requires CONSECUTIVE_FAILURES_REQUIRED
 * missed pings before declaring disconnect, and callers can set a "busy" flag
 * to further extend tolerance during known heavy operations.
 */

const http = require('http');

const BRIDGE_URL = 'http://127.0.0.1:3001/health';
const WATCHDOG_INTERVAL_MS = 4000;
const PING_TIMEOUT_NORMAL_MS = 2000;
const PING_TIMEOUT_BUSY_MS   = 6000;
const CONSECUTIVE_FAILURES_REQUIRED = 3;
const HEARTBEAT_STALE_THRESHOLD_S = 5;  // If update_display hasn't run in 5s, bridge is dead

let bridgeStatus = {
  detected: false,
  checkedAt: null,
  heartbeatOk: true,  // false when update_display has stopped running
};

let _watchdogTimer = null;
let _onConnectCallback = null;
let _onDisconnectCallback = null;
let _busy = false;           // True while actions are in flight
let _consecutiveFailures = 0;

// ── Public API ────────────────────────────────────────────────────────────────

function startWatchdog(onConnect, onDisconnect) {
  _onConnectCallback = onConnect;
  _onDisconnectCallback = onDisconnect;
  _poll();
  _watchdogTimer = setInterval(_poll, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
  }
}

function getBridgeStatus() { return bridgeStatus; }
function isDetected() { return bridgeStatus.detected; }

/**
 * Mark the bridge as busy (actions in flight). While busy, the watchdog
 * uses a longer ping timeout and requires more consecutive failures before
 * declaring disconnect. Call setBusy(false) when the operation finishes.
 */
function setBusy(busy) {
  _busy = !!busy;
  if (!busy) _consecutiveFailures = 0;  // Reset on release
}

function isBusy() { return _busy; }

// ── Internal ──────────────────────────────────────────────────────────────────

function _poll() {
  const timeout = _busy ? PING_TIMEOUT_BUSY_MS : PING_TIMEOUT_NORMAL_MS;
  _ping(timeout, (ok, healthData) => {
    const wasDetected = bridgeStatus.detected;
    bridgeStatus = {
      detected: ok || wasDetected,
      checkedAt: new Date().toISOString(),
      heartbeatOk: ok,
      queue: healthData?.queue ?? -1,
    };

    if (ok) {
      _consecutiveFailures = 0;
      if (!wasDetected) {
        bridgeStatus.detected = true;
        console.log('[bridge] Python control surface connected.');
        if (_onConnectCallback) {
          Promise.resolve(_onConnectCallback()).catch(err => {
            console.error('[bridge] onConnect callback error:', err.message);
          });
        }
      }
    } else {
      _consecutiveFailures++;
      const threshold = _busy
        ? CONSECUTIVE_FAILURES_REQUIRED * 2
        : CONSECUTIVE_FAILURES_REQUIRED;

      if (wasDetected && _consecutiveFailures >= threshold) {
        bridgeStatus.detected = false;
        console.log(`[bridge] Python control surface disconnected (${_consecutiveFailures} consecutive failures).`);
        if (_onDisconnectCallback) _onDisconnectCallback();
      } else if (wasDetected) {
        console.log(`[bridge] Health ping failed (${_consecutiveFailures}/${threshold}), still connected.`);
      }
    }
  });
}

function _ping(timeout, cb) {
  const req = http.get(BRIDGE_URL, { timeout }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.ok !== true) return cb(false, null);

        // Check heartbeat — is update_display actually running?
        const heartbeatAge = data.heartbeat
          ? (Date.now() / 1000) - data.heartbeat
          : 0;
        const heartbeatOk = heartbeatAge < HEARTBEAT_STALE_THRESHOLD_S;

        if (!heartbeatOk) {
          console.warn(`[bridge] HTTP server alive but update_display stale (${heartbeatAge.toFixed(1)}s, queue: ${data.queue})`);
        }

        cb(heartbeatOk, data);
      } catch {
        cb(false, null);
      }
    });
  });
  req.on('error', () => cb(false, null));
  req.on('timeout', () => { req.destroy(); cb(false, null); });
}

// ── Setup instructions (shown in UI when bridge not found) ────────────────────

function getSetupInstructions() {
  return {
    type: 'bridge_setup',
    title: 'One-time setup needed',
    steps: [
      'Copy the **control_surface/** folder from the Addie app directory into your Ableton MIDI Remote Scripts folder.',
      'In Ableton **Preferences → MIDI**, set one of the Control Surface slots to **Addie**.',
      'Save your Live set as the default template — you\'ll never need to do this again.',
    ],
    hint: 'Waiting for Addie Python bridge to come online...',
  };
}

module.exports = {
  startWatchdog,
  stopWatchdog,
  getBridgeStatus,
  isDetected,
  setBusy,
  isBusy,
  getSetupInstructions,
  // Legacy shims — kept so any remaining callers don't crash during migration
  onBridgeConnected: () => {},
  onBridgeDisconnected: () => {},
};
