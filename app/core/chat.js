/**
 * chat.js — Chat pipeline orchestration.
 *
 * SYNC MODEL:
 *   - Full sync (session + browser + all device details) happens once per server
 *     session, on the first message. Never on startup, never on bridge connect.
 *   - No cache. fetchTrackDetails always reads fresh from Live.
 *   - Session is cleared after structural changes (track create/delete/group).
 *
 * PIPELINE (per message):
 *   1. Lazy sync — fetch session + browser + all device details on first message
 *   2. RAG retrieval — per message, ~2ms local vector search
 *   3. reason() — semantic track resolution
 *   4. Name-match — deterministic track mention detection
 *   5. fetchTrackDetails — for relevant tracks, uses cache where valid
 *   6. Main LLM call — full context: session + devices + RAG + history
 *   7. Action execution + wrap-up reply
 */

const { getSession, fetchSession, snapshot: _snapshot, getFullSnapshot, fetchTrackDetails, invalidateBrowser, fetchBrowser, resetAll } = require('./sync');
const { reason } = require('../intelligence/reasoning');
const { newConvId, createConversation, listConversations, appendChat, readChatLog, flushChat, updateSessionFromSync } = require('../state/context');
const { chat } = require('../services/llm');
const { isDetected } = require('../services/bridge');
const { retrieve, formatForPrompt } = require('../services/rag');
const { executeActions } = require('./actions');
const { buildSystemPrompt, buildRagQuery, parseChatHistory } = require('./prompt');
const { extractPreferences } = require('../intelligence/preferences');

// Project that has been fully synced this app session.
// Sync happens lazy on the first handleChat() for a given project.
// Cleared when the active project changes.
let _syncedProject = null;

// Pending action confirmations keyed by convId.
// Each entry: { llmReply, planText, ws, deps, userMessage, project, convId }
const _pendingActions = new Map();

async function handleChat(userMessage, ws, deps) {
  const { config, saveConfig, sendToBridge, send } = deps;
  const project = config.activeProject;
  let convId    = config.activeConversation;

  // ── Auto-create conversation if none active ────────────────────────────────
  if (!convId) {
    convId = newConvId(project);
    createConversation(project, convId, 'New conversation');
    config.activeConversation = convId;
    saveConfig(config);
    send(ws, {
      type:          'conversation_switched',
      conversation:  convId,
      conversations: listConversations(project),
    });
  }

  appendChat(project, convId, 'user', userMessage);

  // ── Step 1: Lazy project sync ─────────────────────────────────────────────
  // Sync runs once per project per app session, on the first message sent to
  // that project. Switching conversations within the same project does NOT
  // re-sync. Switching projects clears _syncedProject, triggering a fresh sync.
  //
  // Two conditions require a sync here:
  //   A. This project hasn't been synced yet this session.
  //   B. A structural action mid-conversation cleared the session cache
  //      (create/delete/group track). Session is gone but project is the same —
  //      lightweight recovery: re-fetch session + snapshot only, browser is fine.
  const sessionGone = _syncedProject === project && !getSession() && isDetected();
  const needsSync   = _syncedProject !== project || sessionGone;

  if (needsSync && isDetected()) {
    send(ws, { type: 'status', text: 'Reading session...' });
    try {
      if (sessionGone) {
        await fetchSession();
        await _snapshot();
        console.log('[chat] Session recovered after structural change.');
      } else {
        await _doSync(project);
        _syncedProject = project;
      }
    } catch (e) {
      console.warn('[chat] Sync failed:', e.message);
    }
  }

  const session = getSession();

  // ── Step 2: RAG retrieval ─────────────────────────────────────────────────
  const recentHistory = parseChatHistory(readChatLog(project, convId)).slice(-8);
  const ragQuery      = buildRagQuery(userMessage, []);
  let ragChunks = [];
  try {
    ragChunks = await retrieve(ragQuery, 5);
  } catch (e) { console.warn('[rag] Retrieval failed:', e.message); }

  // ── Step 3: Semantic track resolution ────────────────────────────────────
  const ragContext = formatForPrompt(ragChunks);
  const needs      = await reason(userMessage, { session, recentMessages: recentHistory, ragContext }, config.model);
  console.log('[chat] reason():', JSON.stringify(needs));

  // ── Step 4: Deterministic name-match ─────────────────────────────────────
  let mentionedTracks = [];
  if (session?.tracks?.length) {
    const msg = userMessage.toLowerCase();
    mentionedTracks = session.tracks
      .filter(t => {
        const name     = t.name.toLowerCase();
        // Strip leading "N-" index prefix and "Addie - " preset prefix so
        // "trilian" matches "2-Addie - Trilian", "diva" matches "3-Addie - Diva", etc.
        const stripped = name.replace(/^\d+-/, '').replace(/^addie\s*-\s*/i, '').trim();
        return msg.includes(name) || (stripped.length > 2 && msg.includes(stripped));
      })
      .map(t => t.name);
  }

  const allTargetTracks = [...new Set([...needs.tracks, ...mentionedTracks])].slice(0, 8);

  // ── Step 5: Fetch device details for relevant tracks ──────────────────────
  let trackDetails = [];
  let clipData     = null;
  // Map of trackName → { added: string[], removed: string[] } for delta reporting
  const deviceChanges = {};

  if (allTargetTracks.length && isDetected()) {
    // Snapshot device names BEFORE eviction so we can diff after the fresh fetch.
    const preRefreshDevices = {};
    if (needs.refresh) {
      const snap = getFullSnapshot();
      if (snap?.tracks) {
        const refreshSet = new Set(allTargetTracks.map(n => n.toLowerCase()));
        for (const t of snap.tracks) {
          if (refreshSet.has(t.name.toLowerCase())) {
            preRefreshDevices[t.name] = (t.devices || []).map(d => d.name);
          }
        }
        snap.tracks = snap.tracks.filter(t => !refreshSet.has(t.name.toLowerCase()));
        console.log('[chat] Snapshot evicted for refresh:', allTargetTracks.join(', '));
      }
    }

    try {
      const result = await fetchTrackDetails(allTargetTracks);
      trackDetails = result.tracks || [];
      console.log('[chat] Track details:', trackDetails.map(t =>
        `${t.name}(${(t.devices||[]).length}dev)`).join(', '));

      // Diff device lists to detect additions/removals since last read.
      if (needs.refresh && Object.keys(preRefreshDevices).length) {
        for (const t of trackDetails) {
          const before = preRefreshDevices[t.name];
          if (!before) continue; // wasn't in snapshot — no basis for diff
          const after = (t.devices || []).map(d => d.name);
          const added   = after.filter(n => !before.includes(n));
          const removed = before.filter(n => !after.includes(n));
          if (added.length || removed.length) {
            deviceChanges[t.name] = { added, removed };
            console.log(`[chat] Device changes on "${t.name}": +[${added}] -[${removed}]`);
          }
        }
      }
    } catch (e) {
      console.warn('[chat] Track detail fetch failed:', e.message);
    }

    try {
      clipData = await sendToBridge('get_clips', { trackNames: allTargetTracks }, 8000);
    } catch (e) {
      console.warn('[chat] Clip fetch failed (non-fatal):', e.message);
    }
  }

  // Merge full snapshot as a baseline so ALL tracks have device data in the
  // prompt — not just the ones reason() targeted this turn. Per-turn fetches
  // for targeted tracks take priority; snapshot fills in everything else.
  const fullSnap = getFullSnapshot();
  if (fullSnap?.tracks?.length) {
    const fetchedNames = new Set(trackDetails.map(t => t.name.toLowerCase()));
    const snapFallback = fullSnap.tracks.filter(t => !fetchedNames.has(t.name.toLowerCase()));
    if (snapFallback.length) {
      trackDetails = [...trackDetails, ...snapFallback];
      console.log('[chat] Snapshot fallback added:', snapFallback.map(t => t.name).join(', '));
    }
  }

  // Detect plugin install — invalidate browser so next message rescans
  if (/\b(just installed|new plugin|installed .+ plugin|added .+ vst)\b/i.test(userMessage)) {
    console.log('[chat] Plugin install detected — browser cache invalidated');
    invalidateBrowser();
    if (isDetected()) {
      try { await fetchBrowser(); } catch (e) { console.warn('[chat] Browser refresh failed:', e.message); }
    }
  }

  // ── Step 6: Main LLM call ─────────────────────────────────────────────────
  send(ws, { type: 'status', text: 'Thinking...' });

  const freshDetailNames = new Set(trackDetails.map(t => t.name.toLowerCase()));
  const systemPrompt     = buildSystemPrompt({
    project, session, trackDetails, ragChunks, clipData, freshDetailNames,
    deviceChanges: Object.keys(deviceChanges).length ? deviceChanges : null,
  });

  const result = await chat({
    apiKey:      config.model.apiKey,
    baseURL:     config.model.endpoint,
    modelId:     config.model.modelId,
    messages:    [...recentHistory, { role: 'user', content: userMessage }],
    systemPrompt,
    maxTokens:   4096,
  });

  // ── Step 7: Actions + wrap-up ─────────────────────────────────────────────
  if (!result.error) {
    const actionBlockMatches = [...result.text.matchAll(/```action\n([\s\S]+?)\n```/g)];

    if (actionBlockMatches.length > 0) {
      const firstActionIdx = result.text.indexOf('```action\n');
      const planText = result.text.slice(0, firstActionIdx).trim();

      const pendingActions = actionBlockMatches.map(m => {
        const body  = m[1].trim();
        const parts = body.includes('|') ? body.split('|').map(s => s.trim()) : body.split(/\s+/);
        return { command: parts[0], args: parts.slice(1).join(' | '), raw: body };
      });

      // Send plan text to UI first
      appendChat(project, convId, 'assistant', planText);
      send(ws, { type: 'chat', role: 'assistant', text: planText, provider: result.provider });

      // Pause — ask the producer to confirm before executing anything
      _pendingActions.set(convId, { llmReply: result.text, planText, ws, deps, userMessage, project, convId, proposedAt: Date.now() });
      send(ws, {
        type:    'action_pending',
        actions: pendingActions.map(a => ({ command: a.command, args: a.args })),
      });
      return; // resumes via confirmActions() / cancelActions()
    }
  }

  // Simple reply (no actions)
  appendChat(project, convId, 'assistant', result.text);
  flushChat(project, convId);
  send(ws, { type: 'chat', role: 'assistant', text: result.text, provider: result.provider });

  // Async preference extraction — fire and forget, never blocks the reply
  extractPreferences(userMessage, result.text, config.model).catch(() => {});
}

function _formatResultLines(actions) {
  return actions.map((a, i) => {
    const label = a.raw ? `${a.command} | ${a.args}` : a.command;
    if (a.skipped) {
      return `  [${i+1}] ⊘ SKIPPED: ${label} — ${a.error}`;
    }
    if (a.success && a.redirected) {
      return `  [${i+1}] ↪ ${label}: redirected from slot ${a.originalSlot} → slot ${a.redirectedSlot} (slot was occupied)`;
    }
    if (a.success && a.retried) {
      const detail = a.verified != null ? `${a.verifiedDisplay || a.verified} (raw: ${a.verified})` : a.note || 'done';
      const warn   = a.warning ? ` ⚠ WARNING: ${a.warning}` : '';
      return `  [${i+1}] ✓ ${label}: ${detail}${warn} [self-corrected — original error: "${a.firstError}", corrected to: "${a.correctedAction}"]`;
    }
    if (a.success) {
      const detail = a.verified != null ? `${a.verifiedDisplay || a.verified} (raw: ${a.verified})` : a.note || 'done';
      const conv   = a.conversion ? ` [${a.conversion}]` : '';
      const warn   = a.warning ? ` ⚠ WARNING: ${a.warning}` : (a.mismatch ? ` ⚠ MISMATCH: sent value ≠ result` : '');
      const icon   = (a.warning || a.mismatch) ? '⚠' : '✓';
      return `  [${i+1}] ${icon} ${label}: ${detail}${conv}${warn}`;
    }
    if (a.retryAction)  return `  [${i+1}] ✗ FAILED (2 attempts): ${label}\n      Attempt 1 error: ${a.error}\n      Retry action: ${a.retryAction}\n      Attempt 2 error: ${a.retryError}`;
    if (a.retrySkipped) return `  [${i+1}] ✗ FAILED (no fix found): ${label} — ${a.error}`;
    return `  [${i+1}] ✗ FAILED: ${label} — ${a.error}`;
  });
}

// ── Confirmation gate: called by server.js when user clicks Run/Cancel ────────

async function confirmActions(convId) {
  const pending = _pendingActions.get(convId);
  if (!pending) return;
  _pendingActions.delete(convId);
  const { llmReply, planText, ws, deps, userMessage, project, proposedAt } = pending;
  const { config, sendToBridge, send } = deps;
  await _executeConfirmedActions({ llmReply, planText, ws, config, sendToBridge, send, userMessage, project, convId, proposedAt });
}

function cancelActions(convId) {
  const pending = _pendingActions.get(convId);
  if (!pending) return;
  _pendingActions.delete(convId);
  const { ws, deps, project } = pending;
  const { send } = deps;
  const msg = 'Actions cancelled.';
  appendChat(project, convId, 'assistant', msg);
  flushChat(project, convId);
  send(ws, { type: 'chat', role: 'assistant', text: msg });
}

// ── Pre-execution plan review ─────────────────────────────────────────────────
// Called after user confirmation but before execution. Fetches fresh Tier 1 and
// asks a cheap LLM call whether the plan is still valid. Returns one of:
//   { status: 'ok' }                          — proceed as-is
//   { status: 'adjusted', revisedReply }       — proceed with patched action blocks
//   { status: 'needs_clarification', message } — cannot safely proceed, tell user

async function _reviewPlanBeforeExecution({ llmReply, planText, userMessage, freshTier1, modelConfig }) {
  const freshTracks = freshTier1?.tracks || [];
  const freshByName = new Map(freshTracks.map(t => [t.name.toLowerCase(), t.name]));

  // ── Pass 1: deterministic name normalization ───────────────────────────────
  // For each action block, extract the track name and check if it exists in the
  // current session. If not, try to match by numeric prefix (e.g. "2-Addie - Trilian"
  // → current track at position 2 regardless of what it's now called).
  // This covers the common case where Ableton renamed the track between plan and
  // confirmation. No LLM needed, no user prompt — just silent remapping.

  // Tracks that the plan itself will create — these don't exist in the session yet
  // by design. Exclude them from unresolved checks so the LLM review doesn't flag
  // them as missing. create_track and create_return both produce new tracks.
  const plannedCreations = new Set();
  for (const m of [...llmReply.matchAll(/```action\n([\s\S]+?)\n```/g)]) {
    const parts = m[1].trim().split('|').map(s => s.trim());
    const cmd = parts[0];
    if (cmd === 'create_track' && parts[2]) plannedCreations.add(parts[2].toLowerCase());
    if (cmd === 'create_return' && parts[1]) plannedCreations.add(parts[1].toLowerCase());
  }
  if (plannedCreations.size) {
    console.log('[chat] Plan will create tracks:', [...plannedCreations].join(', '));
  }

  let revisedReply = llmReply;
  const remaps = []; // { from, to } for logging

  const actionBlocks = [...llmReply.matchAll(/```action\n([\s\S]+?)\n```/g)];
  for (const match of actionBlocks) {
    const body  = match[1].trim();
    const parts = body.includes('|') ? body.split('|').map(s => s.trim()) : body.split(/\s+/);
    const command   = parts[0];
    const trackName = ['create_scene', 'set_tempo', 'set_loop', 'set_time_signature'].includes(command)
      ? null : parts[1];
    if (!trackName) continue;
    if (freshByName.has(trackName.toLowerCase())) continue; // still valid

    // Extract numeric prefix from the planned track name (e.g. "2" from "2-Addie - Trilian")
    const prefixMatch = trackName.match(/^(\d+)/);
    if (!prefixMatch) continue;
    const prefix = prefixMatch[1];

    // Find the current track at that same numeric position
    const candidate = freshTracks.find(t => t.name.match(/^(\d+)/) ?. [1] === prefix);
    if (!candidate) continue;

    // Remap: replace this track name in the full reply
    const escaped = trackName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(\\|\\s*)${escaped}(\\s*\\|)`, 'gi');
    const nextReply = revisedReply.replace(re, (_, pre, post) => `${pre}${candidate.name}${post}`);
    if (nextReply !== revisedReply) {
      remaps.push({ from: trackName, to: candidate.name });
      revisedReply = nextReply;
    }
  }

  if (remaps.length > 0) {
    for (const r of remaps) {
      console.log(`[chat] Pre-execution remap: "${r.from}" → "${r.to}" (numeric prefix match)`);
    }
    // If all track names resolved, skip the LLM call entirely
    const stillUnresolved = [...revisedReply.matchAll(/```action\n([\s\S]+?)\n```/g)].some(m => {
      const parts = m[1].trim().split('|').map(s => s.trim());
      const cmd = parts[0];
      if (['create_scene', 'set_tempo', 'set_loop', 'set_time_signature'].includes(cmd)) return false;
      const tn = parts[1];
      return tn && !freshByName.has(tn.toLowerCase()) && !plannedCreations.has(tn.toLowerCase());
    });
    if (!stillUnresolved) return { status: 'adjusted', revisedReply, reason: remaps.map(r => `"${r.from}" → "${r.to}"`).join(', ') };
  }

  // ── Pass 2: LLM review for anything genuinely ambiguous ───────────────────
  // Only runs if there are still unresolved track names after the deterministic pass.
  const currentTracks = freshTracks.map(t => `${t.name} (${t.type})`).join(', ');
  const remainingBlocks = [...revisedReply.matchAll(/```action\n([\s\S]+?)\n```/g)]
    .map(m => m[1].trim()).join('\n');

  const creationsNote = plannedCreations.size
    ? `\nTracks that the plan will CREATE (do not flag these as missing): ${[...plannedCreations].join(', ')}`
    : '';

  const prompt = `A producer confirmed an action plan for Ableton Live. Before executing, check whether the current session state is compatible with the plan.

User request: "${userMessage}"

Actions to execute:
${remainingBlocks}

Current session tracks (freshly read from Live):
${currentTracks}${creationsNote}

Check if any track names in the actions don't exist in the current session and cannot be inferred. Tracks listed under "will CREATE" are intentionally absent — the plan creates them. Only flag genuine ambiguities — not cosmetic name differences or cases where the intent is obvious.

Reply with EXACTLY one of these JSON formats:
- If all looks fine or you can silently fix it: {"status":"ok"}
- If something truly cannot be resolved without user input: {"status":"needs_clarification","message":"<concise message explaining what's missing and what you need>"}

Return raw JSON only, no markdown.`;

  const result = await chat({
    apiKey:   modelConfig.apiKey,
    baseURL:  modelConfig.endpoint,
    modelId:  modelConfig.modelId,
    messages: [{ role: 'user', content: prompt }],
    systemPrompt: 'You are a precise JSON-only responder. Check Ableton Live action plans against current session state. Be conservative — only flag real blockers. Return only valid JSON.',
    maxTokens: 300,
  });

  if (result.error || !result.text) return remaps.length ? { status: 'adjusted', revisedReply } : { status: 'ok' };

  try {
    const clean  = result.text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(clean);
    if (!['ok', 'needs_clarification'].includes(parsed.status)) return { status: 'ok' };
    if (parsed.status === 'needs_clarification') {
      console.log(`[chat] Plan review — needs clarification: ${parsed.message}`);
    }
    // If LLM says ok but we had remaps, still return the adjusted reply
    if (parsed.status === 'ok' && remaps.length) return { status: 'adjusted', revisedReply };
    return parsed;
  } catch {
    return remaps.length ? { status: 'adjusted', revisedReply } : { status: 'ok' };
  }
}

async function _executeConfirmedActions({ llmReply, planText, ws, config, sendToBridge, send, userMessage, project, convId, proposedAt }) {
  // ── Pre-execution review ───────────────────────────────────────────────────
  // Re-fetch Tier 1 only if enough time has passed since the plan was proposed.
  // If the user confirmed immediately (same turn), the session hasn't changed —
  // skip the re-read and review entirely to avoid redundant LLM calls.
  const REVIEW_STALENESS_MS = 30_000; // 30 seconds
  const age = proposedAt ? (Date.now() - proposedAt) : Infinity;
  const needsReview = isDetected() && age > REVIEW_STALENESS_MS;

  let activeReply = llmReply;
  if (needsReview) {
    send(ws, { type: 'status', text: 'Checking session before executing...' });
    try {
      const freshTier1 = await fetchSession();
      const review = await _reviewPlanBeforeExecution({
        llmReply, planText, userMessage, freshTier1, modelConfig: config.model,
      });
      if (review.status === 'needs_clarification') {
        // Can't proceed — tell the user what's blocking
        const msg = review.message;
        appendChat(project, convId, 'assistant', msg);
        flushChat(project, convId);
        send(ws, { type: 'chat', role: 'assistant', text: msg });
        return;
      }
      if (review.status === 'adjusted') {
        console.log('[chat] Plan adjusted by pre-execution review.');
        activeReply = review.revisedReply;
      }
      // status === 'ok': proceed with original plan
    } catch (e) {
      console.warn('[chat] Pre-execution review failed (non-fatal), proceeding:', e.message);
    }
  }

  const actionBlockMatches = [...activeReply.matchAll(/```action\n([\s\S]+?)\n```/g)];
  let actions = actionBlockMatches.map(m => {
    const body  = m[1].trim();
    const parts = body.includes('|') ? body.split('|').map(s => s.trim()) : body.split(/\s+/);
    return { command: parts[0], args: parts.slice(1).join(' | '), raw: body };
  });

  send(ws, { type: 'action_started', actions: actions.map(a => ({ command: a.command, args: a.args, success: null })) });

  const sendStatus    = (text) => send(ws, { type: 'status', text });
  const actionResults = await executeActions(activeReply, sendToBridge, sendStatus, config.model);

  if (actionResults?.length) {
    actions = actionResults.map((r, i) => ({
      command: r.command || actions[i]?.command || 'unknown',
      args:    r.args    || actions[i]?.args    || '',
      raw:     r.raw     || actions[i]?.raw     || '',
      ...r,
    }));
  }

  send(ws, {
    type: 'action_complete',
    verification: {
      actions: actions.map(a => ({
        command: a.command, args: a.args,
        success: a.success ?? null, error: a.error || null,
        skipped: !!a.skipped,
        verified: a.verified ?? null, verifiedDisplay: a.verifiedDisplay || null,
        warning: a.warning || null, mismatch: !!a.mismatch,
        note: a.note || null, retried: !!a.retried,
        firstError: a.firstError || null, correctedAction: a.correctedAction || null,
        retryAction: a.retryAction || null, retryError: a.retryError || null,
        retrySkipped: !!a.retrySkipped,
      })),
    },
  });

  const resultLines = _formatResultLines(actions);
  const anyFailed   = actions.some(a => a.success === false && !a.skipped);
  const anySkipped  = actions.some(a => a.skipped);
  const anyRetried  = actions.some(a => a.retried);
  const anyMismatch = actions.some(a => a.warning || a.mismatch);

  send(ws, { type: 'status', text: 'Wrapping up...' });

  const wrapUpPrompt = (anyFailed || anySkipped || anyMismatch)
    ? `Actions executed in order:\n${resultLines.join('\n')}\n\n⊘ means the action was skipped because a prior structural failure made it unsafe to continue. ✗ means the action was attempted and failed. Reason causally across the numbered sequence — explain the root failure and what it caused to cascade. Wrap up for the producer: what succeeded, what failed and why, what was skipped as a result, and one concrete next step. Be direct, 3-5 sentences.`
    : `Actions executed in order:\n${resultLines.join('\n')}\n\nBriefly wrap up for the producer — what succeeded${anyRetried ? ' (mention any self-corrections)' : ''} and what to do next. 2-3 sentences, no fluff.`;

  const followUp = await chat({
    apiKey:      config.model.apiKey,
    baseURL:     config.model.endpoint,
    modelId:     config.model.modelId,
    messages:    [
      { role: 'user',      content: userMessage },
      { role: 'assistant', content: planText },
      { role: 'user',      content: wrapUpPrompt },
    ],
    systemPrompt: 'You are Addie, an AI assistant for Ableton Live. Be direct and honest. When actions failed, reflect on what went wrong and offer practical alternatives.',
    maxTokens:    400,
  });

  const wrapUp = followUp.error ? null : followUp.text.trim();
  if (wrapUp) {
    appendChat(project, convId, 'assistant', wrapUp);
    flushChat(project, convId);
    send(ws, { type: 'chat', role: 'assistant', text: wrapUp });
  } else {
    flushChat(project, convId);
  }
  

  // Async preference extraction — fire and forget, never blocks the wrap-up
  const replyForPrefExtraction = wrapUp || planText;
  extractPreferences(userMessage, replyForPrefExtraction, config.model).catch(() => {});
}

// ── Sync helpers — called by server.js on conversation/project switches ───────

/**
 * Run a full session sync: Tier 1 + browser + full snapshot.
 * Updates session.md with the fresh structural data.
 * Idempotent — safe to call even if already synced.
 */
async function _doSync(project) {
  const tier1    = await fetchSession();
  await fetchBrowser();
  const snapshot = await _snapshot();
  _conversationReady = true;
  console.log('[chat] Conversation sync complete.');

  // Update session.md with fresh structural data (no LLM needed)
  try {
    const updated = updateSessionFromSync(project, tier1, snapshot);
    if (updated) console.log('[chat] session.md updated from sync.');
  } catch (e) {
    console.warn('[chat] session.md update failed (non-fatal):', e.message);
  }
}

/**
 * Called by server.js when the active project changes.
 * Clears all caches so the next handleChat() triggers a fresh sync.
 * Does NOT do any eager sync — sync is always lazy on first message.
 *
 * @param {string} project
 */
async function initConversation(project) {
  resetAll();
  _syncedProject = null;
  console.log('[chat] Project changed — caches cleared, sync deferred to first message.');
}

/**
 * Reset sync state when the bridge goes down.
 * Next message will re-sync once the bridge reconnects.
 */
function resetConversation() {
  _syncedProject = null;
}

module.exports = { handleChat, confirmActions, cancelActions, initConversation, resetConversation };
