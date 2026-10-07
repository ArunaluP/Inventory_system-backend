// Small in-memory rate limiter (fixed one-minute window per client IP), no extra dependency.
// Writes (POST / PUT) and reads (GET) have separate budgets; over the limit → 429 + Retry-After.
// Limits come from .env: RATE_LIMIT_WRITES_PER_MIN (default 120), RATE_LIMIT_READS_PER_MIN (600).
// Behind a reverse proxy set TRUST_PROXY so req.ip is the visitor's address, not the proxy's.

const WINDOW_MS = 60 * 1000;

const createRateLimiter = ({ writesPerMinute, readsPerMinute }) => {
  const hits = new Map(); // key -> { count, resetAt }

  // Drop expired windows so the map can't grow without bound
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, WINDOW_MS).unref();

  return (req, res, next) => {
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (req.method === 'OPTIONS') return next();
    const limit = isWrite ? writesPerMinute : readsPerMinute;
    const key = `${isWrite ? 'w' : 'r'}|${req.ip}`;
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ success: false, message: 'Too many requests. Please wait a moment and try again.' });
    }
    return next();
  };
};

module.exports = { createRateLimiter };
