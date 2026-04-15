# Addie

AI producer assistant for Ableton Live. Bridges a Python control surface, a Node.js backend,
and any LLM into a chat interface that sees your session, diagnoses mix problems, and controls your DAW.

**Supported:** Ableton Live 11, 12 — Windows and macOS.

---

## How it works

Addie runs as a native desktop app (Electron). On launch it starts a local server that:
- Connects to Ableton via a **Python MIDI Remote Script** (full session access — mixer, devices, parameters, transport, clips, automation)
- Talks to an **LLM** (your API key, or a local model like Ollama) to understand and respond
- Uses **RAG** (retrieval-augmented generation) grounded in audio engineering reference books

Everything stays local. No cloud sync, no accounts. Your session data never leaves your machine unless you configure a remote LLM.

---

## Compatibility

| | Live 11 | Live 12 |
|---|:---:|:---:|
| Windows | ✓ | ✓ |
| macOS | ✓ | ✓ |

Cross-version API differences (clip note APIs, framework imports) are handled in
`control_surface/compat.py`. Detected Live version is logged to `Log.txt` on startup.

> **Live 10 is not supported.** Live 10 runs Python 2, which is incompatible with the control surface codebase (Python 3). Live 11 is a free upgrade for Live 10 license holders.

---

## Installation

### 1. Install and run
```bash
npm install
npm start
```
Or download the installer from Releases.

On first launch, the onboarding wizard will:
1. Set up your LLM (API key or local model)
2. Detect your Ableton installation and install the control surface automatically
3. Install pre-configured plugin presets into your User Library
4. Walk you through enabling the control surface in Ableton's MIDI preferences

### 2. Configure your LLM

**Supported providers (auto-detected from API key prefix):**
| Provider | Key prefix |
|---|---|
| OpenAI | `sk-` |
| Anthropic | `sk-ant-` |
| DeepSeek | `sk-` (DeepSeek portal) |
| OpenRouter | `sk-or-` |
| Mistral | 32-char alphanumeric |

**Local models (no key needed — set endpoint instead):**
| Tool | Endpoint |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |


---

## Architecture (app/)

```
app/
├── server.js              ← HTTP routes, WebSocket, bridge, startup
├── config.js              ← Config load/save with deep merge
├── core/
│   ├── chat.js            ← Pipeline orchestration, action confirmation gate
│   ├── actions.js         ← Action execution with per-action track re-read
│   ├── prompt.js          ← System prompt construction
│   ├── sync.js            ← Session state: fetchSession, fetchTrackDetails, browser
│   └── constraints.js     ← Single source of truth for all Ableton behavioral rules
├── intelligence/
│   ├── reasoning.js       ← reason() — semantic track resolution
│   ├── annotation.js      ← annotateSession() — LLM device analysis at sync time
│   └── translator.js      ← Deterministic role/flag inference
├── services/
│   ├── bridge.js          ← Python bridge watchdog + heartbeat
│   ├── llm.js             ← Unified LLM interface (OpenAI-compatible)
│   └── rag.js             ← RAG retrieval (manages Python subprocess)
├── state/
│   ├── context.js         ← Projects, conversations, knowledge, session.md
│   └── memory.js          ← Producer pattern learning → producer.md
└── plugins/
    ├── presets.js          ← .adg preset registry + browser_insert intercept
    └── automation.js       ← Breakpoint math for automation envelopes
```

## Control surface (control_surface/)

```
control_surface/
├── __init__.py    ← Ableton entry point (create_instance)
├── addie.py       ← ControlSurface class, command queue, dispatch
├── server.py      ← HTTP server on :3001, Future-based sync protocol, heartbeat
├── handlers.py    ← Live API implementations (50+ commands)
├── compat.py      ← Cross-version shims: Live 11/12, Windows/macOS
└── logger.py      ← [Addie] prefixed log_message wrapper
```

`compat.py` centralises every Live API difference so `handlers.py` stays version-agnostic:
- Clip note reading — `get_notes_extended` (Live 11+)
- Clip note writing — `MidiNoteSpecification` (Live 11.1+) → namedtuple shim → `set_notes` (Live 11.0)
- Clip note removal — `remove_notes_extended` (Live 11+)
- Track routing display — `output_routing_type.display_name` with graceful fallback
- Framework import — `_Framework` → `_AbletonDevicesFramework` (Live 12 alt path) → stub

---

## Ports used
| Port | Purpose |
|---|---|
| 3000 | Addie UI + backend (Express + WebSocket) |
| 3001 | Python control surface (inside Ableton) |


---

## How session data flows

### Initial sync (first message of a session)

On the first message after opening a conversation, Addie reads the following from Live:

- **Mixer state** — volume, pan, sends, mute, solo, routing for every track
- **Tempo**
- **Track list** — all tracks including return tracks, their names and types
- **Device parameters** — full parameter values for every device on every track, including devices inside Racks and inner device parameters
- **Installed devices** — the full browser list (VST/AU plugins, Ableton instruments, effects, packs, user library)

**Not read at initial sync:**
- Clip layout and MIDI note content — fetched per-message for relevant tracks only
- Automation envelopes — same, fetched on demand
- Arrangement length — not currently exposed by the bridge

### Per-message updates

On each subsequent message, Addie identifies which tracks the user is referring to (via semantic reasoning + name matching), then fetches fresh device parameters and clip data for those tracks specifically before answering or planning actions.

**Important:** the mixer-level data (volume, pan, sends, routing, tempo) is not re-read per message — it reflects the state at initial sync. If you change the volume of a track manually in Ableton between two messages, Addie won't see that change until the next session sync. Device parameters for the tracks you're talking about are always fresh.

### After structural changes

If Addie performs a structural action mid-conversation (create/delete/group tracks, create/delete return tracks), the session track list is cleared. The next message re-fetches it automatically before building the prompt.

## How action batches work

The LLM proposes a batch of actions. The producer confirms. Then they execute in order.

**Device addressing is name-based** — actions reference devices by name (`delete_device | Kick | Pro-Q 3`), not by numeric index. The Python bridge resolves names at execution time, so deleting a device mid-batch never silently corrupts the indices of subsequent actions. Inner devices inside Racks are addressed by `deviceName` + `innerDeviceName`. When a Rack has multiple parallel chains and both contain a device with the same name, `chainName` disambiguates — e.g. targeting the "Compressor" in the "High" chain vs. the "Low" chain.

**Structural failures halt the batch.** Commands that mutate session topology (`browser_insert`, `delete_device`, `create_track`, `freeze_track`, `flatten_track`, etc.) are classified as structural. If one fails after retry, all remaining actions in the batch are marked `skipped`. Non-structural failures (`param_set`, `set_mixer`, `set_track_delay`, `set_warp_marker`, etc.) fail in isolation and don't stop the batch.

**Wrap-up is causally aware.** After execution, a follow-up LLM call explains what happened across the full numbered sequence — including which actions were skipped as a result of an earlier failure.

---

## Project memory

Each project lives in `projects/<n>/`:
- `meta.json` — project metadata
- `session.md` — last annotated session state (written at sync time)
- `templates.md` — detected session templates
- `conversations/<id>.md` — append-only conversation history
- `knowledge/<file>` — user-added reference files injected into every prompt

`producer.md` at the root is global memory across all projects.

---

## Building the installer

```bash
npm run build:win   # Windows .exe (NSIS installer)
npm run build:mac   # macOS .dmg
```

---

## Developing

```bash
npm run dev         # Opens with DevTools
```

Log output from the Python control surface goes to Ableton's `Log.txt`:
- **Windows:** `%APPDATA%\Ableton\Live x.x.x\Preferences\Log.txt`
- **macOS:** `~/Library/Preferences/Ableton/Live x.x.x/Log.txt`

All lines from Addie are prefixed with `[Addie]` for easy filtering.
