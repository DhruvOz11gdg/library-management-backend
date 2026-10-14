'use strict';
/**
 * src/utils/logger.js
 * Same simple console + file pattern as the legacy server-bil logger.
 * Volume here is a jewellery storefront, not a bank: synchronous appends are
 * fine and guarantee a line is on disk before a crash takes the process down.
 *
 * Writes:  logs/app.log   (info, warn, error, http)
 *          logs/error.log (error only — this is the file to check first)
 */
const fs = require('fs');
const path = require('path');
const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs');
const APP_LOG = path.join(LOG_DIR, 'app.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const COLORS = {
  INFO: '\x1b[36m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  HTTP: '\x1b[35m',
  RESET: '\x1b[0m',
  DIM: '\x1b[2m',
};
let logDirReady = false;
function ensureLogDir() {
  if (logDirReady) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
    return true;
  } catch (err) {
    // A read-only filesystem must not take the API down — console still works.
    console.error(`[logger] cannot create ${LOG_DIR}: ${err.message}`);
    return false;
  }
}
/** Errors and plain objects are serialised; strings are passed through as-is. */
function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (meta instanceof Error) {
    return ` ${meta.stack || `${meta.name}: ${meta.message}`}`;
  }
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' [meta not serialisable]';
  }
}
function write(level, message, meta) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${formatMeta(meta)}`;
  const color = COLORS[level] || '';
  const isProd = process.env.NODE_ENV === 'production';
  const consoleLine = isProd ? line : `${color}[${level}]${COLORS.RESET} ${message}${COLORS.DIM}${formatMeta(meta)}${COLORS.RESET}`;
  if (level === 'ERROR') console.error(consoleLine);
  else if (level === 'WARN') console.warn(consoleLine);
  else console.log(consoleLine);
  if (!ensureLogDir()) return;
  try {
    fs.appendFileSync(APP_LOG, `${line}\n`);
    if (level === 'ERROR') fs.appendFileSync(ERROR_LOG, `${line}\n`);
  } catch (err) {
    console.error(`[logger] write failed: ${err.message}`);
  }
}
const logger = {
  info: (message, meta) => write('INFO', message, meta),
  warn: (message, meta) => write('WARN', message, meta),
  error: (message, meta) => write('ERROR', message, meta),
  /** One line per HTTP request, written by the request logger in server.js. */
  http: (message, meta) => write('HTTP', message, meta),
  /** Directory holding the log files — surfaced on boot so it is easy to find. */
  LOG_DIR,
};
module.exports = logger;
