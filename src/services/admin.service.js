'use strict';
/**
 * src/services/admin.service.js
 * Login + first-admin seeding. Single-admin store, no role system.
 *
 * Security choices:
 *  - "Invalid email or password" is the SAME message for an unknown email and a
 *    wrong password, and a bcrypt comparison runs even when the admin does not
 *    exist, so response timing does not reveal which emails are real.
 *  - The first admin is created from .env by seedAdmin.js. Re-running it never
 *    silently resets an existing password; that needs --reset-password.
 */
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const AdminUser = require('../models/adminUser.model');
const { ApiError } = require('../utils/apiResponse');
const { getJwtSecret, getJwtExpiresIn } = require('../config/auth');
const logger = require('../utils/logger');
const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
/** Values that ship in .env.sample — seeding with one of these is a mistake. */
const PLACEHOLDER_PASSWORDS = [
  'change-me-before-first-seed',
  'choose-a-strong-password-here',
  'password',
  'password123',
  'admin',
  'admin123',
  '12345678',
];
/** A real bcrypt hash used to equalise timing when the email is unknown. */
const DUMMY_HASH = bcrypt.hashSync('timing-equalisation-only', SALT_ROUNDS);
/** Never includes passwordHash. */
function publicAdmin(admin) {
  return {
    id: String(admin._id),
    _id: String(admin._id),
    email: admin.email,
    name: admin.name || 'Store Admin',
    lastLoginAt: admin.lastLoginAt || null,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
  };
}
function assertCredentialsShape(email, password, { forSeed = false } = {}) {
  if (!email) throw ApiError.badRequest(forSeed ? 'ADMIN_EMAIL is not set in .env' : 'Email is required');
  if (!AdminUser.EMAIL_PATTERN.test(email)) {
    throw ApiError.badRequest(`"${email}" is not a valid email address`);
  }
  if (!password) throw ApiError.badRequest(forSeed ? 'ADMIN_PASSWORD is not set in .env' : 'Password is required');
  if (!forSeed || password === undefined) {
    // shape-only check for the seed path is done in seedAdmin()
  }
}
/** Creates the first admin, or resets an existing one's password on request. */
async function seedAdmin({ email, password, resetPassword = false } = {}) {
  const targetEmail = String(email || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const targetPassword = password === undefined ? process.env.ADMIN_PASSWORD : password;
  assertCredentialsShape(targetEmail, targetPassword, { forSeed: true });
  if (targetPassword.length < MIN_PASSWORD_LENGTH) {
    throw ApiError.badRequest(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (PLACEHOLDER_PASSWORDS.includes(String(targetPassword).toLowerCase())) {
    throw ApiError.badRequest(
      'ADMIN_PASSWORD is still the placeholder value from .env.sample. ' +
        'Pick a real password (at least 8 characters) that only you know — the panel is public-facing.'
    );
  }
  if (!process.env.JWT_SECRET || !process.env.JWT_SECRET.trim()) {
    logger.warn('JWT_SECRET is empty — admin login will fail until you set it in .env');
  }
  const existing = await AdminUser.findOne({ email: targetEmail }).select('+passwordHash');
  if (existing) {
    if (!resetPassword) {
      return { created: false, reset: false, admin: publicAdmin(existing) };
    }
    existing.passwordHash = await bcrypt.hash(targetPassword, SALT_ROUNDS);
    await existing.save();
    logger.warn(`admin password RESET for ${targetEmail}`);
    return { created: false, reset: true, admin: publicAdmin(existing) };
  }
  const created = await AdminUser.create({
    email: targetEmail,
    passwordHash: await bcrypt.hash(targetPassword, SALT_ROUNDS),
    name: 'Store Admin',
  });
  logger.info(`admin created: ${created.email}`);
  return { created: true, reset: false, admin: publicAdmin(created) };
}
/** @returns {Promise<{token: string, admin: object}>} */
async function login(email, password) {
  const targetEmail = String(email || '').trim().toLowerCase();
  const targetPassword = String(password || '');
  if (!targetEmail || !targetPassword) throw ApiError.badRequest('Email and password are required');
  const admin = await AdminUser.findOne({ email: targetEmail }).select('+passwordHash');
  // Equalise timing whether or not the account exists.
  const hashToCheck = admin ? admin.passwordHash : DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(targetPassword, hashToCheck);
  if (!admin || !passwordMatches) {
    logger.warn(`failed admin login for "${targetEmail}"`);
    throw ApiError.unauthorized('Invalid email or password');
  }
  const token = jwt.sign(
    { sub: String(admin._id), email: admin.email, role: 'admin' },
    getJwtSecret(),
    { expiresIn: getJwtExpiresIn() }
  );
  admin.lastLoginAt = new Date();
  await admin.save();
  logger.info(`admin logged in: ${admin.email}`);
  return { token, admin: publicAdmin(admin) };
}
async function getAdminById(id) {
  const admin = await AdminUser.findById(id);
  if (!admin) throw ApiError.unauthorized('That admin account no longer exists');
  return publicAdmin(admin);
}
async function countAdmins() {
  return AdminUser.countDocuments();
}
module.exports = { seedAdmin, login, getAdminById, countAdmins, publicAdmin, MIN_PASSWORD_LENGTH, PLACEHOLDER_PASSWORDS };
