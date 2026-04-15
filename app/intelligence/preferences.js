/**
 * preferences.js — Automatic producer preference learning.
 *
 * Observes conversation turns for signals of producer preference and writes
 * confirmed learnings to producer.md via context.appendProducerMemory().
 *
 * Design principles:
 *   - Only fires when a cheap heuristic detects a preference signal in the
 *     user message. No LLM cost on 90% of turns.
 *   - Only writes high-confidence extractions. Medium/low confidence is
 *     discarded silently — no noise in producer.md.
 *   - Never overwrites. Always appends. User edits producer.md directly.
 *   - Deduplication: skips if producer.md already contains a very similar
 *     preference (string overlap check, no LLM needed).
 *   - Scope: GLOBAL preferences only (plugin choices, workflow habits).
 *     Project-specific or track-specific decisions are NOT written here.
 */

'use strict';

const context = require('../state/context');
const llm     = require('../services/llm');

// ─── HEURISTIC GATE ──────────────────────────────────────────────────────────
// Fast regex check on the user message. If no signal found, skip the LLM call
// entirely. Covers English and Spanish patterns.

const PREF_SIGNALS = /\b(prefer|prefiero|mejor|siempre (uso|usamos)|no (uses?|pongas?|cargues?|uses?)|usá|use instead|rather|en vez|instead of|not the|no el|no la|switch to|cambiar? a|always use|nunca uso|never use)\b/i;

function _hasPrefSignal(userMessage) {
  return PREF_SIGNALS.test(userMessage);
}

// ─── DEDUPLICATION ───────────────────────────────────────────────────────────
// Rough check: if any 5-word window from the new preference text already
// appears in producer.md, consider it a duplicate and skip.

function _isDuplicate(newText, existingMemory) {
  if (!existingMemory || !newText) return false;
  const words  = newText.toLowerCase().split(/\s+/);
  const corpus = existingMemory.toLowerCase();
  // Slide a 5-word window over the new preference text
  for (let i = 0; i <= words.length - 5; i++) {
    const phrase = words.slice(i, i + 5).join(' ');
    if (corpus.includes(phrase)) return true;
  }
  return false;
}


// ─── EXTRACTION PROMPT ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are analyzing a conversation turn between a music producer and Addie (an AI assistant for Ableton Live).
Your job: extract any GLOBAL producer preference revealed in this turn.

A global preference is a repeatable habit or tool choice that applies across projects:
  - Plugin/device choices ("I always use CLA-76 for vocals, not Pro-C 2")
  - Workflow preferences ("I prefer to use the native EQ over third-party ones")
  - Genre/style habits ("I always high-pass everything below 40 Hz")
  - Monitoring preferences, reference track habits, etc.

NOT a global preference:
  - A specific parameter value for a specific track ("set it to -18 dB")
  - A one-time creative decision ("use reverb on this pad")
  - Anything tied to a single project or track

Respond with ONLY valid JSON — no markdown, no explanation, no preamble.

If a clear global preference is present, respond:
{"preference": "<concise description of the preference>", "confidence": "high"}

If there is something that might be a preference but you are not sure, respond:
{"preference": null, "confidence": "low"}

If there is no global preference signal at all, respond:
{"preference": null, "confidence": "none"}

Rules:
- confidence must be "high", "low", or "none"
- preference must be a single sentence, max 120 characters
- Write in the same language the user used
- Never invent preferences not clearly stated or implied by the user`;


// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * Attempt to extract a producer preference from a conversation turn.
 * Fires an LLM call only when the heuristic gate detects a signal.
 * Writes to producer.md if confidence is high and not a duplicate.
 *
 * @param {string} userMessage       — the producer's message this turn
 * @param {string} assistantReply    — Addie's reply (plan text or wrap-up)
 * @param {object} modelConfig       — { apiKey, endpoint, modelId }
 * @returns {Promise<string|null>}   — the preference string if saved, else null
 */
async function extractPreferences(userMessage, assistantReply, modelConfig) {
  if (!userMessage || !_hasPrefSignal(userMessage)) return null;

  const userContent = `PRODUCER MESSAGE:\n${userMessage}\n\nADDIE REPLY:\n${assistantReply || '(no reply)'}`;

  let raw;
  try {
    const result = await llm.chat({
      apiKey:      modelConfig.apiKey,
      baseURL:     modelConfig.endpoint,
      modelId:     modelConfig.modelId,
      messages:    [{ role: 'user', content: userContent }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens:   120,
    });
    if (result.error) {
      console.warn('[preferences] LLM call failed:', result.text);
      return null;
    }
    raw = result.text.trim();
  } catch (e) {
    console.warn('[preferences] Extraction error:', e.message);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // LLM didn't return clean JSON — discard
    console.warn('[preferences] Could not parse JSON from extraction:', raw.slice(0, 80));
    return null;
  }

  if (parsed.confidence !== 'high' || !parsed.preference) return null;

  // Dedup check
  const existing = context.readProducerMemory();
  if (_isDuplicate(parsed.preference, existing)) {
    console.log('[preferences] Duplicate preference, skipping:', parsed.preference);
    return null;
  }

  const date  = new Date().toLocaleDateString();
  const entry = `\n- **Preference:** ${parsed.preference} _(learned ${date})_`;
  context.appendProducerMemory(entry);
  console.log('[preferences] Saved preference:', parsed.preference);
  return parsed.preference;
}

module.exports = { extractPreferences };
