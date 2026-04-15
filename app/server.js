/**
 * server.js — Addie's main backend process.
 *
 * REFACTORED: This file now only handles:
 *   - Express HTTP routes (health, settings, projects, conversations, knowledge, control surface)
 *   - WebSocket setup and message routing
 *   - Bridge function (sendToBridge)
 *   - Bridge watchdog wiring
 *   - Initial sync
 *   - Startup and shutdown
 *
 * Chat pipeline → app/chat.js
 * Action execution → app/actions.js
 * System prompt construction → app/prompt.js
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const { loadConfig, saveConfig: _saveConfig } = require('./config');
const sync      = require('./core/sync');
const context   = require('./state/context');
const llm       = require('./services/llm');
const bridge    = require('./services/bridge');
const rag       = require('./services/rag');
const presets   = require('./plugins/presets');
const { handleChat, confirmActions, cancelActions, initConversation, resetConversation } = require('./core/chat');
const { extractConversationNotes } = require('./intelligence/notes');

const ROOT = process.env.ADDIE_ROOT || path.join(__dirname, '..');

// --- INIT --------------------------------------------------------------------

const config = loadConfig(ROOT);
context.init(ROOT);
presets.init(ROOT);

if (config.activeProject) context.ensureProject(config.activeProject);
if (config.activeProject && !context.projectExists(config.activeProject)) {
  config.activeProject      = null;
  config.activeConversation = null;
  _saveConfig(config, ROOT);
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(ROOT, 'ui')));
app.use(express.json({ limit: '10mb' }));

/** Helper: save config with ROOT bound */
function saveConfig(cfg) { _saveConfig(cfg, ROOT); }

// --- HTTP ROUTES — HEALTH & SETTINGS -----------------------------------------

app.get('/health', (_, res) => res.status(200).json({ ok: true }));

app.get('/api/settings', (_, res) => {
  const info = llm.getProviderInfo(config.model.apiKey, config.model.endpoint);
  res.json({ model: config.model, providerInfo: info });
});

app.post('/api/settings', (req, res) => {
  const { apiKey, endpoint, modelId } = req.body;
  if (apiKey   !== undefined) config.model.apiKey   = apiKey;
  if (endpoint !== undefined) config.model.endpoint = endpoint;
  if (modelId  !== undefined) config.model.modelId  = modelId;
  saveConfig(config);
  const info = llm.getProviderInfo(config.model.apiKey, config.model.endpoint);
  res.json({ ok: true, providerInfo: info });
});

app.get('/api/bridge-status', (_, res) => {
  res.json({ detected: bridge.isDetected() });
});

// Debug endpoint — returns the raw browser list currently in cache.
// Hit this at http://localhost:3000/api/debug/browser after initial sync.
app.get('/api/debug/browser', (_, res) => {
  const browser = sync.getBrowser();
  if (!browser) return res.json({ error: 'browser not yet fetched — send a chat message first' });
  res.json(browser);
});

app.get('/api/has-pending-chat', (_, res) => {
  res.json({ pending: context.hasPendingChat(config.activeProject, config.activeConversation) });
});

app.post('/api/save-chat', (_, res) => {
  flushAllChatBuffers();
  res.json({ ok: true });
});

function flushAllChatBuffers() {
  const buf = context._chatBuffer || {};
  for (const key of Object.keys(buf)) {
    if (!buf[key]?.length) continue;
    const [project, convId] = key.split('/');
    if (project && convId) context.flushChat(project, convId);
  }
}

/**
 * Flush a conversation to disk and asynchronously extract project notes.
 * Fire-and-forget — never blocks the caller.
 */
function flushAndExtract(project, convId) {
  if (!project || !convId) return;
  context.flushChat(project, convId);
  // Extract notes async — don't await, never blocks WS response
  extractConversationNotes(project, convId, config.model).catch(e =>
    console.warn('[notes] Extraction failed (non-fatal):', e.message)
  );
}

app.post('/api/onboarding-done', (_, res) => {
  config.onboardingDone = true;
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/api/reset-onboarding', (_, res) => {
  config.onboardingDone = false;
  saveConfig(config);
  res.json({ ok: true });
});

// --- HTTP ROUTES — PROJECTS --------------------------------------------------

app.get('/api/projects', (_, res) => {
  res.json({ projects: context.listProjects() });
});

app.post('/api/projects', (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (context.projectExists(name)) return res.status(409).json({ error: 'Project already exists' });
  const firstConvId = context.createProject(name.trim(), description || '');
  res.json({ ok: true, name: name.trim(), firstConvId });
});

app.patch('/api/projects/:name', (req, res) => {
  const { name } = req.params;
  if (!context.projectExists(name)) return res.status(404).json({ error: 'Not found' });
  context.updateProjectMeta(name, req.body);
  res.json({ ok: true });
});

app.delete('/api/projects/:name', (req, res) => {
  const { name } = req.params;
  context.deleteProject(name);
  if (name === config.activeProject) {
    config.activeProject = null;
    config.activeConversation = null;
    saveConfig(config);
  }
  res.json({ ok: true });
});

// --- HTTP ROUTES — CONVERSATIONS ---------------------------------------------

app.get('/api/projects/:project/conversations', (req, res) => {
  const { project } = req.params;
  if (!context.projectExists(project)) return res.status(404).json({ error: 'Not found' });
  res.json({ conversations: context.listConversations(project) });
});

app.post('/api/projects/:project/conversations', (req, res) => {
  const { project } = req.params;
  const { title }   = req.body;
  if (!context.projectExists(project)) return res.status(404).json({ error: 'Not found' });
  const id = context.newConvId(project);
  context.createConversation(project, id, title || 'New conversation');
  res.json({ ok: true, id, title: title || 'New conversation' });
});

app.patch('/api/projects/:project/conversations/:id', (req, res) => {
  const { project, id } = req.params;
  const { title }       = req.body;
  context.renameConversation(project, id, title);
  res.json({ ok: true });
});

app.delete('/api/projects/:project/conversations/:id', (req, res) => {
  const { project, id } = req.params;
  const convs = context.listConversations(project);
  if (convs.length <= 1) return res.status(400).json({ error: 'Cannot delete the last conversation' });
  context.deleteConversation(project, id);
  res.json({ ok: true });
});

app.get('/api/projects/:project/conversations/:id/messages', (req, res) => {
  const { project, id } = req.params;
  if (!context.projectExists(project)) return res.status(404).json({ error: 'Not found' });
  const { parseChatHistory } = require('./core/prompt');
  const raw = context.readChatLog(project, id);
  const bufKey = `${project}/${id}`;
  const pending = (context._chatBuffer || {})[bufKey] || [];
  const fullLog = raw + pending.join('');
  const messages = parseChatHistory(fullLog);
  res.json({ messages });
});

// --- HTTP ROUTES — KNOWLEDGE -------------------------------------------------

app.get('/api/projects/:project/knowledge', (req, res) => {
  const { project } = req.params;
  if (!context.projectExists(project)) return res.status(404).json({ error: 'Not found' });
  res.json({ files: context.listKnowledge(project) });
});

app.get('/api/projects/:project/knowledge/:filename', (req, res) => {
  const { project, filename } = req.params;
  const content = context.readKnowledge(project, filename);
  if (content === null) return res.status(404).json({ error: 'Not found' });
  res.json({ content });
});

app.put('/api/projects/:project/knowledge/:filename', (req, res) => {
  const { project, filename } = req.params;
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'content required' });
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._\- ]/g, '_');
  context.writeKnowledge(project, safe, content);
  res.json({ ok: true, filename: safe });
});

app.delete('/api/projects/:project/knowledge/:filename', (req, res) => {
  const { project, filename } = req.params;
  context.deleteKnowledge(project, path.basename(filename));
  res.json({ ok: true });
});

// --- HTTP ROUTES — CONTROL SURFACE / PREFERENCES ----------------------------

app.post('/api/install-control-surface', (req, res) => {
  const fs   = require('fs');
  const dest = path.join(req.body.scriptsPath, 'Addie');
  const src  = path.join(ROOT, 'control_surface');
  if (!fs.existsSync(src))
    return res.json({ ok: false, error: 'control_surface folder not found in app directory.' });
  const alreadyInstalled = fs.existsSync(dest);
  try {
    copyDirSync(src, dest);
    let userLibPath = req.body.userLibraryPath || null;
    let presetsResult = null;
    if (userLibPath) presetsResult = presets.installPresets(userLibPath);
    res.json({ ok: true, dest, alreadyInstalled, presets: presetsResult });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/install-presets', (req, res) => {
  const userLibPath = req.body.userLibraryPath;
  if (!userLibPath) return res.status(400).json({ error: 'userLibraryPath required' });
  res.json(presets.installPresets(userLibPath));
});

app.get('/api/preferences', (_, res) => {
  res.json({ preferences: config.preferences || {} });
});

app.post('/api/save-preferences', (req, res) => {
  const prefs = req.body.preferences || {};
  // Persist structured prefs back to config so Settings UI can reload them
  config.preferences = prefs;
  saveConfig(config);

  // Rebuild the structured section of producer.md (onboarding fields) while
  // preserving any lines that were appended after the boundary marker —
  // those are preferences learned automatically from conversations.
  const BOUNDARY = '_Set during onboarding. Edit freely._';
  const fs       = require('fs');
  const mdPath   = path.join(ROOT, 'producer.md');

  // Extract learned-preference lines that live below the boundary, if any
  let learnedSection = '';
  if (fs.existsSync(mdPath)) {
    const existing  = fs.readFileSync(mdPath, 'utf8');
    const boundaryIdx = existing.indexOf(BOUNDARY);
    if (boundaryIdx !== -1) {
      const tail = existing.slice(boundaryIdx + BOUNDARY.length).trimEnd();
      if (tail.length > 0) learnedSection = '\n' + tail;
    }
  }

  const lines = ['# Producer Memory', ''];
  if (prefs.genres?.length)   lines.push(`- **Genre / style**: ${prefs.genres.join(', ')}`);
  if (prefs.level)            lines.push(`- **Experience level**: ${prefs.level}`);
  if (prefs.monitoring)       lines.push(`- **Monitoring**: ${prefs.monitoring}`);
  if (prefs.workflow?.length) lines.push(`- **Workflow style**: ${prefs.workflow.join(', ')}`);
  if (prefs.plugins)          lines.push(`- **Preferred tools / plugins**: ${prefs.plugins}`);
  if (prefs.references)       lines.push(`- **Reference artists / target sound**: ${prefs.references}`);
  lines.push('', BOUNDARY, '');

  fs.writeFileSync(mdPath, lines.join('\n') + learnedSection, 'utf8');
  res.json({ ok: true });
});

function copyDirSync(src, dest) {
  const fs = require('fs');
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src,  entry.name);
    const destPath = path.join(dest, entry.name);
    entry.isDirectory() ? copyDirSync(srcPath, destPath) : fs.copyFileSync(srcPath, destPath);
  }
}

// --- PYTHON BRIDGE -----------------------------------------------------------

const BRIDGE_ORIGIN = 'http://127.0.0.1:3001';

function sendToBridge(command, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id   = Date.now() + '_' + Math.random().toString(36).slice(2);
    const body = JSON.stringify({ id, command, params: params || {} });

    const req = http.request(
      `${BRIDGE_ORIGIN}/api/bridge/command`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode === 503) {
            console.error(`[bridge] update_display stale — command '${command}' rejected (503)`);
            return reject(new Error('Bridge braindead (update_display not running): ' + command));
          }
          if (res.statusCode === 504)
            return reject(new Error('Bridge timeout (Live main thread): ' + command));
          try {
            const data = JSON.parse(raw);
            if (command === 'browser_list') {
              const r = data.result ?? data;
              const cats = Object.keys(r).filter(k => k !== '_debug');
              console.log('[bridge] browser_list keys:', JSON.stringify(cats));
            }
            if (data.result?.error) return reject(new Error(data.result.error));
            resolve(data.result ?? data);
          } catch (e) {
            reject(new Error('Bridge response parse error: ' + e.message));
          }
        });
      }
    );

    req.on('error',   e => {
      console.error(`[bridge] Connection error for '${command}':`, e.message);
      reject(new Error('Bridge connection error: ' + e.message));
    });
    req.on('timeout', () => {
      req.destroy();
      console.error(`[bridge] Request timeout for '${command}' (${timeoutMs}ms)`);
      reject(new Error('Bridge request timeout: ' + command));
    });
    req.write(body);
    req.end();
  });
}

sync.setBridgeFn(sendToBridge);

// --- BRIDGE WATCHDOG ---------------------------------------------------------

bridge.startWatchdog(
  () => {
    broadcast({ type: 'bridge_ok' });
    // Bridge reconnected — force re-sync on next message (Ableton may have changed).
    if (config.activeProject) {
      initConversation(config.activeProject).catch(e =>
        console.warn('[watchdog] Re-init after reconnect failed:', e.message));
    }
  },
  () => {
    broadcast({ type: 'bridge_lost' });
    sync.clearSession();
    // Mark conversation as not ready — next init will re-sync everything.
    resetConversation();
  }
);

// --- WEBSOCKET ---------------------------------------------------------------

const clients = new Set();

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const ws of clients)
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', ws => {
  clients.add(ws);

  // On WS connect: just send init state. No sync — sync is lazy on first message.
  send(ws, {
    type:                'init',
    project:             config.activeProject,
    conversation:        config.activeConversation || null,
    projects:            context.listProjects(),
    conversations:       config.activeProject ? context.listConversations(config.activeProject) : [],
    machineId:           config.machineId,
    bridgeDetected:      bridge.isDetected(),
    onboardingDone:      !!config.onboardingDone,
    appRoot:             ROOT,
  });

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'chat':
        await handleChat(msg.text, ws, {
          config, saveConfig, sendToBridge, send,
        });
        break;

      case 'confirm_actions':
        confirmActions(config.activeConversation);
        break;

      case 'cancel_actions':
        cancelActions(config.activeConversation);
        break;

      case 'force_sync':
        // No-op — sync happens automatically on first chat message.
        // Silently acknowledged so the client doesn't error.
        break;

      case 'onboarding_done':
        config.onboardingDone = true;
        saveConfig(config);
        break;

      case 'save_chat':
        flushAndExtract(config.activeProject, config.activeConversation);
        send(ws, { type: 'save_complete', project: config.activeProject, conversation: config.activeConversation });
        break;

      case 'switch_project': {
        if (config.activeProject && config.activeConversation)
          flushAndExtract(config.activeProject, config.activeConversation);
        config.activeProject = msg.project;
        context.ensureProject(msg.project);
        const convs = context.listConversations(msg.project);
        config.activeConversation = convs.length ? convs[0].id : null;
        saveConfig(config);
        send(ws, {
          type: 'project_switched',
          project: config.activeProject,
          conversation: config.activeConversation,
          conversations: convs,
        });
        // Project changed — clear caches so next message syncs the new project.
        initConversation(config.activeProject).catch(e =>
          console.warn('[ws] switch_project init failed:', e.message));
        break;
      }

      case 'switch_conversation':
        flushAndExtract(config.activeProject, config.activeConversation);
        config.activeConversation = msg.conversation;
        saveConfig(config);
        send(ws, { type: 'conversation_switched', conversation: msg.conversation });
        // No re-sync — same project, session data is still valid.
        break;

      case 'new_conversation': {
        flushAndExtract(config.activeProject, config.activeConversation);
        const id = context.newConvId(config.activeProject);
        context.createConversation(config.activeProject, id, msg.title || 'New conversation');
        config.activeConversation = id;
        saveConfig(config);
        send(ws, {
          type: 'conversation_switched',
          conversation: id,
          conversations: context.listConversations(config.activeProject),
        });
        // New conversation within the same project — no re-sync needed.
        initConversation(config.activeProject).catch(e =>
          console.warn('[ws] new_conversation init failed:', e.message));
        break;
      }
    }
  });

  ws.on('close', () => clients.delete(ws));
});

// --- START -------------------------------------------------------------------

server.listen(config.ports.ui, () => {
  console.log(`\n  Addie -> http://localhost:${config.ports.ui}`);
});

// --- GRACEFUL SHUTDOWN -------------------------------------------------------

function onShutdown() {
  console.log('[server] Shutting down — flushing chat buffers...');
  flushAllChatBuffers();
  process.exit(0);
}

process.on('SIGTERM', onShutdown);
process.on('SIGINT',  onShutdown);
