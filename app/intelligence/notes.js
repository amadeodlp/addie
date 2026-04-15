'use strict';

const context = require('../state/context');
const llm     = require('../services/llm');

const NOTES_FILENAME = 'addie-notes.md';
const MIN_WORDS      = 80;

const SYSTEM_PROMPT = [
  'You are maintaining a project knowledge file for a music producer working in Ableton Live.',
  '',
  'You will receive:',
  '1. A conversation log between the producer and Addie (an AI assistant)',
  '2. The current project notes (may be empty or a placeholder)',
  '',
  'Your job: produce an updated version of the project notes capturing durable knowledge from this conversation.',
  '',
  'WHAT TO CAPTURE:',
  '- Musical direction and creative intent',
  '- Confirmed decisions about the project',
  '- Constraints the producer stated explicitly',
  '- Workflow context specific to this project',
  '- Corrections the producer made to Addie suggestions',
  '- Plugin or sound choices confirmed for specific tracks',
  '',
  'WHAT NOT TO CAPTURE:',
  '- Specific parameter values (they change constantly)',
  '- Mixer levels, volumes, pan positions',
  '- Anything prefixed with "for now" or clearly temporary',
  '- Session structure details (stale immediately)',
  '',
  'CONSOLIDATION RULES:',
  '- If current notes contradict this conversation, the conversation wins',
  '- Remove outdated info, do not just append',
  '- Keep notes concise — bullet points, no long paragraphs',
  '- If nothing meaningful to capture, return the placeholder text unchanged',
  '- Write in the same language the producer used',
  '',
  'OUTPUT FORMAT: return ONLY the markdown content.',
  'No preamble, no explanation, no markdown code fences.',
  'First line must be: ## Notas del proyecto  (or ## Project notes if in English)',
  'Keep it under 400 words.',
].join('\n');

async function extractConversationNotes(project, convId, modelConfig) {
  const chatLog = context.readChatLog(project, convId);
  if (!chatLog || wordCount(chatLog) < MIN_WORDS) {
    console.log('[notes] Conversation ' + convId + ' too short, skipping.');
    return false;
  }

  const currentNotes = context.readKnowledge(project, NOTES_FILENAME) || '';
  const userContent  = 'CURRENT PROJECT NOTES:\n' + currentNotes + '\n\n---\n\nCONVERSATION LOG:\n' + chatLog;

  let raw;
  try {
    const result = await llm.chat({
      apiKey:       modelConfig.apiKey,
      baseURL:      modelConfig.endpoint,
      modelId:      modelConfig.modelId,
      messages:     [{ role: 'user', content: userContent }],
      systemPrompt: SYSTEM_PROMPT,
      maxTokens:    600,
    });
    if (result.error) {
      console.warn('[notes] LLM call failed:', result.text);
      return false;
    }
    raw = result.text.trim();
  } catch (e) {
    console.warn('[notes] Extraction error:', e.message);
    return false;
  }

  if (!raw || raw.length < 20) return false;

  const existing   = context.readKnowledge(project, NOTES_FILENAME) || '';
  const headerEnd  = existing.indexOf('\n\n');
  const header     = headerEnd !== -1 ? existing.slice(0, headerEnd) : existing;
  const newContent = header + '\n\n' + raw;

  context.writeKnowledge(project, NOTES_FILENAME, newContent);
  console.log('[notes] Project notes updated for "' + project + '" after conversation ' + convId + '.');
  return true;
}

function wordCount(str) {
  return str.trim().split(/\s+/).length;
}

module.exports = { extractConversationNotes, NOTES_FILENAME };
