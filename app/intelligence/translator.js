/**
 * translator.js — Deterministic session analysis layer.
 *
 * Handles what an LLM can't do reliably:
 *   1. Role inference — track name → mixing role (kick, bass, vocal, bus, etc.)
 *   2. Track-level flags — muted, no devices, missing master limiter, etc.
 *   3. Cross-track analysis — frequency masking, solo conflicts, clipping risk
 *
 * Device-level analysis (compressor settings, EQ curves, reverb tails, etc.)
 * is handled by the LLM with RAG context from the knowledge base.
 * The LLM sees raw parameter values and has audio engineering books to
 * reason about them — it doesn't need hardcoded rules for that.
 *
 * Knowledge source for cross-track rules: Owsinski (MEH), Senior (Mixing Secrets)
 */

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

/**
 * Translate a raw session state object.
 * Populates _role and _trackFlags on every track.
 * Devices are passed through unmodified — the LLM handles device analysis.
 *
 * @param {object} rawState - Output from sync.js
 * @returns {object} State with roles, track flags, and cross-track flags
 */
function translateSession(rawState) {
  if (!rawState?.tracks?.length) return rawState;

  const tracks = rawState.tracks.map(t => translateTrack(t));
  const crossFlags = detectCrossTrackIssues(tracks, rawState.tempo);

  // Attach cross-track flags to relevant tracks
  for (const { trackIndex, flag } of crossFlags) {
    const t = tracks[trackIndex];
    if (t) t._trackFlags = [...(t._trackFlags || []), flag];
  }

  return { ...rawState, tracks, _translatedAt: new Date().toISOString() };
}

/**
 * Translate a single track — role + track-level flags only.
 * Devices pass through with their raw parameters intact for LLM analysis.
 */
function translateTrack(track) {
  const role = inferRole(track);
  const devices = (track.devices || []).map(d => {
    const translated = {
      ...d,
      _annotation: null,
      _flags: [],
      _translationConfidence: 'none',
    };
    // Also translate inner devices inside Racks
    if (d.isRack && d.innerDevices?.length) {
      translated.innerDevices = d.innerDevices.map(inner => ({
        ...inner,
        _annotation: null,
        _flags: [],
        _translationConfidence: 'none',
      }));
    }
    return translated;
  });
  const trackFlags = buildTrackFlags(track, devices, role);

  return {
    ...track,
    _role: role,
    _trackFlags: trackFlags,
    devices,
  };
}

// ─── ROLE INFERENCE ──────────────────────────────────────────────────────────
//
// Infer what a track IS from its name and type.
// Used by the LLM to contextualise device analysis ("compressor on a kick"
// means something different from "compressor on a vocal bus").

const ROLE_PATTERNS = [
  // Drums — specific pieces
  [/\bkick\b/i,                   'kick'],
  [/\bsnare\b/i,                  'snare'],
  [/\b(hi.?hat|hh|hat)\b/i,       'hihat'],
  [/\b(overhead|oh)\b/i,          'overhead'],
  [/\b(room|ambience|amb)\b/i,    'drum-room'],
  [/\btom/i,                      'tom'],
  [/\bclap\b/i,                   'clap'],
  [/\bperc\b/i,                   'percussion'],
  [/\b(drum|kit|trap|beat)s?\b/i, 'drum-group'],

  // Bass
  [/\bbass\b(?!.*(bus|group|sum))/i, 'bass'],
  [/\b808\b/i,                    '808'],
  [/\bsub\b/i,                    'sub-bass'],

  // Harmonic / melodic
  [/\b(lead|ld|melody)\b/i,       'lead-synth'],
  [/\b(pad|atmosphere|atmo)\b/i,  'pad'],
  [/\b(chord|chords|harm)\b/i,    'chords'],
  [/\b(piano|keys|keyboard)\b/i,  'keys'],
  [/\b(guitar|gtr)\b/i,           'guitar'],
  [/\b(synth|syn)\b/i,            'synth'],
  [/\barp\b/i,                    'arp'],
  [/\bpluck\b/i,                  'pluck'],

  // Vocals
  [/\b(vox|vocal|voc|voice|lead.?vox|main.?vox)\b/i, 'lead-vocal'],
  [/\b(bgv|bv|back|chorus.?vox|harmony)\b/i,         'backing-vocal'],
  [/\b(adlib|ad.?lib|layer)\b/i,  'vocal-layer'],

  // FX / sound design
  [/\b(fx|sfx|riser|sweep|impact|foley)\b/i, 'fx'],
  [/\b(sample|loop|chop)\b/i,     'sample'],

  // Buses / groups / routing
  [/\b(drum.?bus|drum.?group|drum.?sum)\b/i,   'drum-bus'],
  [/\b(bass.?bus|bass.?group)\b/i,             'bass-bus'],
  [/\b(vocal.?bus|vox.?bus)\b/i,               'vocal-bus'],
  [/\b(mix.?bus|master.?bus|main.?bus)\b/i,    'mix-bus'],
  [/\b(bus|group|sum|buss)\b/i,                'bus'],

  // Special
  [/\b(master|mst)\b/i,           'master'],
  [/\b(return|rev|delay|fx.?track)\b/i, 'return'],
  [/\b(sidechain|sc)\b/i,         'sidechain-source'],
];

function inferRole(track) {
  const name = (track.name || '').trim();

  // Use Ableton track type first
  if (track.type === 'master') return 'master';
  if (track.type === 'return') return 'return';

  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(name)) return role;
  }

  return 'unknown';
}

// ─── TRACK-LEVEL FLAGS ───────────────────────────────────────────────────────
//
// Structural issues that don't need an LLM — just reading mixer state.

function buildTrackFlags(track, devices, role) {
  const flags = [];

  if (track.muted) {
    flags.push('Track is muted — may be a forgotten arrangement choice');
  }

  // Flatten device list: include inner devices from Racks for analysis
  const allDeviceNames = [];
  for (const d of (devices || [])) {
    allDeviceNames.push(d.name || '');
    if (d.isRack && d.innerDevices?.length) {
      for (const inner of d.innerDevices) allDeviceNames.push(inner.name || '');
    }
  }

  if (!allDeviceNames.length) {
    flags.push('No devices loaded — raw signal');
  }

  // Limiter missing from master — check all device names including inner Rack devices
  if (role === 'master') {
    const hasLimiter = allDeviceNames.some(name =>
      /limiter|limit|l1|l2|l3|maximizer|true peak|ceiling/i.test(name)
    );
    if (!hasLimiter) {
      flags.push('No limiter on master chain — output level uncontrolled, clipping risk');
    }
  }

  if (!track.muted && track.volume !== undefined && track.volume < 0.05) {
    flags.push('Volume near zero — effectively silent but not muted');
  }

  if (track.pan !== undefined && Math.abs(track.pan) > 0.9 && !['percussion', 'fx'].includes(role)) {
    flags.push(`Hard pan (${track.pan > 0 ? 'right' : 'left'}) — verify mono compatibility`);
  }

  return flags;
}

// ─── CROSS-TRACK ANALYSIS ────────────────────────────────────────────────────
//
// Inter-track issues that require comparing values across the session.
// An LLM can do this in theory but is unreliable with numerical comparisons
// across multiple tracks in a single prompt.

function detectCrossTrackIssues(tracks, tempo) {
  const crossFlags = [];

  // ── Bass vs Kick low-end competition ─────────────────────────────────────
  // Look for EQ boosts in overlapping low-frequency ranges.
  // Uses Ableton EQ Eight parameter naming to find boost frequencies.
  const kick = tracks.find(t => t._role === 'kick');
  const bass = tracks.find(t => t._role === 'bass' || t._role === '808' || t._role === 'sub-bass');

  if (kick && bass) {
    const kickBoostFreq = getLowestBoostFrequency(kick);
    const bassBoostFreq = getLowestBoostFrequency(bass);

    if (kickBoostFreq && bassBoostFreq) {
      const overlap = Math.abs(kickBoostFreq - bassBoostFreq) < 40;
      if (overlap) {
        crossFlags.push({
          trackIndex: kick.index,
          flag: `Kick boosted at ~${Math.round(kickBoostFreq)} Hz — close to bass boost at ~${Math.round(bassBoostFreq)} Hz. Frequency masking risk.`,
        });
        crossFlags.push({
          trackIndex: bass.index,
          flag: `Bass boosted at ~${Math.round(bassBoostFreq)} Hz — close to kick boost at ~${Math.round(kickBoostFreq)} Hz. Consider offsetting fundamentals.`,
        });
      }
    }
  }

  // ── Multiple tracks soloed ────────────────────────────────────────────────
  const soloedTracks = tracks.filter(t => t.solo);
  if (soloedTracks.length > 1) {
    for (const t of soloedTracks) {
      crossFlags.push({ trackIndex: t.index, flag: 'Multiple tracks soloed — mix balance may be misleading' });
    }
  }

  // ── No master limiter + high volume tracks ────────────────────────────────
  const masterTrack = tracks.find(t => t._role === 'master');
  if (masterTrack) {
    const hasLimiter = (masterTrack.devices || []).some(d =>
      /limiter|limit|l1|l2|l3|maximizer|true peak|ceiling/i.test(d.name || '')
    );
    if (!hasLimiter) {
      const loudTracks = tracks.filter(t => t.volume !== undefined && t.volume > 1.0);
      if (loudTracks.length > 0) {
        crossFlags.push({
          trackIndex: masterTrack.index,
          flag: `No limiter on master + ${loudTracks.length} track(s) pushed above unity — clipping risk`,
        });
      }
    }
  }

  return crossFlags;
}

// ─── UTILITY ─────────────────────────────────────────────────────────────────

/**
 * Find the lowest EQ boost frequency on a track (for cross-track masking check).
 * Scans devices for Ableton EQ Eight parameter naming convention.
 */
function getLowestBoostFrequency(track) {
  // Collect all devices including those inside Racks
  const allDevices = [];
  for (const device of (track.devices || [])) {
    allDevices.push(device);
    if (device.isRack && device.innerDevices?.length) {
      for (const inner of device.innerDevices) allDevices.push(inner);
    }
  }

  for (const device of allDevices) {
    const params = device.parameters || {};
    const boosts = [];

    // Ableton EQ Eight: "1 Freq A", "1 Gain A" through "8 Freq A", "8 Gain A"
    for (let i = 1; i <= 8; i++) {
      const freq = parseFloat(params[`${i} Freq A`]?.value ?? params[`${i} Freq A`] ?? NaN);
      const gain = parseFloat(params[`${i} Gain A`]?.value ?? params[`${i} Gain A`] ?? NaN);
      if (!isNaN(freq) && !isNaN(gain) && gain > 3 && freq < 300) {
        boosts.push(freq);
      }
    }

    if (boosts.length) return Math.min(...boosts);
  }
  return null;
}

module.exports = {
  translateSession,
  translateTrack,
  inferRole,
};
