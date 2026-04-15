/**
 * app/rag.js - RAG retrieval module.
 *
 * Manages a long-lived Python subprocess (scripts/query_index.py) that
 * keeps the embedding model and index vectors in memory between queries.
 *
 * The subprocess is spawned lazily on first retrieve() call and stays
 * alive for the lifetime of the server process.
 *
 * If the index doesn't exist or the subprocess fails to start,
 * retrieve() returns [] gracefully — the rest of the pipeline continues
 * without RAG rather than crashing.
 *
 * Interface:
 *   retrieve(query, topK?)  -> Promise<Array<{ text, source, score }>>
 *   isReady()               -> bool
 *   getStatus()             -> { ready, error, indexExists }
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const readline   = require('readline');

const ROOT       = process.env.ADDIE_ROOT || path.join(__dirname, '..', '..');
const INDEX_DIR  = path.join(ROOT, 'knowledge', '.index');
const SCRIPT     = path.join(ROOT, 'scripts', 'query_index.py');
const DEFAULT_K  = 5;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _proc        = null;   // child_process
let _ready       = false;  // subprocess sent { ready: true }
let _error       = null;   // startup error message if any
let _pending     = [];     // { resolve, reject } queue while subprocess starts
let _rl          = null;   // readline interface on subprocess stdout

// ---------------------------------------------------------------------------
// Index presence check
// ---------------------------------------------------------------------------

function indexExists() {
  return (
    fs.existsSync(path.join(INDEX_DIR, 'chunks.json')) &&
    fs.existsSync(path.join(INDEX_DIR, 'vectors.npy'))
  );
}

// ---------------------------------------------------------------------------
// Subprocess lifecycle
// ---------------------------------------------------------------------------

function startSubprocess() {
  if (_proc) return;

  if (!indexExists()) {
    _error = 'RAG index not found — run scripts/build_index.py to build it';
    console.warn(`[rag] ${_error}`);
    return;
  }

  if (!fs.existsSync(SCRIPT)) {
    _error = 'scripts/query_index.py not found';
    console.warn(`[rag] ${_error}`);
    return;
  }

  console.log('[rag] Starting query subprocess...');

  // Use 'python' on Windows, 'python3' on Mac/Linux
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';

  _proc = spawn(pythonBin, [SCRIPT], {
    env: {
      ...process.env,
      ADDIE_EMBED_MODEL: 'all-MiniLM-L6-v2',
      ADDIE_RAG_TOP_K:   String(DEFAULT_K),
      // Ensure Python output is unbuffered
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Readline on stdout — one JSON response per line
  _rl = readline.createInterface({ input: _proc.stdout });

  // Each line from the subprocess is either:
  //   { ready: true }           — startup complete
  //   [{ text, source, score }] — query result
  //   { error: "..." }          — error
  _rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;

    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.ready === true) {
      _ready = true;
      console.log('[rag] Subprocess ready');
      // Resolve any queries that were queued while we were starting
      for (const { resolve } of _pending) resolve([]);
      _pending = [];
      return;
    }

    // Dequeue the oldest pending query
    const next = _pending.shift();
    if (!next) return;

    if (msg.error) {
      console.warn('[rag] Query error:', msg.error);
      next.resolve([]);
    } else if (Array.isArray(msg)) {
      next.resolve(msg);
    } else {
      next.resolve([]);
    }
  });

  // Log stderr diagnostics without crashing
  _proc.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const l of lines) {
      if (l.trim()) console.log('[rag/py]', l.trim());
    }
  });

  _proc.on('error', (err) => {
    _error = err.message;
    console.error('[rag] Subprocess error:', err.message);
    if (err.code === 'ENOENT') {
      console.error('[rag] Python not found. Install Python 3 and ensure it is on PATH.');
    }
    _ready = false;
    for (const { resolve } of _pending) resolve([]);
    _pending = [];
    _proc = null;
  });

  _proc.on('exit', (code) => {
    console.warn(`[rag] Subprocess exited with code ${code}`);
    _ready = false;
    _proc  = null;
    _rl    = null;
    for (const { resolve } of _pending) resolve([]);
    _pending = [];
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the top-K most relevant chunks for a query.
 * Starts the subprocess on first call if not already running.
 *
 * @param {string} query   - The search query (user message or key topic)
 * @param {number} topK    - Number of chunks to return (default: 5)
 * @returns {Promise<Array<{ text: string, source: string, score: number }>>}
 */
function retrieve(query, topK = DEFAULT_K) {
  return new Promise((resolve) => {
    if (!indexExists()) {
      resolve([]);
      return;
    }

    // Lazy start
    if (!_proc) startSubprocess();

    // If still starting up, queue the resolve for when ready fires
    if (!_ready) {
      // We push to pending but won't actually send the query until ready.
      // For simplicity: if the subprocess isn't ready in time, return empty.
      // The next message will get a response once the model is loaded.
      _pending.push({ resolve });
      return;
    }

    // Subprocess is ready — send the query
    _pending.push({ resolve });

    try {
      const payload = JSON.stringify({ query, top_k: topK }) + '\n';
      _proc.stdin.write(payload);
    } catch (e) {
      console.warn('[rag] Failed to write to subprocess:', e.message);
      _pending.pop();
      resolve([]);
    }
  });
}

/**
 * Format retrieved chunks for injection into the system prompt.
 * Returns null if no chunks retrieved.
 *
 * @param {Array<{ text, source, score }>} chunks
 * @returns {string|null}
 */
function formatForPrompt(chunks) {
  if (!chunks || chunks.length === 0) return null;

  const lines = [];
  for (const chunk of chunks) {
    lines.push(`[${chunk.source}]`);
    lines.push(chunk.text);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function isReady()   { return _ready; }
function getStatus() { return { ready: _ready, error: _error, indexExists: indexExists() }; }

// Start the subprocess eagerly at server init so the model is warm
// before the first user message arrives.
startSubprocess();

module.exports = { retrieve, formatForPrompt, isReady, getStatus };
