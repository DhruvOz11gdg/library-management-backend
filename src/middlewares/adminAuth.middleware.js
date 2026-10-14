'use strict';
/**
 * src/middlewares/adminAuth.middleware.js
 * The one gate in front of every admin operation — the simplified, single-role
 * equivalent of the legacy project's authMiddleware.js.
 *
 * Accepts the JWT from either:
 *   1. the httpOnly cookie set by POST /v1/admin/login  (what the panel uses)
 *   2. an `Authorization: Bearer <token>` header         (curl, Postman, scripts)
 *
 * The admin row is re-read on every request, so removing the account or
 * changing the password invalidates existing sessions immediately rather than
 * waiting for the token to expire.
 */
const jwt = require('jsonwebtoken');
const AdminUser = require('../models/adminUser.model');
const { ApiError } = require('../utils/apiResponse');
const asyncHandler = require('../utils/asyncHandler');
const { COOKIE_NAME, getJwtSecret } = require('../config/auth');
const logger = require('../utils/logger');
function extractToken(req) {
  const fromCookie = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (fromCookie) return { token: fromCookie, source: 'cookie' };
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return { token: header.slice(7).trim(), source: 'header' };
  return { token: null, source: null };
}
const adminAuth = asyncHandler(async (req, res, next) => {
  const { token } = extractToken(req);
  if (!token) {
    throw ApiError.unauthorized('Admin login required. Sign in at /admin and try again.');
  }
  let payload;
  try {
    payload = jwt.verify(token, getJwtSecret());
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Your session expired — please sign in again.');
    }
    logger.warn(`rejected admin token: ${err.message}`);
    throw ApiError.unauthorized('Invalid session — please sign in again.');
  }
  const admin = await AdminUser.findById(payload.sub);
  if (!admin) throw ApiError.unauthorized('That admin account no longer exists.');
  req.admin = { id: String(admin._id), email: admin.email, name: admin.name };
  next();
});
module.exports = adminAuth;
module.exports.extractToken = extractToken;
