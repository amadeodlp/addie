/**
 * actions.js — Action execution.
 *
 * PHILOSOPHY: Before any device action, always re-read the target track from Live.
 * No caching assumptions. No phase classification. No hasTier3 gate.
 *
 * For param_set:
 *   1. Fetch fresh track data from Live
 *   2. Execute param_set with real parameter context available
 *
 * For browser_insert + param_set in the same batch:
 *   1. Execute browser_insert
 *   2. Wait for Live to register the device
 *   3. Re-fetch the track
 *   4. Execute param_set (device is now loaded, parameters are known)
 *
 * Error correction: one LLM-assisted retry per failed action.
 */

const sync    = require('./sync');
const bridge  = require('../services/bridge');
const presets = require('../plugins/presets');
const llm     = require('../services/llm');

async function executeActions(llmReply, sendToBridge, sendStatus, modelConfig) {
  const matches = [...llmReply.matchAll(/```action\n([\s\S]+?)\n```/g)];
  if (!matches.length) return null;

  const parsed = matches.map(m => {
    const body  = m[1].trim();
    const parts = body.includes('|') ? body.split('|').map(s => s.trim()) : body.split(/\s+/);
    return { body, command: parts[0], trackName: _extractTrackName(parts) };
  });

  // Auto-prepend create_track for any browser_insert targeting a track that doesn't exist yet.
  // constraint: browser-insert-needs-existing-track
  // NOTE: This safety net only covers audio/MIDI tracks. Return tracks must be created
  // explicitly via create_return in the LLM plan. Return tracks that already exist, or
  // that are being created in the same batch via create_return, are excluded from the
  // auto-prepend by including returnTracks in the known-names set below.
  // Use a live-fetch if session is null (e.g. cleared after a create_return earlier in the batch).
  let _tier1 = sync.getSession();
  if (!_tier1 && bridge.isDetected()) {
    try { _tier1 = await sync.fetchSession(); } catch { /* best-effort */ }
  }
  // Include both regular tracks AND return tracks so that browser_insert targeting a
  // just-created return (e.g. "Parallel Compression") is not mistaken for a missing
  // audio/MIDI track and incorrectly auto-prepended with create_track.
  const tier1TrackNames = new Set([
    ...(_tier1?.tracks       || []).map(t => t.name.toLowerCase()),
    ...(_tier1?.returnTracks || []).map(t => t.name.toLowerCase()),
  ]);

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.command !== 'browser_insert' || !p.trackName) continue;
    const tn = p.trackName.toLowerCase();
    if (tier1TrackNames.has(tn)) continue;
    // Also skip if the track is being created earlier in this same batch,
    // either as a regular track (create_track) or a return track (create_return).
    const alreadyCreating = parsed.slice(0, i).some(
      prev => (prev.command === 'create_track' || prev.command === 'create_return')
               && prev.body.toLowerCase().includes(tn)
    );
    if (!alreadyCreating) {
      console.log(`[action] Auto-prepending create_track for missing track: "${p.trackName}"`);
      parsed.splice(i, 0, { body: `create_track | audio | ${p.trackName}`, command: 'create_track', trackName: null });
      tier1TrackNames.add(tn);
    }
  }

  bridge.setBusy(true);
  const results = [];

  // Guard: if create_track has a type that is not 'audio' or 'midi', the LLM
  // likely confused create_track with browser_insert — convert it silently.
  // e.g. "create_track | 1-Drums | Channel EQ" → "browser_insert | 1-Drums | Channel EQ"
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].command !== 'create_track') continue;
    const parts = parsed[i].body.split('|').map(s => s.trim());
    const type  = (parts[1] || '').toLowerCase();
    if (type !== 'audio' && type !== 'midi') {
      const trackName  = parts[1];
      const deviceName = parts[2];
      if (trackName && deviceName) {
        console.warn(`[action] create_track with non-standard type "${trackName}" — converting to browser_insert | ${trackName} | ${deviceName}`);
        const newBody = `browser_insert | ${trackName} | ${deviceName}`;
        parsed[i] = { body: newBody, command: 'browser_insert', trackName };
      }
    }
  }

  // Structural commands — if one fails after retry, the remaining batch is
  // cancelled. Subsequent actions were planned against a world that no longer
  // exists (wrong device chain, missing track, etc.).
  const STRUCTURAL = new Set([
    'browser_insert', 'delete_device', 'move_device',
    'create_track', 'delete_track', 'duplicate_track',
    'group_tracks', 'ungroup_tracks',
    'create_return', 'delete_return',
  ]);

  let haltReason = null; // set when a structural failure stops the batch

  try {
    for (let i = 0; i < parsed.length; i++) {
      const { body: actionBody, command, trackName } = parsed[i];
      const isDeviceAction = command === 'param_set' || command === 'param_set_inner';
      const isLoadAction   = command === 'browser_insert';
      const isDeleteAction = command === 'delete_device';
      const isStructural   = STRUCTURAL.has(command);

      // If a prior structural action failed, mark remaining actions as skipped
      if (haltReason) {
        results.push({
          success:  false,
          skipped:  true,
          command,
          args:     parsed[i].body,
          raw:      parsed[i].body,
          error:    `Skipped — batch halted by prior failure: ${haltReason}`,
        });
        continue;
      }

      // Structural actions need a short delay before proceeding
      const needsDelay = /^(browser_insert|create_track|create_return|delete_track|group_tracks)/.test(command);
      if (i > 0 && needsDelay) await new Promise(r => setTimeout(r, 1500));

      sendStatus(`Executing ${i + 1}/${parsed.length}...`);

      // For device actions: re-fetch the track first so we have current state
      if ((isDeviceAction || isLoadAction || isDeleteAction) && trackName && bridge.isDetected()) {
        await _resyncTrack(trackName);
      }

      // Snapshot track names BEFORE any action that may cause Ableton to rename
      // a track. Used by _syncTier1AndPatchBatch to detect renames by position diff.
      let preActionTrackNames = null;
      if ((isLoadAction || isDeleteAction) && trackName && bridge.isDetected()) {
        const pre = sync.getSession();
        preActionTrackNames = pre?.tracks?.map(t => t.name) ?? null;
      }

      const result = await executeSingleAction(actionBody, sendToBridge, sendStatus);

      // After a successful browser_insert: wait for Live to register the device,
      // re-fetch device details, then re-fetch Tier 1 to catch any track rename
      // that Ableton performs when an instrument VST is loaded.
      // constraint: track-rename-on-instrument-load
      if (isLoadAction && result.success && trackName) {
        sendStatus(`Verifying load on ${trackName}...`);
        await new Promise(r => setTimeout(r, 2000));
        const fresh = await _resyncTrack(trackName);
        const deviceNames = (fresh?.devices || []).map(d => d.name);
        const totalParams = (fresh?.devices || []).reduce(
          (n, d) => n + Object.keys(d.parameters || {}).length +
            (d.innerDevices || []).reduce((m, id) => m + Object.keys(id.parameters || {}).length, 0), 0
        );
        result.note = `Loaded and confirmed. Devices: ${deviceNames.join(', ')}. ${totalParams} parameters exposed.`;

        // Re-fetch Tier 1 and patch the batch if Ableton renamed the track
        await _syncTier1AndPatchBatch(trackName, parsed, i, result, 0, preActionTrackNames);
      }

      // After a successful delete_device: Ableton may auto-rename the track.
      // Same patch logic as browser_insert above.
      // constraint: track-rename-on-instrument-load
      if (isDeleteAction && result.success && trackName) {
        await _syncTier1AndPatchBatch(trackName, parsed, i, result, 500, preActionTrackNames);
      }

      // After a successful create_track: verify the track was actually named as
      // expected. If Live failed to apply the name (returned a default like "Audio"),
      // patch all subsequent actions that reference the intended name so they use
      // the real name that exists in Live.
      if (command === 'create_track' && result.success) {
        const intendedName = parsed[i].body.split('|').map(s => s.trim())[2]; // args[1] = name
        const actualName   = result.result?.name;

        // Warn if the created track has the same name as an existing track —
        // likely the LLM confused create_track with browser_insert.
        if (intendedName) {
          const session = sync.getSession();
          const existingNames = (session?.tracks || []).map(t => t.name.toLowerCase());
          if (existingNames.includes(intendedName.toLowerCase())) {
            console.warn(`[action] create_track named "${intendedName}" but a track with that name already exists — LLM may have confused create_track with browser_insert.`);
            result.note = (result.note ? result.note + ' ' : '') +
              `Warning: a track named "${intendedName}" already existed. If the intent was to load a device, use browser_insert instead.`;
          }
        }

        if (intendedName && actualName && actualName.toLowerCase() !== intendedName.toLowerCase()) {
          console.warn(`[action] create_track name mismatch: expected "${intendedName}", got "${actualName}". Patching batch.`);
          result.note = `Track created as "${actualName}" (intended: "${intendedName}").`;
          for (let j = i + 1; j < parsed.length; j++) {
            if (parsed[j].trackName?.toLowerCase() === intendedName.toLowerCase()) {
              const parts = parsed[j].body.split('|').map(s => s.trim());
              if (parts[1]?.toLowerCase() === intendedName.toLowerCase()) {
                parts[1] = actualName;
                parsed[j].body      = parts.join(' | ');
                parsed[j].trackName = actualName;
                console.log(`[action] Patched action [${j+1}]: trackName "${intendedName}" → "${actualName}"`);
              }
            }
          }
        }
      }

      // On failure: handle create_clip slot conflicts deterministically before
      // falling through to the LLM retry system.
      if (!result.success && command === 'create_clip' && /already has a clip/i.test(result.error)) {
        const redirected = await _redirectClipToFreeSlot(parsed, i, sendToBridge, sendStatus);
        if (redirected) {
          results.push(redirected);
          continue;
        }
        // Could not find a free slot — fall through to normal failure handling
      }

      // On failure: one LLM-assisted retry
      if (!result.success) {
        console.warn(`[action] Failed (attempt 1): ${actionBody} — ${result.error}`);
        sendStatus(`Action ${i + 1} failed — analyzing error...`);
        const corrected = await analyzeAndCorrectAction(actionBody, result.error, sendToBridge, modelConfig);

        if (corrected) {
          sendStatus(`Retrying action ${i + 1}...`);
          if (needsDelay) await new Promise(r => setTimeout(r, 1500));
          const retryResult = await executeSingleAction(corrected, sendToBridge, sendStatus);
          if (retryResult.success) {
            retryResult.retried         = true;
            retryResult.originalAction  = actionBody;
            retryResult.correctedAction = corrected;
            retryResult.firstError      = result.error;
            results.push(retryResult);
            continue;
          } else {
            result.retryAction = corrected;
            result.retryError  = retryResult.error;
          }
        } else {
          result.retrySkipped = true;
        }

        // Structural failure after retry — halt the rest of the batch
        if (isStructural) {
          haltReason = `[${i + 1}] ${command} failed: ${result.error}`;
          console.warn(`[action] Structural failure — halting batch. Reason: ${haltReason}`);
        }
      }

      results.push(result);
    }
  } finally {
    bridge.setBusy(false);
  }

  return results;
}

/**
 * Re-fetch Tier 1 after an action that may cause Ableton to rename a track
 * (browser_insert of an instrument VST, delete_device, etc.).
 * If the track name changed, patches all subsequent parsed actions in the batch.
 *
 * Uses preActionTrackNames (captured just before the action executed) to detect
 * the rename by positional diff — avoids stale/mutated _fullSnapshot entirely.
 *
 * Returns the new track name if renamed, null otherwise.
 */
async function _syncTier1AndPatchBatch(trackName, parsed, currentIndex, result, delayMs = 0, preActionTrackNames = null) {
  try {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    const freshTier1  = await sync.fetchSession();
    const freshTracks = freshTier1?.tracks || [];
    const freshNames  = freshTracks.map(t => t.name);
    const oldNameLower = trackName.toLowerCase();

    // If the old name still exists in the fresh snapshot, nothing changed
    if (freshNames.some(n => n.toLowerCase() === oldNameLower)) return null;

    // Find the new name using positional diff against the pre-action snapshot.
    // The track that was at position N before the action and is now different at
    // position N is the one Ableton renamed.
    let newName = null;
    if (preActionTrackNames?.length) {
      const oldIndex = preActionTrackNames.findIndex(n => n.toLowerCase() === oldNameLower);
      if (oldIndex >= 0 && oldIndex < freshNames.length) {
        const candidate = freshNames[oldIndex];
        if (candidate.toLowerCase() !== oldNameLower) newName = candidate;
      }
    }

    if (!newName) {
      console.warn(`[action] Track "${trackName}" disappeared but could not determine new name — patch skipped.`);
      return null;
    }

    console.log(`[action] Track renamed by Ableton: "${trackName}" → "${newName}"`);
    result.note = (result.note ? result.note + ' ' : '') +
      `Track renamed by Ableton to "${newName}".`;

    // Patch all remaining actions in the batch that reference the old name
    for (let j = currentIndex + 1; j < parsed.length; j++) {
      if (parsed[j].trackName?.toLowerCase() !== oldNameLower) continue;
      const oldBody = parsed[j].body;
      const parts = oldBody.split('|').map(s => s.trim());
      if (parts[1]?.toLowerCase() === oldNameLower) {
        parts[1] = newName;
        parsed[j].body = parts.join(' | ');
        parsed[j].trackName = newName;
        console.log(`[action] Patched action [${j+1}]: "${oldBody}" → "${parsed[j].body}"`);
      }
    }

    return newName;
  } catch (e) {
    console.warn(`[action] _syncTier1AndPatchBatch failed for "${trackName}" (non-fatal):`, e.message);
    return null;
  }
}

/**
 * Re-fetch a single track from Live and update the sync cache.
 * Returns the fresh track object, or null on failure.
 */
async function _resyncTrack(trackName) {
  try {
    const result = await sync.fetchTrackDetails([trackName]);
    return result.tracks?.[0] || null;
  } catch (e) {
    console.warn(`[action] _resyncTrack failed for "${trackName}":`, e.message);
    return null;
  }
}

/**
 * When create_clip fails because the target slot is occupied, find the next
 * free slot by querying Live directly, retry create_clip there, and patch all
 * subsequent actions in the batch that reference the original slot+track combo.
 *
 * Slot-sensitive commands patched: set_clip_notes, get_clip_notes, set_clip_name,
 * delete_clip, create_automation, read_automation, clear_automation.
 *
 * Returns a result object (with .redirected = true) on success, or null if no
 * free slot was found or the retry failed.
 */
async function _redirectClipToFreeSlot(parsed, currentIndex, sendToBridge, sendStatus) {
  const action    = parsed[currentIndex];
  const parts     = action.body.split('|').map(s => s.trim());
  const trackName = parts[1];
  const origSlot  = parseInt(parts[2], 10);
  const length    = parts[3];

  if (!trackName || isNaN(origSlot) || !length) return null;

  // Ask Live for the current clip layout on this track
  let freeSlot = null;
  try {
    const clips = await sendToBridge('get_clips', { trackNames: [trackName] }, 8000);
    const slots = clips?.tracks?.[0]?.clipSlots || [];
    // Find the first empty slot at or after the originally planned slot
    for (let s = origSlot; s < Math.max(slots.length, origSlot + 16); s++) {
      const slot = slots[s];
      if (!slot || !slot.hasClip) { freeSlot = s; break; }
    }
  } catch (e) {
    console.warn(`[action] _redirectClipToFreeSlot: get_clips failed (${e.message})`);
    return null;
  }

  if (freeSlot === null) {
    console.warn(`[action] _redirectClipToFreeSlot: no free slot found for "${trackName}" starting at ${origSlot}`);
    return null;
  }

  console.log(`[action] Slot ${origSlot} occupied on "${trackName}" — redirecting to slot ${freeSlot}`);

  // Retry create_clip on the free slot
  const newBody   = `create_clip | ${trackName} | ${freeSlot} | ${length}`;
  sendStatus(`Redirecting clip to slot ${freeSlot}...`);
  const retryResult = await executeSingleAction(newBody, sendToBridge, sendStatus);
  if (!retryResult.success) {
    console.warn(`[action] _redirectClipToFreeSlot: retry on slot ${freeSlot} also failed: ${retryResult.error}`);
    return null;
  }

  // Patch all subsequent slot-sensitive actions on the same track that reference origSlot
  const SLOT_COMMANDS = new Set([
    'set_clip_notes', 'get_clip_notes', 'set_clip_name',
    'delete_clip', 'create_automation', 'read_automation', 'clear_automation',
  ]);
  const trackLower = trackName.toLowerCase();
  for (let j = currentIndex + 1; j < parsed.length; j++) {
    const p = parsed[j];
    if (!SLOT_COMMANDS.has(p.command)) continue;
    const pparts = p.body.split('|').map(s => s.trim());
    if (pparts[1]?.toLowerCase() !== trackLower) continue;
    if (parseInt(pparts[2], 10) !== origSlot) continue;
    pparts[2] = String(freeSlot);
    parsed[j].body = pparts.join(' | ');
    console.log(`[action] Patched action [${j+1}] slot ${origSlot} → ${freeSlot}: ${parsed[j].body}`);
  }

  retryResult.redirected      = true;
  retryResult.originalSlot    = origSlot;
  retryResult.redirectedSlot  = freeSlot;
  retryResult.note = `Slot ${origSlot} was occupied — clip created in slot ${freeSlot} instead.`;
  return retryResult;
}

// --- SINGLE ACTION EXECUTOR --------------------------------------------------

async function executeSingleAction(actionBody, sendToBridge, sendStatus) {
  let parts;
  if (actionBody.includes('|')) {
    parts = actionBody.split('|').map(s => s.trim());
  } else {
    parts = actionBody.split(/\s+/);
  }
  let command = parts[0];
  const args  = parts.slice(1);

  sendStatus(`Executing: ${command}`);

  let params = {}, trackName = null;

  if (command === 'param_set' && args.length >= 4) {
    trackName = args[0];
    params = { trackName, deviceName: args[1], paramName: args[2], value: args.slice(3).join(' ').trim() };
  } else if (command === 'param_set_inner' && args.length >= 4) {
    trackName = args[0];
    if (args.length >= 5) {
      // Full form: param_set_inner | Track | RackName | InnerDeviceName | ParamName | value
      params = { trackName, deviceName: args[1], innerDeviceName: args[2], paramName: args[3], value: args.slice(4).join(' ').trim() };
    } else {
      // Short form (4 args): LLM omitted InnerDeviceName — auto-resolve from cache.
      // param_set_inner | Track | RackName | ParamName | value
      // Find the single inner device inside the named rack and use it.
      const rackName = args[1];
      const paramName = args[2];
      const value = args[3];
      let innerDeviceName = null;
      try {
        const cachedTrack = sync.getFullSnapshot()?.tracks?.find(
          t => t.name.toLowerCase() === trackName.toLowerCase()
        );
        const rack = cachedTrack?.devices?.find(
          d => d.name.toLowerCase().includes(rackName.toLowerCase()) && d.isRack
        );
        if (rack?.innerDevices?.length === 1) {
          innerDeviceName = rack.innerDevices[0].name;
          console.log(`[action] param_set_inner short-form: auto-resolved inner device "${innerDeviceName}" for rack "${rackName}"`);
        } else if (rack?.innerDevices?.length > 1) {
          const inner = rack.innerDevices.find(id =>
            Object.keys(id.parameters || {}).some(k => k.toLowerCase() === paramName.toLowerCase())
          );
          if (inner) {
            innerDeviceName = inner.name;
            console.log(`[action] param_set_inner short-form: resolved inner device "${innerDeviceName}" by param match`);
          }
        }
      } catch { /* best-effort */ }
      if (innerDeviceName) {
        params = { trackName, deviceName: rackName, innerDeviceName, paramName, value };
      } else {
        // Can't resolve — fall through to error path with a clear message
        return { success: false, error: `param_set_inner: could not auto-resolve inner device for rack "${rackName}" on track "${trackName}". Include InnerDeviceName explicitly: param_set_inner | ${trackName} | ${rackName} | InnerDeviceName | ${paramName} | ${value}` };
      }
    }
    command = 'param_set';
  } else if (command === 'browser_insert' && args.length >= 2) {
    trackName = args[0];
    const rawDeviceName = args.slice(1).join(' ');
    const presetName = presets.getPresetName(rawDeviceName);
    if (presetName) console.log(`[presets] Intercepting: "${rawDeviceName}" → "${presetName}"`);
    params = { trackName, deviceName: presetName || rawDeviceName };
  } else if (command === 'delete_device' && args.length >= 2) {
    trackName = args[0];
    params = { trackName, deviceName: args[1] };
  } else if (command === 'move_device' && args.length >= 3) {
    trackName = args[0];
    params = { trackName, deviceName: args[1], newIndex: parseInt(args[2], 10) };
  } else if (command === 'enable_device' && args.length >= 3) {
    trackName = args[0];
    // enable_device | TrackName | DeviceName | true/false
    // enable_device | TrackName | RackName | InnerDeviceName | true/false
    if (args.length >= 4 && (args[3] === 'true' || args[3] === 'false')) {
      params = { trackName, deviceName: args[1], innerDeviceName: args[2], enabled: args[3] !== 'false' };
    } else {
      params = { trackName, deviceName: args[1], enabled: args[2] !== 'false' };
    }
  } else if (command === 'create_track' && args.length >= 1) {
    params = { type: args[0] || 'audio', index: -1 };
    if (args[1]) params.name = args[1];
  } else if (command === 'delete_track' && args.length >= 1) {
    params = { trackName: args[0] };
  } else if (command === 'rename_track' && args.length >= 2) {
    trackName = args[0];
    params = { trackName, newName: args[1] };
  } else if (command === 'duplicate_track' && args.length >= 1) {
    trackName = args[0];
    params = { trackName };
  } else if (command === 'set_track_color' && args.length >= 2) {
    trackName = args[0];
    params = { trackName, colorIndex: parseInt(args[1], 10) };
  } else if (command === 'group_tracks' && args.length >= 1) {
    const trackNames = args[0].split(',').map(s => s.trim());
    params = { trackNames };
    if (args[1]) params.groupName = args[1];
  } else if (command === 'ungroup_tracks' && args.length >= 1) {
    params = { trackName: args[0] };
  } else if (command === 'set_mixer' && args.length >= 2) {
    trackName = args[0];
    params = { trackName };
    const kvRegex = /(volume|pan|send_[A-Z]):(.+?)(?=\s+(?:volume|pan|send_[A-Z]):|$)/gi;
    let match;
    while ((match = kvRegex.exec(args.slice(1).join(' '))) !== null) {
      const key = match[1].toLowerCase(), val = match[2].trim();
      if (key === 'volume') params.volume = val;
      else if (key === 'pan') params.pan = val;
      else { if (!params.sends) params.sends = {}; params.sends[key.replace('send_', '').toUpperCase()] = val; }
    }
  } else if (command === 'set_mute' && args.length >= 2) {
    trackName = args[0];
    params = { trackName, mute: args[1] !== 'false' };
  } else if (command === 'set_solo' && args.length >= 2) {
    trackName = args[0];
    params = { trackName, solo: args[1] !== 'false' };
  } else if (command === 'set_routing' && args.length >= 2) {
    trackName = args[0];
    params = { trackName };
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('output:'))          params.outputType    = arg.slice(7);
      else if (arg.startsWith('output_channel:')) params.outputChannel = arg.slice(15);
      else if (arg.startsWith('input:'))          params.inputType     = arg.slice(6);
      else if (arg.startsWith('input_channel:'))  params.inputChannel  = arg.slice(14);
    }
  } else if (command === 'get_routing_options' && args.length >= 1) {
    trackName = args[0];
    params = { trackName };
  } else if (command === 'create_return') {
    params = { name: args[0] || null };
  } else if (command === 'delete_return' && args.length >= 1) {
    params = { trackName: args[0] };
  } else if (command === 'set_tempo' && args.length >= 1) {
    params = { tempo: parseFloat(args[0]) };
  } else if (command === 'set_loop' && args.length >= 1) {
    params = {};
    for (const kv of (args.join(' ').match(/(\w+):([^\s]+)/g) || [])) {
      const [key, val] = kv.split(':');
      if (key === 'enabled') params.enabled = val === 'true';
      else if (key === 'start') params.start = parseFloat(val);
      else if (key === 'length') params.length = parseFloat(val);
    }
  } else if (command === 'create_clip' && args.length >= 3) {
    trackName = args[0];
    params = { trackName, slotIndex: parseInt(args[1], 10), length: parseFloat(args[2]) };
  } else if (command === 'delete_clip' && args.length >= 2) {
    trackName = args[0];
    params = { trackName, slotIndex: parseInt(args[1], 10) };
  } else if (command === 'set_clip_name' && args.length >= 3) {
    trackName = args[0];
    params = { trackName, slotIndex: parseInt(args[1], 10), name: args.slice(2).join(' ') };
  } else if (command === 'get_clip_notes' && args.length >= 2) {
    trackName = args[0];
    params = { trackName, slotIndex: parseInt(args[1], 10) };
  } else if (command === 'create_scene') {
    params = { index: args.length >= 1 ? parseInt(args[0], 10) : -1 };
  } else if (command === 'set_clip_notes' && args.length >= 3) {
    trackName = args[0];
    const notes = args.slice(2).join(' ').split(',').map(s => s.trim()).filter(Boolean).map(n => {
      const p = n.split(':').map(Number);
      return { pitch: isFinite(p[0]) ? p[0] : 60, start: isFinite(p[1]) ? p[1] : 0, duration: isFinite(p[2]) ? p[2] : 0.25, velocity: isFinite(p[3]) ? p[3] : 100 };
    });
    params = { trackName, slotIndex: parseInt(args[1], 10), notes, clearExisting: true };
  } else if (command === 'create_automation' && args.length >= 4) {
    // create_automation | TrackName | slotIndex | DeviceName | paramName | points: beat:value, ...
    // Also supports mixerParam variant: create_automation | TrackName | slotIndex | mixer | volume | points: ...
    trackName = args[0];
    const slotIndex = parseInt(args[1], 10);
    const deviceArg = args[2];
    const paramName = args[3];
    const pointsStr = args.slice(4).join(' ');
    const rawPoints = [];
    const pointMatches = pointsStr.matchAll(/([\d.]+)\s*:\s*(-?[\d.]+)/g);
    for (const m of pointMatches) rawPoints.push([parseFloat(m[1]), parseFloat(m[2])]);
    // Convert [beat, value] pairs → [time, value, duration] breakpoints.
    // Duration of each step = gap to next point (last step gets duration 0).
    const breakpoints = rawPoints.map(([beat, value], i) => {
      const nextBeat = i < rawPoints.length - 1 ? rawPoints[i + 1][0] : beat;
      const duration = i < rawPoints.length - 1 ? nextBeat - beat : 0;
      return [beat, value, duration];
    });
    if (deviceArg.toLowerCase() === 'mixer') {
      params = { trackName, slotIndex, mixerParam: paramName, breakpoints };
    } else {
      const [devName, innerName] = deviceArg.split('::').map(s => s.trim());
      params = innerName
        ? { trackName, slotIndex, deviceName: devName, innerDeviceName: innerName, paramName, breakpoints }
        : { trackName, slotIndex, deviceName: devName, paramName, breakpoints };
    }
  } else if (command === 'read_automation' && args.length >= 3) {
    // read_automation | TrackName | slotIndex | DeviceName | paramName
    trackName = args[0];
    const slotIndex = parseInt(args[1], 10);
    const deviceArg = args[2];
    const paramName = args[3] || '';
    if (deviceArg.toLowerCase() === 'mixer') {
      params = { trackName, slotIndex, mixerParam: paramName };
    } else {
      const [devName, innerName] = deviceArg.split('::').map(s => s.trim());
      params = innerName
        ? { trackName, slotIndex, deviceName: devName, innerDeviceName: innerName, paramName }
        : { trackName, slotIndex, deviceName: devName, paramName };
    }
  } else if (command === 'clear_automation' && args.length >= 3) {
    // clear_automation | TrackName | slotIndex | DeviceName | paramName
    trackName = args[0];
    const slotIndex = parseInt(args[1], 10);
    const deviceArg = args[2];
    const paramName = args[3] || '';
    if (deviceArg.toLowerCase() === 'mixer') {
      params = { trackName, slotIndex, mixerParam: paramName };
    } else {
      const [devName, innerName] = deviceArg.split('::').map(s => s.trim());
      params = innerName
        ? { trackName, slotIndex, deviceName: devName, innerDeviceName: innerName, paramName }
        : { trackName, slotIndex, deviceName: devName, paramName };
    }
  } else {
    return { success: false, error: 'Unknown or malformed action: ' + actionBody };
  }

  try {
    const timeout = (command === 'browser_insert' || command === 'create_track') ? 15000
      : command === 'set_clip_notes' ? 12000 : 8000;
    const result = await sendToBridge(command, params, timeout);

    // Read-back verification for set_clip_notes
    if (command === 'set_clip_notes' && result?.ok) {
      try {
        const rb = await sendToBridge('get_clip_notes', { trackName: params.trackName, slotIndex: params.slotIndex });
        return { success: true, result, trackName, command,
          verifiedDisplay: `${rb?.noteCount ?? '?'} notes written (expected ${params.notes?.length ?? '?'})`,
          mismatch: rb?.noteCount !== params.notes?.length && rb?.noteCount !== undefined };
      } catch { return { success: true, result, trackName, command }; }
    }

    // Read-back verification for param_set
    if (command === 'param_set') {
      const clampWarning = result?.warning || null;
      try {
        const readParams = { trackName: params.trackName, deviceName: params.deviceName, paramName: params.paramName };
        if (params.innerDeviceName !== undefined) readParams.innerDeviceName = params.innerDeviceName;
        const verified = await sendToBridge('param_get', readParams);
        return { success: true, verified: typeof verified === 'object' ? verified.value : verified,
          verifiedDisplay: verified.display, warning: clampWarning, mismatch: false,
          conversion: result?.resolved || result?.conversion || null, trackName, command };
      } catch { return { success: true, verified: null, verifiedDisplay: null, warning: clampWarning, mismatch: false, trackName, command }; }
    }

    // set_mixer result extraction
    if (command === 'set_mixer') {
      const mixParts = [];
      if (result.volumeDisplay) mixParts.push(`vol:${result.volumeDisplay}`);
      if (result.panDisplay)    mixParts.push(`pan:${result.panDisplay}`);
      if (result.sends) for (const [l, v] of Object.entries(result.sends)) {
        mixParts.push(result.sendDisplays?.[l] ? `send_${l}:${result.sendDisplays[l]}` : `send_${l}:raw ${v}`);
      }
      return { success: true, verified: null,
        verifiedDisplay: mixParts.join(', ') || null,
        warning: result.warnings?.length ? result.warnings.join('; ') : null,
        conversion: result.conversions?.length ? result.conversions.join('; ') : null,
        trackName, command };
    }

    // Bridge returned an error payload — surface it as a failure so the retry system kicks in.
    // Some handlers return { ok: false, error: '...' } instead of throwing.
    if (result?.error) {
      return { success: false, error: result.error, command };
    }

    // After structural changes, clear the session so the track list is re-fetched.
    // constraint: return-track-send-index (create_return changes send slot count)
    if (['create_track', 'delete_track', 'duplicate_track', 'group_tracks', 'ungroup_tracks',
         'create_return', 'delete_return', 'rename_track'].includes(command)) {
      sync.clearSession();
    }

    return { success: true, result, trackName: trackName || result?.name || result?.track, command };
  } catch (err) {
    return { success: false, error: err.message, command };
  }
}

// --- ERROR CORRECTION --------------------------------------------------------

async function analyzeAndCorrectAction(actionBody, errorMsg, sendToBridge, modelConfig) {
  try {
    let paramHint = '';
    if (/parameter not found/i.test(errorMsg)) {
      const parts   = actionBody.includes('|') ? actionBody.split('|').map(s => s.trim()) : actionBody.split(/\s+/);
      const command = parts[0];
      if ((command === 'param_set' || command === 'param_set_inner') && parts.length >= 4) {
        const trackName    = parts[1];
        const deviceName   = parts[2];
        const innerName    = command === 'param_set_inner' ? parts[3] : undefined;
        try {
          const snapshot = await sendToBridge('snapshot', { trackNames: [trackName] });
          const devices  = snapshot?.tracks?.[0]?.devices || [];
          let targetDevice;
          if (innerName) {
            // find rack by name, then inner device by name
            const rack = devices.find(d => d.name.toLowerCase().includes(deviceName.toLowerCase()));
            targetDevice = rack?.innerDevices?.find(id => id.name.toLowerCase().includes(innerName.toLowerCase()));
          } else {
            targetDevice = devices.find(d => d.name.toLowerCase().includes(deviceName.toLowerCase()));
          }
          if (targetDevice?.parameters) {
            paramHint = `\nAvailable parameters on "${targetDevice.name}": ${Object.keys(targetDevice.parameters).join(', ')}`;
          } else {
            // Show all devices on the track so the LLM can pick the right one
            const deviceList = devices.map(d => {
              const inner = d.innerDevices?.length ? ` [rack: ${d.innerDevices.map(id => id.name).join(', ')}]` : '';
              return `${d.name}${inner}`;
            }).join('; ');
            paramHint = `\nDevice "${deviceName}" not found. Devices on track "${trackName}": ${deviceList}`;
          }
        } catch { /* best-effort */ }
      }
    }

    const result = await llm.chat({
      apiKey:   modelConfig.apiKey,
      baseURL:  modelConfig.endpoint,
      modelId:  modelConfig.modelId,
      messages: [{ role: 'user', content: `An Ableton action failed. Return ONLY the corrected pipe-delimited action, or NO_FIX.\n\nFailed: ${actionBody}\nError: ${errorMsg}${paramHint}` }],
      systemPrompt: `You fix Ableton Live control surface actions. Rules:
- Return ONLY a corrected version of the SAME command that failed, or NO_FIX.
- NEVER change the command type. If create_clip failed, return a corrected create_clip — not delete_clip, not create_track, not anything else.
- NEVER return a destructive command (delete_clip, delete_track, delete_device, delete_return) as a correction.
- Fix only: wrong parameter names, wrong value formats, wrong syntax. If the error is a state problem (slot occupied, track missing, etc.), return NO_FIX.
- For quantized params, use the EXACT choice name. For continuous params, use display units.`,
      maxTokens: 200,
    });

    if (result.error || !result.text) return null;
    const corrected = result.text.trim().replace(/^```.*\n?/, '').replace(/\n?```$/, '').trim();
    if (corrected === 'NO_FIX' || corrected.length < 5) return null;

    // Safety gate: the corrected action must be the same command as the original.
    // Prevents the retry LLM from generating destructive or unrelated commands.
    const originalCommand = actionBody.split('|')[0].trim().toLowerCase();
    const correctedCommand = corrected.split('|')[0].trim().toLowerCase();
    if (correctedCommand !== originalCommand) {
      console.warn(`[action-retry] Rejected correction: command changed from "${originalCommand}" to "${correctedCommand}". Returning NO_FIX.`);
      return null;
    }

    return corrected;
  } catch (e) {
    console.error('[action-retry] LLM call failed:', e.message);
    return null;
  }
}

// --- HELPERS -----------------------------------------------------------------

function _extractTrackName(parts) {
  const command = parts[0];
  if (['create_scene', 'set_tempo', 'set_loop', 'set_time_signature'].includes(command)) return null;
  return parts[1] || null;
}

module.exports = { executeActions };
