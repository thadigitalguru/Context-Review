const { encodingForModel, getEncoding } = require('js-tiktoken');

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
      text,
      label: options.label || 'generic',
    };
  }

  return {
    tokens: Math.ceil(text.length / 3.5),
    characters: text.length,
    method: 'heuristic_chars',
    confidence: 'low',
    text,
    label: options.label || 'generic',
  };
}

function exactTokenCount(text, model) {
  const normalizedModel = String(model || '').toLowerCase();
  const encodingName = resolveEncoding(normalizedModel);
  if (!encodingName) return null;

  try {
    const encoding = encodingName === 'model'
      ? encodingForModel(model)
      : getEncoding(encodingName);
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

module.exports = { countTokens, stringifyValue };
