/**
 * llm.js — Smart LLM provider detection and connection.
 *
 * Priority:
 *   1. User provides API key → detect provider, pick best model
 *   2. User provides local base URL (Ollama etc.) → connect directly
 *   3. No config → try Ollama on localhost → try LM Studio → prompt user
 *
 * All providers speak the OpenAI-compatible chat completions API.
 */

const OpenAI = require('openai');

const PROVIDERS = [
  {
    name: 'Groq',
    detect: (key) => key.startsWith('gsk_'),
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    notes: 'Fast inference. Free tier has rate limits — for production, enable a paid plan at console.groq.com.',
  },
  {
    name: 'OpenAI',
    detect: (key) => key.startsWith('sk-') && !key.startsWith('sk-ant-'),
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    notes: 'gpt-4o-mini is cost-effective for production.',
  },
  {
    name: 'Anthropic',
    detect: (key) => key.startsWith('sk-ant-'),
    baseURL: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-haiku-4-5-20251001',
    notes: 'Anthropic API direct.',
  },
  {
    name: 'OpenRouter',
    detect: (key) => key.startsWith('sk-or-'),
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'mistralai/mixtral-8x7b-instruct',
    notes: 'Access to many models via one key.',
  },
  {
    name: 'Mistral',
    detect: (key) => key.length === 32 && /^[a-zA-Z0-9]+$/.test(key),
    baseURL: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-medium',
    notes: 'Mistral API.',
  },
];

const LOCAL_PROVIDERS = [
  {
    name: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    apiKey: 'ollama',
  },
  {
    name: 'LM Studio',
    baseURL: 'http://localhost:1234/v1',
    defaultModel: null,
    apiKey: 'lm-studio',
  },
];

// ─── DETECTION ────────────────────────────────────────────────────────────────

function detectProvider(apiKey, customBaseURL) {
  if (customBaseURL && (customBaseURL.includes('localhost') || customBaseURL.includes('127.0.0.1'))) {
    // Match local providers by port number regardless of hostname or trailing path
    const userPort = /:(\d+)/.exec(customBaseURL)?.[1];
    const local = LOCAL_PROVIDERS.find(p => {
      const providerPort = /:(\d+)/.exec(p.baseURL)?.[1];
      return userPort && providerPort && userPort === providerPort;
    });
    return local
      ? { ...local, baseURL: local.baseURL.replace('localhost', new URL(customBaseURL).hostname), isLocal: true }
      : { name: 'Custom Local', baseURL: customBaseURL, defaultModel: null, apiKey: apiKey || 'local', isLocal: true };
  }

  if (customBaseURL) {
    return { name: 'Custom Endpoint', baseURL: customBaseURL, defaultModel: null, apiKey: apiKey || '', isLocal: false };
  }

  if (apiKey) {
    const provider = PROVIDERS.find(p => p.detect(apiKey));
    if (provider) return { ...provider, apiKey, isLocal: false };
    return {
      name: 'Unknown Provider',
      baseURL: 'https://api.openai.com/v1',
      defaultModel: null,
      apiKey,
      isLocal: false,
      notes: 'Could not detect provider from key. Set modelId manually in config.json.',
    };
  }

  return null;
}

// ─── FALLBACK CHAIN ───────────────────────────────────────────────────────────

async function resolveFallback() {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (res.ok) {
      const data = await res.json();
      const model = data.models?.[0]?.name || 'llama3';
      console.log(`[llm] Fallback: Ollama detected with model "${model}"`);
      return { ...LOCAL_PROVIDERS[0], defaultModel: model, isLocal: true };
    }
  } catch { /* Ollama not running */ }

  try {
    const res = await fetch('http://localhost:1234/v1/models');
    if (res.ok) {
      console.log('[llm] Fallback: LM Studio detected');
      return { ...LOCAL_PROVIDERS[1], isLocal: true };
    }
  } catch { /* LM Studio not running */ }

  console.warn('[llm] No local model found and no API key configured.');
  return null;
}

// ─── CLIENT FACTORY ───────────────────────────────────────────────────────────

function buildClient(providerConfig) {
  return new OpenAI({
    apiKey: providerConfig.apiKey || 'no-key',
    baseURL: providerConfig.baseURL,
    defaultHeaders: (providerConfig.name === 'OpenRouter' || providerConfig.name === 'Anthropic')
      ? { 'HTTP-Referer': 'https://addie.app', 'X-Title': 'Addie' }
      : {},
  });
}

// ─── MODEL RESOLUTION ────────────────────────────────────────────────────────
//
// Resolution order:
//   1. Explicit modelId from user config — always wins, no API call needed
//   2. Provider's hardcoded defaultModel — use directly, no API call needed
//   3. Last resort: fetch /models and pick first chat-capable model
//      (only for local providers and custom endpoints with no default)
//
// We intentionally do NOT call models.list() for known remote providers
// (Groq, OpenAI, etc.) because their lists include non-chat models,
// experimental models, and models requiring terms acceptance that can
// get picked randomly — causing exactly the orpheus-style errors.

const _modelCache = {};

async function resolveModel(provider, preferredModelId) {
  // 1. Explicit user override — always trust it
  if (preferredModelId) return preferredModelId;

  // 2. For Ollama, query actual installed models instead of trusting hardcoded default
  if (provider.name === 'Ollama') {
    try {
      const host = provider.baseURL.replace('/v1', '');
      const res = await fetch(`${host}/api/tags`);
      if (res.ok) {
        const data = await res.json();
        const model = data.models?.[0]?.name;
        if (model) {
          console.log(`[llm] Ollama: detected installed model "${model}"`);
          return model;
        }
      }
    } catch { /* fall through to hardcoded default */ }
  }

  // 3. Hardcoded default — use directly, never hit the API
  if (provider.defaultModel) return provider.defaultModel;

  // 3. No default (custom local endpoint, LM Studio, etc.) — ask the API
  if (_modelCache[provider.name]) return _modelCache[provider.name];

  try {
    const client = buildClient(provider);
    const list   = await client.models.list();
    const models = list.data || [];
    if (models.length === 0) throw new Error('empty model list');

    const chatModels = models.filter(m => {
      const id = (m.id || '').toLowerCase();
      return !id.includes('embed') && !id.includes('tts') && !id.includes('whisper') && !id.includes('dall');
    });

    const picked = (chatModels[0] || models[0]).id;
    console.log(`[llm] ${provider.name} — auto-picked model: ${picked}`);
    _modelCache[provider.name] = picked;
    return picked;
  } catch (e) {
    console.warn(`[llm] Could not fetch model list for ${provider.name}: ${e.message}`);
    return 'gpt-4o-mini'; // last-resort fallback
  }
}

// ─── MAIN CALL ────────────────────────────────────────────────────────────────

async function chat({ apiKey, baseURL, modelId, messages, systemPrompt, maxTokens = 1024 }) {
  let provider = detectProvider(apiKey, baseURL);

  if (!provider) {
    provider = await resolveFallback();
  }

  if (!provider) {
    return {
      text: '⚠ No LLM configured. Open Settings and add an API key, or install Ollama (https://ollama.ai) for free local inference.',
      error: true,
    };
  }

  const client = buildClient(provider);
  const model  = await resolveModel(provider, modelId);

  console.log(`[llm] Using ${provider.name} / ${model}`);

  try {
    const allMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : [...messages];

    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: allMessages,
    });

    return {
      text:     response.choices[0].message.content,
      provider: provider.name,
      model,
      error:    false,
    };
  } catch (err) {
    const friendly = friendlyError(err, provider);
    console.error(`[llm] Error (${provider.name}):`, err.message);
    return { text: friendly, error: true, provider: provider.name };
  }
}

function friendlyError(err, provider) {
  const msg = err.message || '';
  if (msg.includes('401') || msg.includes('Unauthorized'))
    return `⚠ Invalid API key for ${provider.name}. Check your key in Settings.`;
  if (msg.includes('429') || msg.includes('rate'))
    return `⚠ Rate limit hit on ${provider.name}.${provider.name === 'Groq' ? ' Free tier is limited — consider upgrading at console.groq.com.' : ' Try again in a moment.'}`;
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch'))
    return `⚠ Cannot reach ${provider.name} at ${provider.baseURL}. Is the server running?`;
  if (msg.includes('terms'))
    return `⚠ Model requires terms acceptance on ${provider.name}. Go to console.groq.com and accept terms for the model, or set a specific modelId in Settings.`;
  return `⚠ LLM error (${provider.name}): ${msg}`;
}

// ─── SETTINGS INFO ────────────────────────────────────────────────────────────

function getProviderInfo(apiKey, baseURL) {
  const p = detectProvider(apiKey, baseURL);
  if (!p) return null;
  return { name: p.name, defaultModel: p.defaultModel, notes: p.notes || '', isLocal: p.isLocal || false };
}

module.exports = { chat, detectProvider, getProviderInfo, PROVIDERS, LOCAL_PROVIDERS };
