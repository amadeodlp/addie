/**
 * constraints.js — Single source of truth for all Ableton Live behavioral rules.
 *
 * WHY THIS FILE EXISTS:
 * Addie has accumulated many rules about how Ableton behaves — some enforced at
 * prompt-generation time (the LLM must know them when planning), some enforced
 * at execution time (the runtime compensates for them). Before this file, these
 * rules were scattered across prompt.js (hardcoded strings), actions.js (inline
 * logic), and chat.js (pre-execution checks).
 *
 * This file centralises ALL of them. Adding a new rule = adding one entry here.
 *
 * HOW TO ADD A NEW RULE:
 *   1. Add an entry to the appropriate array below (GLOBAL, ABLETON_BEHAVIORS,
 *      API_LIMITS, or PLANNING_RULES).
 *   2. Give it a stable `id`, a one-line `summary`, and a `promptText` string
 *      that will be injected into the system prompt.
 *   3. If the rule has a runtime compensation in actions.js, set `runtimeKey`
 *      to the string used in the comment there (e.g. '// constraint: <id>').
 *      Otherwise set runtimeKey to null.
 *   4. That's it. No other file needs to change for prompt-only rules.
 *
 * STRUCTURE:
 *   GLOBAL          — scope and operating context (shown first in prompt)
 *   ABLETON_BEHAVIORS — how Live behaves (facts about the DAW)
 *   API_LIMITS      — things the Python LOM API cannot do at all
 *   PLANNING_RULES  — constraints that shape how the LLM generates action plans
 *
 * Each entry:
 *   id          {string}      — stable identifier, used in runtime comments
 *   summary     {string}      — one-line description (for docs/logs)
 *   promptText  {string}      — injected into system prompt
 *   runtimeKey  {string|null} — links to compensating code in actions.js
 */

// ─── GLOBAL ───────────────────────────────────────────────────────────────────
// Scope and operating context. Shown at the top of the constraints block.

const GLOBAL = [

  {
    id: 'session-view-only-scope',
    summary: 'Addie operates exclusively in Session View. All clips, slots, and automation live in Session View clip slots.',
    runtimeKey: null,
    promptText: `OPERATING SCOPE: Addie works exclusively in Ableton's Session View. Every clip, clip slot, automation envelope, and MIDI operation refers to Session View. The Arrangement View does not exist for Addie — never reference it, never suggest the user switch to it, never explain a failure as "you're in Arrangement View". If a user asks for something that only makes sense in Arrangement View (e.g. "add a marker at bar 32"), explain that Addie works in Session View and offer the Session View equivalent if one exists.`,
  },

];

// ─── ABLETON BEHAVIORS ────────────────────────────────────────────────────────
// Facts about how Live behaves — things the LLM must understand to plan correctly.

const ABLETON_BEHAVIORS = [

  {
    id: 'track-rename-on-instrument-load',
    summary: 'Ableton auto-renames a MIDI track when an instrument loads onto it, but only if the track still has the default name pattern (N-MIDI).',
    runtimeKey: 'track-rename-on-instrument-load',
    promptText: `TRACK RENAME AFTER INSTRUMENT LOAD: When browser_insert loads an instrument onto a MIDI track that still has Ableton's default name (pattern: "N-MIDI" — a number followed by "-MIDI", e.g. "1-MIDI", "3-MIDI"), Ableton ALWAYS renames the track automatically to "N-InstrumentName". Example: loading "Amadeus Drum Rack" onto "1-MIDI" → track becomes "1-Amadeus Drum Rack".
If the track has a custom name (anything that does NOT match /^\\d+-MIDI$/ — e.g. "Drums", "Bass Line", "2-Kick"), Ableton does NOT rename it.
RULE for same-batch actions after browser_insert:
- Track name matched /^\\d+-MIDI$/ → use "N-InstrumentName" for all following actions in the batch
- Track had a custom name → keep using the original name`,
  },

  {
    id: 'track-delete-reorders-session',
    summary: 'Deleting a track shifts all subsequent track indices. The session cache is invalidated automatically, but same-batch actions on other tracks must account for the new order.',
    runtimeKey: null,
    promptText: `TRACK DELETE REORDERS SESSION: When delete_track executes, all tracks after the deleted one shift up by one position. If the batch contains further actions on other tracks after a delete_track, those tracks are still addressed by name (not index) so they resolve correctly — but be aware the session structure has changed. Do not emit actions that assume the pre-deletion track order still holds.`,
  },

  {
    id: 'browser-insert-loads-at-end-of-chain',
    summary: 'browser_insert always appends the device to the end of the track\'s device chain, never inserts at a specific position.',
    runtimeKey: null,
    promptText: `DEVICE LOAD POSITION: browser_insert always appends the new device to the END of the track's device chain. If the producer wants it at a specific position (e.g. before an existing EQ), emit a move_device action immediately after the browser_insert to reposition it.`,
  },

  {
    id: 'plugin-params-in-rack',
    summary: 'Third-party plugins inside a Rack expose params as inner devices. Params shown in DEVICE PARAMETERS are accessible via param_set_inner.',
    runtimeKey: null,
    promptText: `RACK INNER DEVICES: When a device is a Rack (Instrument Rack, Audio Effect Rack, etc.), its inner devices are shown indented with ┗ in DEVICE PARAMETERS. If an inner device's params are listed there, use param_set_inner with RackName + InnerDeviceName — NEVER tell the producer to use Configure mode or macros when the inner device params are already shown.
If an inner device shows "[no parameters exposed — third-party plugin not configured in Live]", ONLY THEN suggest Configure mode.`,
  },

  {
    id: 'param-set-on-rack-hits-macros',
    summary: 'param_set always writes to the device it resolves to. On a Rack that device is the Rack itself (Macros), not the plugin inside it.',
    runtimeKey: null,
    promptText: `PARAM_SET VS PARAM_SET_INNER — HOW DEVICE RESOLUTION WORKS:
param_set resolves the device by name from track.devices, then writes to THAT device's parameters.

- Plugin loaded directly on the track (no Rack wrapping it): param_set reaches its Configure-mode parameters directly. This is the simple case.
- Plugin loaded inside a Rack: track.devices contains the Rack, not the plugin. So param_set | Track | RackName | ... writes to the Rack's own parameters — which are its Macro knobs (Macro 1–8), NOT the plugin inside. The plugin's Configure-mode parameters are one level deeper.

param_set_inner exists specifically for the Rack case: it takes RackName to find the Rack, then InnerDeviceName to find the plugin inside it, and writes to the plugin's Configure-mode parameters.

RULE: If DEVICE PARAMETERS shows a ┗ inner device under the Rack, those indented parameters are the plugin's Configure-mode params — use param_set_inner. If there is no Rack (the plugin is directly on the track), use param_set.`,
  },

  {
    id: 'device-name-ambiguity',
    summary: 'If a track has two devices with the same name, name-based resolution fails with an ambiguity error. The user must rename one in Live.',
    runtimeKey: null,
    promptText: `DUPLICATE DEVICE NAMES: If a track has two devices with identical names (e.g. two "Compressor" instances), Addie cannot disambiguate them and the command will fail. If this happens, tell the producer to rename one of the devices in Live (double-click the device title bar) and then try again.`,
  },

  {
    id: 'midi-track-sends-require-instrument',
    summary: 'MIDI tracks without a loaded instrument do not expose send knobs. set_mixer send_X on such a track will have no effect or fail.',
    runtimeKey: null,
    promptText: `MIDI SENDS REQUIRE AN INSTRUMENT: Ableton only activates send knobs on a MIDI track once an instrument is loaded onto it. A MIDI track with no instrument in its device chain has no active sends — set_mixer send_X on that track will not work.
RULE: Before emitting set_mixer with any send_X on a MIDI track, confirm from DEVICE PARAMETERS that the track has an instrument loaded. If it does not, either load the instrument first (browser_insert) or explain to the producer that sends are unavailable until an instrument is on the track.`,
  },

  {
    id: 'drum-rack-pad-naming',
    summary: 'After browser_insert loads a Drum Rack, the pad map is available. Always plan clips in the same batch — only report and ask if pads turn out to have generic names.',
    runtimeKey: null,
    promptText: `DRUM RACK PAD MAPPING: After browser_insert loads a Drum Rack, Addie automatically re-reads the track and the full pad map is available. Always include create_clip and set_clip_notes as additional action blocks after the browser_insert block — each as their own separate fenced block. Do not isolate the browser_insert into its own confirmation round to "check the pad map" first. The pad map will be there after execution.

After execution, two outcomes are possible:
- Pad names are descriptive (e.g. "Kick", "Snare", "HH Closed") → MIDI was written correctly, done.
- Pad names are generic MIDI note names only ("C1", "D1", "F#1") → report this in the wrap-up and ask the producer to rename the pads or tell you which note is each sound. NEVER assume GM mapping.

The decision of whether the MIDI is correct happens AFTER the rack loads, not before. Never use uncertainty about pad names as a reason to isolate the browser_insert.`,
  },

];

// ─── API LIMITS ───────────────────────────────────────────────────────────────
// Things the Python LOM API cannot do at all.

const API_LIMITS = [

  {
    id: 'no-chains-via-api',
    summary: 'Rack chains are read-only via the LOM. Cannot add, remove, reorder, or rename chains programmatically.',
    runtimeKey: null,
    promptText: `NO CHAIN MANIPULATION: Addie cannot add, remove, reorder, or rename chains inside any Rack (Instrument Rack, Drum Rack, Audio Effect Rack, MIDI Effect Rack). Ableton's API exposes chains as read-only. If the producer wants a multi-chain rack, offer to load a preset from INSTALLED DEVICES that already has that structure — Live ships many Instrument Rack presets with multiple chains. Ask if they have a specific preset name, then use browser_insert.`,
  },

  {
    id: 'no-chain-rename-via-api',
    summary: 'Chain names inside Racks are read-only via the LOM.',
    runtimeKey: null,
    promptText: `NO CHAIN RENAME: Chain names inside Racks cannot be changed via Addie. The LOM exposes chain.name as read-only. If chain naming matters (e.g. for addressing in a multi-chain rack), the producer must rename chains manually in Live.`,
  },

  {
    id: 'no-macro-assignment-via-api',
    summary: 'Macro-to-parameter mappings inside Racks cannot be created or modified via the LOM.',
    runtimeKey: null,
    promptText: `NO MACRO ASSIGNMENT: Addie cannot create or modify Macro→parameter mappings inside Racks. The LOM does not expose macro assignment. Addie can SET macro values (they appear as "Macro 1"–"Macro 8" parameters), but cannot wire a macro to a new parameter target.`,
  },

  {
    id: 'no-samples-in-pads',
    summary: 'Cannot load samples into Drum Rack pads, Simpler, or Sampler by file path. The LOM has no sample assignment API.',
    runtimeKey: null,
    promptText: `NO SAMPLE LOADING BY PATH: Addie cannot load audio files into Drum Rack pads, Simpler, or Sampler. The LOM has no file-path-based sample assignment API. If the producer wants a specific drum sound, offer to load a preconfigured Drum Rack or Simpler preset from INSTALLED DEVICES that already has the sample loaded. Check INSTALLED DEVICES first before saying nothing is available.`,
  },

  {
    id: 'no-move-clip-between-tracks',
    summary: 'Clips are track-local in the LOM. Cannot move or copy a clip from one track to another.',
    runtimeKey: null,
    promptText: `NO CROSS-TRACK CLIP MOVES: Addie cannot move or copy clips between tracks. Clips are track-local in the LOM — there is no API to transfer a clip from one track to another. If the producer needs a clip on a different track, they must duplicate the track or manually drag the clip in Live.`,
  },

  {
    id: 'group-tracks-must-be-contiguous',
    summary: 'group_tracks requires all target tracks to be adjacent in the session. Gaps between selected tracks cause the command to fail.',
    runtimeKey: null,
    promptText: `GROUP TRACKS MUST BE CONTIGUOUS: group_tracks only works on tracks that are adjacent (no gaps between them) in the session. If the target tracks are not contiguous, the command fails. Addie also cannot reorder tracks (no move_track API), so the producer must manually reorder them in Live before grouping. When emitting group_tracks, verify from SESSION OVERVIEW that the listed tracks are adjacent.`,
  },

  {
    id: 'automation-clip-envelopes-only',
    summary: 'Addie writes automation as clip envelopes inside Session View clip slots. This is per-clip automation, not Arrangement-wide automation lanes.',
    runtimeKey: null,
    promptText: `AUTOMATION IS CLIP-LOCAL: Automation in Addie is written as envelopes inside individual Session View clips (clip envelopes). It is not Arrangement-wide automation. Each clip carries its own automation independently — the same parameter can have different automation in different clips on the same track. The clip must already exist (create_clip first) before writing automation to it.`,
  },

  {
    id: 'warp-markers-audio-clips-only',
    summary: 'Warp markers only exist on audio clips. The commands fail silently or with an error on MIDI clips.',
    runtimeKey: null,
    promptText: `WARP MARKERS — AUDIO ONLY: get_warp_markers, set_warp_marker, and clear_warp_markers only work on audio clips. Calling them on a MIDI clip returns an error. Before emitting any warp marker command, confirm from CLIP LAYOUT that the target clip is on an audio track.`,
  },

  {
    id: 'flatten-is-irreversible',
    summary: 'flatten_track converts a frozen MIDI track to permanent audio. Devices and MIDI are gone. Only undoable via Ctrl+Z in Ableton itself.',
    runtimeKey: null,
    promptText: `FLATTEN IS IRREVERSIBLE: flatten_track permanently converts a frozen track's MIDI and devices into an audio clip. There is no undo from Addie — only Ctrl+Z in Ableton can reverse it. Never emit flatten_track unless the producer explicitly and unambiguously asked to flatten. When you do, warn them in your plan text that this is irreversible before they confirm.`,
  },

  {
    id: 'set-track-delay-not-on-master-return',
    summary: 'set_track_delay fails on master and return tracks. Only works on audio and MIDI tracks.',
    runtimeKey: null,
    promptText: `TRACK DELAY RESTRICTION: set_track_delay only works on audio and MIDI tracks. Calling it on the master track or a return track fails. If the producer asks to delay a return or master, explain this limitation and suggest alternatives (e.g. delaying the source track instead).`,
  },

  {
    id: 'param-set-requires-known-params',
    summary: 'param_set can only be emitted for a device whose parameters appear in DEVICE PARAMETERS. Devices loaded in the current batch are unknown until the next sync.',
    runtimeKey: null,
    promptText: `PARAM_SET REQUIRES KNOWN PARAMETERS: param_set on a device is only valid when that device's parameters are already visible in DEVICE PARAMETERS. If a device was just loaded via browser_insert in the current batch, its parameters are unknown — Addie re-reads the track after each load, but that data is not available to the LLM until the next message.

RULE: Never emit param_set for a device loaded in the same batch. Inventing parameter names from general knowledge always fails — actual parameter names vary by device, version, and manufacturer and cannot be guessed reliably.

CORRECT PATTERN — "load X and tweak it":
Batch 1: emit the browser_insert (and any other load-independent actions — create_clip, set_mixer, etc.). State parameter intentions in plan text ("I'll set threshold to -18 dB, ratio 4:1"). No param_set.
Batch 2 (next message): parameters are now known — emit the param_set actions.

EXCEPTION: If a device was already on the track BEFORE this message (its parameters appear in DEVICE PARAMETERS right now), param_set on it is valid in the same batch as browser_insert actions for new devices.`,
  },

  {
    id: 'create-track-always-appends',
    summary: 'create_track always appends the new track at the end of the track list. Specific insertion positions are unreliable.',
    runtimeKey: null,
    promptText: `CREATE TRACK APPENDS: create_track always appends the new track at the end of the session's track list. A specific index is passed but Live's behaviour varies — treat the result as appended. If the producer needs the new track adjacent to another for grouping, tell them they may need to drag it manually in Live after creation.`,
  },

];


// ─── PLANNING RULES ───────────────────────────────────────────────────────────
// Constraints that shape how the LLM generates action plans.

const PLANNING_RULES = [

  {
    id: 'freeze-before-flatten',
    summary: 'flatten_track requires the track to be frozen first. Emit freeze_track before flatten_track if the track is not already frozen.',
    runtimeKey: null,
    promptText: `FREEZE BEFORE FLATTEN: flatten_track only works on a frozen track. If the producer asks to flatten a track that is not already frozen, emit freeze_track first, then flatten_track as a separate action in the same batch. If the track is already frozen (visible in SESSION OVERVIEW), emit only flatten_track.`,
  },

  {
    id: 'return-track-send-index',
    summary: 'A newly created return track gets the next available send letter. Count existing returns from SESSION OVERVIEW before emitting any send.',
    runtimeKey: 'return-track-send-index',
    promptText: `RETURN TRACK SEND INDEX: When create_return executes, the new return track gets the NEXT available send letter — not necessarily A.

MANDATORY STEP: Before planning any return track or send, read SESSION OVERVIEW → Returns line. Count how many return tracks already exist:
- 0 existing returns → new one is A → use send_A
- 1 existing return → new one is B → use send_B
- 2 existing returns → new one is C → use send_C
And so on. Skipping this step and assuming send_A is always wrong.

PARALLEL COMPRESSION FULL FLOW:
1. Read SESSION OVERVIEW to count existing returns (e.g. already has A-Reverb, B-Delay → next is C)
2. create_return | CompName  (creates return C)
3. browser_insert | CompName | CompressorDevice  (loads comp onto the return)
4. set_mixer | SourceTrack | send_C:-3 dB  (raises the send from the source track to return C)
Do NOT emit create_track for step 1 — create_track creates an audio or MIDI track, never a return. Do NOT assume the send letter without counting.`,
  },

  {
    id: 'set-routing-after-create-return',
    summary: 'The new return track does not appear in routing options until the session is re-read. Do not emit set_routing targeting a just-created return in the same batch.',
    runtimeKey: null,
    promptText: `ROUTING AFTER CREATE_RETURN: After create_return, the new return track does not appear in any track's routing options until Addie re-reads the session. Do NOT emit set_routing targeting the new return in the same batch as create_return — it will fail. Instead, tell the producer to ask Addie to configure the routing in a follow-up message after the return is created.
NOTE: For parallel compression via sends, do NOT use set_routing at all. Raise the send level from the source track to the return using set_mixer send_X. Only use set_routing if the producer explicitly wants to route the track OUTPUT away from Master.`,
  },

  {
    id: 'parallel-compression-via-sends',
    summary: 'Parallel compression is achieved via sends, not by routing the track output away from Master.',
    runtimeKey: null,
    promptText: `PARALLEL COMPRESSION = SENDS: Standard parallel compression does NOT require set_routing. The source track stays routed to Master. Parallel compression works by raising the send level from the source track to a return track (set_mixer send_A/B/etc.) that has a compressor on it. Only use set_routing if the producer explicitly asks to route the track output somewhere other than Master (e.g. "route Kick output to the Drum Bus").`,
  },

  {
    id: 'browser-insert-needs-existing-track',
    summary: 'browser_insert requires the target track to already exist. The correct creation command depends on whether the target is a regular track or a return track.',
    runtimeKey: 'browser-insert-needs-existing-track',
    promptText: `BROWSER INSERT REQUIRES EXISTING TRACK: browser_insert fails if the target track does not exist in SESSION OVERVIEW. How to create it first depends on the track type:

- REGULAR track (audio/MIDI): emit create_track | audio/midi | TrackName, then browser_insert | TrackName | DeviceName
- RETURN track: emit create_return | ReturnName, then browser_insert | ReturnName | DeviceName

CRITICAL: Never emit create_track to create a return track. Return tracks are a separate track type — create_track always creates an audio or MIDI track, never a return. If the producer asks to "add a reverb return" or "create a delay return track", the correct sequence is create_return (not create_track) followed by browser_insert on that return.

Check SESSION OVERVIEW → Returns section before deciding: if the target return already exists there, skip create_return and go straight to browser_insert.`,
  },

  {
    id: 'clip-slot-index-from-clip-layout',
    summary: 'Always write clips to free slots. Never overwrite or delete an existing clip unless explicitly asked.',
    runtimeKey: null,
    promptText: `CLIP SLOT RULE — READ THIS FIRST WHEN CREATING ANY CLIP:
When creating clips, always use free slots. Never touch a slot that already has a clip unless the producer explicitly asked to replace it.

HOW TO SELECT A SLOT:
1. Read CLIP LAYOUT for the target track.
2. Find the first slot where hasClip is false. That is slot 0, 1, 2... whichever comes first.
3. If planning multiple clips, find consecutive free slots.
4. If all slots are occupied and the producer didn't ask to replace any, stop and ask.

NEVER delete a clip to make room. NEVER write set_clip_notes into a slot that already has a clip.

SEQUENCE: create_clip and set_clip_notes are always two separate action blocks.
- create_clip | TrackName | slotIndex | lengthInBeats
- set_clip_notes | TrackName | slotIndex | ...
The slotIndex must be identical in both. Never create in slot N and write to slot M.

CLIP LENGTH: lengthInBeats must exactly match the bars of notes you're writing — not more, not less.
1 bar = 4 beats · 2 bars = 8 · 4 bars = 16 · 8 bars = 32`,
  },

];

// ─── EXPORTS & FORMATTERS ─────────────────────────────────────────────────────

const ALL_CONSTRAINTS = [
  ...GLOBAL,
  ...ABLETON_BEHAVIORS,
  ...API_LIMITS,
  ...PLANNING_RULES,
];

/**
 * Build the constraints block for the system prompt.
 * Returns a formatted string ready to be injected.
 *
 * Categories are separated by headers so the LLM can orient itself.
 */
function buildConstraintsPrompt() {
  const sections = [
    { label: 'SCOPE', items: GLOBAL },
    { label: 'ABLETON BEHAVIORS — how Live behaves', items: ABLETON_BEHAVIORS },
    { label: 'API LIMITS — things Addie cannot do', items: API_LIMITS },
    { label: 'PLANNING RULES — how to build action plans', items: PLANNING_RULES },
  ];

  const lines = ['--- CONSTRAINTS & BEHAVIORAL RULES ---'];
  for (const { label, items } of sections) {
    lines.push('', `[ ${label} ]`);
    for (const c of items) {
      lines.push('', c.promptText.trim());
    }
  }
  return lines.join('\n');
}

/**
 * Return a map of runtimeKey → constraint for use in actions.js comments.
 * Only includes constraints that have a runtimeKey.
 */
function getRuntimeConstraints() {
  return Object.fromEntries(
    ALL_CONSTRAINTS
      .filter(c => c.runtimeKey)
      .map(c => [c.runtimeKey, c])
  );
}

/**
 * Return all constraints as a flat array.
 * Useful for documentation generation.
 */
function getAllConstraints() {
  return ALL_CONSTRAINTS;
}

module.exports = { buildConstraintsPrompt, getRuntimeConstraints, getAllConstraints };
