const crypto = require('crypto');

const ROLE_ORDER = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

function createAuthMiddleware(options = {}) {
  const requireAuth = options.requireAuth !== undefined
    ? options.requireAuth
    : process.env.CONTEXT_REVIEW_REQUIRE_AUTH === '1';
  const apiKeys = normalizeApiKeys(options.apiKeys) || parseApiKeys(process.env.CONTEXT_REVIEW_API_KEYS);
  const jwtSecret = options.jwtSecret || process.env.CONTEXT_REVIEW_JWT_SECRET || '';

  return function authMiddleware(req, res, next) {
    const auth = resolveAuth(req, { apiKeys, jwtSecret });
    if (!auth.ok) {
      if (!requireAuth) {
        req.auth = null;
        return next();
      }
      return res.status(401).json({ error: auth.error || 'Unauthorized' });
    }
    req.auth = auth.context;
    next();
  };
}

function requireRole(minRole) {
  return function roleMiddleware(req, res, next) {
    if (!req.auth) return next();
    if (hasRole(req.auth.role, minRole)) return next();
    return res.status(403).json({ error: `Insufficient role: requires ${minRole}` });
  };
}

function hasRole(actual, required) {
  const current = ROLE_ORDER[String(actual || 'viewer')] || 0;
  const needed = ROLE_ORDER[String(required || 'viewer')] || 0;
  return current >= needed;
}

function resolveAuth(req, { apiKeys, jwtSecret }) {
  const authHeader = String(req.headers.authorization || '');
  const apiKeyHeader = String(req.headers['x-context-review-api-key'] || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';

  if (apiKeyHeader) {
    const context = apiKeys.get(apiKeyHeader);
    if (!context) return { ok: false, error: 'Invalid API key' };
    return { ok: true, context };
  }

  if (bearer) {
    if (!jwtSecret) return { ok: false, error: 'JWT auth is not configured' };
    const claims = verifyHS256JWT(bearer, jwtSecret);
    if (!claims) return { ok: false, error: 'Invalid JWT token' };
    return { ok: true, context: claimsToContext(claims) };
  }

  return { ok: false, error: 'Missing authentication credentials' };
}

function parseApiKeys(raw) {
  const map = new Map();
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw);
    for (const [key, value] of Object.entries(parsed || {})) {
      map.set(key, normalizeAuthContext(value || {}));
    }
  } catch (e) {
    console.error('Failed to parse CONTEXT_REVIEW_API_KEYS:', e.message);
  }
  return map;
}

function normalizeApiKeys(apiKeys) {
  if (!apiKeys) return null;
  const map = new Map();

  if (apiKeys instanceof Map) {
    for (const [key, value] of apiKeys.entries()) {
      map.set(String(key), normalizeAuthContext(value || {}));
    }
    return map;
  }

  if (typeof apiKeys === 'object') {
    for (const [key, value] of Object.entries(apiKeys)) {
      map.set(String(key), normalizeAuthContext(value || {}));
    }
    return map;
  }

  return null;
}

function claimsToContext(claims) {
  return normalizeAuthContext({
    tenant: claims.tenant || claims.tid,
    role: claims.role || claims.r || 'viewer',
    projects: claims.projects || claims.project_scope || [],
    users: claims.users || claims.user_scope || [],
    subject: claims.sub || '',
  });
}

function normalizeAuthContext(input) {
  return {
    tenant: String(input.tenant || 'default'),
    role: normalizeRole(input.role),
    projects: normalizeStringArray(input.projects),
    users: normalizeStringArray(input.users),
    subject: String(input.subject || ''),
  };
}

function normalizeRole(role) {
  const value = String(role || 'viewer').toLowerCase();
  if (value === 'admin' || value === 'editor' || value === 'viewer') return value;
  return 'viewer';
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

function verifyHS256JWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    const header = safeJson(base64UrlDecode(headerB64));
    if (!header || header.alg !== 'HS256') return null;

    const data = `${headerB64}.${payloadB64}`;
    const expected = base64UrlEncode(crypto.createHmac('sha256', secret).update(data).digest());
    const given = base64UrlEncode(base64UrlDecode(signatureB64));
    if (!timingSafeEqual(expected, given)) return null;

    const payload = safeJson(base64UrlDecode(payloadB64));
    if (!payload) return null;
    if (payload.exp && Date.now() / 1000 > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  createAuthMiddleware,
  requireRole,
  hasRole,
};
