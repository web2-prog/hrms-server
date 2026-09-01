const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function loginRateLimit(req, res, next) {
  const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(req.body?.email || '').toLowerCase()}`;
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (!entry || now - entry.start > WINDOW_MS) {
    loginAttempts.set(key, { start: now, count: 1 });
    return next();
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - entry.start)) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ message: 'Too many login attempts. Try again later.' });
  }

  entry.count += 1;
  return next();
}

function parseCorsOrigins(raw) {
  const parts = String(raw || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowAll = parts.includes('*');
  const origins = parts.filter((o) => o !== '*');
  return { allowAll, origins };
}

/** Local Vite / preview hosts — any port on localhost or 127.0.0.1. */
function isLocalDevOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * CORS policy:
 * - CORS_ORIGINS=* → allow any origin
 * - empty list in non-production → allow any origin (local DX)
 * - otherwise exact match, plus localhost/127.0.0.1 any port when NODE_ENV !== production
 * - denial uses callback(null, false) so Express does not throw a 500 stack
 */
export function corsOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  const { allowAll, origins } = parseCorsOrigins(process.env.CORS_ORIGINS);

  if (allowAll || (!origins.length && !isProd)) {
    return { origin: true, credentials: true };
  }

  return {
    origin(origin, callback) {
      // Non-browser clients (curl, server-to-server) send no Origin.
      if (!origin) return callback(null, true);
      if (origins.includes(origin)) return callback(null, true);
      if (!isProd && isLocalDevOrigin(origin)) return callback(null, true);

      console.warn(`CORS blocked origin: ${origin}`);
      return callback(null, false);
    },
    credentials: true,
  };
}

export function assertJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'change-me') {
    console.warn('WARNING: Set a strong JWT_SECRET in production.');
  }
}
