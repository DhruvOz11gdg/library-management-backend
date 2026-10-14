'use strict';
/**
 * src/config/imgbb.js
 * ImgBB configuration + boot-time sanity check (the replacement for the legacy
 * project's config/aws.js).
 *
 * Design note (decision D20): a missing IMGBB_API_KEY logs a loud warning at
 * boot instead of refusing to start. Reason: the API serves the storefront, and
 * a missing image key must not take the whole site down — only image upload is
 * disabled, and POST /v1/upload/product-image returns a 503 that says exactly
 * what to fix. The key is still validated before every upload attempt.
 */
const logger = require('../utils/logger');
const IMGBB_DEFAULT_API_URL = 'https://api.imgbb.com/1/upload';
/** The upload endpoint. Overridable so tests can point at a local stub. */
function getImgbbApiUrl() {
  return (process.env.IMGBB_API_URL || '').trim() || IMGBB_DEFAULT_API_URL;
}
function getImgbbApiKey() {
  return (process.env.IMGBB_API_KEY || '').trim();
}
function isImgbbConfigured() {
  return getImgbbApiKey().length > 0;
}
/**
 * Called once at boot from server.js.
 * @returns {{configured: boolean, apiUrl: string, usingStub: boolean}}
 */
function checkImgbbConfig() {
  const configured = isImgbbConfigured();
  const apiUrl = getImgbbApiUrl();
  const usingStub = apiUrl !== IMGBB_DEFAULT_API_URL;
  if (!configured) {
    logger.warn('IMGBB_API_KEY is not set — product image upload is DISABLED.');
    logger.warn('Get a free key at https://api.imgbb.com/ and add it to .env, then restart.');
  } else if (usingStub) {
    logger.warn(`IMGBB_API_URL is overridden → ${apiUrl} (non-production image host; testing only)`);
  } else {
    logger.info('ImgBB configured — product image upload enabled');
  }
  return { configured, apiUrl, usingStub };
}
module.exports = {
  IMGBB_DEFAULT_API_URL,
  getImgbbApiUrl,
  getImgbbApiKey,
  isImgbbConfigured,
  checkImgbbConfig,
};
