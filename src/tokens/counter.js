const { encodingForModel, getEncoding } = require('js-tiktoken');

// Cache encoding instances: getEncoding() builds the full BPE rank table on
// every call, which is wasteful when counting per-item across large contexts.
const encodingCache = new Map();

// Texts beyond this size fall back to the heuristic to avoid blocking the
// event loop on a single encode() call.
const MAX_EXACT_COUNT_CHARS = 500_000;

function stringifyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function countTokens(value, options = {}) {
  const text = stringifyValue(value);
  if (!text) {
    return {
      tokens: 0,
      characters: 0,
      method: 'heuristic_chars',
      confidence: 'low',
      source: 'heuristic',
      text,
      label: options.label || 'generic',
    };
  }

  const exact = exactTokenCount(text, options.model);
  if (exact) {
    return {
      tokens: exact.tokens,
      characters: text.length,
      method: exact.method,
      confidence: 'high',
      source: 'tokenizer',
      text,
      label: options.label || 'generic',
    };
  }

  const heuristicMethod = text.length > MAX_EXACT_COUNT_CHARS ? 'heuristic_large_payload' : 'heuristic_chars';
  return {
    tokens: Math.ceil(text.length / 3.5),
    characters: text.length,
    method: heuristicMethod,
    confidence: 'low',
    source: 'heuristic',
    text,
    label: options.label || 'generic',
  };
}

function getCachedEncoding(encodingName, model) {
  const cacheKey = encodingName === 'model' ? `model:${model}` : encodingName;
  if (encodingCache.has(cacheKey)) return encodingCache.get(cacheKey);
  const encoding = encodingName === 'model'
    ? encodingForModel(model)
    : getEncoding(encodingName);
  encodingCache.set(cacheKey, encoding);
  return encoding;
}

function clearEncodingCache() {
  encodingCache.clear();
}

function exactTokenCount(text, model) {
  if (text.length > MAX_EXACT_COUNT_CHARS) return null;
  const normalizedModel = String(model || '').toLowerCase();
  const encodingName = resolveEncoding(normalizedModel);
  if (!encodingName) return null;

  try {
    const encoding = getCachedEncoding(encodingName, model);
    return {
      tokens: encoding.encode(text).length,
      method: encodingName === 'model' ? 'tiktoken_model' : `tiktoken_${encodingName}`,
    };
  } catch (err) {
    return null;
  }
}

function resolveEncoding(model) {
  if (!model) return null;
  if (model.includes('gpt-4o') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
    return 'o200k_base';
  }
  if (model.includes('gpt-4') || model.includes('gpt-3.5') || model.includes('text-embedding')) {
    return 'cl100k_base';
  }
  return null;
}

module.exports = { countTokens, stringifyValue, clearEncodingCache, MAX_EXACT_COUNT_CHARS };
