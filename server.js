'use strict';
/**
 * alankar-backend/server.js — process entry point.
 *
 * Responsibilities, in order:
 *   1. load .env
 *   2. build the Express app (CORS → parsers → request log → /v1 routes → 404 → error handler)
 *   3. connect to MongoDB
 *   4. listen
 *   5. shut down cleanly on SIGINT/SIGTERM
 *
 * Deliberately thin: no controllers, no models, no business logic in here.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { connectDB, disconnectDB } = require('./src/config/db');
const { checkImgbbConfig } = require('./src/config/imgbb');
const { checkAuthConfig } = require('./src/config/auth');
const routes = require('./src/routes');
const { notFoundHandler, errorHandler } = require('./src/middlewares/errorHandler.middleware');
const logger = require('./src/utils/logger');
const PORT = Number(process.env.PORT) || 5001;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const app = express();
// Correct req.ip behind a reverse proxy — matters for the rate limiter on
// POST /v1/orders/intent in Block 10.
app.set('trust proxy', 1);
app.disable('x-powered-by');
/* ---------------------------------------------------------------- *
 * CORS — the frontend sends the admin JWT as an httpOnly cookie
 * (Block 5), so credentials:true is required. Origin list comes from
 * CORS_ORIGIN in .env; an empty list means "allow any origin", which is
 * a development convenience and is logged as a warning on boot.
 * ---------------------------------------------------------------- */
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header: curl, Postman, server-to-server, same-origin.
      if (!origin) return callback(null, true);
      if (corsOrigins.length === 0 || corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
/* One log line per request, written after the response finishes. */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.http(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  next();
});
/* ---- API ---- */
app.use('/v1', routes);
/* ---- 404 + central error handler, always last ---- */
app.use(notFoundHandler);
app.use(errorHandler);
/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */
async function start() {
  // Config sanity check: warns loudly, never refuses to boot (decision D20 —
  // a missing image API key must not take the storefront down).
  checkImgbbConfig();
  const authConfig = checkAuthConfig();
  if (!authConfig.configured) {
    logger.warn('JWT_SECRET is not set — admin login will fail until you add it to .env and restart.');
    logger.warn('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  } else {
    logger.info(`Admin auth configured — sessions last ${authConfig.expiresIn}`);
  }
  await connectDB();
  const server = app.listen(PORT, HOST, () => {
    logger.info(`alankar-backend listening on http://${HOST}:${PORT}  [${NODE_ENV}]  logs → ${logger.LOG_DIR}`);
    logger.info(`API base path: /v1`);
    if (corsOrigins.length === 0) {
      logger.warn('CORS_ORIGIN is empty — allowing any origin. Set it before going to production.');
    } else {
      logger.info(`CORS allowed origins: ${corsOrigins.join(', ')}`);
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} is already in use. Stop the other process or set a different PORT in .env.`);
    } else {
      logger.error('HTTP server error', err);
    }
    process.exit(1);
  });
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down cleanly`);
    server.close(async () => {
      try {
        await disconnectDB();
      } catch (err) {
        logger.error('Error while disconnecting from MongoDB', err);
      }
      logger.info('Shutdown complete');
      process.exit(0);
    });
    // Do not hang forever waiting for in-flight connections.
    setTimeout(() => {
      logger.warn('Forced exit after 10s shutdown timeout');
      process.exit(1);
    }, 10000).unref();
  };
  ['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));
  return server;
}
/* A bug that escapes every handler should be logged loudly, not swallowed. */
process.on('unhandledRejection', (reason) => {
  logger.error('UNHANDLED PROMISE REJECTION — this is a bug, fix it', reason instanceof Error ? reason : { reason });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION — this is a bug, fix it', err);
  process.exit(1);
});
if (require.main === module) {
  start().catch((err) => {
    // Configuration/database problems land here: one clear line, then stop.
    logger.error('Startup aborted.', err);
    process.exit(1);
  });
}
module.exports = { app, start };
