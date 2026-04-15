/**
 * reasoning.js — Pre-call that decides which tracks need fresh data.
 *
 * Sole responsibility: semantic track resolution.
 * Given the user's message and the Tier 1 track list, return which tracks are
 * being talked about — covering pronoun references, semantic descriptions, and
 * anything else regex can't catch.
 *
 * Everything else (browser, clips, automation) is now always fetched or
 * deterministically derived — no LLM needed to decide.
 *
 * Returns: { tracks: string[], need_action: boolean }
 */

const llm = require('../services/llm');

async function reason(userMessage, { session, recentMessages, ragContext }, modelConfig) {
  if (!session?.tracks?.length) {
    return {
      tracks: [],
      need_action: /\b(create|build|set up|make|add|load|new track|record|set tempo|let'?s)\b/i.test(userMessage),
      refresh: false,
    };
  }

  const trackList = session.tracks
    .map(t => `${t.name} (${t.type}${t.muted ? ', muted' : ''}${t.solo ? ', solo' : ''})`)
    .join(', ');

  const contextMessages = (recentMessages || []).slice(-6);

  // Summarise recent history as text in the system prompt so the model
  // can explicitly reason about which track the conversation has been about.
  const historyBlock = contextMessages.length
    ? '\nRecent conversation:\n' + contextMessages
        .map(m => `${m.role === 'user' ? 'Producer' : 'Addie'}: ${m.content.slice(0, 200)}`)
        .join('\n')
    : '';

  const systemPrompt = `You are a routing module for Addie, an AI assistant for Ableton Live.

Your only job: decide which tracks need their full device parameters read from Live right now.

Session tracks (use EXACT names in your response):
${trackList}
${historyBlock}
Respond with ONLY valid JSON, no other text:
{
  "tracks": [],
  "need_action": false,
  "refresh": false
}

TRACK IDENTIFICATION — this is your most important task:

Track names often have prefixes like "2-" or "3-Addie - ". Match loosely:
- "trilian" → matches "2-Addie - Trilian"
- "diva" → matches "3-Addie - Diva"  
- "drum rack" or "drums" → matches "1-Drum Rack"
- Any word that appears anywhere in a track name is a match

CONTEXT RESOLUTION — use the conversation history:
- If the conversation has been about a specific track and the new message continues that topic (even without naming the track), include that track
- Pronouns like "it", "that", "there" → resolve to the most recently discussed track
- "update trilian data" / "refresh trilian" / "update its data" → the track being referred to, need_action: false, refresh: true
- "let's work on X" → X track, refresh: true (we need current state before working)
- Mid-conversation follow-ups ("ok let's do it", "go ahead", "yes") → same track(s) as previous messages

REFRESH FLAG:
- true whenever: user says they made changes outside Addie, user asks to refresh/update/re-read, need_action is true and tracks is non-empty
- false only for pure read/analysis with no prior changes indicated

NEED_ACTION:
- true if message asks to change, set, load, delete, create, or modify anything in Live

Examples:
- "update trilian data" → tracks: ["2-Addie - Trilian"], need_action: false, refresh: true
- "let's find a good sound on trilian" → tracks: ["2-Addie - Trilian"], need_action: false, refresh: true
- "modify some params on it" (after talking about Trilian) → tracks: ["2-Addie - Trilian"], need_action: true, refresh: true
- "what's on the kick?" → tracks: ["1-Drum Rack"], need_action: false, refresh: false
- "set the threshold to -20" (after discussing Compressor on Bass) → tracks: ["Bass track name"], need_action: true, refresh: true
- "how's my gain staging?" → tracks: all tracks, need_action: false, refresh: false
- "set the tempo to 140" → tracks: [], need_action: true, refresh: false`;

  const messages = [{ role: 'user', content: userMessage }];

  const result = await llm.chat({
    apiKey:      modelConfig.apiKey,
    baseURL:     modelConfig.endpoint,
    modelId:     modelConfig.modelId,
    messages,
    systemPrompt,
    maxTokens:   120,
  });

  if (result.error) {
    console.warn('[reason] Pre-call failed:', result.text);
    return { tracks: [], need_action: false, refresh: false };
  }

  try {
    const cleaned = result.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed  = JSON.parse(cleaned);

    const validNames = new Set(session.tracks.map(t => t.name.toLowerCase()));
    const tracks = (parsed.tracks || []).filter(n => validNames.has(n.toLowerCase()));

    console.log('[reason]', JSON.stringify({ tracks, need_action: parsed.need_action, refresh: parsed.refresh }));
    return { tracks, need_action: !!parsed.need_action, refresh: !!parsed.refresh };
  } catch {
    console.warn('[reason] Could not parse response:', result.text);
    return { tracks: [], need_action: false };
  }
}

module.exports = { reason };
