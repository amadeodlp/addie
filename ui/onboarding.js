/**
 * onboarding.js  — v2
 *
 * Redesigned two-step onboarding:
 *   1. prefs   — pressable tag chips for genre, workflow, experience, monitoring
 *   2. llm     — API key input with expandable explainer
 *
 * Followed by the original install / enable steps, then straight to the app.
 * All preferences are also surfaced in Settings for later editing.
 */

// ─── PREFERENCE DATA ────────────────────────────────────────────────────────

const PREF_DATA = {
  genres: [
    'Hip-Hop', 'Techno', 'House', 'Drum & Bass', 'Ambient', 'Pop',
    'R&B / Soul', 'Jazz', 'Metal', 'Indie', 'Lo-Fi', 'Trap',
    'Experimental', 'Reggae', 'Folk / Acoustic', 'Film / Scoring'
  ],
  workflow: [
    'Beat-first', 'Melody-first', 'Sketch fast, fix later',
    'High template usage', 'Heavy sampling', 'Live recording',
    'Modular / hardware heavy', 'Mix as I go'
  ],
  level: ['Beginner', 'Intermediate', 'Advanced', 'Professional'],
  monitoring: ['Studio monitors', 'Headphones', 'Both']
};

// ─── STATE ───────────────────────────────────────────────────────────────────

const STEPS = ['prefs', 'llm', 'install', 'enable'];
let _currentStep  = null;
let _bridgePoll   = null;
let _installDone  = false;

// Gathered preferences (multi-select where applicable)
const _prefs = { genres: [], workflow: [], level: '', monitoring: '', plugins: '', references: '' };

// ─── ENTRY ───────────────────────────────────────────────────────────────────

function initOnboarding(isFirstRun) {
  if (!isFirstRun) { showApp(); return; }
  showOnboarding();
  goTo('prefs');
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function goTo(step) {
  if (_currentStep) {
    const el = document.getElementById(`ob-step-${_currentStep}`);
    if (el) el.classList.add('hidden');
  }
  _currentStep = step;
  const el = document.getElementById(`ob-step-${step}`);
  if (el) {
    el.classList.remove('hidden');
    el.classList.add('ob-step-entering');
    setTimeout(() => el.classList.remove('ob-step-entering'), 400);
  }
  if (step === 'install') initInstallStep();
  if (step === 'enable')  initEnableStep();
}

function showOnboarding() {
  document.getElementById('onboarding').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function showApp() {
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

// ─── STEP 1: PREFERENCES ─────────────────────────────────────────────────────

function buildTagGroup(containerId, items, prefKey, multiSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'ob-tag';
    btn.textContent = item;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (multiSelect) {
        btn.classList.toggle('ob-tag-active');
        const arr = _prefs[prefKey];
        const idx = arr.indexOf(item);
        idx === -1 ? arr.push(item) : arr.splice(idx, 1);
      } else {
        container.querySelectorAll('.ob-tag').forEach(b => b.classList.remove('ob-tag-active'));
        btn.classList.add('ob-tag-active');
        _prefs[prefKey] = item;
      }
    });
    container.appendChild(btn);
  });
}

buildTagGroup('ob-tags-genres',    PREF_DATA.genres,     'genres',     true);
buildTagGroup('ob-tags-workflow',  PREF_DATA.workflow,   'workflow',   true);
buildTagGroup('ob-tags-level',     PREF_DATA.level,      'level',      false);
buildTagGroup('ob-tags-monitoring',PREF_DATA.monitoring, 'monitoring', false);

document.getElementById('ob-prefs-next-btn').addEventListener('click', () => {
  _prefs.genresCustom = document.getElementById('ob-pref-genres-custom')?.value.trim() || '';
  _prefs.plugins      = document.getElementById('ob-pref-plugins')?.value.trim() || '';
  _prefs.references   = document.getElementById('ob-pref-references')?.value.trim() || '';
  goTo('llm');
});

document.getElementById('ob-prefs-skip-btn').addEventListener('click', () => goTo('llm'));

// ─── STEP 2: LLM SETUP ───────────────────────────────────────────────────────

const obApiKeyInput  = document.getElementById('ob-api-key');
const obProviderHint = document.getElementById('ob-provider-hint');
const obLlmNextBtn   = document.getElementById('ob-llm-next-btn');
const obLlmError     = document.getElementById('ob-llm-error');
const obExplainBtn   = document.getElementById('ob-explain-btn');
const obExplainBox   = document.getElementById('ob-explain-box');
const obEyeBtn       = document.getElementById('ob-api-key-eye');
const obEyeShow      = document.getElementById('ob-eye-show');
const obEyeHide      = document.getElementById('ob-eye-hide');
let   _obKeyVisible  = false;

function _isLocalUrl(v) { return /^https?:\/\//i.test(v); }

// Eye toggle
obEyeBtn?.addEventListener('click', () => {
  _obKeyVisible = !_obKeyVisible;
  obApiKeyInput.classList.toggle('api-key-masked', !_obKeyVisible);
  obEyeShow.style.display = _obKeyVisible ? 'none' : '';
  obEyeHide.style.display = _obKeyVisible ? ''     : 'none';
});

// Toggle explainer
obExplainBtn?.addEventListener('click', () => {
  const open = obExplainBox.classList.toggle('ob-explain-open');
  obExplainBtn.textContent = open ? '✕  Close' : '? What is this?';
});

// Provider detection on input
let _keyDebounce = null;
obApiKeyInput?.addEventListener('input', () => {
  clearTimeout(_keyDebounce);
  const val = obApiKeyInput.value.trim();
  if (!val) { obProviderHint.textContent = ''; obLlmNextBtn.disabled = true; return; }
  obLlmNextBtn.disabled = false;

  // Auto-unmask local URLs
  if (_isLocalUrl(val) && !_obKeyVisible) {
    _obKeyVisible = true;
    obApiKeyInput.classList.remove('api-key-masked');
    obEyeShow.style.display = 'none';
    obEyeHide.style.display = '';
  }

  _keyDebounce = setTimeout(async () => {
    try {
      const isLocal = _isLocalUrl(val);
      const body    = isLocal ? { apiKey: '', endpoint: val } : { apiKey: val, endpoint: '' };
      const r = await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (isLocal) {
        obProviderHint.textContent = '✓ Local endpoint detected — set Model ID in Settings if needed';
        obProviderHint.className = 'ob-provider-hint ok';
      } else if (d.providerInfo) {
        obProviderHint.textContent = `✓ ${d.providerInfo.name}${d.providerInfo.defaultModel ? ' · ' + d.providerInfo.defaultModel : ''}`;
        obProviderHint.className = 'ob-provider-hint ok';
      } else {
        obProviderHint.textContent = 'Provider not recognised — you can set it manually in Settings.';
        obProviderHint.className = 'ob-provider-hint warn';
      }
    } catch { obProviderHint.textContent = ''; }
  }, 500);
});

obLlmNextBtn?.addEventListener('click', async () => {
  obLlmError?.classList.add('hidden');
  const val     = obApiKeyInput.value.trim();
  const isLocal = _isLocalUrl(val);
  const body    = isLocal ? { apiKey: '', endpoint: val } : { apiKey: val, endpoint: '' };
  try {
    await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    await savePrefs();
  } catch (e) {
    if (obLlmError) { obLlmError.textContent = 'Could not save: ' + e.message; obLlmError.classList.remove('hidden'); }
    return;
  }
  goTo('install');
});

document.getElementById('ob-llm-skip-btn')?.addEventListener('click', async () => {
  await savePrefs();
  goTo('install');
});

async function savePrefs() {
  try {
    await fetch('/api/save-preferences', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: _prefs })
    });
  } catch { /* non-fatal */ }
}

// ─── STEP 3: INSTALL CONTROL SURFACE ─────────────────────────────────────────

async function initInstallStep() {
  const statusEl  = document.getElementById('ob-install-status');
  const errorEl   = document.getElementById('ob-install-error');
  const manualEl  = document.getElementById('ob-install-manual');
  const actionsEl = document.getElementById('ob-install-actions');
  errorEl.classList.add('hidden');
  manualEl.classList.add('hidden');
  actionsEl.style.display = 'none';
  statusEl.innerHTML = `<div class="ob-install-row"><div class="ob-spinner"></div><span>Looking for Ableton installations...</span></div>`;

  let paths = [];
  try { paths = await window.addie.findAbletonPaths(); } catch { paths = []; }

  if (!paths?.length) {
    statusEl.innerHTML = `<div class="ob-install-row warn">Ableton installation not found automatically.</div>`;
    manualEl.classList.remove('hidden');
    actionsEl.style.display = 'flex';
    return;
  }

  if (paths.length === 1) {
    await _obDoInstall(paths[0], statusEl, errorEl, manualEl);
    actionsEl.style.display = 'flex';
    return;
  }

  // Multiple installations — let user pick
  statusEl.innerHTML = `<div class="ob-install-row" style="flex-direction:column;align-items:flex-start;gap:8px">
    <span>Multiple Ableton versions found. Select one to install into:</span>
    <div id="ob-version-picker" style="display:flex;flex-wrap:wrap;gap:6px"></div>
  </div>`;

  const picker = document.getElementById('ob-version-picker');
  for (const p of paths) {
    const btn = document.createElement('button');
    btn.className = 'ob-tag';
    btn.textContent = p.version;
    btn.title = p.scriptsPath;
    btn.addEventListener('click', async () => {
      statusEl.innerHTML = `<div class="ob-install-row"><div class="ob-spinner"></div><span>Installing into <code>${p.scriptsPath}</code>...</span></div>`;
      await _obDoInstall(p, statusEl, errorEl, manualEl);
      actionsEl.style.display = 'flex';
    });
    picker.appendChild(btn);
  }
}

async function _obDoInstall(target, statusEl, errorEl, manualEl) {
  try {
    const res  = await fetch('/api/install-control-surface', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptsPath: target.scriptsPath })
    });
    const data = await res.json();
    if (data.ok) {
      _installDone = true;
      const note = data.alreadyInstalled ? ' (updated)' : '';
      statusEl.innerHTML = `<div class="ob-install-row ok"><span class="ob-check">✓</span><span>Installed into <code>${target.version}</code>${note}</span></div>`;
    } else { throw new Error(data.error || 'Unknown error'); }
  } catch (e) {
    statusEl.innerHTML = `<div class="ob-install-row warn">Installation failed: ${e.message}</div>`;
    errorEl.textContent = 'You may need to install manually.';
    errorEl.classList.remove('hidden');
    manualEl.classList.remove('hidden');
  }
}

document.getElementById('ob-install-next-btn')?.addEventListener('click', () => goTo('enable'));

// ─── STEP 4: ENABLE IN ABLETON ───────────────────────────────────────────────

function initEnableStep() {
  const checkbox = document.getElementById('ob-enable-checkbox');
  const nextBtn  = document.getElementById('ob-enable-next-btn');
  // Reset state each time step is entered
  if (checkbox) { checkbox.checked = false; }
  if (nextBtn)  { nextBtn.disabled = true; }
  checkbox?.addEventListener('change', () => {
    if (nextBtn) nextBtn.disabled = !checkbox.checked;
  });
}

document.getElementById('ob-enable-next-btn')?.addEventListener('click', finishOnboarding);

async function finishOnboarding() {
  try { await fetch('/api/onboarding-done', { method: 'POST' }); } catch { /* non-fatal */ }
  // DO NOT send force_sync — sync only happens when the user sends a chat message.
  // Show the app directly; the WebSocket init message already sent onboardingDone=false
  // so we drive the transition ourselves here.
  showApp();
  // Tell app.js to render the projects page now that onboarding is done
  if (typeof window.showProjectsPage === 'function') window.showProjectsPage();
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────

window.initOnboarding = initOnboarding;

// ─── SETTINGS PREFS PANEL (also used in settings overlay) ────────────────────

window.initPrefsPanel = function initPrefsPanel(containerId, initialPrefs = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  function buildSettingsTagGroup(parentEl, items, key, multiSelect, state) {
    const wrap = document.createElement('div');
    wrap.className = 'ob-tags';
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'ob-tag';
      btn.type = 'button';
      btn.textContent = item;
      const isActive = multiSelect ? (state[key] || []).includes(item) : state[key] === item;
      if (isActive) btn.classList.add('ob-tag-active');
      btn.addEventListener('click', () => {
        if (multiSelect) {
          btn.classList.toggle('ob-tag-active');
          if (!Array.isArray(state[key])) state[key] = [];
          const idx = state[key].indexOf(item);
          idx === -1 ? state[key].push(item) : state[key].splice(idx, 1);
        } else {
          wrap.querySelectorAll('.ob-tag').forEach(b => b.classList.remove('ob-tag-active'));
          btn.classList.add('ob-tag-active');
          state[key] = item;
        }
      });
      wrap.appendChild(btn);
    });
    parentEl.appendChild(wrap);
  }

  const state = {
    genres:       [...(initialPrefs.genres || [])],
    genresCustom: initialPrefs.genresCustom || '',
    workflow:     [...(initialPrefs.workflow || [])],
    level:        initialPrefs.level || '',
    monitoring:   initialPrefs.monitoring || '',
    plugins:      initialPrefs.plugins || '',
    references:   initialPrefs.references || ''
  };

  const rows = [
    { label: 'GENRE / STYLE',  key: 'genres',     items: PREF_DATA.genres,     multi: true },
    { label: 'WORKFLOW',       key: 'workflow',    items: PREF_DATA.workflow,   multi: true },
    { label: 'EXPERIENCE',     key: 'level',       items: PREF_DATA.level,      multi: false },
    { label: 'MONITORING',     key: 'monitoring',  items: PREF_DATA.monitoring, multi: false },
  ];

  container.innerHTML = '';
  rows.forEach(row => {
    const section = document.createElement('div');
    section.className = 'settings-section';
    const label = document.createElement('div');
    label.className = 'settings-label';
    label.textContent = row.label;
    section.appendChild(label);
    buildSettingsTagGroup(section, row.items, row.key, row.multi, state);
    container.appendChild(section);
  });

  // Text fields
  const textFields = [
    { label: 'OTHER GENRES', key: 'genresCustom', placeholder: 'e.g. Cumbia, Afrobeat, Bossa Nova...' },
    { label: 'PLUGINS / TOOLS', key: 'plugins',    placeholder: 'e.g. Serum, FabFilter, Valhalla...' },
    { label: 'REFERENCE ARTISTS', key: 'references', placeholder: 'e.g. Burial, Charlotte de Witte...' }
  ];
  textFields.forEach(f => {
    const section = document.createElement('div');
    section.className = 'settings-section';
    const label = document.createElement('div');
    label.className = 'settings-label';
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = state[f.key];
    input.placeholder = f.placeholder;
    input.className = 'settings-text-input';
    input.addEventListener('input', () => { state[f.key] = input.value; });
    section.appendChild(label);
    section.appendChild(input);
    container.appendChild(section);
  });

  return { getState: () => ({ ...state }) };
};
