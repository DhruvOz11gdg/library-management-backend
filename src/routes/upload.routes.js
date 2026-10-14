'use strict';
/**
 * src/routes/upload.routes.js
 * Mounted at /v1/upload in routes/index.js.
 *
 *   POST /v1/upload/product-image   admin  — multipart/form-data, field: "image"
 *
 * Decision D8 is now closed: an unauthenticated upload endpoint would let
 * anyone burn the ImgBB quota and fill the media library, so adminAuth sits in
 * front of multer — the file is rejected before a byte is buffered.
 *
 * The order matters: adminAuth → multer → controller.
 */
const express = require('express');
const { uploadSingleImage } = require('../middlewares/upload.middleware');
const uploadController = require('../controllers/upload.controller');
const adminAuth = require('../middlewares/adminAuth.middleware');
const router = express.Router();
router.post('/product-image', adminAuth, uploadSingleImage, uploadController.uploadProductImage);
module.exports = router;
