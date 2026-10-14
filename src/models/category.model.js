'use strict';
/**
 * src/models/category.model.js
 * Product categories for the storefront (Necklace, Earrings, Bangles/Kadas …).
 *
 * `slug` is the public identifier used in URLs and in
 * `GET /v1/products?category=<slug>`. `code` is a short uppercase prefix used
 * to build SKUs in Block 4 — it exists so two similarly-named categories can
 * never generate the same SKU prefix ("Bracelets" and "Bridal Sets" would both
 * reduce to BR by first-two-letters).
 *
 * `image` holds ImgBB URLs ({ url, thumbUrl }) — same shape as product images,
 * and, like products, the ImgBB `delete_url` is never stored on a category
 * because categories only ever reference existing products' images.
 */
const mongoose = require('mongoose');
const { slugify, deriveCode } = require('../utils/slugify');
const { Schema } = mongoose;
const imageSchema = new Schema(
  {
    url: { type: String, trim: true, default: '' },
    thumbUrl: { type: String, trim: true, default: '' },
  },
  { _id: false }
);
const categorySchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      unique: true,
      maxlength: [80, 'Category name cannot exceed 80 characters'],
    },
    slug: {
      type: String,
      required: [true, 'Category slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // SKU prefix, e.g. "NK" for Necklace, "OX" for Navratri/Oxidised.
    code: {
      type: String,
      uppercase: true,
      trim: true,
      maxlength: [3, 'Category code cannot exceed 3 characters'],
      default: '',
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    // Subcategories: "Chokers" under "Necklace". null = top-level category.
    parentCategory: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
      index: true,
    },
    image: { type: imageSchema, default: () => ({}) },
    sortOrder: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    toJSON: { versionKey: false },
    toObject: { versionKey: false },
  }
);
/**
 * Safety net only — the service always sets slug/code explicitly, because the
 * service needs to know when it has to de-duplicate a slug. This hook exists so
 * a category created straight from the model (seed data, a future import
 * script) still comes out valid instead of failing on a required field.
 */
categorySchema.pre('validate', function fillSlugAndCode(next) {
  if (this.name && !this.slug) this.slug = slugify(this.name);
  if (this.name && !this.code) this.code = deriveCode(this.name);
  next();
});
/** Findable by id OR slug — the pattern Block 4 reuses for products. */
categorySchema.statics.findByIdOrSlug = function findByIdOrSlug(idOrSlug) {
  if (!idOrSlug) return null;
  return mongoose.Types.ObjectId.isValid(String(idOrSlug))
    ? this.findById(idOrSlug)
    : this.findOne({ slug: String(idOrSlug).toLowerCase() });
};
module.exports = mongoose.model('Category', categorySchema);
