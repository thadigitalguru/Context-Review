const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'cookie',
  'set-cookie',
]);

const REDACTED_VALUE = '[REDACTED]';

function isSensitiveHeaderName(name) {
  const normalized = String(name || '').toLowerCase().trim();
  if (SENSITIVE_HEADER_NAMES.has(normalized)) return true;
  if (normalized.includes('api-key') || normalized.includes('apikey')) return true;
  if (normalized === 'x-context-review-api-key') return true;
  if (normalized.startsWith('x-context-review-') === false) {
    if (normalized.includes('secret') || normalized.includes('token') && normalized.includes('auth')) return true;
  }
  return false;
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveHeaderName(key)) {
      redacted[key] = REDACTED_VALUE;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function sanitizeCaptureHeaders(capture) {
  if (!capture || typeof capture !== 'object') return capture;
  if (capture.request && capture.request.headers) {
    return {
      ...capture,
      request: {
        ...capture.request,
        headers: redactHeaders(capture.request.headers),
      },
    };
  }
  return capture;
}

module.exports = {
  SENSITIVE_HEADER_NAMES,
  REDACTED_VALUE,
  isSensitiveHeaderName,
  redactHeaders,
  sanitizeCaptureHeaders,
};
