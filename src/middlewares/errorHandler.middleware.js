'use strict';
/**
 * src/middlewares/errorHandler.middleware.js
 * The only place that formats an error response. Mounted last in server.js,
 * after every route, so a controller can simply `throw` or call next(err).
 *
 * Contract (same envelope as a success, with success:false):
 *   { success: false, message, data: null, errors: [] }
 * `stack` is attached for 5xx only, and only when NODE_ENV !== 'production'.
 */
const logger = require('../utils/logger');
const { ApiError } = require('../utils/apiResponse');
/** Turns any unmatched URL into a 404 that flows through the handler below. */
function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}
// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || err.status || 500;
  let message = err.message || 'Internal server error';
  let errors = Array.isArray(err.errors) ? err.errors : [];
  // --- Mongoose: schema validation failed ---
  if (err.name === 'ValidationError' && err.errors && !Array.isArray(err.errors)) {
    statusCode = 400;
    message = 'Validation failed';
    errors = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  }
  // --- Mongoose: malformed ObjectId / wrong type in a query or body ---
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for "${err.path}"`;
    errors = [{ field: err.path, value: err.value }];
  }
  // --- MongoDB: unique index violation (duplicate SKU / slug / email) ---
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `Duplicate value for "${field}"`;
    errors = [{ field, value: (err.keyValue || {})[field] }];
  }
  // --- JWT (Block 5 admin auth) ---
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid session token — please log in again';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Session expired — please log in again';
  }
  // --- multer (Block 3 image upload) ---
  if (err.name === 'MulterError') {
    statusCode = 400;
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Image is too large — the limit is 5MB per file'
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Too many images — the limit is 6 per product'
          : `Upload rejected: ${err.code}`;
  }
  // --- CORS: origin not in CORS_ORIGIN (thrown from server.js) ---
  if (typeof message === 'string' && message.startsWith('CORS blocked')) {
    statusCode = 403;
  }
  // --- Body parser: malformed JSON request body ---
  if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    message = 'Invalid JSON in request body';
  }
  const isServerError = statusCode >= 500;
  const where = `${req.method} ${req.originalUrl}`;
  if (isServerError) {
    logger.error(`${where} → ${statusCode} ${message}`, err);
  } else {
    logger.warn(`${where} → ${statusCode} ${message}`);
  }
  const body = { success: false, message, data: null, errors };
  if (isServerError && process.env.NODE_ENV !== 'production') {
    body.stack = err.stack;
  }
  res.status(statusCode).json(body);
}
module.exports = { notFoundHandler, errorHandler };
