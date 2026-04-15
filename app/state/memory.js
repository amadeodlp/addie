/**
 * memory.js — Producer preference learning.
 *
 * Observes patterns across sessions and writes learnings to producer.md.
 * Fully deterministic — no LLM calls here. The LLM reads the output.
 */

const context = require('./context');

// In-session observation log (resets each session)
const observations = [];

function observe(type, data) {
  observations.push({ type, data, ts: Date.now() });
  maybeLearn();
}

// Called after certain thresholds to crystallize learnings
function maybeLearn() {
  // Template detection: if session has >8 tracks, routing + buses = template candidate
  const templateObs = observations.filter(o => o.type === 'session_synced');
  if (templateObs.length > 0) {
    const latest = templateObs[templateObs.length - 1].data;
    if (isTemplateLike(latest)) {
      // Use the project name carried in the observation if available
      const project = latest._project || 'default';
      context.appendTemplate(project, summarizeTemplate(latest));
    }
  }
}

function recordPreference(key, value, projectName = 'default') {
  const entry = `\n- **${key}**: ${value} _(observed ${new Date().toLocaleDateString()})_`;
  context.appendProducerMemory(entry);
}

function isTemplateLike(sessionState) {
  if (!sessionState?.tracks) return false;
  const hasBus = sessionState.tracks.some(t => /bus|group/i.test(t.name || ''));
  const hasMaster = sessionState.tracks.some(t => /master/i.test(t.name || ''));
  return hasBus && hasMaster && sessionState.tracks.length >= 6;
}

function summarizeTemplate(sessionState) {
  return {
    trackCount: sessionState.tracks?.length,
    tempo: sessionState.tempo,
    structure: sessionState.tracks?.map(t => ({
      name: t.name,
      role: t._annotation,
      deviceCount: t.devices?.length || 0,
    })),
  };
}

module.exports = { observe, recordPreference };
