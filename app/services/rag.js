/**
 * app/services/rag.js - RAG retrieval module.
 *
 * Manages a long-lived subprocess (scripts/query_index.py, or the bundled
 * PyInstaller executable in production) that keeps the embedding model and
 * index vectors in memory between queries.
 *
 * Subprocess resolution order:
 *   1. Bundled executable  — <resourcesPath>/rag-bin/query_index[.exe]
 *      (present in distributed builds, produced by PyInstaller)
 *   2. Python script       — scripts/query_index.py via python3 / python
 *      (used in development)
 *
 * If the index doesn't exist or the subprocess fails to start,
 * retrieve() returns [] gracefully — the rest of the pipeline continues
 * without RAG rather than crashing.
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const readline   = require('readline');

const ROOT          = process.env.ADDIE_ROOT     || path.join(__dirname, '..', '..');
const RESOURCES     = process.env.ADDIE_RESOURCES || null;   // set by electron/main.js in prod
const INDEX_DIR     = path.join(ROOT, 'knowledge', '.index');
const SCRIPT        = path.join(ROOT, 'scripts', 'query_index.py');
const DEFAULT_K     = 5;

// ---------------------------------------------------------------------------
// Resolve subprocess entry point
// ---------------------------------------------------------------------------

function resolveSubprocessCommand() {
  // 1. Bundled PyInstaller executable (production)
  if (RESOURCES) {
    const ext     = process.platform === 'win32' ? '.exe' : '';
    const binPath = path.join(RESOURCES, 'rag-bin', `query_index${ext}`);
    if (fs.existsSync(binPath)) {
      console.log(`[rag] Using bundled executable: ${binPath}`);
      return { cmd: binPath, args: [] };
    }
  }

  // 2. Python script (development)
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  console.log(`[rag] Using Python script: ${SCRIPT}`);
  return { cmd: pythonBin, args: [SCRIPT] };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _proc    = null;
let _ready   = false;
let _error   = null;
let _pending = [];
let _rl      = null;

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
    _error = 'RAG index not found';
    console.warn(`[rag] ${_error}`);
    return;
  }

  const { cmd, args } = resolveSubprocessCommand();

  console.log('[rag] Starting query subprocess...');

  _proc = spawn(cmd, args, {
    env: {
      ...process.env,
      ADDIE_ROOT:        ROOT,
      ADDIE_EMBED_MODEL: 'all-MiniLM-L6-v2',
      ADDIE_RAG_TOP_K:   String(DEFAULT_K),
      PYTHONUNBUFFERED:  '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  _rl = readline.createInterface({ input: _proc.stdout });

  _rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;

    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.ready === true) {
      _ready = true;
      console.log('[rag] Subprocess ready');
      for (const { resolve } of _pending) resolve([]);
      _pending = [];
      return;
    }

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
      console.error('[rag] Subprocess binary not found:', cmd);
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

function retrieve(query, topK = DEFAULT_K) {
  return new Promise((resolve) => {
    if (!indexExists()) { resolve([]); return; }

    if (!_proc) startSubprocess();

    if (!_ready) {
      _pending.push({ resolve });
      return;
    }

    _pending.push({ resolve });

    try {
      _proc.stdin.write(JSON.stringify({ query, top_k: topK }) + '\n');
    } catch (e) {
      console.warn('[rag] Failed to write to subprocess:', e.message);
      _pending.pop();
      resolve([]);
    }
  });
}

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

startSubprocess();

module.exports = { retrieve, formatForPrompt, isReady, getStatus };
