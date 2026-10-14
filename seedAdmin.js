'use strict';
/**
 * alankar-backend/seedAdmin.js
 *
 *   node seedAdmin.js                    → create the first admin from .env
 *   node seedAdmin.js --reset-password   → set a new password for that email
 *
 * Reads ADMIN_EMAIL and ADMIN_PASSWORD from .env. There is no public register
 * endpoint by design; this script is the only way an admin account is created.
 *
 * Safe to re-run: an existing admin is never modified unless --reset-password
 * is passed (so a stray re-run cannot lock the owner out with an old .env value).
 */
require('dotenv').config();
const { connectDB, disconnectDB } = require('./src/config/db');
const { seedAdmin, MIN_PASSWORD_LENGTH } = require('./src/services/admin.service');
const { parseDurationToMs, getJwtExpiresIn } = require('./src/config/auth');
const logger = require('./src/utils/logger');
/** Thin wrapper so this file is both a CLI and a testable module. */
async function run({ resetPassword = false, email, password } = {}) {
  const result = await seedAdmin({ email, password, resetPassword });
  const lines = [];
  if (result.created) lines.push(`Admin created: ${result.admin.email}`);
  else if (result.reset) lines.push(`Password RESET for: ${result.admin.email}`);
  else lines.push(`Admin already exists: ${result.admin.email} (password unchanged)`);
  if (!result.reset) {
    lines.push('');
    lines.push('Sign in at POST /v1/admin/login with the ADMIN_EMAIL / ADMIN_PASSWORD values from .env.');
    lines.push(`Session length: ${getJwtExpiresIn()} (${Math.round(parseDurationToMs(getJwtExpiresIn()) / 3600000)}h)`);
  }
  lines.push('');
  lines.push('Recommended now that this has run:');
  lines.push('  1. change ADMIN_PASSWORD in .env to a new value you have not used elsewhere');
  lines.push('  2. keep ADMIN_EMAIL — it is the account you sign in with');
  lines.push('  3. never commit .env');
  logger.info(['', '─'.repeat(72), ...lines, '─'.repeat(72)].join('\n'));
  return result;
}
if (require.main === module) {
  (async () => {
    try {
      const resetPassword = process.argv.includes('--reset-password');
      await connectDB();
      await run({ resetPassword });
      await disconnectDB();
      process.exit(0);
    } catch (err) {
      // Configuration problems land here: one actionable line, no stack dump.
      logger.error(`seedAdmin failed: ${err.message}`);
      await disconnectDB().catch(() => {});
      process.exit(1);
    }
  })();
}
module.exports = { run, seedAdmin, MIN_PASSWORD_LENGTH };
