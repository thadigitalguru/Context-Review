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

  return {
    tokens: Math.ceil(text.length / 3.5),
    characters: text.length,
    method: 'heuristic_chars',
    confidence: 'low',
    text,
    label: options.label || 'generic',
  };
}

module.exports = { countTokens, stringifyValue };
