'use strict';
/**
 * src/config/db.js
 * Single Mongoose connection for the whole process (mirrors legacy config/db.js).
 *
 * A missing MONGODB_URI is a configuration mistake, not a crash: connectDB()
 * throws a message that tells you exactly what to do, and server.js turns that
 * into a clean boot-time failure with a readable log line.
 */
const mongoose = require('mongoose');
const logger = require('../utils/logger');
const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];
async function connectDB() {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Run `cp .env.sample .env` and paste your MongoDB Atlas ' +
        'connection string (Atlas → Connect → Drivers). See .env.sample for the step-by-step.'
    );
  }
  if (mongoose.connection.readyState === 1) {
    logger.warn('connectDB() called while already connected — reusing the existing connection');
    return mongoose.connection;
  }
  mongoose.set('strictQuery', true);
  mongoose.connection.on('connected', () => {
    logger.info(`MongoDB connected → ${mongoose.connection.name} @ ${mongoose.connection.host}`);
  });
  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', err);
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
  });
  return mongoose.connection;
}
/** Called from the graceful shutdown in server.js so Atlas sees a clean close. */
async function disconnectDB() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}
function dbStatus() {
  return READY_STATES[mongoose.connection.readyState] || 'unknown';
}
module.exports = { connectDB, disconnectDB, dbStatus };
