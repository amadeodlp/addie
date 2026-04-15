/**
 * context.js — File-based producer memory and project management.
 *
 * Directory layout (v2):
 *
 *   projects/<name>/
 *     meta.json              { description, createdAt, updatedAt }
 *     session.md             last annotated session state
 *     templates.md           auto-detected session templates
 *     conversations/
 *       <id>.md              one file per conversation
 *     knowledge/
 *       <filename>           user-added text / .md files
 */

const fs   = require('fs');
const path = require('path');

let ROOT          = path.join(__dirname, '..', '..');
let PROJECTS_DIR  = path.join(ROOT, 'projects');
let PRODUCER_FILE = path.join(ROOT, 'producer.md');

function init(root) {
  ROOT          = root;
  PROJECTS_DIR  = path.join(ROOT, 'projects');
  PRODUCER_FILE = path.join(ROOT, 'producer.md');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

// ─── CHAT BUFFER ──────────────────────────────────────────────────────────────
//
// Chat turns are held in memory and only written to disk when the user
// explicitly saves (Ctrl+S or confirmed close) — matching Ableton's behaviour.

const _chatBuffer = {};   // { [`${project}/${convId}`]: string[] }

function _bufKey(project, convId) { return `${project}/${convId}`; }

/** Returns true if there are unsaved chat turns for this conversation. */
function hasPendingChat(project, convId) {
  return !!(_chatBuffer[_bufKey(project, convId)]?.length);
}

/** Flush buffered turns to disk. Clears the buffer afterwards. */
function flushChat(project, convId) {
  const key = _bufKey(project, convId);
  const buf = _chatBuffer[key];
  if (!buf?.length) return;
  ensureConversation(project, convId);
  const p = convPath(project, convId);
  fs.appendFileSync(p, buf.join(''), 'utf8');
  _chatBuffer[key] = [];
  touchProject(project);
  console.log(`[context] Saved conversation ${convId} in project: ${project}`);
}

// ─── PROJECT MANAGEMENT ───────────────────────────────────────────────────────

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory())
    .map(name => {
      const meta = readProjectMeta(name);
      return { name, ...meta };
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function projectExists(name) {
  return fs.existsSync(path.join(PROJECTS_DIR, name));
}

function createProject(name, description = '') {
  const dir = path.join(PROJECTS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'knowledge'),     { recursive: true });

  const now = Date.now();
  writeProjectMeta(name, { description, createdAt: now, updatedAt: now });

  writeIfMissing(path.join(dir, 'session.md'),
    `# Session State — ${name}\n\n_No sync yet._\n`);
  writeIfMissing(path.join(dir, 'templates.md'),
    `# Templates — ${name}\n\n`);

  // Create addie-notes.md as the default first knowledge file.
  // The LLM will consolidate and rewrite the section below the header
  // after each conversation. The header is preserved on every rewrite.
  writeIfMissing(path.join(dir, 'knowledge', 'addie-notes.md'),
    `# Notas de Addie\n_Addie guardará aquí las preferencias y descubrimientos que vayamos logrando en este proyecto. Podés editarlas manualmente también._\n\n`);

  console.log(`[context] Created project: ${name}`);
  // No conversation created here — user creates them manually from the UI.
}

function ensureProject(name) {
  if (!projectExists(name)) return createProject(name);
  // Migrate old flat structure if needed
  const convDir = path.join(PROJECTS_DIR, name, 'conversations');
  const knwDir  = path.join(PROJECTS_DIR, name, 'knowledge');
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(knwDir,  { recursive: true });

  if (!fs.existsSync(path.join(PROJECTS_DIR, name, 'meta.json'))) {
    writeProjectMeta(name, { description: '', createdAt: Date.now(), updatedAt: Date.now() });
  }

  // Migrate legacy chat.md → conversations/conv_1.md
  const legacyChat = path.join(PROJECTS_DIR, name, 'chat.md');
  if (fs.existsSync(legacyChat)) {
    const migratedId = 'conv_1';
    const dest = convPath(name, migratedId);
    if (!fs.existsSync(dest)) {
      const content = fs.readFileSync(legacyChat, 'utf8');
      fs.writeFileSync(dest, content, 'utf8');
      writeConvMeta(name, migratedId, { title: 'General', createdAt: Date.now() });
      console.log(`[context] Migrated chat.md → conversations/${migratedId}.md for project: ${name}`);
    }
  }

  // Migrate legacy context.md → knowledge/context.md
  const legacyContext = path.join(PROJECTS_DIR, name, 'context.md');
  if (fs.existsSync(legacyContext)) {
    const dest = path.join(PROJECTS_DIR, name, 'knowledge', 'context.md');
    if (!fs.existsSync(dest)) {
      const content = fs.readFileSync(legacyContext, 'utf8');
      fs.writeFileSync(dest, content, 'utf8');
      console.log(`[context] Migrated context.md → knowledge/context.md for project: ${name}`);
    }
  }

}

function deleteProject(name) {
  const dir = path.join(PROJECTS_DIR, name);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[context] Deleted project: ${name}`);
}

function updateProjectMeta(name, fields) {
  const existing = readProjectMeta(name);
  writeProjectMeta(name, { ...existing, ...fields, updatedAt: Date.now() });
}

function readProjectMeta(name) {
  const p = path.join(PROJECTS_DIR, name, 'meta.json');
  if (!fs.existsSync(p)) return { description: '', createdAt: 0, updatedAt: 0 };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeProjectMeta(name, meta) {
  fs.writeFileSync(
    path.join(PROJECTS_DIR, name, 'meta.json'),
    JSON.stringify(meta, null, 2), 'utf8'
  );
}

function touchProject(name) {
  const meta = readProjectMeta(name);
  writeProjectMeta(name, { ...meta, updatedAt: Date.now() });
}

// ─── CONVERSATION MANAGEMENT ─────────────────────────────────────────────────

function newConvId(project) {
  const convs = listConversations(project);
  const nums = convs.map(c => {
    const m = c.id.match(/^conv_(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return 'conv_' + next;
}

function convPath(project, convId) {
  return path.join(PROJECTS_DIR, project, 'conversations', convId + '.md');
}

function convMetaPath(project, convId) {
  return path.join(PROJECTS_DIR, project, 'conversations', convId + '.json');
}

function listConversations(project) {
  const dir = path.join(PROJECTS_DIR, project, 'conversations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const id   = f.replace(/\.md$/, '');
      const meta = readConvMeta(project, id);
      const stat = fs.statSync(path.join(dir, f));
      return { id, title: meta.title || id, createdAt: meta.createdAt || 0, updatedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Internal primitive — writes conversation files without calling ensureProject.
// Used by ensureProject itself to avoid infinite recursion.
function _createConversationFiles(project, convId, title) {
  const dir = path.join(PROJECTS_DIR, project, 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const p = convPath(project, convId);
  if (!fs.existsSync(p)) fs.writeFileSync(p, `# ${title}\n\n`, 'utf8');
  writeConvMeta(project, convId, { title, createdAt: Date.now() });
}

function createConversation(project, convId, title = 'New conversation') {
  // Ensure project dirs exist without recursing through ensureProject
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(path.join(dir, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'knowledge'),     { recursive: true });
  _createConversationFiles(project, convId, title);
  touchProject(project);
  return convId;
}

function deleteConversation(project, convId) {
  const p    = convPath(project, convId);
  const meta = convMetaPath(project, convId);
  if (fs.existsSync(p))    fs.unlinkSync(p);
  if (fs.existsSync(meta)) fs.unlinkSync(meta);
  touchProject(project);
}

function renameConversation(project, convId, title) {
  const existing = readConvMeta(project, convId);
  writeConvMeta(project, convId, { ...existing, title });
  touchProject(project);
}

function ensureConversation(project, convId) {
  const p = convPath(project, convId);
  if (!fs.existsSync(p)) {
    const dir = path.join(PROJECTS_DIR, project, 'conversations');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, `# Conversation\n\n`, 'utf8');
    writeConvMeta(project, convId, { title: 'Conversation', createdAt: Date.now() });
  }
}

function readConvMeta(project, convId) {
  const p = convMetaPath(project, convId);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeConvMeta(project, convId, meta) {
  const dir = path.join(PROJECTS_DIR, project, 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(convMetaPath(project, convId), JSON.stringify(meta, null, 2), 'utf8');
}

function readChatLog(project, convId) {
  const p = convPath(project, convId);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function appendChat(project, convId, role, content) {
  ensureConversation(project, convId);
  const ts    = new Date().toLocaleTimeString();
  const label = role === 'user' ? '**You**' : '**Addie**';
  const chunk = `\n### ${label} — ${ts}\n\n${content}\n`;
  const key   = _bufKey(project, convId);
  if (!_chatBuffer[key]) _chatBuffer[key] = [];
  _chatBuffer[key].push(chunk);
}

// ─── KNOWLEDGE MANAGEMENT ────────────────────────────────────────────────────

function knowledgeDir(project) {
  return path.join(PROJECTS_DIR, project, 'knowledge');
}

function listKnowledge(project) {
  const dir = knowledgeDir(project);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size, updatedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeKnowledge(project, filename, content) {
  const dir = knowledgeDir(project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
  touchProject(project);
}

function readKnowledge(project, filename) {
  const p = path.join(knowledgeDir(project), filename);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function deleteKnowledge(project, filename) {
  const p = path.join(knowledgeDir(project), filename);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  touchProject(project);
}

function assembleKnowledge(project) {
  const dir   = knowledgeDir(project);
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  if (!files.length) return '';
  return files.map(f => {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    return `### ${f}\n\n${content}`;
  }).join('\n\n---\n\n');
}

// ─── PRODUCER MEMORY ─────────────────────────────────────────────────────────

function readProducerMemory() {
  if (!fs.existsSync(PRODUCER_FILE)) {
    fs.writeFileSync(PRODUCER_FILE, '# Producer Memory\n\n_Addie will learn your preferences here._\n');
  }
  return fs.readFileSync(PRODUCER_FILE, 'utf8');
}

function appendProducerMemory(content) {
  const existing = readProducerMemory();
  fs.writeFileSync(PRODUCER_FILE, existing + '\n' + content);
}

// ─── SESSION / TEMPLATES ─────────────────────────────────────────────────────

function readSessionState(project) {
  const p = path.join(PROJECTS_DIR, project, 'session.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function writeSessionState(project, annotated) {
  ensureProject(project);
  fs.writeFileSync(
    path.join(PROJECTS_DIR, project, 'session.md'),
    sessionStateToMarkdown(annotated), 'utf8'
  );
}

function readTemplates(project) {
  const p = path.join(PROJECTS_DIR, project, 'templates.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function appendTemplate(project, template) {
  ensureProject(project);
  const ts = new Date().toLocaleDateString();
  const p  = path.join(PROJECTS_DIR, project, 'templates.md');
  fs.appendFileSync(p,
    `\n## Template detected — ${ts}\n\n\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\`\n`,
    'utf8'
  );
}

// ─── CONTEXT ASSEMBLY ─────────────────────────────────────────────────────────

/**
 * Assemble full producer context for the LLM prompt.
 *
 * @param {string} project — project name
 * @param {Set} [freshTier3Names] — lowercase track names that have fresh Tier 3
 *   data in the current turn. When provided, the stale session.md content for
 *   those tracks is suppressed from the context to prevent contradictory info.
 *
 * BUG FIX: Previously, stale session.md (from the last full sync) was always
 * injected into the prompt alongside fresh Tier 3 data. If the user manually
 * added/removed devices between syncs, the LLM would see both the old annotated
 * state AND the new fresh params — leading to hallucination and confusion.
 */
function assembleContext(project, freshTier3Names) {
  const knowledge = assembleKnowledge(project);

  let sessionState = readSessionState(project);

  // If we have fresh Tier 3 data for some tracks, redact those tracks from the
  // stale session.md to prevent contradictory information in the prompt.
  if (freshTier3Names?.size > 0 && sessionState) {
    sessionState = _redactFreshTracks(sessionState, freshTier3Names);
  }

  const parts = [
    '## Producer Memory\n',        readProducerMemory(),
    '\n---\n## Project Knowledge\n', knowledge || '_No project knowledge added yet._',
    '\n---\n## Last Known Session State (from last full sync — tracks with fresh data above take precedence)\n', sessionState,
    '\n---\n## Templates\n',        readTemplates(project),
  ];
  return parts.join('\n');
}

/**
 * Redact track sections from session.md for tracks that have fresh Tier 3 data.
 * Session.md uses ### TrackName as section headers.
 */
function _redactFreshTracks(sessionMd, freshNames) {
  const lines = sessionMd.split('\n');
  const result = [];
  let skipping = false;

  for (const line of lines) {
    // Detect track section headers: ### TrackName or ### TrackName (role)
    const headerMatch = line.match(/^### (.+?)(?:\s*\(.*\))?\s*$/);
    if (headerMatch) {
      const trackName = headerMatch[1].trim().toLowerCase();
      if (freshNames.has(trackName)) {
        skipping = true;
        result.push(`### ${headerMatch[1]} _(fresh data available above — this section skipped)_\n`);
        continue;
      } else {
        skipping = false;
      }
    }

    // Stop skipping at next section header or horizontal rule
    if (skipping && /^(### |---|\*\*Tempo)/.test(line)) {
      skipping = false;
    }

    if (!skipping) {
      result.push(line);
    }
  }

  return result.join('\n');
}

// ─── SYNC-DRIVEN SESSION UPDATE ──────────────────────────────────────────────

/**
 * Update session.md from a fresh sync result — no LLM required.
 *
 * Writes a lightweight structural snapshot: tempo, track list, and
 * device names per track. This is enough for Addie to have meaningful
 * project context when opening a new conversation after a gap.
 *
 * Only writes if the session actually changed (different tempo, track
 * count, or any track's device list changed) to avoid pointless disk writes.
 *
 * @param {string} project
 * @param {object} tier1   — result of fetchSession() (mixer/track list)
 * @param {object} snapshot — result of snapshot() (full devices)
 * @returns {boolean} true if session.md was updated
 */
function updateSessionFromSync(project, tier1, snapshot) {
  if (!tier1?.tracks) return false;

  const now   = new Date().toISOString();
  const lines = [`# Session State — ${project}`, '', `_Last sync: ${now}_`, ''];

  lines.push(`**Tempo:** ${tier1.tempo ?? '?'} BPM | **Tracks:** ${tier1.tracks.length}`);
  if (tier1.return_names?.length)
    lines.push(`**Returns:** ${tier1.return_names.join(', ')}`);
  lines.push('', '---', '');

  // Build device map from snapshot for richer output
  const deviceMap = {};
  if (snapshot?.tracks) {
    for (const t of snapshot.tracks) {
      if (!t.devices?.length) continue;
      deviceMap[t.name.toLowerCase()] = t.devices.map(d => {
        const inner = d.innerDevices?.length
          ? ` [${d.innerDevices.map(i => i.name).join(', ')}]` : '';
        return `${d.name}${inner}`;
      });
    }
  }

  for (const track of tier1.tracks) {
    const flags = [];
    if (track.muted) flags.push('MUTED');
    if (track.solo)  flags.push('SOLO');
    const flagStr = flags.length ? `  _(${flags.join(', ')})_` : '';
    lines.push(`### ${track.name}${flagStr}`);

    const mixParts = [];
    if (track.volumeDisplay) mixParts.push(`Vol: ${track.volumeDisplay}`);
    if (track.panDisplay && track.panDisplay !== '0' && track.panDisplay !== 'C')
      mixParts.push(`Pan: ${track.panDisplay}`);
    if (track.routingTarget && track.routingTarget !== 'Master')
      mixParts.push(`→ ${track.routingTarget}`);
    if (mixParts.length) lines.push(mixParts.join(' | '));

    const devices = deviceMap[track.name.toLowerCase()];
    if (devices?.length) {
      lines.push(`Devices: ${devices.join(' › ')}`);
    } else {
      lines.push(`_No devices._`);
    }
    lines.push('');
  }

  const newContent = lines.join('\n');

  // Check if anything actually changed before writing
  const existing = readSessionState(project);
  // Strip the timestamp line for comparison so a sync with no real changes
  // doesn't trigger a write
  const strip = s => s.replace(/_Last sync:.*_/, '').replace(/\s+/g, ' ').trim();
  if (strip(existing) === strip(newContent)) return false;

  ensureProject(project);
  const fs = require('fs');
  fs.writeFileSync(
    path.join(PROJECTS_DIR, project, 'session.md'),
    newContent, 'utf8'
  );
  console.log(`[context] session.md updated for project: ${project}`);
  return true;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content);
}

// ─── PARAMETER VALUE EXTRACTION ──────────────────────────────────────────────

function extractParamDisplay(v) {
  if (v === null || v === undefined) return '?';
  if (typeof v === 'object') {
    if (v.display !== undefined && v.display !== null && v.display !== '') return v.display;
    if (v.value   !== undefined && v.value   !== null) return roundVal(v.value);
    return '?';
  }
  return roundVal(v);
}

function roundVal(n) {
  const f = parseFloat(n);
  if (isNaN(f)) return String(n);
  return parseFloat(f.toFixed(3)).toString();
}

function fmtVol(v, display) {
  if (display) return display;
  if (v === null || v === undefined) return null;
  return roundVal(v);
}

// ─── SESSION STATE → MARKDOWN ────────────────────────────────────────────────

function sessionStateToMarkdown(state) {
  if (!state) return '# Session State\n\n_No sync data._\n';

  let md = `# Session State\n\n`;
  md += `_Synced: ${state.syncedAt}_`;
  if (state.annotatedAt) md += ` | Analyzed: ${state.annotatedAt}`;
  md += `\n\n`;
  md += `**Tempo:** ${state.tempo ?? 'unknown'} BPM | `;
  md += `**Tracks:** ${state.tracks?.length ?? 0}\n\n`;
  md += `---\n\n`;

  for (const track of (state.tracks || [])) {
    const name = track.name || `Track ${track.index}`;
    const role = track._role ? ` (${track._role})` : '';
    md += `### ${name}${role}\n\n`;

    if (track._trackFlags?.length) {
      for (const flag of track._trackFlags) md += `> ! ${flag}\n`;
      md += '\n';
    }

    const mixerParts = [];
    const vol = fmtVol(track.volume, track.volumeDisplay);
    if (vol !== null)                                   mixerParts.push(`Vol: ${vol}`);
    if (track.panDisplay)                               mixerParts.push(`Pan: ${track.panDisplay}`);
    else if (track.pan !== undefined && track.pan !== null)  mixerParts.push(`Pan: ${roundVal(track.pan)}`);
    if (track.muted)                                    mixerParts.push(`MUTED`);
    if (track.solo)                                     mixerParts.push(`SOLO`);
    if (track.routingTarget)                            mixerParts.push(`-> ${track.routingTarget}`);
    if (mixerParts.length) md += `${mixerParts.join(' | ')}\n\n`;

    if (track.devices?.length) {
      for (const device of track.devices) {
        const deviceName = device.name || 'Unknown Device';
        const enabled    = device.enabled === false ? ' (bypassed)' : '';
        const paramCount = device.parameters ? Object.keys(device.parameters).length : 0;
        const paramNote  = paramCount > 0 ? ` (${paramCount} params captured)` : '';
        md += `**${deviceName}**${enabled}${paramNote}\n`;
        if (device._annotation) md += `> ${device._annotation}\n`;
        if (device._flags?.length) {
          for (const flag of device._flags) md += `> ! ${flag}\n`;
        }
        md += '\n';
      }
    } else {
      md += '_No devices loaded._\n\n';
    }
  }

  return md;
}

module.exports = {
  init,
  // Projects
  listProjects, projectExists, createProject, ensureProject, deleteProject,
  updateProjectMeta, readProjectMeta,
  // Conversations
  listConversations, createConversation, deleteConversation, renameConversation,
  ensureConversation, readConvMeta, readChatLog, appendChat, newConvId,
  // Save
  flushChat, hasPendingChat,
  // Expose buffer for read-back (server.js needs pending turns for history endpoint)
  _chatBuffer,
  // Knowledge
  listKnowledge, writeKnowledge, readKnowledge, deleteKnowledge,
  // Session / templates
  readSessionState, writeSessionState, readTemplates, appendTemplate,
  // Producer memory
  readProducerMemory, appendProducerMemory,
  // Context assembly
  assembleContext,
  updateSessionFromSync,
  // Helpers used by other modules
  extractParamDisplay, roundVal,
};
