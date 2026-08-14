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

export function corsOptions() {
  const raw = process.env.CORS_ORIGINS || '';
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (!origins.length) {
    return { origin: true, credentials: true };
  }

  return {
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
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
