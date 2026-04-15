/**
 * app.js — Addie main UI.
 *
 * Navigation state machine:
 *   projects-page  →  project-detail  →  chat
 *
 * All views live as absolutely-positioned divs. Showing a view = remove
 * .hidden from it; hiding = add .hidden.
 */

window.addEventListener("error", e =>
  console.error(
    "[addie-debug] UNCAUGHT ERROR:",
    e.message,
    e.filename,
    e.lineno,
  ),
)
window.addEventListener("unhandledrejection", e =>
  console.error("[addie-debug] UNHANDLED REJECTION:", e.reason),
)

console.log(
  "[addie-debug] app.js loaded, creating WebSocket to",
  `ws://${location.host}`,
)
const ws = new WebSocket(`ws://${location.host}`);
window._addieWS = ws;

ws.addEventListener("open", () => console.log("[addie-debug] WebSocket OPEN"))
ws.addEventListener("error", e =>
  console.error("[addie-debug] WebSocket ERROR", e),
)

// ─── i18n shorthand ──────────────────────────────────────────────────────────
const t = (key, params) => (window.i18n ? window.i18n.t(key, params) : key)

// ─── STATE ────────────────────────────────────────────────────────────────────

let state = {
  activeProject:      null,
  activeConversation: null,
  projects:           [],       // [{ name, description, updatedAt, ... }]
  conversations:      [],       // [{ id, title, updatedAt }]
  bridgeDetected:     false,
};

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

function showView(id) {
  console.log("[addie-debug] showView:", id)
  const views = document.querySelectorAll(".view")
  console.log("[addie-debug] found .view elements:", views.length)
  views.forEach(v => v.classList.add("hidden"))
  const target = document.getElementById(id)
  console.log("[addie-debug] target element:", id, "found?", !!target)
  target?.classList.remove("hidden")
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);

  switch (msg.type) {

    case 'init':
      console.log(
        "[addie-debug] init received:",
        JSON.stringify(msg).slice(0, 300),
      )
      state.activeProject      = msg.project;
      state.activeConversation = msg.conversation;  // may be null
      state.projects           = msg.projects || [];
      state.conversations      = msg.conversations || [];
      state.bridgeDetected     = msg.bridgeDetected;

      console.log(
        "[addie-debug] onboardingDone:",
        msg.onboardingDone,
        "initOnboarding exists:",
        !!window.initOnboarding,
      )
      if (window.initOnboarding) window.initOnboarding(!msg.onboardingDone);

      if (msg.onboardingDone) {
        console.log(
          "[addie-debug] post-onboarding: calling updateBridgeIndicators, applyTranslations, showProjectsPage",
        )
        updateBridgeIndicators();
        window.i18n.applyTranslations()
        // Always start on the projects page — user picks a conversation manually
        showProjectsPage();
        console.log(
          "[addie-debug] showProjectsPage done. #app hidden?",
          document.getElementById("app").classList.contains("hidden"),
          "#view-projects hidden?",
          document.getElementById("view-projects").classList.contains("hidden"),
        )
      }
      break;

    case 'bridge_ok':
      state.bridgeDetected = true;
      updateBridgeIndicators();
      break;

    case 'bridge_lost':
      state.bridgeDetected = false;
      updateBridgeIndicators();
      break;

    case 'chat':
      removeStatus();
      appendMessage(msg.role, msg.text, null, msg.provider);
      break;

    case 'action_pending':
      removeStatus();
      showActionConfirmWidget(msg.actions);
      break;

    case 'action_started':
      removeStatus();
      showActionBlock(msg.actions, 'pending');
      break;

    case 'action_complete':
      updateActionBlock(msg.verification);
      break;

    case 'status':
      showStatus(msg.text);
      break;

    case 'sync_progress':
      showStatus(
        t("chat.sync_progress", { stage: msg.stage }) +
          (msg.data?.fetched ? ` (${msg.data.fetched}/${msg.data.total})` : ""),
      )
      break;

    case 'sync_complete':
      removeStatus();
      document.getElementById("sync-status").textContent = t("chat.synced", {
        count: msg.trackCount,
      })
      if (msg.userTriggered)
        appendSystem(t("chat.session_synced", { count: msg.trackCount }))
      break;

    case 'sync_error':
      removeStatus();
      appendSystem(t("chat.sync_error", { error: msg.error }))
      break;

    case 'project_switched':
      state.activeProject      = msg.project;
      state.activeConversation = msg.conversation;  // null when switching from projects page
      state.conversations      = msg.conversations || [];
      // If we're already in chat view, update sidebar; otherwise stay on current view
      renderSidebarConvList();
      document.getElementById('sidebar-project-name').textContent = state.activeProject || '';
      break;

    case 'conversation_switched':
      state.activeConversation = msg.conversation;
      if (msg.conversations) state.conversations = msg.conversations;
      renderSidebarConvList();
      updateChatConvTitle();
      document.getElementById('messages').innerHTML = '';
      // Load saved chat history for the switched-to conversation
      loadConversationHistory(state.activeProject, msg.conversation);
      break;

    case 'save_complete':
      clearUnsavedIndicator();
      appendSystem(t("chat.saved"))
      break;
  }
});

ws.addEventListener("close", () => appendSystem(t("chat.connection_lost")))

// ─── PROJECTS PAGE ────────────────────────────────────────────────────────────

function showProjectsPage() {
  renderProjectGrid();
  showView('view-projects');
}
window.showProjectsPage = showProjectsPage; // exposed for onboarding.js

function renderProjectGrid() {
  const grid = document.getElementById('project-grid');
  grid.innerHTML = '';

  for (const p of state.projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <div class="project-card-name">${escHtml(p.name)}</div>
      <div class="project-card-desc">${escHtml(p.description || '')}</div>
      <div class="project-card-meta">${p.updatedAt ? relativeTime(p.updatedAt) : ''}</div>
    `;
    card.addEventListener('click', () => openProjectDetail(p.name));
    grid.appendChild(card);
  }

  // New project dashed card
  const newCard = document.createElement('div');
  newCard.className = 'project-card new-card';
  newCard.innerHTML = `<span style="font-size:20px">+</span><span>${escHtml(t("projects.new"))}</span>`
  newCard.addEventListener('click', promptNewProject);
  grid.appendChild(newCard);
}

async function promptNewProject() {
  const name = await customPrompt(t("projects.prompt_name"))
  if (!name?.trim()) return;

  const res  = await fetch('/api/projects', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name: name.trim(), description: '' }),
  });
  const data = await res.json();
  if (!data.ok) { alert(data.error); return; }

  // Refresh project list
  const listRes  = await fetch('/api/projects');
  const listData = await listRes.json();
  state.projects = listData.projects || [];
  renderProjectGrid();

  openProjectDetail(name.trim());
}

// ─── PROJECT DETAIL PAGE ─────────────────────────────────────────────────────

let _detailProject = null;  // name of the project currently shown in detail

async function openProjectDetail(projectName) {
  _detailProject = projectName;

  document.getElementById('detail-project-name').textContent = projectName;

  // Load meta for description
  const meta = state.projects.find(p => p.name === projectName) || {};
  document.getElementById('detail-project-desc').textContent = meta.description || '';
  document.getElementById('detail-desc-input').value = meta.description || '';

  // Load conversations
  const convRes  = await fetch(`/api/projects/${encodeURIComponent(projectName)}/conversations`);
  const convData = await convRes.json();
  const convs    = convData.conversations || [];
  renderDetailConvList(convs, null);

  // Load knowledge
  await refreshKnowledgeList();

  showView('view-project-detail');
}

function renderDetailConvList(convs, activeId) {
  const list = document.getElementById('conv-list');
  list.innerHTML = '';
  for (const c of convs) {
    const item = makeConvItem({ ...c, title: getConvTitle(c.id) }, activeId, (id) => {
      openConversation(_detailProject, id, convs);
    }, async (id) => {
      if (convs.length <= 1) {
        alert(t("detail.cant_delete_last"))
        return
      }
      if (!confirm(t("detail.delete_conv_confirm", { title: getConvTitle(c.id) }))) return
      await fetch(`/api/projects/${encodeURIComponent(_detailProject)}/conversations/${id}`, { method: 'DELETE' });
      const refreshed = await (await fetch(`/api/projects/${encodeURIComponent(_detailProject)}/conversations`)).json();
      renderDetailConvList(refreshed.conversations || [], activeId);
    });
    list.appendChild(item);
  }
}

function makeConvItem(conv, activeId, onClick, onDelete) {
  const item = document.createElement('div');
  item.className = 'conv-item' + (conv.id === activeId ? ' active' : '');

  const title = document.createElement('span');
  title.className = 'conv-item-title';
  title.textContent = conv.title;

  const date = document.createElement('span');
  date.className = 'conv-item-date';
  date.textContent = conv.updatedAt ? relativeTime(conv.updatedAt) : '';

  const del = document.createElement('button');
  del.className = 'conv-item-delete';
  del.textContent = '×';
  del.title = 'Delete';
  del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(conv.id); });

  item.appendChild(title);
  item.appendChild(date);
  item.appendChild(del);
  item.addEventListener('click', () => onClick(conv.id));
  return item;
}

// Description editing
document.getElementById('detail-edit-desc-btn').addEventListener('click', () => {
  document.getElementById('detail-project-desc').classList.add('hidden');
  document.getElementById('detail-edit-desc-form').classList.remove('hidden');
  document.getElementById('detail-desc-input').focus();
});
document.getElementById('detail-desc-cancel-btn').addEventListener('click', () => {
  document.getElementById('detail-edit-desc-form').classList.add('hidden');
  document.getElementById('detail-project-desc').classList.remove('hidden');
});
document.getElementById('detail-desc-save-btn').addEventListener('click', async () => {
  const desc = document.getElementById('detail-desc-input').value.trim();
  await fetch(`/api/projects/${encodeURIComponent(_detailProject)}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ description: desc }),
  });
  document.getElementById('detail-project-desc').textContent = desc;
  document.getElementById('detail-edit-desc-form').classList.add('hidden');
  document.getElementById('detail-project-desc').classList.remove('hidden');
  // Update in local state
  const p = state.projects.find(p => p.name === _detailProject);
  if (p) p.description = desc;
});

// New conversation from detail page
document.getElementById('new-conv-btn').addEventListener('click', async () => {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(_detailProject)}/conversations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t("chat.conversation") }),
    },
  )
  const data = await res.json();
  openConversation(_detailProject, data.id, null);
});

// Delete project
document.getElementById('delete-project-btn').addEventListener('click', async () => {
  if (!confirm(t("detail.delete_confirm", { name: _detailProject }))) return
  await fetch(`/api/projects/${encodeURIComponent(_detailProject)}`, { method: 'DELETE' });

  // Refresh project list and return to projects page
  const listRes  = await fetch('/api/projects');
  const listData = await listRes.json();
  state.projects = listData.projects || [];
  if (state.activeProject === _detailProject) {
    state.activeProject      = null;
    state.activeConversation = null;
  }
  showProjectsPage();
});

// Back from detail
document.getElementById('detail-back-btn').addEventListener('click', () => {
  showProjectsPage();
});

// ─── KNOWLEDGE ────────────────────────────────────────────────────────────────

let _editingKnowledgeFile = null;

async function refreshKnowledgeList() {
  const res  = await fetch(`/api/projects/${encodeURIComponent(_detailProject)}/knowledge`);
  const data = await res.json();
  renderKnowledgeList(data.files || []);
}

function renderKnowledgeList(files) {
  const list = document.getElementById('knowledge-list');
  list.innerHTML = '';

  // addie-notes.md always floats to the top
  const ADDIE_NOTES = 'addie-notes.md';
  const sorted = [
    ...files.filter(f => f.filename === ADDIE_NOTES),
    ...files.filter(f => f.filename !== ADDIE_NOTES),
  ];

  if (!sorted.length) {
    const empty = document.createElement('p');
    empty.className = 'detail-hint';
    empty.textContent = t("detail.no_knowledge")
    list.appendChild(empty);
    return;
  }

  for (const f of sorted) {
    const isAddieNotes = f.filename === ADDIE_NOTES;
    const item = document.createElement('div');
    item.className = 'knowledge-item' + (isAddieNotes ? ' addie-notes-item' : '');

    if (isAddieNotes) {
      item.innerHTML = `
        <div class="knowledge-item-addie-notes-header">
          <span class="knowledge-item-name">📝 ${escHtml(f.filename)}</span>
          <span class="knowledge-item-size">${formatBytes(f.size)}</span>
        </div>
        <div class="knowledge-item-addie-notes-subtitle">Addie guardará aquí las preferencias y descubrimientos que vayamos logrando en este proyecto. Podés editarlas manualmente también.</div>
      `;
    } else {
      item.innerHTML = `
        <span class="knowledge-item-name">${escHtml(f.filename)}</span>
        <span class="knowledge-item-size">${formatBytes(f.size)}</span>
        <button class="knowledge-item-delete" title="Delete">×</button>
      `;
      item.querySelector('.knowledge-item-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${f.filename}"?`)) return;
        await fetch(`/api/projects/${encodeURIComponent(_detailProject)}/knowledge/${encodeURIComponent(f.filename)}`, { method: 'DELETE' });
        await refreshKnowledgeList();
      });
    }

    item.addEventListener('click', async () => {
      const res  = await fetch(`/api/projects/${encodeURIComponent(_detailProject)}/knowledge/${encodeURIComponent(f.filename)}`);
      const data = await res.json();
      openKnowledgeEditor(f.filename, data.content);
    });
    list.appendChild(item);
  }
}

function openKnowledgeEditor(filename, content) {
  _editingKnowledgeFile = filename;
  document.getElementById('knowledge-filename').value = filename || '';
  document.getElementById('knowledge-content').value  = content || '';
  document.getElementById('knowledge-editor').classList.remove('hidden');
  document.getElementById('knowledge-content').focus();
}

document.getElementById('new-knowledge-btn').addEventListener('click', () => {
  openKnowledgeEditor('', '');
});

document.getElementById('knowledge-cancel-btn').addEventListener('click', () => {
  document.getElementById('knowledge-editor').classList.add('hidden');
  _editingKnowledgeFile = null;
});

document.getElementById('knowledge-save-btn').addEventListener('click', async () => {
  let filename = document.getElementById('knowledge-filename').value.trim();
  const content = document.getElementById('knowledge-content').value;
  const errorEl = document.getElementById('knowledge-filename-error');

  if (!filename) {
    errorEl.textContent = 'Please enter a filename.';
    errorEl.classList.remove('hidden');
    document.getElementById('knowledge-filename').focus();
    return;
  }
  errorEl.classList.add('hidden');
  if (!filename.includes('.')) filename += '.md';

  await fetch(`/api/projects/${encodeURIComponent(_detailProject)}/knowledge/${encodeURIComponent(filename)}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ content }),
  });

  document.getElementById('knowledge-editor').classList.add('hidden');
  _editingKnowledgeFile = null;
  await refreshKnowledgeList();
});

// ─── CHAT VIEW ────────────────────────────────────────────────────────────────

async function loadConversationHistory(project, convId) {
  if (!project || !convId) return;
  try {
    const res  = await fetch(`/api/projects/${encodeURIComponent(project)}/conversations/${encodeURIComponent(convId)}/messages`);
    const data = await res.json();
    const msgs = data.messages || [];
    for (const msg of msgs) {
      appendMessage(msg.role, msg.content);
    }
    // Show kickstarts if conversation is empty
    if (msgs.length === 0) {
      showKickstarts();
    }
  } catch (e) { console.warn('Could not load chat history:', e); }
}

function openConversation(projectName, convId, _convList) {
  // Tell server to switch project+conversation if needed.
  // When a WS message is sent, the server replies with conversation_switched /
  // project_switched which calls loadConversationHistory from its handler.
  // To avoid a duplicate showKickstarts() call, only load history locally
  // when no WS message was sent (same project + same conversation).
  let sentWs = false;
  if (projectName !== state.activeProject) {
    ws.send(JSON.stringify({ type: 'switch_project', project: projectName }));
    sentWs = true;
  } else if (convId !== state.activeConversation) {
    ws.send(JSON.stringify({ type: 'switch_conversation', conversation: convId }));
    sentWs = true;
  }

  state.activeProject      = projectName;
  state.activeConversation = convId;

  document.getElementById('sidebar-project-name').textContent = projectName;
  document.getElementById('messages').innerHTML = '';
  updateChatConvTitle();
  renderSidebarConvList();

  if (!sentWs) {
    loadConversationHistory(projectName, convId);
  }

  showView('view-chat');
}

function updateChatConvTitle() {
  const title = getConvTitle(state.activeConversation);
  document.getElementById('chat-conv-title').textContent = title;
}

function getConvTitle(convId) {
  const c = state.conversations.find(c => c.id === convId);
  if (
    c &&
    c.title &&
    c.title !== "New conversation" &&
    c.title !== "Conversation" &&
    c.title !== "Conversación" &&
    c.title !== t("chat.conversation")
  )
    return c.title
  const num = convId?.match(/conv_(\d+)/)?.[1];
  return num
    ? `${t("chat.conversation")} ${num}`
    : convId || t("chat.conversation")
}

function renderSidebarConvList() {
  const list = document.getElementById('conv-list-sidebar');
  list.innerHTML = '';
  for (const c of state.conversations) {
    const item = makeConvItem({ ...c, title: getConvTitle(c.id) }, state.activeConversation, (id) => {
      ws.send(JSON.stringify({ type: 'switch_conversation', conversation: id }));
    }, async (id) => {
      if (state.conversations.length <= 1) {
        alert(t("detail.cant_delete_last"))
        return
      }
      if (!confirm(t("detail.delete_conv_confirm", { title: getConvTitle(c.id) }))) return
      await fetch(`/api/projects/${encodeURIComponent(state.activeProject)}/conversations/${id}`, { method: 'DELETE' });
      const refreshed = await (await fetch(`/api/projects/${encodeURIComponent(state.activeProject)}/conversations`)).json();
      state.conversations = refreshed.conversations || [];
      renderSidebarConvList();
    });
    list.appendChild(item);
  }
}

// Logo → back to projects page
document.getElementById('logo').addEventListener('click', () => showProjectsPage());

// Back button in chat header
document.getElementById('chat-back-btn').addEventListener('click', () => {
  openProjectDetail(state.activeProject);
});

// Project name in sidebar → back to project detail page
document.getElementById('sidebar-project-name').addEventListener('click', () => {
  openProjectDetail(state.activeProject);
});

// New conversation from sidebar
document.getElementById('new-conv-sidebar-btn').addEventListener('click', async () => {
  ws.send(
    JSON.stringify({ type: "new_conversation", title: t("chat.conversation") }),
  )
});

// Rename current conversation
document.getElementById('rename-conv-btn').addEventListener('click', async () => {
  const current = getConvTitle(state.activeConversation);
  const title = await customPrompt(t("chat.rename_prompt"), current)
  if (!title?.trim() || title.trim() === current) return;
  await fetch(`/api/projects/${encodeURIComponent(state.activeProject)}/conversations/${state.activeConversation}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ title: title.trim() }),
  });
  const c = state.conversations.find(c => c.id === state.activeConversation);
  if (c) c.title = title.trim();
  updateChatConvTitle();
  renderSidebarConvList();
});

// ─── KICKSTARTS ───────────────────────────────────────────────────────────────

let _kickstartsData = null;

async function loadKickstartsData() {
  if (_kickstartsData) return _kickstartsData;
  try {
    const res = await fetch('/kickstarts.json');
    _kickstartsData = await res.json();
  } catch (e) {
    console.warn('Could not load kickstarts:', e);
    _kickstartsData = { newProject: [], workInProgress: [] };
  }
  return _kickstartsData;
}

async function showKickstarts() {
  const defaultData = await loadKickstartsData()
  const localized = window.i18n.getKickstarts()
  const data = localized || defaultData
  const messages = document.getElementById('messages');

  const newItems = pickRandom(data.newProject, 4);
  const wipItems = pickRandom(data.workInProgress, 4);

  if (!newItems.length && !wipItems.length) return;

  const container = document.createElement('div');
  container.className = 'kickstarts';
  container.id = 'kickstarts';

  // Greeting
  const greeting = document.createElement('div');
  greeting.className = 'kickstarts-greeting';
  greeting.innerHTML = `<h2>${t("kickstarts.greeting")}</h2><p>${t("kickstarts.subtitle")}</p>`
  container.appendChild(greeting);

  // Two columns
  const columns = document.createElement('div');
  columns.className = 'kickstarts-columns';

  // New project column
  const newCol = document.createElement('div');
  newCol.className = 'kickstarts-column';
  const newTitle = document.createElement('div');
  newTitle.className = 'kickstarts-column-title';
  newTitle.textContent = t("kickstarts.new_project")
  newCol.appendChild(newTitle);
  for (const item of newItems) {
    newCol.appendChild(makeKickstartChip(item));
  }

  // Work in progress column
  const wipCol = document.createElement('div');
  wipCol.className = 'kickstarts-column';
  const wipTitle = document.createElement('div');
  wipTitle.className = 'kickstarts-column-title';
  wipTitle.textContent = t("kickstarts.wip")
  wipCol.appendChild(wipTitle);
  for (const item of wipItems) {
    wipCol.appendChild(makeKickstartChip(item));
  }

  columns.appendChild(newCol);
  columns.appendChild(wipCol);
  container.appendChild(columns);
  messages.appendChild(container);
}

function makeKickstartChip(item) {
  const chip = document.createElement('div');
  chip.className = 'kickstart-chip';

  const icon = document.createElement('span');
  icon.className = 'kickstart-chip-icon';
  icon.textContent = item.icon || '💬';

  const text = document.createElement('span');
  text.className = 'kickstart-chip-text';
  text.textContent = item.text;

  chip.appendChild(icon);
  chip.appendChild(text);

  chip.addEventListener('click', () => {
    dismissKickstarts();
    // Send the prompt as if the user typed it
    const input = document.getElementById('input');
    input.value = item.text;
    sendMessage();
  });

  return chip;
}

function dismissKickstarts() {
  const el = document.getElementById('kickstarts');
  if (el) el.remove();
}

function pickRandom(arr, count) {
  if (!arr || arr.length <= count) return arr || [];
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// ─── SEND ─────────────────────────────────────────────────────────────────────

function sendMessage() {
  const input = document.getElementById('input');
  const text  = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  dismissKickstarts();
  appendMessage('user', text);
  ws.send(JSON.stringify({ type: 'chat', text }));
  input.value = '';
  input.style.height = 'auto';
}

// ─── BRIDGE INDICATORS ────────────────────────────────────────────────────────

function updateBridgeIndicators() {
  const on    = state.bridgeDetected;
  const cls   = on ? 'bridge-indicator on' : 'bridge-indicator off';
  const label = on ? 'bridge: on' : 'bridge: off';
  const title = on ? t("chat.bridge_connected") : t("chat.bridge_not_detected");

  for (const id of ['bridge-indicator', 'proj-bridge-indicator', 'detail-bridge-indicator']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.className = cls;
    el.title     = title;
    const dot    = el.querySelector('.bridge-dot');
    const lbl    = el.querySelector('.bridge-label');
    if (lbl) lbl.textContent = label;
  }
}

// ─── UNSAVED INDICATOR ────────────────────────────────────────────────────────

function markUnsaved() {
  const el = document.getElementById('sync-status');
  if (el && !el.textContent.includes('●')) {
    el.textContent += ' ●';
    el.title = 'Unsaved changes — Ctrl+S to save';
  }
}

function clearUnsavedIndicator() {
  const el = document.getElementById('sync-status');
  if (el) { el.textContent = el.textContent.replace(' ●', ''); el.title = ''; }
}

// ─── RENDER MESSAGES ─────────────────────────────────────────────────────────

function appendMessage(role, text, _unused = null, provider = null) {
  const messages = document.getElementById("messages")
  const div = document.createElement("div")
  div.className = `message ${role === "user" ? "user" : "assistant"}`

  const label = document.createElement("div")
  label.className = "message-label"
  label.textContent =
    role === "user" ? t("chat.label_you") : t("chat.label_addie")

  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/i)
  const thinkContent = thinkMatch ? thinkMatch[1].trim() : null
  let cleanText = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()

  // Strip any leftover action blocks (server strips them from finalText,
  // but this catches chat history reloads from disk)
  cleanText = cleanText.replace(/```action\n[\s\S]+?\n```/g, "")
  cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim()

  // Think block toggle
  if (thinkContent) {
    const thinkToggle = document.createElement("button")
    thinkToggle.className = "think-toggle"
    thinkToggle.textContent = t("actions.show_thinking")
    const thinkBlock = document.createElement("div")
    thinkBlock.className = "think-block hidden"
    thinkBlock.textContent = thinkContent
    thinkToggle.addEventListener("click", () => {
      const hidden = thinkBlock.classList.toggle("hidden")
      thinkToggle.textContent = hidden
        ? t("actions.show_thinking")
        : t("actions.hide_thinking")
    })
    div.appendChild(thinkToggle)
    div.appendChild(thinkBlock)
  }

  div.appendChild(label)

  const bubble = document.createElement("div")
  bubble.className = "bubble"
  bubble.textContent = cleanText
  div.appendChild(bubble)

  if (provider && role === "assistant") {
    const tag = document.createElement("div")
    tag.className = "provider-tag"
    tag.textContent = provider
    div.appendChild(tag)
  }

  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight

  if (role === "assistant") markUnsaved()
}

// ── ACTION CONFIRM WIDGET — shown before execution, requires user approval ──

function showActionConfirmWidget(actions) {
  const messages = document.getElementById('messages');

  const wrap = document.createElement('div');
  wrap.className = 'action-block pending';
  wrap.id = 'action-confirm-widget';

  const header = document.createElement('div');
  header.className = 'action-block-header';
  header.innerHTML = `<span class="action-block-spinner"></span> <span class="action-block-label">Addie wants to make ${actions.length} change${actions.length !== 1 ? 's' : ''} — approve?</span>`;
  wrap.appendChild(header);

  const list = document.createElement('div');
  list.className = 'action-block-list';
  for (const a of actions) {
    const item = document.createElement('div');
    item.className = 'action-block-item pending';
    item.innerHTML = `<span class="action-block-item-icon">◻</span> <span class="action-block-item-text">${escHtml(a.command)} | ${escHtml(a.args)}</span>`;
    list.appendChild(item);
  }
  wrap.appendChild(list);

  const btns = document.createElement('div');
  btns.className = 'action-confirm-buttons';

  const runBtn = document.createElement('button');
  runBtn.className = 'action-confirm-btn';
  runBtn.textContent = 'Run actions';
  runBtn.addEventListener('click', () => {
    wrap.remove();
    ws.send(JSON.stringify({ type: 'confirm_actions' }));
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'action-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    wrap.remove();
    ws.send(JSON.stringify({ type: 'cancel_actions' }));
  });

  btns.appendChild(runBtn);
  btns.appendChild(cancelBtn);
  wrap.appendChild(btns);

  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

// ── ACTION BLOCK — standalone UI element between messages ──────────────────

let _activeActionBlock = null

function showActionBlock(actions, status = "pending") {
  const messages = document.getElementById("messages")

  const wrap = document.createElement("div")
  wrap.className = "action-block pending"
  wrap.id = "active-action-block"
  _activeActionBlock = wrap

  const header = document.createElement("div")
  header.className = "action-block-header"
  header.innerHTML = `<span class="action-block-spinner"></span> <span class="action-block-label">${t("actions.processing") || "Processing actions..."}</span>`
  wrap.appendChild(header)

  const list = document.createElement("div")
  list.className = "action-block-list"
  for (const a of actions) {
    const item = document.createElement("div")
    item.className = "action-block-item pending"
    item.innerHTML = `<span class="action-block-item-icon">◻</span> <span class="action-block-item-text">${escHtml(a.command)} | ${escHtml(a.args)}</span>`
    list.appendChild(item)
  }
  wrap.appendChild(list)

  messages.appendChild(wrap)
  messages.scrollTop = messages.scrollHeight
}

function updateActionBlock(verification) {
  const wrap =
    _activeActionBlock || document.getElementById("active-action-block")
  if (!wrap) return

  const actionList = verification?.actions || []
  const succeeded = actionList.filter(a => a.success === true)
  const failed = actionList.filter(a => a.success === false)
  const selfFixed = succeeded.filter(a => a.retried)
  const allBad = actionList.length > 0 && succeeded.length === 0
  const statusCls = allBad ? "failed" : failed.length > 0 ? "partial" : "ok"

  // Update block status
  wrap.className = `action-block ${statusCls}`
  wrap.removeAttribute("id")
  _activeActionBlock = null

  // Update header
  const header = wrap.querySelector(".action-block-header")
  if (header) {
    if (allBad) {
      header.innerHTML = `<span class="action-block-status-icon">✗</span> <span class="action-block-label">${t("actions.all_failed", { count: failed.length })}</span>`
    } else if (failed.length > 0) {
      const fixNote = selfFixed.length
        ? `, ${t("actions.self_corrected", { count: selfFixed.length })}`
        : ""
      header.innerHTML = `<span class="action-block-status-icon">⚠</span> <span class="action-block-label">${t("actions.mixed", { ok: succeeded.length, fail: failed.length })}${fixNote}</span>`
    } else if (selfFixed.length > 0) {
      header.innerHTML = `<span class="action-block-status-icon">✓</span> <span class="action-block-label">${t("actions.executed", { count: succeeded.length })} (${t("actions.self_corrected", { count: selfFixed.length })})</span>`
    } else {
      header.innerHTML = `<span class="action-block-status-icon">✓</span> <span class="action-block-label">${t("actions.executed", { count: succeeded.length })}</span>`
    }
    header.style.cursor = "pointer"
  }

  // Rebuild item list with real results
  const list = wrap.querySelector(".action-block-list")
  if (list) {
    list.innerHTML = ""
    list.classList.add("hidden")

    for (const a of actionList) {
      const item = document.createElement("div")
      if (a.success) {
        const hasProblem = a.warning || a.mismatch
        item.className =
          "action-block-item" +
          (a.retried ? " retried" : "") +
          (hasProblem ? " clamped" : " ok")
        const icon = hasProblem ? "⚠" : "✓"
        const detail =
          a.verified != null
            ? ` → ${a.verifiedDisplay || a.verified}`
            : a.note
              ? ` → ${a.note}`
              : ""
        const retryNote = a.retried ? " (self-corrected)" : ""
        const warnNote = a.warning
          ? ` ⚠ ${a.warning}`
          : a.mismatch
            ? " ⚠ sent ≠ verified"
            : ""
        item.textContent = `${icon} ${a.command} | ${a.args}${detail}${retryNote}${warnNote}`
      } else {
        item.className = "action-block-item fail"
        const attempts = a.retryAction
          ? ` (tried 2×: "${a.error}" → "${a.retryError}")`
          : a.retrySkipped
            ? " (no correction found)"
            : ""
        item.textContent = `✗ ${a.command} | ${a.args} — ${a.error}${attempts}`
      }
      list.appendChild(item)
    }

    // Toggle detail list on header click
    if (header) {
      header.addEventListener("click", () => list.classList.toggle("hidden"))
    }
  }

  document.getElementById("messages").scrollTop =
    document.getElementById("messages").scrollHeight
}

function appendSystem(text) {
  const messages = document.getElementById('messages');
  const div      = document.createElement('div');
  div.className = "message system"
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

let statusEl = null;
function showStatus(text) {
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'status-msg';
    document.getElementById('messages').appendChild(statusEl);
  }
  statusEl.textContent = text;
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}
function removeStatus() { if (statusEl) { statusEl.remove(); statusEl = null; } }

// ─── EVENTS — CHAT ────────────────────────────────────────────────────────────

document.getElementById('send-btn').addEventListener('click', sendMessage);

document.getElementById('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

document.getElementById('input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});

// Ctrl+S / Cmd+S — save chat (mirrors Ableton's save shortcut)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'save_chat' }));
  }
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────

const overlay          = document.getElementById('settings-overlay');
const apiKeyInput      = document.getElementById('api-key-input');
const modelIdInput     = document.getElementById('model-id-input');
const providerDetected = document.getElementById('provider-detected');
const settingsFeedback = document.getElementById('settings-feedback');

// ── Eye toggle (show / hide api key input value) ──────────────────────────────
const apiKeyEye     = document.getElementById('api-key-eye');
const eyeIconShow   = document.getElementById('eye-icon-show');
const eyeIconHide   = document.getElementById('eye-icon-hide');
let   _keyVisible   = false;

apiKeyEye?.addEventListener('click', () => {
  _keyVisible = !_keyVisible;
  // text input always — we manage masking with CSS filter instead of type swap
  // (type swap resets cursor position and is jarring)
  apiKeyInput.classList.toggle('api-key-masked', !_keyVisible);
  eyeIconShow.style.display = _keyVisible ? 'none'  : '';
  eyeIconHide.style.display = _keyVisible ? ''      : 'none';
});

function _isLocalEndpoint(val) {
  return /^https?:\/\//i.test(val);
}

let _settingsPrefsPanel = null; // holds { getState } from initPrefsPanel

async function openSettings() {
  overlay.classList.remove('hidden');
  const [settingsRes, prefsRes] = await Promise.all([
    fetch('/api/settings'),
    fetch('/api/preferences'),
  ]);
  const data  = await settingsRes.json();
  const prefs = await prefsRes.json();

  // If endpoint is set and no apiKey, show the endpoint in the unified field
  const fieldVal = data.model.apiKey || data.model.endpoint || '';
  apiKeyInput.value = fieldVal;
  // Start masked unless it looks like a local URL (not sensitive)
  _keyVisible = _isLocalEndpoint(fieldVal);
  apiKeyInput.classList.toggle('api-key-masked', !_keyVisible);
  eyeIconShow.style.display = _keyVisible ? 'none' : '';
  eyeIconHide.style.display = _keyVisible ? ''     : 'none';

  modelIdInput.value = data.model.modelId || '';
  if (data.providerInfo)
    providerDetected.textContent = `Detected: ${data.providerInfo.name} · ${data.providerInfo.defaultModel || 'auto'}`;

  if (typeof window.initPrefsPanel === 'function') {
    _settingsPrefsPanel = window.initPrefsPanel('settings-prefs-panel', prefs.preferences || {});
  }
}

// Bridge help button — open / close / reinstall
document.getElementById('bridge-help-btn').addEventListener('click', () => {
  document.getElementById('bridge-dialog-overlay').classList.remove('hidden');
});

document.getElementById('bridge-dialog-close').addEventListener('click', () => {
  document.getElementById('bridge-dialog-overlay').classList.add('hidden');
});

document.getElementById('bridge-dialog-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('bridge-dialog-overlay'))
    document.getElementById('bridge-dialog-overlay').classList.add('hidden');
});

document.getElementById('bridge-dialog-reinstall-btn').addEventListener('click', () => {
  _runInstall(document.getElementById('bridge-dialog-reinstall-feedback'));
});

// Settings buttons across all views
document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('proj-settings-btn').addEventListener('click', openSettings);
document.getElementById('detail-settings-btn').addEventListener('click', openSettings);

document.getElementById('settings-close').addEventListener('click', () => overlay.classList.add('hidden'));
overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });

// "What key do I need?" explainer toggle in settings
const settingsExplainBtn = document.getElementById('settings-explain-btn');
const settingsExplainBox = document.getElementById('settings-explain-box');
settingsExplainBtn?.addEventListener('click', () => {
  const open = settingsExplainBox.classList.toggle('ob-explain-open');
  settingsExplainBtn.textContent = open ? t('settings.what_key_close') : t('settings.what_key');
});

apiKeyInput.addEventListener('input', debounce(async () => {
  const val = apiKeyInput.value.trim();
  if (!val) { providerDetected.textContent = ''; return; }

  const isLocal = _isLocalEndpoint(val);
  // Auto-unmask local endpoints (they're not sensitive)
  if (isLocal && !_keyVisible) {
    _keyVisible = true;
    apiKeyInput.classList.remove('api-key-masked');
    eyeIconShow.style.display = 'none';
    eyeIconHide.style.display = '';
  }

  const body = isLocal
    ? { apiKey: '', endpoint: val, modelId: modelIdInput.value.trim() }
    : { apiKey: val, endpoint: '', modelId: modelIdInput.value.trim() };

  const r = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (isLocal) {
    providerDetected.textContent = `→ Local endpoint — set Model ID below`;
  } else {
    providerDetected.textContent = d.providerInfo
      ? `→ ${d.providerInfo.name} · ${d.providerInfo.defaultModel || 'set model manually'}`
      : 'Provider not recognized — set endpoint and model manually.';
  }
}, 500));

document.getElementById('settings-save').addEventListener('click', async () => {
  const val     = apiKeyInput.value.trim();
  const isLocal = _isLocalEndpoint(val);
  const body    = isLocal
    ? { apiKey: '', endpoint: val, modelId: modelIdInput.value.trim() }
    : { apiKey: val, endpoint: '', modelId: modelIdInput.value.trim() };

  const res  = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Save producer preferences if the panel was rendered
  if (_settingsPrefsPanel) {
    await fetch('/api/save-preferences', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ preferences: _settingsPrefsPanel.getState() }),
    });
  }

  const data = await res.json();
  if (data.ok) {
    settingsFeedback.textContent = t("settings.saved")
    setTimeout(() => { settingsFeedback.textContent = ''; overlay.classList.add('hidden'); }, 1200);
  }
});

// ─── REINSTALL CONTROL SURFACE ────────────────────────────────────────────────

/**
 * If only one Ableton installation is found, install into it immediately.
 * If multiple are found, render a version-picker inside feedbackEl so the
 * user can choose before anything is written to disk.
 * Returns a Promise that resolves once install completes (or rejects on error).
 */
async function _runInstall(feedbackEl) {
  feedbackEl.textContent = t("settings.looking_ableton");
  feedbackEl.innerHTML = '';

  let paths = [];
  try { paths = await window.addie.findAbletonPaths(); } catch { paths = []; }

  if (!paths || paths.length === 0) {
    feedbackEl.textContent = t("settings.ableton_not_found");
    return;
  }

  if (paths.length === 1) {
    await _doInstall(paths[0], feedbackEl);
    return;
  }

  // Multiple installations — show picker
  feedbackEl.innerHTML = '';
  const label = document.createElement('div');
  label.style.cssText = 'margin-bottom:8px;font-size:12px;color:var(--text-muted,#888)';
  label.textContent = 'Select Ableton version to install into:';
  feedbackEl.appendChild(label);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';

  for (const p of paths) {
    const btn = document.createElement('button');
    btn.className = 'ob-tag';
    btn.style.cssText = 'font-size:12px;padding:4px 10px;cursor:pointer';
    btn.textContent = p.version;
    btn.title = p.scriptsPath;
    btn.addEventListener('click', async () => {
      feedbackEl.innerHTML = '';
      await _doInstall(p, feedbackEl);
    });
    btnRow.appendChild(btn);
  }
  feedbackEl.appendChild(btnRow);
}

async function _doInstall(target, feedbackEl) {
  feedbackEl.textContent = t("settings.installing_into", { version: target.version });
  try {
    const res  = await fetch('/api/install-control-surface', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ scriptsPath: target.scriptsPath }),
    });
    const data = await res.json();
    feedbackEl.textContent = data.ok
      ? t("settings.installed_into", { version: target.version })
      : t("settings.install_failed", { error: data.error });
  } catch (e) {
    feedbackEl.textContent = `Error: ${e.message}`;
  }
}

document.getElementById('settings-reinstall-btn').addEventListener('click', () => {
  const feedback = document.getElementById('reinstall-feedback');
  _runInstall(feedback);
});

// ─── REDO ONBOARDING ──────────────────────────────────────────────────────────

document.getElementById('settings-redo-onboarding-btn').addEventListener('click', async () => {
  const feedback = document.getElementById('redo-onboarding-feedback');
  feedback.textContent = '';
  try {
    await fetch('/api/reset-onboarding', { method: 'POST' });
    feedback.textContent = t('settings.onboarding_reset') || 'Restarting…';
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    feedback.textContent = `Error: ${e.message}`;
  }
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m    = Math.floor(diff / 60000);
  const h    = Math.floor(diff / 3600000);
  const d    = Math.floor(diff / 86400000);
  if (m < 1) return t("misc.just_now")
  if (m < 60) return t("misc.minutes_ago", { n: m })
  if (h < 24) return t("misc.hours_ago", { n: h })
  if (d < 30) return t("misc.days_ago", { n: d })
  return new Date(ts).toLocaleDateString();
}

function formatBytes(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Custom prompt dialog (window.prompt() is not supported in Electron)
function customPrompt(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('prompt-overlay');
    const input   = document.getElementById('prompt-input');
    const titleEl = document.getElementById('prompt-title');
    const okBtn   = document.getElementById('prompt-ok-btn');
    const cancelBtn = document.getElementById('prompt-cancel-btn');

    titleEl.textContent = title;
    input.value = defaultValue;
    overlay.classList.remove('hidden');
    input.focus();
    input.select();

    function cleanup() {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlay);
    }
    function onOk() { cleanup(); resolve(input.value); }
    function onCancel() { cleanup(); resolve(null); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    function onOverlay(e) { if (e.target === overlay) onCancel(); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onOverlay);
  });
}


// ─── THEME & LANGUAGE PICKERS ─────────────────────────────────────────────────

// Theme picker inside settings panel (unchanged)
function renderThemePicker() {
  const container = document.getElementById('theme-picker');
  if (!container) return;
  container.innerHTML = '';
  const lang = window.i18n.getLanguage();
  const current = window.themes.getTheme();
  for (const [key, theme] of Object.entries(window.themes.THEMES)) {
    const btn = document.createElement('button');
    btn.className = 'theme-option' + (key === current ? ' active' : '');
    btn.dataset.theme = key;
    btn.textContent = (lang === 'es' && theme.labelEs) ? theme.labelEs : theme.label;
    btn.style.setProperty('--swatch', theme.vars['--accent']);
    btn.addEventListener('click', () => {
      window.themes.setTheme(key);
      renderThemePicker();
      renderThemeDropdowns();
    });
    container.appendChild(btn);
  }
}

// Theme dropdowns in topbars (proj / detail / chat)
function renderThemeDropdowns() {
  const lang    = window.i18n.getLanguage();
  const current = window.themes.getTheme();
  const currentTheme = window.themes.THEMES[current];

  for (const id of ['proj', 'detail', 'chat']) {
    const swatch  = document.getElementById(`${id}-theme-swatch`);
    const panel   = document.getElementById(`${id}-theme-panel`);
    const trigger = document.getElementById(`${id}-theme-trigger`);
    if (!swatch || !panel || !trigger) continue;

    // Rainbow icon using each theme's representative color
    const dotColors = Object.values(window.themes.THEMES).map(t => t.dotColor || t.vars['--accent']);
    const step = 100 / dotColors.length;
    const stops = dotColors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(', ');
    swatch.style.background = `conic-gradient(${stops})`;
    swatch.style.border = 'none';

    // Rebuild option list
    panel.innerHTML = '';
    for (const [key, theme] of Object.entries(window.themes.THEMES)) {
      const btn  = document.createElement('button');
      btn.className = 'theme-dropdown-item' + (key === current ? ' active' : '');
      const dot  = document.createElement('span');
      dot.className = 'theme-dropdown-item-dot';
      dot.style.background = theme.dotColor || theme.vars['--accent'];
      const label = document.createElement('span');
      label.textContent = (lang === 'es' && theme.labelEs) ? theme.labelEs : theme.label;
      btn.appendChild(dot);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        window.themes.setTheme(key);
        renderThemeDropdowns();
        renderThemePicker();
        closeAllThemeDropdowns();
      });
      panel.appendChild(btn);
    }

    // Bind toggle (once only)
    if (!trigger._themeDropdownBound) {
      trigger._themeDropdownBound = true;
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !panel.classList.contains('hidden');
        closeAllThemeDropdowns();
        if (!isOpen) panel.classList.remove('hidden');
      });
    }
  }
}

function closeAllThemeDropdowns() {
  for (const id of ['proj', 'detail', 'chat']) {
    document.getElementById(`${id}-theme-panel`)?.classList.add('hidden');
  }
}

// Cerrar dropdowns al hacer click fuera
document.addEventListener('click', closeAllThemeDropdowns);

function renderLangPicker() {
  const current = window.i18n.getLanguage();
  document.querySelectorAll('.lang-flag-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === current);
  });
}

// One delegated listener covers all three topbar flag pickers
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.lang-flag-btn');
  if (!btn) return;
  window.i18n.setLanguage(btn.dataset.lang);
  renderLangPicker();
  renderThemePicker();
  renderThemeDropdowns();
  renderProjectGrid();
  renderSidebarConvList();
  updateChatConvTitle();
  updateBridgeIndicators();
  const syncEl = document.getElementById('sync-status');
  if (syncEl && (syncEl.textContent.startsWith('No sync') || syncEl.textContent.startsWith('Sin sinc'))) {
    syncEl.textContent = t('chat.no_sync');
  }
});

// Init pickers when settings opens
const _origOpenSettings = openSettings;
openSettings = async function() {
  await _origOpenSettings();
  renderThemeDropdowns();
  renderLangPicker();
};

// ─── INIT ON LOAD ─────────────────────────────────────────────────────────────
window.i18n.applyTranslations();
renderThemeDropdowns();
renderLangPicker();