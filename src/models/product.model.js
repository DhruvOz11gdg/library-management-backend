'use strict';
/**
 * src/models/product.model.js
 * The catalogue. One document per SKU.
 *
 * Admin-only fields that must never reach the storefront:
 *   - costPrice          → the owner's buying price
 *   - images[].deleteUrl → ImgBB's public delete link (anyone holding it can
 *                          delete the photo from the account)
 * These are stripped by toPublicProduct() in product.service.js, which is the
 * single choke point every public response goes through. There is a regression
 * test that deep-scans public responses for them.
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;
const imageSchema = new Schema(
  {
    url: { type: String, required: [true, 'Image url is required'], trim: true },
    thumbUrl: { type: String, trim: true, default: '' },
    // ADMIN-ONLY — never returned by a public endpoint.
    deleteUrl: { type: String, trim: true, default: '' },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: true }
);
const productSchema = new Schema(
  {
    sku: {
      type: String,
      required: [true, 'SKU is required'],
      trim: true,
      uppercase: true,
      unique: true,
      index: true,
      maxlength: [24, 'SKU cannot exceed 24 characters'],
      match: [/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'SKU may contain only capital letters, numbers and dashes (e.g. NK-OX-001)'],
    },
    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      maxlength: [120, 'Product name cannot exceed 120 characters'],
    },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    category: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      required: [true, 'Category is required'],
      index: true,
    },
    // e.g. ["navratri","wedding","daily"] — drives the occasion filter in the UI
    occasionTags: { type: [String], default: [], index: true },
    description: { type: String, trim: true, default: '', maxlength: [2000, 'Description cannot exceed 2000 characters'] },
    price: { type: Number, required: [true, 'Selling price is required'], min: [0, 'Price cannot be negative'] },
    mrp: {
      type: Number,
      required: [true, 'MRP is required'],
      min: [0, 'MRP cannot be negative'],
      validate: {
        validator(value) {
          return value === undefined || this.price === undefined || value >= this.price;
        },
        message: 'MRP must be greater than or equal to the selling price',
      },
    },
    // ADMIN-ONLY.
    costPrice: { type: Number, default: 0, min: [0, 'Cost price cannot be negative'] },
    stockQty: { type: Number, required: true, default: 0, min: [0, 'Stock cannot be negative'] },
    lowStockAlert: { type: Number, default: 3, min: 0 },
    // Hex codes, matching the existing storefront Product.colors field
    colors: { type: [String], default: [] },
    images: {
      type: [imageSchema],
      default: [],
      validate: {
        validator(images) {
          return !images || images.length <= 6;
        },
        message: 'A product can have at most 6 images',
      },
    },
    isFeatured: { type: Boolean, default: false, index: true },
    isBestseller: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    toJSON: { versionKey: false },
    toObject: { versionKey: false },
  }
);
/* Search index (spec: text index across name, description, occasionTags). */
productSchema.index(
  { name: 'text', description: 'text', occasionTags: 'text' },
  { weights: { name: 5, occasionTags: 3, description: 1 }, name: 'ProductTextIndex' }
);
/* Filter indexes — the storefront's hot paths. */
productSchema.index({ isActive: 1, category: 1, createdAt: -1 });
productSchema.index({ isActive: 1, isFeatured: -1 });
productSchema.index({ isActive: 1, isBestseller: -1 });
/** Public detail pages accept a slug (canonical) or a SKU — the WhatsApp message shows the SKU, so `…/products/NK-OX-001` must work. */
productSchema.statics.findByIdOrSlugOrSku = function findByIdOrSlugOrSku(identifier) {
  if (!identifier) return null;
  const value = String(identifier).trim();
  if (mongoose.Types.ObjectId.isValid(value) && value.length === 24) return this.findById(value);
  return this.findOne({ $or: [{ slug: value.toLowerCase() }, { sku: value.toUpperCase() }] });
};
module.exports = mongoose.model('Product', productSchema);
