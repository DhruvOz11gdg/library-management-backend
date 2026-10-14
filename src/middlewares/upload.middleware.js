'use strict';
/**
 * src/middlewares/upload.middleware.js
 * multer with MEMORY storage — not disk, not S3. The buffer goes straight to
 * sharp and then to ImgBB, so nothing is ever written to the server's disk and
 * a failed upload leaves no temp files behind.
 *
 * Same fileFilter idea as the legacy project: check the extension AND the
 * declared MIME type, and reject anything that is not a photo. The real
 * validation is that sharp has to be able to decode it (see image.service.js),
 * which catches a .exe renamed to .jpg.
 */
const path = require('path');
const multer = require('multer');
const { ApiError } = require('../utils/apiResponse');
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per photo
const MAX_FILES_PER_REQUEST = 6; // a product has at most 6 photos
const ALLOWED_EXTENSIONS = ['jpeg', 'jpg', 'png', 'gif', 'webp'];
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const storage = multer.memoryStorage();
function fileFilter(req, file, cb) {
  const extension = path.extname(file.originalname || '').replace('.', '').toLowerCase();
  const extensionOk = ALLOWED_EXTENSIONS.includes(extension);
  const mimeOk = ALLOWED_MIME_TYPES.includes(file.mimetype);
  if (extensionOk && mimeOk) return cb(null, true);
  return cb(
    ApiError.badRequest(
      `"${file.originalname || 'that file'}" is not a supported image. ` +
        `Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}.`
    )
  );
}
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES_PER_REQUEST },
});
/** One photo per request — the admin panel uploads each file as it is picked. */
const uploadSingleImage = upload.single('image');
/** Up to 6 photos in one request (kept for the multi-file flow). */
const uploadMultipleImages = upload.array('images', MAX_FILES_PER_REQUEST);
module.exports = {
  upload,
  uploadSingleImage,
  uploadMultipleImages,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_REQUEST,
  ALLOWED_EXTENSIONS,
};
