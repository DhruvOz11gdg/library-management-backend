'use strict';
/**
 * alankar-backend/startWithDemoDb.js  —  `npm run dev:demo`
 *
 * Zero-install way to run the FULL platform: starts an ephemeral MongoDB
 * (mongodb-memory-server, a devDependency) with a persistent data directory
 * (.mongo-data/, gitignored), seeds categories + admin + demo products, then
 * boots the real server.js unchanged.
 *
 * Why this exists:
 *  - lets the owner (and any agent sandbox) see the storefront + admin panel
 *    working end-to-end BEFORE installing MongoDB or creating an Atlas cluster
 *  - data survives restarts (same .mongo-data directory), so products added
 *    through the admin panel are still there next run
 *
 * For production this file is irrelevant: set MONGODB_URI in .env to a real
 * MongoDB and use `npm start` / `npm run dev`.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const logger = require('./src/utils/logger');
const DEMO_DB_DIR = path.join(__dirname, '.mongo-data');
async function main() {
  fs.mkdirSync(DEMO_DB_DIR, { recursive: true });
  logger.info('DEMO MODE — starting in-memory MongoDB with persistent data dir .mongo-data/');
  const mongod = await MongoMemoryServer.create({
    instance: { dbName: 'alankar', dbPath: DEMO_DB_DIR, storageEngine: 'wiredTiger' },
  });
  // Point the untouched server.js at the demo database before it loads .env-driven config.
  process.env.MONGODB_URI = mongod.getUri('alankar');
  // Seed everything the storefront needs to look alive (all idempotent).
  const { seedCategories } = require('./seedCategories');
  const { seedAdmin } = require('./src/services/admin.service');
  const { seedDemoProducts } = require('./seedDemoProducts');
  const { connectDB } = require('./src/config/db');
  await connectDB();
  await seedCategories({ quiet: true });
  try {
    const admin = await seedAdmin({});
    logger.info(
      admin.created
        ? `Demo admin created: ${process.env.ADMIN_EMAIL} (password from .env ADMIN_PASSWORD)`
        : `Demo admin ready: ${admin.admin.email} (password unchanged)`
    );
  } catch (err) {
    logger.warn(`Admin seeding skipped: ${err.message}`);
    logger.warn('Set ADMIN_EMAIL + ADMIN_PASSWORD (8+ chars) in .env, then restart dev:demo.');
  }
  await seedDemoProducts({ quiet: true });
  logger.info('DEMO MODE — seeds complete');
  // Boot the real server (reads process.env.MONGODB_URI set above).
  const { start } = require('./server');
  await start();
  const shutdown = async (signal) => {
    logger.info(`${signal} received in demo mode — stopping mongod`);
    try {
      await mongod.stop();
    } catch (err) {
      logger.warn(`mongod stop warning: ${err.message}`);
    }
    process.exit(0);
  };
  // server.js already registers SIGINT/SIGTERM handlers for the HTTP server;
  // these run additionally to stop the demo mongod (exit happens above).
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch((err) => {
  logger.error('Demo boot failed', err);
  process.exit(1);
});
