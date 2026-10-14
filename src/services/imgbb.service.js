'use strict';
/**
 * src/services/imgbb.service.js
 * Minimal ImgBB client — the drop-in replacement for the legacy S3 uploader.
 *
 * The API key never leaves this process. Every failure mode is translated into
 * an ApiError with a message the store owner can act on, because the admin
 * panel shows this text verbatim when an upload fails mid-session.
 */
const axios = require('axios');
const FormData = require('form-data');
const { getImgbbApiUrl, getImgbbApiKey, isImgbbConfigured } = require('../config/imgbb');
const { ApiError } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const UPLOAD_TIMEOUT_MS = 30000;
/** ImgBB's own error payloads vary; pull the most useful string out of them. */
function extractImgbbErrorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload.slice(0, 200);
  return (
    (payload.error && (payload.error.message || payload.error)) ||
    payload.status_txt ||
    payload.message ||
    null
  );
}
/**
 * Upload one image buffer to ImgBB.
 * @param {Buffer} fileBuffer image bytes (already compressed)
 * @param {string} [filename] human-readable name shown in the ImgBB account
 * @returns {Promise<{url: string, thumbUrl: string, deleteUrl: string|null, size: number|null, width: number|null, height: number|null, imgbbId: string|null}>}
 */
async function uploadToImgbb(fileBuffer, filename) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw ApiError.badRequest('Nothing to upload — the image buffer is empty');
  }
  if (!isImgbbConfigured()) {
    throw new ApiError(
      503,
      'Image upload is not configured on the server: IMGBB_API_KEY is missing. ' +
        'Add it to alankar-backend/.env (free key from https://api.imgbb.com/) and restart the API.'
    );
  }
  const form = new FormData();
  form.append('image', fileBuffer.toString('base64'));
  if (filename) form.append('name', filename);
  let response;
  try {
    response = await axios.post(`${getImgbbApiUrl()}?key=${getImgbbApiKey()}`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: UPLOAD_TIMEOUT_MS,
    });
  } catch (err) {
    // ImgBB answered, but with an error status.
    if (err.response) {
      const detail = extractImgbbErrorMessage(err.response.data) || `HTTP ${err.response.status}`;
      const status = err.response.status === 400 ? 400 : 502;
      logger.error(`ImgBB upload failed (${err.response.status}): ${detail}`);
      throw new ApiError(
        status,
        status === 400
          ? `ImgBB rejected the image: ${detail}`
          : `ImgBB could not accept the image right now (${detail}). Please try again.`
      );
    }
    // Timed out.
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      logger.error(`ImgBB upload timed out after ${UPLOAD_TIMEOUT_MS}ms`);
      throw new ApiError(504, 'The image host timed out. Check the internet connection and try again.');
    }
    // Unreachable / DNS / TLS.
    logger.error('ImgBB unreachable', err);
    throw new ApiError(502, 'Could not reach the image host (api.imgbb.com). Check the internet connection and try again.');
  }
  const data = response.data && response.data.data;
  if (!data || !data.url) {
    logger.error('ImgBB returned an unexpected payload', response.data);
    throw new ApiError(502, 'The image host returned an unexpected response. Nothing was saved — please try again.');
  }
  return {
    url: data.url,
    thumbUrl: (data.thumb && data.thumb.url) || data.url,
    // ADMIN-ONLY. Whoever holds this URL can delete the image from the ImgBB
    // account. It is stored on the product document and never sent to the
    // storefront — see toPublicProduct() in product.service.js.
    deleteUrl: data.delete_url || null,
    size: typeof data.size === 'number' ? data.size : null,
    width: data.width || null,
    height: data.height || null,
    imgbbId: data.id || null,
  };
}
module.exports = { uploadToImgbb, UPLOAD_TIMEOUT_MS };
