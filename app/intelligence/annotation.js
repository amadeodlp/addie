/**
 * annotation.js — LLM-powered session analysis.
 *
 * The translator provides roles and structural flags (deterministic).
 * This module handles all device-level analysis — reads raw parameters
 * and uses LLM knowledge (+ RAG) to interpret what each device is doing.
 */

const llm        = require('../services/llm');
const translator = require('./translator');

const CHUNK_SIZE = 8;

async function annotateSession(rawState, modelConfig, onProgress) {
  if (!rawState?.tracks?.length) return rawState;

  if (onProgress) onProgress('Analyzing session structure...');
  const translated = translator.translateSession(rawState);

  const needsLLM = translated.tracks.filter(t => t.devices?.length > 0);
  const empty    = translated.tracks.filter(t => !t.devices?.length);

  console.log(
    `[annotation] ${needsLLM.length} track(s) with devices → LLM. ` +
    `${empty.length} empty track(s) skipped.`
  );

  if (needsLLM.length === 0) {
    if (onProgress) onProgress('No devices to analyze.');
    return { ...translated, annotatedAt: new Date().toISOString() };
  }

  const priority = needsLLM.filter(t => isPriorityTrack(t));
  const regular  = needsLLM.filter(t => !isPriorityTrack(t));
  const llmAnnotated = {};

  if (priority.length > 0) {
    if (onProgress) onProgress(`Analyzing ${priority.length} bus/master track(s)...`);
    const results = await annotateChunk(priority, translated, modelConfig);
    for (const t of results) llmAnnotated[t.index] = t;
  }

  for (let i = 0; i < regular.length; i += CHUNK_SIZE) {
    const chunk = regular.slice(i, i + CHUNK_SIZE);
    const end   = Math.min(i + CHUNK_SIZE, regular.length);
    if (onProgress) onProgress(`Analyzing tracks ${i + 1}-${end} of ${regular.length}...`);
    const results = await annotateChunk(chunk, translated, modelConfig);
    for (const t of results) llmAnnotated[t.index] = t;
  }

  const finalTracks = translated.tracks.map(t => llmAnnotated[t.index] ?? t);
  console.log('[annotation] Annotation complete.');
  return { ...translated, annotatedAt: new Date().toISOString(), tracks: finalTracks };
}

async function annotateChunk(chunk, fullSession, modelConfig) {
  const sessionContext = `
Session tempo: ${fullSession.tempo ?? 'unknown'} BPM
Total tracks: ${fullSession.tracks?.length ?? 'unknown'}
Track names: ${fullSession.tracks?.map(t => t.name).join(', ')}
`.trim();

  const trackData = chunk.map(track => {
    const devices = (track.devices || []).map(d => {
      const entry = { name: d.name, enabled: d.enabled };
      if (d.parameters && Object.keys(d.parameters).length > 0) {
        entry.parameters = d.parameters;
        entry.paramCount = Object.keys(d.parameters).length;
      }
      if (d.isRack && d.innerDevices?.length) {
        entry.isRack = true;
        entry.innerDevices = d.innerDevices.map(inner => {
          const innerEntry = { name: inner.name, enabled: inner.enabled };
          if (inner.parameters && Object.keys(inner.parameters).length > 0) {
            innerEntry.parameters = inner.parameters;
            innerEntry.paramCount = Object.keys(inner.parameters).length;
          }
          return innerEntry;
        });
      }
      return entry;
    });
    return {
      index: track.index, name: track.name, type: track.type,
      volume: track.volume, volumeDisplay: track.volumeDisplay,
      pan: track.pan, panDisplay: track.panDisplay,
      muted: track.muted, solo: track.solo,
      routingTarget: track.routingTarget,
      role: track._role, trackFlags: track._trackFlags, devices,
    };
  });

  const systemPrompt = `You are an expert audio engineer analyzing an Ableton Live session.

You will receive tracks with their raw device parameters. Your job:

1. For EVERY device, write a concise annotation (1-2 sentences) describing what it's doing in mixing terms — intent, character, and how it serves the track's role.
2. Flag any problems or concerns as short actionable warnings.
3. Consider the device chain as a whole — how devices interact on the same track.
4. For Racks containing inner devices (marked with isRack: true and innerDevices array), analyze the INNER devices — those are the real signal processors. The Rack itself is just a container. Annotate each inner device individually.

CRITICAL RULES:
- The parameter data you see is ALWAYS accurate. It was read directly from Ableton Live's API. Never say "low confidence", "incomplete capture", or "possibly defaults". If parameters are present, they are real.
- For third-party plugins (VST/AU) you may not recognise every parameter name. Interpret them by their names and values — most follow standard conventions (Threshold, Attack, Release, Freq, Gain, Mix, etc.). If a parameter name is unclear, describe what the value suggests rather than saying you don't know.
- For synth instruments (Diva, Serum, Massive, Vital, etc.), focus on: oscillator configuration, filter settings, modulation, and anything relevant to the sound character and how it sits in the mix.
- Be specific with numbers. "Threshold at -18 dB with 4:1 ratio" not "moderate compression".
- Use the track role for context: a compressor on a drum bus means something different from a compressor on a vocal.

Respond ONLY with valid JSON. No markdown fences, no explanation outside the JSON.`;

  const userPrompt = `Session context:
${sessionContext}

Return this exact JSON structure:
{
  "tracks": [
    {
      "index": <number>,
      "role": "<confirmed or corrected role>",
      "devices": [{ "name": "<n>", "annotation": "<what it's doing>", "flags": ["<issue>"] }],
      "trackFlags": ["<track-level issues>"]
    }
  ]
}

Track data:
${JSON.stringify(trackData, null, 2)}`;

  try {
    const result = await llm.chat({
      apiKey: modelConfig.apiKey, baseURL: modelConfig.endpoint,
      modelId: modelConfig.modelId,
      messages: [{ role: 'user', content: userPrompt }],
      systemPrompt, maxTokens: 2000,
    });

    if (result.error) { console.warn('[annotation] LLM error:', result.text); return chunk; }
    const parsed = safeParseJSON(result.text);
    if (!parsed?.tracks) { console.warn('[annotation] Unexpected response shape.'); return chunk; }

    return chunk.map(track => {
      const ann = parsed.tracks.find(t => t.index === track.index);
      if (!ann) return track;
      return {
        ...track,
        _role: ann.role || track._role,
        _trackFlags: mergeFlags(track._trackFlags, ann.trackFlags),
        devices: (track.devices || []).map((device, i) => {
          const deviceAnn = ann.devices?.[i];
          if (!deviceAnn) return device;
          const updated = {
            ...device,
            _annotation: deviceAnn.annotation || device._annotation,
            _flags: mergeFlags(device._flags, deviceAnn.flags),
          };
          if (device.isRack && device.innerDevices?.length && deviceAnn.innerDevices?.length) {
            updated.innerDevices = device.innerDevices.map((inner, j) => {
              const innerAnn = deviceAnn.innerDevices?.[j];
              if (!innerAnn) return inner;
              return { ...inner, _annotation: innerAnn.annotation || inner._annotation, _flags: mergeFlags(inner._flags, innerAnn.flags) };
            });
          }
          return updated;
        }),
      };
    });
  } catch (err) {
    console.error('[annotation] Chunk annotation failed:', err.message);
    return chunk;
  }
}

// --- HELPERS -----------------------------------------------------------------

function isPriorityTrack(track) {
  const name = (track.name || '').toLowerCase();
  return track.type === 'return' || track.type === 'master' ||
    /bus|group|sum|master|main|return/i.test(name);
}

function mergeFlags(existing = [], incoming = []) {
  const all = [...(existing || [])];
  for (const flag of (incoming || [])) {
    const isDuplicate = all.some(f => f.toLowerCase().slice(0, 30) === flag.toLowerCase().slice(0, 30));
    if (!isDuplicate) all.push(flag);
  }
  return all;
}

function safeParseJSON(text) {
  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

module.exports = { annotateSession };
