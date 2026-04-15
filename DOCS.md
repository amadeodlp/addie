# Addie — Technical Documentation

AI producer assistant for Ableton Live. Bridges a Python control surface, a Node.js backend, and any LLM into a chat interface that sees your session, diagnoses mix problems, and controls your DAW.

**Supported:** Ableton Live 11, 12 — Windows and macOS.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Directory Structure](#2-directory-structure)
3. [Installation & Setup](#3-installation--setup)
4. [Configuration](#4-configuration)
5. [The Control Surface (Python)](#5-the-control-surface-python)
6. [The Backend (Node.js)](#6-the-backend-nodejs)
7. [Session Data Model](#7-session-data-model)
8. [The Chat Pipeline](#8-the-chat-pipeline)
9. [Action Execution](#9-action-execution)
10. [Parameter Value System](#10-parameter-value-system)
11. [LLM Integration](#11-llm-integration)
12. [RAG — Knowledge Retrieval](#12-rag--knowledge-retrieval)
13. [Session Annotation](#13-session-annotation)
14. [Context, Projects & Conversations](#14-context-projects--conversations)
15. [Third-Party Plugin Parameter Access](#15-third-party-plugin-parameter-access)
16. [Ports & Communication](#16-ports--communication)
17. [Design Principles](#17-design-principles)
18. [Compatibility — Live 10/11/12, Windows/macOS](#18-compatibility--live-101112-windowsmacos)
19. [UI — Themes & Internationalisation](#19-ui--themes--internationalisation)
20. [Constraints & Behavioral Rules](#20-constraints--behavioral-rules)

---

## 1. Architecture Overview

Addie runs as three separate processes communicating over local HTTP and WebSocket:

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Shell                                              │
│  electron/main.js                                            │
│  - App lifecycle, window management                          │
│  - Ableton path detection (IPC)                              │
│  - User Library path detection (IPC)                         │
│  - Forks the Node backend on startup                         │
│  - Flushes chat buffers on close via HTTP                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ fork()
┌──────────────────────────▼──────────────────────────────────┐
│  Node.js Backend                              :3000          │
│  app/server.js                                               │
│  - Express HTTP + WebSocket server                           │
│  - Chat pipeline orchestration                               │
│  - Session data management                                   │
│  - Action execution with per-action track re-read            │
│  - LLM calls (all providers)                                 │
│  - RAG retrieval (via Python subprocess)                     │
│  - Preset intercept for third-party plugins                  │
└────────────┬────────────────────────────┬───────────────────┘
             │ HTTP :3001                  │ stdin/stdout
┌────────────▼───────────┐   ┌────────────▼───────────────────┐
│  Python Control Surface│   │  RAG Query Subprocess           │
│  control_surface/      │   │  scripts/query_index.py         │
│  - Ableton MIDI Remote │   │  - sentence-transformers        │
│    Script              │   │  - numpy vector retrieval       │
│  - Reads/writes Live   │   │  - Stays alive, model in RAM    │
│    session data        │   └────────────────────────────────┘
│  - HTTP server on :3001│
│  - Heartbeat monitoring│
│  - Rack traversal for  │
│    VST/AU plugins      │
│  - Full LOM coverage   │
└────────────────────────┘
```

Everything runs locally. Session data never leaves the machine unless the user configures a remote LLM.

---

## 2. Directory Structure

```
addie/
├── electron/
│   ├── main.js              Electron entry, window/IPC management
│   └── preload.js           contextBridge API exposed to renderer
├── app/
│   ├── server.js            HTTP routes, WebSocket, bridge, startup
│   ├── config.js            Config load/save with deep merge
│   ├── core/
│   │   ├── chat.js          Pipeline orchestration, action confirmation gate
│   │   ├── actions.js       Action execution, per-action resync, retry
│   │   ├── prompt.js        System prompt construction
│   │   ├── sync.js          Session state: fetchSession, fetchTrackDetails, browser
│   │   └── constraints.js   Single source of truth for all Ableton behavioral rules
│   ├── intelligence/
│   │   ├── reasoning.js     reason() — semantic track resolution
│   │   ├── annotation.js    annotateSession() — LLM device analysis
│   │   └── translator.js    Deterministic role/flag inference
│   ├── services/
│   │   ├── bridge.js        Python bridge watchdog + heartbeat
│   │   ├── llm.js           LLM provider abstraction (OpenAI-compatible)
│   │   └── rag.js           RAG retrieval (manages Python subprocess)
│   ├── state/
│   │   ├── context.js       Projects, conversations, knowledge, session.md
│   │   └── memory.js        Producer pattern learning → producer.md
│   └── plugins/
│       ├── presets.js       .adg preset registry + browser_insert intercept
│       └── automation.js    Breakpoint math for automation envelopes
├── control_surface/
│   ├── __init__.py          Ableton entry point (create_instance)
│   ├── addie.py             ControlSurface class, command queue, dispatch
│   ├── server.py            HTTP server, Future-based sync protocol, heartbeat
│   ├── handlers.py          Live API implementations (50+ commands)
│   ├── compat.py            Cross-version shims: Live 10/11/12, Windows/macOS
│   └── logger.py            [Addie] prefixed log_message wrapper
├── scripts/
│   ├── build_index.py       Build RAG index from PDFs (run once, dev only)
│   ├── query_index.py       Runtime RAG subprocess (managed by rag.js)
│   └── README.md
├── ui/
│   ├── index.html           App shell: onboarding + projects + chat views
│   ├── app.js               Chat UI, WebSocket client
│   ├── onboarding.js        First-run wizard state machine
│   ├── kickstarts.json      Contextual suggestion prompts
│   ├── style.css            Dark theme, all component styles
│   └── assets/
├── knowledge/
│   ├── *.pdf                Audio engineering reference books
│   └── .index/
│       ├── chunks.json      Pre-built text chunks (committed)
│       └── vectors.npy      Pre-built embedding vectors (committed)
├── projects/
│   └── <name>/
│       ├── meta.json        Project metadata
│       ├── session.md       Last annotated session state
│       ├── templates.md     Auto-detected session templates
│       ├── conversations/
│       │   ├── <id>.md      Append-only chat log
│       │   └── <id>.json    Conversation metadata
│       └── knowledge/       User-added reference files
├── presets/
│   ├── registry.json        Maps plugin names to pre-configured .adg presets
│   ├── *.adg                Instrument Rack presets with Configure lists
│   └── README.md
├── producer.md              Global producer preferences and learned habits
├── config.json              Runtime configuration
└── package.json
```


---

## 3. Installation & Setup

### Prerequisites

- Node.js 18+
- Python 3.8+
- Ableton Live 11+

### Install and run (development)

```bash
npm install
npm start        # or: npm run dev  (opens DevTools)
```

### First run — onboarding wizard

1. **Welcome**
2. **LLM setup** — paste an API key (Groq, OpenAI, Anthropic, OpenRouter, Mistral) or configure a local model (Ollama/LM Studio)
3. **Install control surface** — Addie detects your Ableton directory and copies `control_surface/` into `MIDI Remote Scripts/Addie/` automatically. Also installs pre-configured plugin presets into Ableton's User Library.
4. **Enable in Ableton** — Preferences → Link, Tempo & MIDI → set a Control Surface slot to **Addie**. The wizard polls the bridge and advances automatically when connection is detected.
5. **Producer preferences** — genre, experience level, monitoring, preferred plugins, reference artists. Written to `producer.md`.

### Build the RAG index (dev only, run once)

```bash
pip install pymupdf sentence-transformers numpy
python scripts/build_index.py
```

Output is committed to the repo. End users never run this.

### Build distributable

```bash
npm run build:win   # Windows .exe installer
npm run build:mac   # macOS .dmg
```

---

## 4. Configuration

`config.json` at the app root, created automatically:

```json
{
  "machineId": "<hardware fingerprint>",
  "model": {
    "apiKey":   "",
    "endpoint": "",
    "modelId":  ""
  },
  "ports": {
    "ui":           3000,
    "pythonBridge": 3001
  },
  "activeProject": "default",
  "activeConversation": "conv_1",
  "onboardingDone": true
}
```

---

## 5. The Control Surface (Python)

An Ableton MIDI Remote Script loaded at startup via Preferences → MIDI. Supports Live 10, 11, and 12 on both Windows and macOS. Cross-version API differences are isolated in `compat.py` — `handlers.py` calls compat shims and stays version-agnostic.

### Modules

| File | Responsibility |
|---|---|
| `__init__.py` | `create_instance()` entry point Ableton calls |
| `addie.py` | `ControlSurface` subclass, command queue, `update_display` dispatch |
| `server.py` | Threaded HTTP server on `:3001`, `_Future` sync protocol, heartbeat |
| `handlers.py` | All Live API command implementations |
| `compat.py` | Version/platform shims — see Section 18 |
| `logger.py` | `[Addie]`-prefixed wrapper around `log_message` |

### Threading model

Ableton calls `create_instance(c_instance)` → instantiates `Addie(c_instance)` extending `ControlSurface`. `update_display()` is called on every display tick — the only method that runs on Live's main thread.

All network I/O happens on a background thread. Synchronization uses a `_Future` pattern:

1. Node POSTs to `/api/bridge/command`
2. HTTP thread creates a `_Future`, enqueues `(command, params, future)`
3. HTTP thread blocks on `future.wait(timeout=8.0)`
4. `update_display()` dequeues up to 3 commands per tick, dispatches, calls `future.set_result(result)`
5. HTTP thread unblocks, sends JSON response

### Heartbeat monitoring

`update_display()` calls `server.update_heartbeat()` every tick. `/health` reports this timestamp. If the heartbeat is stale (>5s), the bridge returns 503 — the HTTP server is alive but Ableton's main thread has stopped. Node's watchdog in `bridge.js` checks heartbeat age and only considers the bridge alive when both HTTP and heartbeat are fresh.

### Error handling in update_display

Everything is wrapped in a try/except. Individual command failures return `{'error': ...}` to the future but never propagate. If `update_display()` raises an unhandled exception, Ableton stops calling it silently, leaving the HTTP server alive but the bridge braindead. The heartbeat mechanism detects this.

### Bridge commands

**Session reading:**
`ping`, `snapshot_tier1` (mixer only), `snapshot` (full params), `param_get`, `param_count`, `get_clips`, `get_transport`, `get_routing_options`, `browser_list`

**Device control:**
`param_set` (supports `innerDeviceName` for Rack-nested devices, `chainName` to disambiguate within multi-chain Racks), `browser_insert`, `delete_device`, `move_device`, `enable_device`

**Track management:**
`create_track`, `delete_track`, `rename_track`, `duplicate_track`, `set_track_color`, `group_tracks`, `ungroup_tracks`

**Track utilities:**
`set_track_delay` (phase alignment, Haas widening, latency compensation), `freeze_track`, `flatten_track`

**Mixer:**
`set_mixer` (volume, pan, sends in one call), `set_mute`, `set_solo`

**Routing:**
`set_routing`, `get_routing_options`

**Return tracks:**
`create_return`, `delete_return`

**Transport:**
`set_tempo`, `set_time_signature`, `set_loop`

**Clips & scenes:**
`create_clip`, `delete_clip`, `create_scene`, `set_clip_name`, `get_clip_notes`, `set_clip_notes`

**Warp markers (audio clips):**
`get_warp_markers`, `set_warp_marker`, `clear_warp_markers`

**Automation:**
`create_automation`, `read_automation`, `clear_automation`

**Excluded from LLM dispatch (real-time/recording operations):**
`play`, `stop`, `tap_tempo`, `fire_clip`, `stop_clip`, `fire_scene`, `arm_track`, `set_crossfade`

### Track delay

`set_track_delay` sets a track's delay in milliseconds. Positive values delay the audio (arrives later); negative values advance it (arrives earlier). The range is approximately ±100 ms. Common uses:

- **Phase alignment** — fix timing offsets between recorded tracks
- **Haas effect** — duplicate a track, pan copies opposite, delay one copy 15–30 ms for stereo width
- **Latency compensation** — manually offset a plugin's inherent latency

### Freeze and flatten

`freeze_track` renders a MIDI or audio track (with all effects) into a temporary audio file, freeing CPU. The track becomes read-only until unfrozen. `flatten_track` converts a frozen track's rendered audio into a permanent audio clip — this removes the original MIDI and devices. Flatten is irreversible except via Ctrl+Z in Ableton, so it goes through the action confirmation gate.

### Warp markers

`set_warp_marker` adds a single warp marker to an audio clip, anchoring a position in the original audio file (`sample_time`, in seconds) to a position in Live's beat timeline (`warped_time`, in beats). `get_warp_markers` reads existing markers. `clear_warp_markers` removes all markers from a clip.

Warp mode can be set alongside any marker operation (0=Beats, 1=Tones, 2=Texture, 3=Re-Pitch, 4=Complex, 5=ComplexPro). All three handlers require `is_audio_clip` and are only available on Live 11+.

### Serialization

`handlers.py` has two serialization modes:

- **`_serialize_track_tier1`** (mixer only) — index, type, name, muted, solo, volume+display, pan+display, sends, routingTarget. No devices. Used for the session overview.
- **`_serialize_track`** (full) — everything above plus all device parameters. Each parameter: `{ value, min, max, display, is_quantized, value_items, scale }`. Racks are recursively traversed — inner devices get full parameter dicts.

### Rack traversal

`_serialize_device` checks `device.can_have_chains` → walks `device.chains` → serializes each nested device. Inner devices are indexed sequentially across all chains for serialization only. `_find_inner_device_by_name(track, rack_name, inner_name)` provides direct name-based access for `param_get`/`param_set`.

### Browser search

`handle_browser_list` and `handle_browser_insert` both use a single canonical traversal function `_walk_browser_root`. This guarantees that any name the LLM sees in the browser list will resolve when `browser_insert` is called — the same code path produces both the list and the lookup. Search order: `plugins` (VST/AU) → `instruments` → `audio_effects` → `midi_effects` → `user_library` → `packs`. Match priority per root: exact → starts-with → contains.

`_walk_browser_root` is seeded with the root node's own name as the initial `_folder` value, so the full breadcrumb path (e.g. `plugins > VST3 > Waves`) is preserved from the top level. Navigation-only nodes (`is_folder=False, is_loadable=False`) — used by Ableton for visual groupings like "Dynamics" or "EQ & Filters" — are traversed transparently without adding their names to the breadcrumb. Only real folder nodes (`is_folder=True`) accumulate into the path. Native Ableton devices that are simultaneously `is_folder=True` and `is_loadable=True` are yielded as loadable items without recursing into their preset children.

### HTTP endpoints (Python bridge)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{"ok": true, "heartbeat": <epoch>, "queue": <int>}` |
| POST | `/api/bridge/command` | Main command path. 503 if heartbeat stale, 504 on timeout. |


---

## 6. The Backend (Node.js)

### Module responsibilities

- **`server.js`** — HTTP routes, WebSocket routing, `sendToBridge()`, bridge watchdog wiring, startup/shutdown. No chat logic.
- **`core/chat.js`** — Pipeline orchestration. Lazy session sync, reason(), track resolution, LLM call, action confirmation gate.
- **`core/actions.js`** — Action execution. Per-action track re-read, LLM-assisted retry, read-back verification.
- **`core/prompt.js`** — System prompt assembly. `buildSystemPrompt()`, `buildRagQuery()`, `parseChatHistory()`.
- **`core/sync.js`** — Session state. `fetchSession()`, `fetchTrackDetails()`, `fetchBrowser()`, formatters, cache management.

### HTTP routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/api/settings` | Read model config + provider info |
| POST | `/api/settings` | Update API key, endpoint, model ID |
| GET | `/api/bridge-status` | Is bridge connected? |
| GET | `/api/has-pending-chat` | Unsaved chat turns? |
| POST | `/api/save-chat` | Flush all chat buffers to disk |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| PATCH | `/api/projects/:name` | Update project metadata |
| DELETE | `/api/projects/:name` | Delete project |
| GET | `/api/projects/:p/conversations` | List conversations |
| POST | `/api/projects/:p/conversations` | Create conversation |
| PATCH | `/api/projects/:p/conversations/:id` | Rename conversation |
| DELETE | `/api/projects/:p/conversations/:id` | Delete conversation |
| GET | `/api/projects/:p/conversations/:id/messages` | Get message history |
| GET/PUT/DELETE | `/api/projects/:p/knowledge/:filename` | Knowledge file CRUD |
| POST | `/api/install-control-surface` | Copy control_surface/ into Ableton |
| POST | `/api/install-presets` | Install .adg presets into User Library |
| POST | `/api/save-preferences` | Write producer.md |

### WebSocket messages (server → client)

| Type | Payload | Description |
|---|---|---|
| `init` | project, conversation, projects, conversations, machineId, bridgeDetected, onboardingDone, appRoot | On connection |
| `chat` | role, text, provider | LLM response |
| `status` | text | Progress indicator |
| `action_pending` | actions[] | LLM proposed actions, awaiting confirmation |
| `action_started` | actions[] | Execution begun |
| `action_complete` | verification | Results with per-action success/failure |
| `bridge_ok` / `bridge_lost` | — | Bridge state changes |
| `project_switched` | project, conversation, conversations | |
| `conversation_switched` | conversation | |
| `save_complete` | project, conversation | |

### WebSocket messages (client → server)

| Type | Payload | Description |
|---|---|---|
| `chat` | text | User message |
| `confirm_actions` | — | Execute pending actions |
| `cancel_actions` | — | Discard pending actions |
| `save_chat` | — | Flush to disk |
| `switch_project` | project | |
| `switch_conversation` | conversation | |
| `new_conversation` | title? | |

---

## 7. Session Data Model

Addie reads session data in two shapes, both via the Python bridge.

### Session overview (`fetchSession`)

Calls `snapshot_tier1` — mixer state and track list for all tracks, no device parameters. Contains tempo, track names, types, muted/solo state, volume, pan, sends, routing targets, and mixer scale probes. Used in every prompt as the session overview.

```
Tempo: 120 BPM | 6 tracks | Returns: A-Reverb, B-Delay
Volume scale (raw→display): 0.0000=-inf dB | ... | 1.0000=6.0 dB

AUDIO:
  Kick  [vol:-6.0 dB (raw:0.7100)]
  Bass  [vol:-4.0 dB (raw:0.7500) →Drum Bus]
MIDI:
  3-Addie - Diva  [vol:0.0 dB (raw:0.8500)]
```

### Track details (`fetchTrackDetails`)

Calls `snapshot` with specific track names — full device parameters for those tracks. Each parameter includes display value, range, scale probes (5 points across the range), and for quantized params the full choice list. Racks are fully traversed — inner devices show all parameters with their device names for direct name-based addressing.

```
3-Addie - Diva:
  Instrument Rack
    ┗ Diva
      params: OSC: Tune2: -0.04 (range: -1.0 to 1.0),
              VCF1: Frequency: 35.50 (range: 20.0 Hz to 20.0 kHz), ...
```

### Browser (`fetchBrowser`)

Calls `browser_list` — full installed device list organized by category (VST/AU plugins, instruments, audio effects, MIDI effects, user library, packs). Fetched once at initial sync and held in memory. Invalidated when the user reports installing a new plugin.

### Session lifecycle

- **`resetAll()`** — clears all four caches (`_session`, `_browserList`, `_annotatedState`, `_fullSnapshot`). Called by `initConversation()` at the start of every conversation open/switch so the next sync reads completely fresh data.
- **`clearSession()`** — nulls `_session` and `_fullSnapshot` only. Called after structural changes (create/delete/group tracks, create/delete return tracks, rename track) that invalidate the track list. The next message detects `getSession() === null` and re-fetches without touching the browser cache.
- On bridge disconnect, `clearSession()` is called so the next reconnect starts fresh.
- `fetchTrackDetails()` always fetches directly from Live — no cache, no dirty tracking.

---

## 8. The Chat Pipeline

Every user message goes through this pipeline in `core/chat.js`:

```
User message
    │
    ▼
Step 1 — Lazy project sync
    Sync runs once per project per app session, on the first message sent to
    that project. _syncedProject tracks which project has been synced.
    handleChat checks two cases:
      A. _syncedProject !== project → full sync (fetchSession + fetchBrowser
         + snapshot). Sets _syncedProject = project.
      B. _syncedProject === project but getSession() === null (structural action
         cleared it mid-conversation) → lightweight recovery: fetchSession() +
         snapshot() only. Browser cache untouched.
    Switching conversations within the same project does NOT re-sync.
    If neither case applies, this step is a no-op.
    │
    ▼
Step 2 — RAG retrieval
    Local cosine similarity search (~2ms, no network)
    Runs per message — topics shift within sessions
    │
    ▼
Step 3 — reason() [intelligence/reasoning.js]
    Cheap LLM call (~80 tokens max)
    Input: session overview + recent message history
    Output: { tracks: string[], need_action: boolean }
    Handles pronoun resolution and semantic references
    ("the muddy low end" → ["Kick", "Bass", "Sub"])
    │
    ▼
Step 4 — Deterministic name-match
    Scan session track list for exact/stripped name mentions in message
    Union with reason() tracks, cap at 8
    │
    ▼
Step 5 — fetchTrackDetails for relevant tracks
    Always fetches fresh from Live — no cache
    Clip data fetched alongside (always — needed for MIDI and automation)
    │
    ▼
Step 6 — Main LLM call
    buildSystemPrompt: session + devices + clips + browser + RAG + producer context
    llm.chat(history + userMessage, systemPrompt)
    │
    ▼
Step 7 — Action confirmation gate
    If actions present: send plan text + action_pending to UI
    Execution pauses until user confirms or cancels
    │
    ▼
Step 8 — Action execution [core/actions.js]
    executeActions() — see Section 9
    │
    ▼
Step 9 — Wrap-up
    Follow-up LLM call with actual results
    Summary sent to UI + saved to conversation log
```

### System prompt structure

```
[Persona + capabilities]
[Constraints & Behavioral Rules — from constraints.js]
[Action format reference — all commands with pipe-delimited syntax]
[Parameter value rules — display units, quantized choice names]
Bridge: connected | not connected

--- SESSION OVERVIEW ---
[Mixer state: tempo, all tracks with volume/pan/sends/routing]

DEVICE PARAMETERS (relevant tracks — fresh from Ableton this turn)
[Full device chains with parameters for targeted tracks]

CLIP LAYOUT
[Session view slot data for targeted tracks, if available]

--- INSTALLED DEVICES ---
[Browser list by category]

--- REFERENCE KNOWLEDGE ---   ← only if RAG returned results
[Retrieved audio engineering passages]

--- PRODUCER CONTEXT ---
[producer.md + project knowledge + last annotated session.md + templates.md]
```


---

## 9. Action Execution

`core/actions.js` executes all action blocks found in the LLM reply.

### Core principle

Before any device action, always re-read the target track from Live. No assumptions about cached state. No phase gates.

```javascript
// Pseudocode for every device action:
async function handleDeviceAction(trackName, action) {
  await resyncTrack(trackName)   // always, unconditionally
  await executeAction(action)    // with fresh data in cache
}

// For browser_insert specifically:
async function handleLoad(trackName, deviceName) {
  await resyncTrack(trackName)   // read state before load
  await executeLoad()            // load the device
  await wait(2000)               // Live needs time to register
  await resyncTrack(trackName)   // re-read with new device present
  // subsequent param_set actions on this track now have real parameter data
}
```

### Execution loop

For each action block in the LLM reply:

1. Auto-prepend `create_track` if `browser_insert` targets a track not in the session
2. If a prior structural action failed, mark remaining actions as `skipped` and continue (no execution)
3. `_resyncTrack(trackName)` — fetch fresh track data from Live (runs for `param_set`, `browser_insert`, and `delete_device`)
4. Execute via `sendToBridge(command, params)`
5. If `browser_insert` succeeded: wait 2s, re-fetch track, record device/param confirmation
6. If `delete_device` succeeded: wait 500ms, re-fetch Tier 1 to detect any track rename Ableton may have applied (e.g. "Reverb" → the track's base name after its last device is removed). If a rename is detected, all remaining actions in the batch that reference the old name are patched in-place with the new name before executing.
7. On failure: one LLM-assisted retry via `analyzeAndCorrectAction()`
8. If a structural command still fails after retry: set halt flag — all remaining actions are skipped

### Structural vs. non-structural failures

**Structural commands** (`browser_insert`, `delete_device`, `move_device`, `create_track`, `delete_track`, `duplicate_track`, `group_tracks`, `ungroup_tracks`, `create_return`, `delete_return`, `freeze_track`, `flatten_track`) mutate the session topology. If one fails, the device chain or track list is no longer what the rest of the batch was planned against. Execution halts — remaining actions are marked `skipped` rather than attempted.

**Non-structural commands** (`param_set`, `set_mixer`, `set_mute`, `enable_device`, `set_clip_notes`, `set_track_delay`, `set_warp_marker`, etc.) fail in isolation. A failed `param_set` on one track does not affect other actions in the batch.

### Name-based device resolution

All device actions use **device names**, not numeric indices. The Python bridge resolves names to live positions at execution time via `_find_device_by_name` and `_find_inner_device_by_name`. This eliminates the class of bugs where sequential actions in the same batch (e.g. two deletes) corrupt each other's index references because Live's chain shifted after the first operation.

If a name is ambiguous (two devices with the same name on one track), the bridge returns an explicit error. If a name is not found, the error lists all available devices on the track.

### After structural changes

`create_track`, `delete_track`, `duplicate_track`, `group_tracks`, `ungroup_tracks`, `create_return`, `delete_return`, `rename_track` → call `clearSession()` so the track list is re-fetched on the next message.

### Error correction

`analyzeAndCorrectAction()` sends the failed action + error to a cheap LLM call. For "parameter not found" errors, it fetches the actual device list from the track by name — showing all devices and their inner devices — and includes it as context. If the device itself wasn't found, the hint lists every device on the track so the LLM can target the right one. Returns a corrected pipe-delimited action string or `NO_FIX`.

### Read-back verification

After `param_set`: calls `param_get` immediately and compares sent vs. actual value. Surfaces mismatches and clamp warnings in the UI.

After `set_clip_notes`: calls `get_clip_notes` and compares note count.

---

## 10. Parameter Value System

Ableton exposes device parameters as raw numeric values with non-linear mappings to display units. The mapping varies per parameter, per device, per manufacturer — there is no formula.

### Scale probing

During full serialization, every continuous parameter is probed at 5 points across its range via `param.str_for_value()`:

```python
entry['scale'] = [
    [0.00, param.str_for_value(lo)],   # 0%
    [0.25, param.str_for_value(q1)],   # 25%
    [0.50, param.str_for_value(mid)],  # 50%
    [0.75, param.str_for_value(q3)],   # 75%
    [1.00, param.str_for_value(hi)],   # 100%
]
```

This gives the LLM a concrete range in display units. Example:
```
Threshold: -18.0 dB (range: -60.0 dB to 0.0 dB)
```
The LLM targets `-20` and the bridge resolves it to the correct raw value.

### What the LLM sends

**Continuous parameters:** display-unit value matching the scale range. `param_set | Kick | Compressor | Threshold | -20`

**Quantized parameters (choices/dropdowns):** exact choice name from the choices list. `param_set | Kick | Compressor | Ratio | 4:1`

Raw internal values are never sent. The bridge resolves display values to raw via binary search on the parameter's scale.

---

## 11. LLM Integration

`services/llm.js` provides a unified OpenAI-compatible interface across all providers.

### Supported providers (auto-detected from API key)

| Provider | Key prefix | Notes |
|---|---|---|
| OpenAI | `sk-` | |
| Anthropic | `sk-ant-` | Via OpenAI-compatible endpoint |
| DeepSeek | `sk-` (DeepSeek portal) | Strong reasoning, cost-effective |
| OpenRouter | `sk-or-` | Multi-provider routing |
| Mistral | 32-char alphanumeric | |

### Local models

Set endpoint to `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1` (LM Studio). No API key required.

### LLM calls in the pipeline

| Call | Model | Max tokens | Purpose |
|---|---|---|---|
| `reason()` | Configured model | 80 | Semantic track resolution |
| Main chat | Configured model | 4096 | Response + action generation |
| `analyzeAndCorrectAction()` | Configured model | 200 | Error correction |
| Wrap-up | Configured model | 400 | Post-execution summary |

---

## 12. RAG — Knowledge Retrieval

`services/rag.js` manages a Python subprocess (`scripts/query_index.py`) that stays alive with the sentence-transformers model loaded in RAM.

### Knowledge base

Pre-built from 5 audio engineering reference books (PDFs in `knowledge/`). Split into 2,129 chunks, embedded with `all-MiniLM-L6-v2`. Index files committed to the repo — end users never build it.

### Retrieval

Per message, before the main LLM call: cosine similarity search, top-5 chunks, ~2ms locally. Query built from the user message + device names on relevant tracks. Results injected into the system prompt under `--- REFERENCE KNOWLEDGE ---` only when retrieved.

---

## 13. Session Annotation

`intelligence/annotation.js` runs once at initial sync: reads the full session with all device parameters, sends tracks to the LLM in chunks of 8, and produces device-level annotations (what each device is doing in mixing terms) and flags (issues, concerns). Output written to `projects/<n>/session.md`.

The annotation is background context — it informs the LLM through `session.md` in the producer context section, but never overrides fresh device parameter data from the current message.

`intelligence/translator.js` runs deterministically before annotation: infers track roles from names (kick, bass, vocal bus, etc.), builds track-level flags (muted, no devices, no master limiter), and detects cross-track issues (frequency masking between kick and bass EQ boosts, multiple soloed tracks).

---

## 14. Context, Projects & Conversations

### Projects

Each project in `projects/<n>/` has:
- `meta.json` — name, description, timestamps
- `session.md` — structural session snapshot, updated on every sync (no LLM required). Contains tempo, track list, mixer state, and device names per track. Also updated by the LLM-powered `annotateSession()` when that runs.
- `templates.md` — auto-detected session templates (append-only)
- `conversations/` — one `.md` + `.json` per conversation
- `knowledge/` — user-added reference files injected into every prompt

### Sync lifecycle

Session sync is **lazy and project-scoped**. It runs once per project per app session, triggered by the first message sent to that project — not on app launch, not on conversation switch.

`initConversation(project)` is called on `switch_project` and on bridge watchdog reconnect. It clears all in-memory caches via `sync.resetAll()` and sets `_syncedProject = null`, so the next message triggers a fresh sync. It does **not** do any eager sync itself.

Switching conversations within the same project — via `switch_conversation`, `new_conversation`, or WebSocket reconnect — does not clear caches or re-sync. The session data from the current project's sync remains valid.

On bridge disconnect, `resetConversation()` sets `_syncedProject = null` so the next message re-syncs once the bridge is back.

`context.updateSessionFromSync(project, tier1, snapshot)` writes fresh structural data to `session.md` after every full sync (diff-checked, no write if nothing changed).

Chat turns are buffered in memory and only written to disk on explicit save (Ctrl+S or confirmed close). Conversation files are append-only markdown.

### Producer context assembly

`context.assembleContext(project, freshDetailNames)` builds the producer context block:
1. `producer.md` — global preferences and learned habits
2. Project knowledge files — user-added references
3. `session.md` — last known session state, with sections for freshly-read tracks redacted to avoid contradiction with the live device parameters already in the prompt
4. `templates.md` — detected session templates

The `freshDetailNames` set tells the assembler which tracks have current device data in the prompt — those tracks are excluded from `session.md` to prevent the LLM seeing both stale annotations and fresh parameters for the same track.


---

## 15. Third-Party Plugin Parameter Access

VST/AU plugins run in their own process. Ableton only exposes parameters it has been explicitly told about via **Configure mode** — clicking Configure in the device panel, then touching each parameter in the plugin's GUI adds it to Ableton's parameter list.

### The Rack wall

When a plugin is wrapped in an Instrument Rack (which Ableton does automatically in many workflows), `track.devices` returns the Rack, not the plugin. Addie's serialization walks inside Racks: `device.can_have_chains` → `device.chains` → `chain.devices`. Inner devices get full parameter dicts and are addressed by name: `param_set_inner | TrackName | RackName | InnerDeviceName | ParamName | value`.

### Multi-chain Rack addressing

Audio Effect Racks can have multiple parallel chains (e.g. a frequency-splitting preset with "Low" and "High" chains, each containing their own devices). The serialization already exposes `chainName` on every inner device. When two chains contain a device with the same name (e.g. both have a "Compressor"), the resolver requires `chainName` to disambiguate:

```
# Single-chain Rack — chainName not needed:
param_set | Drums | Instrument Rack | Diva | Filter Freq | 800

# Multi-chain Rack — chainName required when names collide:
param_set | Drums | Audio Effect Rack | Compressor | Threshold | -18
  → with chainName: "High"
```

If `chainName` is omitted and the name is ambiguous across chains, the bridge returns an error listing all available `"DeviceName"/chain:"ChainName"` pairs. `enable_device` supports the same `chainName` parameter.

**Limitation:** `browser_insert` cannot target a specific chain — the LOM has no API to select a destination chain before loading. Multi-chain presets must be shipped as pre-built `.adg` files with devices already in place; Addie configures their parameters from there.

### Pre-configured presets (.adg files)

Addie ships Instrument Rack presets with Configure lists already populated for popular plugins. On first sync, these are installed into Ableton's User Library under an `Addie/` subfolder.

When the LLM generates `browser_insert TrackName Diva`, the server intercepts via `plugins/presets.js` and rewrites it to `browser_insert TrackName Addie - Diva`, loading the pre-configured preset instead. The user gets full parameter access without ever touching Configure mode.

### Fallback for unconfigured plugins

If a plugin loads with no exposed parameters, Addie tells the user: open the plugin GUI, click Configure, wiggle every parameter you want Addie to control, then ask again. The configured parameters persist in the Live Set.

### Adding new presets

1. Load plugin in Ableton → open Configure → touch all important parameters
2. Group into Instrument Rack → save as "Addie - PluginName" in User Library
3. Copy .adg into `presets/`
4. Add entry to `presets/registry.json`: `{"PluginName": "Addie - PluginName"}`

---

## 16. Ports & Communication

| Port | Process | Purpose |
|---|---|---|
| 3000 | Node.js backend | Express HTTP + WebSocket |
| 3001 | Python control surface | Bridge command HTTP server |

Node → Python: HTTP POST to `http://127.0.0.1:3001/api/bridge/command`

Electron → Node: `fork()` on startup, IPC for path detection, HTTP for flush-on-close

UI → Node: WebSocket on port 3000

RAG subprocess: managed by `rag.js` via stdin/stdout

---

## 17. Design Principles

### Always read before acting

Before any device action, re-read the target track from Live. No assumptions about cached state. This eliminates an entire class of bugs where stale parameter data causes wrong actions.

### Determinism over cleverness

The pipeline has one decision point that uses an LLM: `reason()`, which resolves which tracks the user is referring to. Everything else is deterministic. No conditional fetch logic, no safety nets correcting other safety nets.

### All context upfront, per conversation

When a conversation is opened, Addie reads everything — session Tier 1, all device parameters, browser list — before the first message arrives. Subsequent messages within that conversation fetch fresh data only for the tracks the user is talking about. The LLM always has full context before answering.

### Conversation boundaries reset state

Switching projects or conversations clears all in-memory session caches via `sync.resetAll()`. The new conversation always syncs from scratch. This means there is no cross-conversation cache contamination — the session state the LLM sees always reflects the current Live session and the current project.

### Action confirmation

The LLM proposes actions, the user confirms, then they execute. No writes happen without user intent. The producer stays in control.

### Scope boundaries

Excluded from LLM dispatch intentionally: `play`, `stop`, `fire_clip`, `fire_scene`, `arm_track`. These are real-time performance operations. Having an AI fire clips or arm tracks during a live session is dangerous — these remain manual.

---

## 18. Compatibility — Live 10/11/12, Windows/macOS

### Supported matrix

| | Live 11 | Live 12 |
|---|:---:|:---:|
| Windows | ✓ | ✓ |
| macOS | ✓ | ✓ |

> **Live 10 is not supported.** Live 10 runs Python 2, which is fundamentally incompatible with the control surface codebase (Python 3 — f-strings, `super()`, `threading.Thread(daemon=True)`, stdlib import paths, encoding). Live 11 is a free upgrade for Live 10 license holders.

### compat.py

All version-specific API differences are centralised in `control_surface/compat.py`. The rest of the codebase imports shim functions from there and never branches on version directly.

#### `get_live_version() → (major, minor, patch)`

Detects the running Live version on first call (cached). Strategy cascade:

1. `Live.Application.get_application().get_major_version()` — canonical, works on all versions
2. `hasattr(Clip.Clip, 'get_notes_extended')` — symbol inspection fallback
3. Returns `(0, 0, 0)` if detection fails — callers use the oldest-compatible code path

Result is logged to `Log.txt` immediately after `log_message` becomes available in `Addie.__init__`.

#### `get_control_surface_base() → class`

Returns the correct `ControlSurface` base class for the current platform:

1. `_Framework.ControlSurface` — Live 10/11/12 primary path (Windows and macOS)
2. `_AbletonDevicesFramework.ControlSurface` — Live 12 alternate path
3. `_StubControlSurface` — no-op stub for unit tests and static analysis outside Live

Called at `addie.py` module import time (before `log_message` is wired up). Falls back to `print()` for its own log line until the logger is ready.

#### `get_clip_notes(clip) → list[dict]`

| Live version | API used |
|---|---|
| 11+ | `clip.get_notes_extended(from_pitch, pitch_span, from_time, time_span)` → `MidiNote` objects |
| 10 | `clip.get_notes(from_time, from_pitch, time_span, pitch_span)` → tuple list |

Returns unified `[{pitch, start, duration, velocity, mute}, ...]` regardless of version.

#### `remove_clip_notes(clip, from_pitch, pitch_span, from_time, time_span)`

| Live version | API used |
|---|---|
| 11+ | `clip.remove_notes_extended(...)` |
| 10 | Read all notes → filter → `select_all_notes()` + `replace_selected_notes(keep)` |

#### `set_clip_notes(clip, notes_data, clear_existing) → int`

Three-tier cascade:

| Live version | API used |
|---|---|
| 11.1+ | `Live.Clip.MidiNoteSpecification` + `clip.add_new_notes()` |
| 11.0 | `collections.namedtuple` shim + `clip.add_new_notes()` |
| 10 | `clip.set_notes()` / `select_all_notes()` + `replace_selected_notes()` |

Returns number of notes written.

#### `init_control_surface(instance, c_instance)`

Calls the `ControlSurface` base `__init__` in a version-safe way. Used in `Addie.__init__` instead of `super().__init__(c_instance)`.

**Why this exists:** On Live 10, `_Framework.ControlSurface.__init__` takes no arguments beyond `self` — `c_instance` is stored internally by the framework before `__init__` runs. Passing it explicitly raises `TypeError`, and Live silently discards the entire script without logging anything. The control surface never appears in Preferences as a selectable device.

The shim inspects the base class `__init__` signature at runtime via `inspect.signature`. If the signature accepts a second parameter it calls with `c_instance`; otherwise without. For C-extension types where `inspect.signature` raises, it falls back to try-with / catch-`TypeError` / retry-without.

This is transparent on Live 11/12 where the argument is accepted normally.

#### `get_routing_display(track) → str | None`

`track.output_routing_type.display_name` wrapped in `try/except`. Returns `None` on Live 10 where this can raise on return/master tracks — routing info simply doesn't appear in context rather than crashing.

### Electron — platform paths

`electron/main.js` already handles platform differences for installation and User Library detection:

**Ableton MIDI Remote Scripts path:**
- Windows: `{drive}\ProgramData\Ableton\Live x.x.x\Resources\MIDI Remote Scripts`
  Probes the `PROGRAMDATA` drive plus `C:`, `D:`, `E:` to cover non-system-drive installs.
- macOS: `/Applications/Ableton Live x.app/Contents/App-Resources/MIDI Remote Scripts`
  Also checks `~/Applications` for user-scoped installs.

**User Library path:**
- Windows: `%USERPROFILE%\Documents\Ableton\User Library` and `OneDrive\Documents` variant
- macOS: `~/Music/Ableton/User Library` and `~/Library/Mobile Documents/com~apple~CloudDocs/Music/Ableton/User Library` (iCloud Drive)

**Port cleanup (`freePort`):**
- Windows: `netstat -ano | findstr` + `taskkill /PID`
- macOS/Linux: `lsof -ti tcp:{port} | xargs kill -9`

Both branches are already in place and the install handler in `server.js` uses paths passed from Electron via IPC — no hardcoded platform paths in the Node layer.

### Known limitations by version

| Area | Live 11 | Live 12 |
|---|---|---|
| Clip note read/write | Modern API | Modern API |
| Routing display | Full support | Full support |
| Browser categories | Reference baseline | May add new roots; `_walk_browser_root` is structure-agnostic |
| `create_group_track` | ✓ | ✓ |
| `create_track` return value | Returns `int` index — `handle_create_track` locates track by position | Returns `Track` object directly — used as-is |
| `_Framework` | ✓ | Primary + `_AbletonDevicesFramework` fallback |

---

## 19. UI — Themes & Internationalisation

### Themes (`ui/themes.js`)

Addie ships four built-in themes, each defined as a complete set of CSS custom properties. The theme system applies variables directly to `:root` so every component inherits them with no additional class logic.

**Available themes:**

| Key | English label | Spanish label | Accent |
|---|---|---|---|
| `midnight` | Midnight | Medianoche | `#c8ff00` (lime) |
| `clear` | Clear | Claro | `#1a1a1a` (near-black, light bg) |
| `carmesi` | Carmesí | Carmesí | `#ff3b5c` (crimson) |
| `turquesa` | Turquesa | Turquesa | `#00e5c8` (teal) |

**How it works:**

1. On load, `themes.js` reads the saved preference from `localStorage` (`addie-theme`) and calls `applyTheme()` immediately — before any other script runs — to avoid a flash of the default theme.
2. `applyTheme()` always resets to the `midnight` defaults first, then overlays the selected theme's variables. This ensures no stale variables leak when switching.
3. `setTheme(name)` saves to `localStorage` and calls `applyTheme()`.
4. The theme picker in Settings is rendered dynamically by `renderThemePicker()` in `app.js`. Each button carries a `--swatch` CSS variable set to the theme's accent colour, used by a `::before` pseudo-element to show a colour dot.

**CSS variables set per theme:**

`--bg`, `--surface`, `--border`, `--accent`, `--accent-dim`, `--text`, `--text-dim`, `--user-bubble`, `--addie-bubble`, `--danger`, `--ok`, `--warn`

**Public API** (exposed as `window.themes`):

| Function | Purpose |
|---|---|
| `getTheme()` | Returns current theme key |
| `getThemes()` | Returns the full `THEMES` object |
| `setTheme(name)` | Switches theme, persists to localStorage |
| `applyTheme()` | Re-applies current theme vars to `:root` |
| `THEMES` | Raw theme definitions object |

---

### Internationalisation (`ui/i18n.js`)

Addie supports English (`en`) and Spanish (`es`). The active language persists in `localStorage` (`addie-lang`).

**Architecture:**

- All UI strings live in `TRANSLATIONS[lang][key]` inside `i18n.js`.
- `t(key, params)` is the translation shorthand used throughout `app.js` and `onboarding.js`. Params are interpolated with `{placeholder}` syntax, e.g. `t('chat.synced', { count: 6 })`.
- Static HTML elements that hold translatable text carry a `data-i18n="key"` attribute. `applyTranslations()` sweeps all of them and sets `textContent` (or `placeholder` for inputs).
- Dynamic content rendered via JS must call `t()` at render time — it is not retroactively updated by `applyTranslations()`. This applies to: bridge indicator labels, action block messages, kickstart chips, conversation titles, relative timestamps, and settings feedback strings.

**Language switching flow:**

1. User clicks a language button in the Settings `lang-picker`.
2. `setLanguage(lang)` saves to `localStorage` and calls `applyTranslations()`.
3. The `lang-picker` click handler in `app.js` additionally re-renders: `renderThemePicker()` (theme labels are localised), `renderProjectGrid()`, `renderSidebarConvList()`, `updateChatConvTitle()`, `updateBridgeIndicators()`, and the sync status element.

**Kickstarts localisation:**

English kickstarts are loaded from `ui/kickstarts.json`. Spanish kickstarts are defined inline in `i18n.js` as `KICKSTARTS_ES` and returned by `getKickstarts()` when the active language is `es`. `showKickstarts()` in `app.js` checks `window.i18n.getKickstarts()` first and falls back to the JSON if it returns `null`.

**Adding a new language:**

1. Add a new key block under `TRANSLATIONS` in `i18n.js` — copy the `en` block and translate all values.
2. Add a `<button class="lang-option" data-lang="xx">` in the `#lang-picker` div in `index.html`.
3. Optionally add a localised kickstarts block (same structure as `KICKSTARTS_ES`) and update `getKickstarts()` to return it.

**LLM language matching:**

The system prompt in `core/prompt.js` instructs Addie to always reply in the same language the user used in their last message. This is independent of the UI language setting — if the user writes in Spanish, Addie responds in Spanish regardless of what language the UI is set to.

---

## 20. Constraints & Behavioral Rules

`app/core/constraints.js` is the single source of truth for all rules about how Ableton behaves, what the LOM API can and cannot do, and how the LLM should plan action batches.

### Why this file exists

Before `constraints.js`, rules accumulated as patches scattered across the codebase: hardcoded strings inside `_buildActionFormat()` in `prompt.js`, inline comments in `actions.js`, and ad-hoc checks in `chat.js`. Every time a new edge case was discovered in testing, a fix landed in whichever file was closest to the symptom — with no central record of what was known and why.

`constraints.js` consolidates all of them. Adding a new rule means adding one entry to this file. No other file needs to change for prompt-only rules.

### Structure

Rules are organised into four arrays:

| Array | Purpose |
|---|---|
| `GLOBAL` | Operating scope and context — shown first in the prompt |
| `ABLETON_BEHAVIORS` | Facts about how Live behaves (track rename, device resolution, etc.) |
| `API_LIMITS` | Things the Python LOM API cannot do at all |
| `PLANNING_RULES` | Constraints that shape how the LLM generates action plans |

Each entry:

```js
{
  id:         'track-rename-on-instrument-load',  // stable identifier
  summary:    'one-line description',              // for docs and logs
  promptText: `...`,                               // injected into system prompt
  runtimeKey: 'track-rename-on-instrument-load',  // links to compensating code
                                                   // in actions.js (null if none)
}
```

### How rules reach the LLM

`buildConstraintsPrompt()` formats all four arrays into a single string block, separated by category headers. This block is injected into the system prompt by `prompt.js` between the capabilities paragraph and the action format reference — so the LLM reads constraints before it reads the command syntax.

```js
// prompt.js
const constraints = require('./constraints');
// ...
blocks.push(constraints.buildConstraintsPrompt());
```

### Runtime trazability

Rules that have a compensating runtime behaviour in `actions.js` carry a `runtimeKey`. The corresponding code in `actions.js` has a comment `// constraint: <id>` to make the link explicit. This means you can find all the places a rule touches by searching for its `id`.

Example — the track rename rule:
- `constraints.js`: entry with `id: 'track-rename-on-instrument-load'`, `promptText` explaining the LLM what to expect
- `actions.js`: `_syncTier1AndPatchBatch()` with `// constraint: track-rename-on-instrument-load` — the runtime compensation that detects the rename by positional diff and patches remaining actions in the batch

### Current rule inventory

| id | category | summary |
|---|---|---|
| `session-view-only-scope` | global | Addie operates exclusively in Session View |
| `track-rename-on-instrument-load` | ableton-behavior | Ableton auto-renames MIDI tracks on instrument load (default name only) |
| `track-delete-reorders-session` | ableton-behavior | Deleting a track shifts all subsequent track positions |
| `browser-insert-loads-at-end-of-chain` | ableton-behavior | browser_insert always appends to the end of the device chain |
| `plugin-params-in-rack` | ableton-behavior | Inner device params in a Rack → param_set_inner |
| `param-set-on-rack-hits-macros` | ableton-behavior | param_set on a Rack writes to Macro knobs, not the inner plugin |
| `device-name-ambiguity` | ableton-behavior | Two devices with the same name on one track causes an error |
| `midi-track-sends-require-instrument` | ableton-behavior | MIDI tracks without a loaded instrument have no active sends |
| `drum-rack-pad-naming` | ableton-behavior | Pads with generic names → cannot infer note-to-sound mapping |
| `no-chains-via-api` | api-limit | Rack chains are read-only via the LOM |
| `no-chain-rename-via-api` | api-limit | Chain names are read-only |
| `no-macro-assignment-via-api` | api-limit | Macro→parameter mappings cannot be created programmatically |
| `no-samples-in-pads` | api-limit | No file-path sample assignment in Drum Rack, Simpler, or Sampler |
| `no-move-clip-between-tracks` | api-limit | Clips are track-local — no cross-track move/copy |
| `group-tracks-must-be-contiguous` | api-limit | group_tracks fails if selected tracks are not adjacent |
| `automation-clip-envelopes-only` | api-limit | Automation is per-clip (clip envelopes), not Arrangement-wide |
| `warp-markers-audio-clips-only` | api-limit | Warp marker commands fail on MIDI clips |
| `flatten-is-irreversible` | api-limit | flatten_track permanently removes MIDI and devices |
| `set-track-delay-not-on-master-return` | api-limit | set_track_delay fails on master and return tracks |
| `create-track-always-appends` | api-limit | create_track appends at end of track list regardless of index |
| `param-set-requires-known-params` | api-limit | param_set only valid when device params appear in DEVICE PARAMETERS — never for devices loaded in the current batch |
| `freeze-before-flatten` | planning-rule | flatten_track requires the track to be frozen first |
| `return-track-send-index` | planning-rule | New return track gets the next send letter — count existing returns first |
| `set-routing-after-create-return` | planning-rule | New return doesn't appear in routing options until next sync — don't set_routing in same batch |
| `parallel-compression-via-sends` | planning-rule | Parallel compression = sends, not set_routing |
| `browser-insert-needs-existing-track` | planning-rule | browser_insert requires existing track — create_track for audio/MIDI, create_return for returns |
| `clip-slot-index-from-clip-layout` | planning-rule | Always write clips to free slots — never overwrite or delete existing clips unless explicitly asked |
| `never-delete-clip-unprompted` | planning-rule | Never emit delete_clip unless explicitly requested — never to make room for a new clip |
| `create-clip-occupied-slot` | planning-rule | If a slot is occupied, use the next free one and shift all subsequent clips in the plan — never delete existing clips to make room |

### Adding a new rule

1. Add an entry to the appropriate array in `constraints.js`
2. Set `promptText` to the text the LLM should read — be specific and concrete
3. Set `runtimeKey` to the rule's `id` if there's compensating code in `actions.js`, otherwise `null`
4. If runtime code is needed, add it to `actions.js` with a comment `// constraint: <id>`
5. Update the inventory table above
