const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
// Load .env from this folder (not the process's working directory, which iisnode may set
// elsewhere). dotenv never overrides variables that are already set, so iisnode's PORT wins.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const db = require('./config/db');
const materialRoutes = require('./routes/materialRoutes');
const templateRoutes = require('./routes/templateRoutes');
const currencyRoutes = require('./routes/currencyRoutes');
const supplierRoutes = require('./routes/supplierRoutes');
const { isProduction, sendServerError } = require('./utils/http');
const { createRateLimiter } = require('./utils/rateLimit');

const app = express();
app.disable('x-powered-by');

// Production: the built React app lives in ./client (created by deploy/build-smarterasp.js) and is
// served by this same server, so the frontend calls /api on the same domain. In development the
// folder doesn't exist and Vite serves the frontend instead.
const clientDir = path.join(__dirname, 'client');
const clientIndex = path.join(clientDir, 'index.html');
const serveClient = fs.existsSync(clientIndex);

// Behind Nginx / a load balancer, set TRUST_PROXY (e.g. 1 = one proxy hop) so client IPs are
// read from X-Forwarded-For; without a proxy leave it unset.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

// CORS: only the frontend may call the API from a browser. Set CORS_ORIGINS in .env as a
// comma-separated list when the frontend runs elsewhere (defaults to the Vite dev server).
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  // Requests without an Origin header (curl, server-to-server) aren't browser cross-site calls
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
  methods: ['GET', 'POST', 'PUT']
}));

// Security headers for every response (static files, the app page and the API)
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
};

// Static frontend files — mounted before the rate limiter and before no-store, so assets are
// never throttled and Vite's hashed files in /assets can be cached for a year.
if (serveClient) {
  app.use(express.static(clientDir, {
    index: false, // "/" is answered by the app-page fallback below (with no-cache)
    setHeaders: (res, filePath) => {
      res.set(securityHeaders);
      const inAssets = path.relative(clientDir, filePath).split(path.sep)[0] === 'assets';
      res.set('Cache-Control', inAssets ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
  }));
}

// Hardening headers for API responses; no-store keeps pricing data out of browser and
// proxy caches
app.use((req, res, next) => {
  res.set({ ...securityHeaders, 'Cache-Control': 'no-store' });
  next();
});

// Throttle each client so one visitor can't flood the API (see utils/rateLimit.js)
app.use(createRateLimiter({
  writesPerMinute: Number(process.env.RATE_LIMIT_WRITES_PER_MIN) || 120,
  readsPerMinute: Number(process.env.RATE_LIMIT_READS_PER_MIN) || 600
}));

// Larger limit so bulk Excel imports fit in one request
app.use(express.json({ limit: '5mb' }));

// API Endpoints
// Development only (no built client): a simple banner on "/". In production "/" is the app.
if (!serveClient) {
  app.get('/', (req, res) => {
    res.send('🚀 Inventory & Template System API is active!');
  });
}

// Health check: is the API up and can it reach the database? (cheap SELECT 1)
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ success: true, status: 'ok', database: 'ok' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Health check: database unreachable:`, error.message);
    res.status(503).json({ success: false, status: 'degraded', database: 'unreachable' });
  }
});

app.use('/api/materials', materialRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/currencies', currencyRoutes);
app.use('/api/suppliers', supplierRoutes);

// Unknown /api routes: JSON 404. Any other GET (a page address such as /templates/5, or a
// refresh on a deep link) gets the app page so the React app can handle it.
// (A final middleware instead of a route pattern: '*' / '/*' are not valid in Express 5.)
app.use((req, res) => {
  const isApi = req.path === '/api' || req.path.startsWith('/api/');
  if (serveClient && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
    res.set({ ...securityHeaders, 'Cache-Control': 'no-cache' });
    return res.sendFile(clientIndex);
  }
  res.status(404).json({ success: false, message: 'Not found' });
});

// Last-resort error handler: malformed JSON / oversized bodies get a clear 4xx, anything
// else a 500 that never exposes stack traces or database details in production
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Request body is not valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request is too large.' });
  }
  sendServerError(res, 'Unexpected server error', err);
});

// Start Server
// PORT is used exactly as given: a number locally, or a named pipe (e.g. \\.\pipe\…) when IIS
// runs the app through iisnode — never parse it as a number.
const PORT = process.env.PORT || 5000;
const isPipe = typeof PORT === 'string' && !/^\d+$/.test(PORT);
// HOST=127.0.0.1 behind Nginx so the API is only reachable through the web server. Ignored for
// a named pipe (iisnode), where a host makes no sense.
const HOST = isPipe ? undefined : (process.env.HOST || undefined);
const httpServer = app.listen(PORT, HOST, async () => {
  console.log(`========================================`);
  console.log(`🚀 Server running on ${isPipe ? `pipe ${PORT}` : `http://${HOST || 'localhost'}:${PORT}`} (${isProduction ? 'production' : 'development'})`);
  console.log(`🖥️  Frontend: ${serveClient ? `served from ${clientDir}` : 'not bundled (development: use Vite)'}`);
  console.log(`🔒 CORS allowed origins: ${allowedOrigins.join(', ')}`);

  try {
    const connection = await db.getConnection();
    console.log(`✅ MySQL Database connected successfully!`);
    connection.release();
  } catch (err) {
    // Never crash on a database problem at startup: the app keeps running and /api/health reports it
    console.error(`❌ Database connection failed:`, err.message);
  }
  console.log(`========================================`);
});

// Log unexpected async failures instead of crashing silently
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason);
});

// Graceful shutdown (process managers send SIGTERM / SIGINT): finish requests, close DB pool
const shutdown = (signal) => {
  console.log(`${signal} received — shutting down`);
  httpServer.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
