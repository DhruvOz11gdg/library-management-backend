'use strict';
/**
 * src/controllers/upload.controller.js
 * POST /v1/upload/product-image  (admin-only from Block 5)
 *
 * Flow: multer (memory) → sharp compress → ImgBB → save an UploadedImage record
 *       → return { url, thumbUrl } to the admin panel.
 *
 * The response deliberately contains NO `deleteUrl`. ImgBB's delete_url is a
 * plain link that anyone can open to permanently remove the image; it is kept
 * server-side (UploadedImage + the product document) and never leaves the API
 * on a public route. There is a regression test that scans every public
 * response for it.
 */
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, ApiError } = require('../utils/apiResponse');
const { compressImage } = require('../services/image.service');
const { uploadToImgbb } = require('../services/imgbb.service');
const UploadedImage = require('../models/uploadedImage.model');
const slugify = require('../utils/slugify');
const logger = require('../utils/logger');
/**
 * Builds the name shown in the ImgBB account, so the owner can find a photo
 * later: "alankar-peacock-choker-1737150000000".
 */
function buildFilename(originalName, hintName) {
  const source = (hintName || originalName || 'product').replace(/\.[^.]+$/, '');
  const base = slugify(source).slice(0, 60) || 'product';
  return `alankar-${base}-${Date.now()}`;
}
const uploadProductImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw ApiError.badRequest(
      'No image received. Send one file in the "image" field as multipart/form-data.'
    );
  }
  const filename = buildFilename(req.file.originalname, req.body && req.body.name);
  // 1. Compress (format-preserving; see image.service.js)
  const compressed = await compressImage(req.file.buffer);
  // 2. Upload to ImgBB
  const uploaded = await uploadToImgbb(compressed.buffer, filename);
  // 3. Remember it server-side so the delete link exists somewhere, and so an
  //    uploaded-but-unused photo can be found later.
  //    Upsert, not create: if ImgBB hands back a URL we have already recorded
  //    (a retried request, or a deduped image) the upload itself succeeded, so
  //    the admin must not be shown an error — we just refresh the record.
  const record = await UploadedImage.findOneAndUpdate(
    { url: uploaded.url },
    {
      $set: {
        thumbUrl: uploaded.thumbUrl,
        deleteUrl: uploaded.deleteUrl || '',
        filename,
        size: uploaded.size || compressed.size,
        originalSize: compressed.originalSize,
        width: uploaded.width || compressed.width,
        height: uploaded.height || compressed.height,
        imgbbId: uploaded.imgbbId || '',
        uploadedBy: req.admin ? req.admin.id : null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  logger.info(
    `upload ok: ${filename} ${(compressed.originalSize / 1024).toFixed(0)}KB → ` +
      `${(compressed.size / 1024).toFixed(0)}KB (−${compressed.savedPercent}%) → ${uploaded.url}`
  );
  return sendSuccess(res, {
    statusCode: 201,
    message: `Image uploaded (${(compressed.size / 1024).toFixed(0)}KB, saved ${compressed.savedPercent}% of ${(compressed.originalSize / 1024).toFixed(0)}KB)`,
    data: {
      url: uploaded.url,
      thumbUrl: uploaded.thumbUrl,
      width: uploaded.width || compressed.width,
      height: uploaded.height || compressed.height,
      size: uploaded.size || compressed.size,
      originalSize: compressed.originalSize,
      savedPercent: compressed.savedPercent,
      format: compressed.format,
      uploadId: String(record._id),
    },
  });
});
module.exports = { uploadProductImage, buildFilename };
