'use strict';
/**
 * src/services/image.service.js
 * Image compression before upload — the Alankar equivalent of the legacy
 * project's sharp/getCompressionOptions step that ran before the S3 put.
 *
 * Why it matters here: ImgBB's free tier has a per-image ceiling, phone photos
 * are 3–8MB, and the admin uploads over shop wifi. 1200px @ q82 is more than a
 * jewellery photo needs on a phone screen.
 *
 * Format is preserved on purpose:
 *   JPEG → JPEG (mozjpeg, progressive)
 *   PNG  → PNG  (transparency kept — a transparent PNG re-encoded as JPEG gets
 *                a black background)
 *   WebP → WebP
 *   GIF  → passed through untouched (sharp would flatten the animation)
 */
const sharp = require('sharp');
const { ApiError } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const DEFAULT_COMPRESSION = { maxWidth: 1200, maxHeight: 1200, quality: 82 };
/** Formats sharp must not touch (animation would be lost). */
const PASSTHROUGH_FORMATS = new Set(['gif']);
/**
 * @param {Buffer} buffer original image bytes
 * @param {{maxWidth?: number, maxHeight?: number, quality?: number}} [options]
 * @returns {Promise<{buffer: Buffer, format: string, width: number|null, height: number|null,
 *                    originalSize: number, size: number, savedPercent: number, passthrough: boolean}>}
 */
async function compressImage(buffer, options = {}) {
  const { maxWidth, maxHeight, quality } = { ...DEFAULT_COMPRESSION, ...options };
  const originalSize = buffer.length;
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw ApiError.badRequest(
      'That file could not be read as an image — it may be corrupt or renamed. Try re-saving it as JPG or PNG.'
    );
  }
  const format = metadata.format || 'jpeg';
  if (PASSTHROUGH_FORMATS.has(format)) {
    logger.info(`compress: ${format} passed through untouched (${(originalSize / 1024).toFixed(0)}KB)`);
    return {
      buffer,
      format,
      width: metadata.width || null,
      height: metadata.height || null,
      originalSize,
      size: originalSize,
      savedPercent: 0,
      passthrough: true,
    };
  }
  // .rotate() with no argument applies the EXIF orientation — without it, every
  // portrait photo taken on a phone comes out sideways.
  let pipeline = sharp(buffer)
    .rotate()
    .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true });
  switch (format) {
    case 'png':
      pipeline = pipeline.png({ quality, compressionLevel: 9, effort: 7 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality });
      break;
    case 'jpeg':
    case 'jpg':
    default:
      pipeline = pipeline.jpeg({ quality, mozjpeg: true, progressive: true });
      break;
  }
  let output;
  try {
    output = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (err) {
    logger.error('sharp compression failed', err);
    throw ApiError.badRequest('That image could not be processed — please try a different photo.');
  }
  const size = output.info.size;
  const savedPercent = originalSize > 0 ? Math.round(((originalSize - size) / originalSize) * 100) : 0;
  return {
    buffer: output.data,
    format,
    width: output.info.width,
    height: output.info.height,
    originalSize,
    size,
    savedPercent,
    passthrough: false,
  };
}
module.exports = { compressImage, DEFAULT_COMPRESSION };
