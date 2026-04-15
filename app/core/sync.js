/**
 * sync.js — Session state management.
 *
 *   fetchSession()      — mixer state + track list for all tracks. No devices.
 *                         Fetched on first message, re-fetched after structural changes.
 *
 *   fetchTrackDetails() — full device parameters for specific tracks.
 *                         Always fetches fresh from Live. No cache.
 *
 *   fetchBrowser()      — installed device list (plugins, instruments, effects, packs).
 *                         Fetched once on first message. Invalidated only when the user
 *                         reports installing a new plugin.
 *
 *   snapshot()          — full device parameters for ALL tracks at once.
 *                         Called once at initial sync so the first message has everything.
 */

let _sendToBridge = null;

let _session      = null;
let _browserList  = null;
let _annotatedState = null;
let _fullSnapshot = null;  // cached result of the initial full snapshot()

// --- BRIDGE ------------------------------------------------------------------

function setBridgeFn(fn) { _sendToBridge = fn; }

// --- SESSION (mixer + track list) --------------------------------------------

async function fetchSession() {
  if (!_sendToBridge) throw new Error('Bridge not connected');
  const raw = await _sendToBridge('snapshot_tier1', {});
  if (!raw?.tracks) throw new Error('snapshot_tier1 returned no tracks');
  raw.syncedAt   = new Date().toISOString();
  raw.trackCount = raw.tracks.length;
  _session = raw;
  return raw;
}

function getSession() { return _session; }

/**
 * Clear session. Called after structural changes (create/delete/group/ungroup tracks,
 * create/delete return tracks) that invalidate the track list.
 * Next message will re-fetch.
 */
function clearSession() {
  _session = null;
  _fullSnapshot = null;  // track list changed — snapshot is stale too
}

// --- TRACK DETAILS (full device parameters) ----------------------------------

/**
 * Fetch full device parameters for the given tracks directly from Live.
 * Always fresh — no cache.
 * Also patches _fullSnapshot so it stays current as tracks are re-read.
 */
async function fetchTrackDetails(trackNames) {
  if (!_sendToBridge) throw new Error('Bridge not connected');
  if (!trackNames?.length) return { tracks: [] };
  const raw = await _sendToBridge('snapshot', { trackNames });
  const freshTracks = raw?.tracks || [];

  // Patch _fullSnapshot with fresh data so subsequent turns don't fall back
  // to the initial (possibly stale) snapshot for these tracks.
  if (_fullSnapshot?.tracks && freshTracks.length) {
    const freshNames = new Set(freshTracks.map(t => t.name.toLowerCase()));
    _fullSnapshot.tracks = _fullSnapshot.tracks.filter(t => !freshNames.has(t.name.toLowerCase()));
    _fullSnapshot.tracks.push(...freshTracks);
  }

  return { tempo: _session?.tempo ?? null, tracks: freshTracks };
}

// --- FULL SNAPSHOT (initial sync — all tracks at once) -----------------------

/**
 * Fetch full device parameters for every track in the session.
 * Called once at initial sync. Returns the raw data (also used by annotateSession).
 */
async function snapshot() {
  if (!_sendToBridge) throw new Error('Bridge not connected');
  const raw = await _sendToBridge('snapshot', {});
  if (!raw?.tracks) throw new Error('snapshot returned no tracks');
  raw.syncedAt   = new Date().toISOString();
  raw.trackCount = raw.tracks.length;
  _fullSnapshot = raw;  // cache for use as fallback in subsequent turns
  return raw;
}

function getFullSnapshot() { return _fullSnapshot; }
function clearFullSnapshot() { _fullSnapshot = null; }

// --- BROWSER -----------------------------------------------------------------

async function fetchBrowser() {
  if (!_sendToBridge) throw new Error('Bridge not connected');
  try {
    const result = await _sendToBridge('browser_list', {}, 15000);
    delete result._debug;
    _browserList = result;
    const summary = Object.entries(result || {}).map(([cat, folders]) => {
      const total = Object.values(folders).reduce((s, arr) => s + arr.length, 0);
      return `${cat}(${total})`;
    }).join(', ');
    console.log('[sync] Browser fetched:', summary);
    return result;
  } catch (err) {
    console.warn('[sync] Could not fetch browser list:', err.message);
    return null;
  }
}

function getBrowser() { return _browserList; }

function invalidateBrowser() {
  _browserList = null;
  console.log('[sync] Browser cache invalidated — will re-fetch on next message.');
}

// --- ANNOTATED STATE ---------------------------------------------------------

function getSessionState()  { return _annotatedState; }
function setSessionState(s) { _annotatedState = s; }

// --- PROMPT FORMATTERS -------------------------------------------------------

function formatSessionForPrompt(session) {
  if (!session?.tracks?.length) return 'No session data available.';

  const letters = 'ABCDEFGHIJKLMNOP';
  const returnNames = session.return_names || [];
  const sendMap = returnNames.length
    ? returnNames.map((name, i) => `send_${letters[i]} → ${name}`).join(' | ')
    : null;

  const lines = [
    `Tempo: ${session.tempo ?? '?'} BPM | ${session.tracks.length} tracks | Returns: ${returnNames.join(', ') || 'none'}`,
    ...(sendMap ? [`Send slots: ${sendMap}`] : []),
  ];

  const ms = session.mixerScale;
  if (ms) {
    if (ms.volume) {
      const vScale = ms.volume.map(([r, d]) => `${r.toFixed(4)}=${d}`).join(' | ');
      lines.push(`Volume scale (raw→display): ${vScale}  [range: ${ms.volumeRange?.[0] ?? 0}–${ms.volumeRange?.[1] ?? 1}]`);
    }
    if (ms.send) {
      const sScale = ms.send.map(([r, d]) => `${r.toFixed(4)}=${d}`).join(' | ');
      lines.push(`Send scale (raw→display): ${sScale}  [range: ${ms.sendRange?.[0] ?? 0}–${ms.sendRange?.[1] ?? 1}]`);
    }
    if (ms.panRange) {
      lines.push(`Pan range: ${ms.panRange[0]}–${ms.panRange[1]} (${ms.panRange[0]}=hard left, 0=center, ${ms.panRange[1]}=hard right)`);
    }
  }
  lines.push('');

  const groups = { audio: [], midi: [], return: [], master: [] };
  for (const t of session.tracks) (groups[t.type] || groups.audio).push(t);

  const fmt = (t) => {
    const flags = [];
    if (t.muted) flags.push('MUTED');
    if (t.solo)  flags.push('SOLO');
    const vol = t.volumeDisplay
      ? `vol:${t.volumeDisplay} (raw:${t.volume != null ? t.volume.toFixed(4) : '?'})`
      : (t.volume != null ? `vol:raw:${t.volume.toFixed(4)}` : '');
    const pan = t.panDisplay
      ? (t.panDisplay !== '0' && t.panDisplay !== 'C' ? `pan:${t.panDisplay} (raw:${t.pan != null ? t.pan.toFixed(4) : '?'})` : '')
      : (t.pan != null && Math.abs(t.pan) > 0.01 ? `pan:raw:${t.pan.toFixed(4)}` : '');
    const route = t.routingTarget && t.routingTarget !== 'Master' ? `→${t.routingTarget}` : '';

    const sendParts = [];
    if (Array.isArray(t.sends)) {
      const letters = 'ABCDEFGHIJKLMNOP';
      for (let i = 0; i < t.sends.length; i++) {
        const s = t.sends[i];
        const raw = typeof s === 'object' ? s.value : s;
        const display = typeof s === 'object' ? s.display : null;
        if (raw != null && raw > 0.001) {
          sendParts.push(display
            ? `send_${letters[i]}:${display} (raw:${raw.toFixed(4)})`
            : `send_${letters[i]}:raw:${raw.toFixed(4)}`);
        }
      }
    }

    // Show available output routing types so the LLM has exact names for set_routing.
    // Skip if the only option is Master (nothing interesting to route to).
    let routingOpts = '';
    if (Array.isArray(t.outputRoutingTypes) && t.outputRoutingTypes.length > 1) {
      routingOpts = ` [routing options: ${t.outputRoutingTypes.join(' | ')}]`;
    }

    const meta = [vol, pan, ...sendParts, route, ...flags].filter(Boolean).join(' ');
    return `  ${t.name}${meta ? '  [' + meta + ']' : ''}${routingOpts}`;
  };

  if (groups.audio.length)  lines.push('AUDIO:',  ...groups.audio.map(fmt),  '');
  if (groups.midi.length)   lines.push('MIDI:',   ...groups.midi.map(fmt),   '');
  if (groups.return.length) lines.push('RETURN:', ...groups.return.map(fmt), '');
  if (groups.master.length) lines.push('MASTER:', ...groups.master.map(fmt));

  return lines.join('\n');
}

function _fmtParam(k, v) {
  if (typeof v !== 'object') return `${k}: ${v}`;
  const display = v.display ?? v.value;
  const min = v.min, max = v.max;

  if (v.is_quantized && Array.isArray(v.value_items) && v.value_items.length > 0) {
    return `${k}: ${display} (choices: ${v.value_items.join('|')})`;
  }
  if (min != null && max != null) {
    let line = `${k}: ${display}`;
    if (Array.isArray(v.scale) && v.scale.length > 0) {
      line += ` (range: ${v.scale[0][1]} to ${v.scale[v.scale.length - 1][1]})`;
    }
    return line;
  }
  return `${k}: ${display}`;
}

function formatDevicesForPrompt(tracks) {
  if (!tracks?.length) return null;

  return tracks.map(t => {
    const lines = [`${t.name}:`];

    for (const d of (t.devices || [])) {
      lines.push(`  ${d.name}${d.enabled === false ? ' (bypassed)' : ''}`);

      // Drum Racks have both can_have_chains and can_have_drum_pads — drum pads
      // take precedence over the inner-device display since the pad map is what
      // the LLM needs for MIDI composition. Show pads first, skip inner devices.
      if (d.drumPads?.length) {
        lines.push(`    drum pads (note → sound):`);
        for (const pad of d.drumPads) {
          lines.push(`      ${pad.note}: ${pad.name}${pad.chains?.length ? ` [${pad.chains.join(', ')}]` : ''}`);
        }
      } else if (d.isRack && d.innerDevices?.length) {
        const hasMappedMacros = d.parameters && Object.entries(d.parameters).some(
          ([k, v]) => /^Macro/i.test(k) && (typeof v === 'object' ? v.value : v) !== 0
        );
        if (hasMappedMacros) {
          const macroStr = Object.entries(d.parameters)
            .filter(([k, v]) => /^Macro/i.test(k) && (typeof v === 'object' ? v.value : v) !== 0)
            .map(([k, v]) => _fmtParam(k, v)).join(', ');
          lines.push(`    rack macros (mapped): ${macroStr}`);
        }
        for (const inner of d.innerDevices) {
          // If the inner device is itself a rack, automation can't reach inside it —
          // only the outer rack's Macros are automatable. Show a clear note instead.
          const innerIsRack = inner.isRack && inner.innerDevices?.length;
          const automationHint = innerIsRack
            ? '[nested rack — automate via outer rack Macros only]'
            : `[automation: "${d.name}::${inner.name}"]`;
          lines.push(`    ┗ ${inner.name}${inner.enabled === false ? ' (bypassed)' : ''} [inner device: use param_set_inner with InnerDeviceName="${inner.name}"] ${automationHint}`);
          if (inner.parameters && Object.keys(inner.parameters).length) {
            lines.push(`      params: ${Object.entries(inner.parameters).map(([k, v]) => _fmtParam(k, v)).join(', ')}`);
          } else {
            lines.push(`      [no parameters exposed — third-party plugin not configured in Live]`);
          }
          if (innerIsRack) {
            for (const nested of inner.innerDevices) {
              lines.push(`      ┗ ${nested.name}${nested.enabled === false ? ' (bypassed)' : ''}`);
              if (nested.parameters && Object.keys(nested.parameters).length) {
                lines.push(`        params: ${Object.entries(nested.parameters).map(([k, v]) => _fmtParam(k, v)).join(', ')}`);
              }
            }
          }
        }
      } else {
        if (d.parameters && Object.keys(d.parameters).length) {
          lines.push(`    params: ${Object.entries(d.parameters).map(([k, v]) => _fmtParam(k, v)).join(', ')}`);
        } else {
          lines.push(`    [no parameters exposed — third-party plugin not accessible through Live's API]`);
        }
      }
    }
    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Reset all in-memory session state.
 * Called when switching project or conversation so the next initConversation()
 * starts from a clean slate and reads everything fresh from Live.
 */
function resetAll() {
  _session        = null;
  _browserList    = null;
  _annotatedState = null;
  _fullSnapshot   = null;
  console.log('[sync] All caches cleared.');
}

module.exports = {
  setBridgeFn,
  fetchSession, getSession, clearSession,
  fetchTrackDetails,
  snapshot, getFullSnapshot, clearFullSnapshot,
  fetchBrowser, getBrowser, invalidateBrowser,
  getSessionState, setSessionState,
  resetAll,
  formatSessionForPrompt, formatDevicesForPrompt,
};
