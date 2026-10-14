'use strict';
/**
 * src/config/auth.js
 * JWT + admin-cookie configuration. Kept in one place because three layers need
 * to agree on it: admin.service (signs the token), adminAuth.middleware
 * (verifies it) and admin.controller (sets/clears the cookie).
 */
const { ApiError } = require('../utils/apiResponse');
/** The httpOnly cookie the admin panel authenticates with. */
const COOKIE_NAME = 'alankar_admin_token';
const DEFAULT_EXPIRES_IN = '7d';
function getJwtSecret() {
  const secret = (process.env.JWT_SECRET || '').trim();
  if (!secret) {
    throw new ApiError(
      500,
      'Server misconfiguration: JWT_SECRET is not set, so admin login cannot be issued. ' +
        'Run: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" and put the result in alankar-backend/.env, then restart.'
    );
  }
  return secret;
}
function isJwtConfigured() {
  return (process.env.JWT_SECRET || '').trim().length > 0;
}
function getJwtExpiresIn() {
  return (process.env.JWT_EXPIRES_IN || '').trim() || DEFAULT_EXPIRES_IN;
}
/** "7d" / "12h" / "30m" / "45s" → milliseconds. Falls back to 7 days. */
function parseDurationToMs(value) {
  const match = /^(\d+)\s*([smhd])?$/i.exec(String(value || '').trim());
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * multipliers[unit];
}
/**
 * Cookie options.
 *
 * `sameSite` matters when the API lives on a different registrable domain than
 * the storefront (e.g. backend on onrender.com, frontend on alankar.me): the
 * default Lax will not send the cookie cross-site and admin login would appear
 * to "not stick". In that case set COOKIE_SAMESITE=none (which browsers only
 * accept together with Secure, i.e. HTTPS).
 */
function getCookieOptions() {
  const sameSite = (process.env.COOKIE_SAMESITE || 'lax').trim().toLowerCase();
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true, // JavaScript in the browser can never read this token
    secure: isProduction || sameSite === 'none',
    sameSite: ['lax', 'strict', 'none'].includes(sameSite) ? sameSite : 'lax',
    maxAge: parseDurationToMs(getJwtExpiresIn()),
    path: '/',
  };
}
function checkAuthConfig() {
  if (!isJwtConfigured()) return { configured: false };
  return { configured: true, expiresIn: getJwtExpiresIn() };
}
module.exports = {
  COOKIE_NAME,
  DEFAULT_EXPIRES_IN,
  getJwtSecret,
  isJwtConfigured,
  getJwtExpiresIn,
  parseDurationToMs,
  getCookieOptions,
  checkAuthConfig,
};
