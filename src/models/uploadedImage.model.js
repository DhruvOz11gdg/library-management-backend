'use strict';
/**
 * src/models/uploadedImage.model.js
 * A record of every image this backend has pushed to ImgBB.
 *
 * Why this exists (decision D21): the upload endpoint must not return ImgBB's
 * `delete_url` to the browser (anyone holding it can delete the photo). But the
 * product document is *supposed* to keep it so the owner can tidy up old photos.
 * The frontend only ever sends back `{url, thumbUrl}` when it saves a product,
 * so the backend re-attaches `deleteUrl` by looking the URL up here. That keeps
 * the documented API shape exactly as specified while still never leaking the
 * delete link.
 *
 * It doubles as the beginnings of a media library: `productId` is stamped when
 * an image is attached to a product, so orphaned uploads can be found later.
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;
const uploadedImageSchema = new Schema(
  {
    url: { type: String, required: true, trim: true, unique: true, index: true },
    thumbUrl: { type: String, trim: true, default: '' },
    // ADMIN-ONLY — never returned by a public endpoint.
    deleteUrl: { type: String, trim: true, default: '' },
    filename: { type: String, trim: true, default: '' },
    size: { type: Number, default: null },
    originalSize: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    imgbbId: { type: String, trim: true, default: '' },
    // Set when the image is attached to a product (null = uploaded but unused).
    productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  },
  { timestamps: true, toJSON: { versionKey: false } }
);
uploadedImageSchema.index({ createdAt: -1 });
module.exports = mongoose.model('UploadedImage', uploadedImageSchema);
