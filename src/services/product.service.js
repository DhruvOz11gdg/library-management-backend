'use strict';
/**
 * src/services/product.service.js
 * All product business logic. Controllers stay thin; every public response
 * goes through toPublicProduct() so admin-only fields cannot leak.
 *
 * Search behaviour (worth knowing): `?search=` uses the MongoDB text index for
 * whole words ("choker", "oxidised"), and automatically falls back to a partial
 * match on name/SKU when the text search finds nothing ("neck" → Necklace).
 * The mode used is reported as `meta.searchMode` so the admin panel can explain
 * an empty result instead of just showing nothing.
 */
const mongoose = require('mongoose');
const Product = require('../models/product.model');
const Category = require('../models/category.model');
const UploadedImage = require('../models/uploadedImage.model');
const slugify = require('../utils/slugify');
const { generateSku, normaliseManualSku } = require('./sku.service');
const { ApiError } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const MAX_IMAGES = 6;
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 60;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SORTS = {
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  newest: { createdAt: -1, _id: -1 },
};
const EDITABLE_FIELDS = [
  'sku', 'name', 'slug', 'category', 'occasionTags', 'description', 'price', 'mrp',
  'costPrice', 'stockQty', 'lowStockAlert', 'colors', 'images',
  'isFeatured', 'isBestseller', 'isActive',
];
/* ------------------------------------------------------------------ *
 * Shape helpers — the single place admin-only fields are removed.
 * ------------------------------------------------------------------ */
function mapImages(images = [], { includeDeleteUrl = false } = {}) {
  const mapped = (images || []).map((image, index) => {
    const out = {
      url: image.url,
      thumbUrl: image.thumbUrl || image.url,
      isPrimary: Boolean(image.isPrimary),
      position: index,
    };
    if (includeDeleteUrl) out.deleteUrl = image.deleteUrl || '';
    return out;
  });
  // Primary first, original order preserved otherwise.
  return mapped.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position);
}
function categorySummary(category) {
  if (!category || !category._id) return null;
  return { id: String(category._id), name: category.name, slug: category.slug, code: category.code || '' };
}
/** Everything the storefront may see. costPrice and images[].deleteUrl are gone. */
function toPublicProduct(doc) {
  const product = doc.toObject ? doc.toObject() : doc;
  const images = mapImages(product.images);
  const primary = images.find((image) => image.isPrimary) || images[0] || null;
  const category = categorySummary(product.category);
  return {
    id: String(product._id),
    _id: String(product._id),
    sku: product.sku,
    name: product.name,
    slug: product.slug,
    category,
    categoryId: category ? category.id : product.category ? String(product.category) : null,
    occasionTags: product.occasionTags || [],
    description: product.description || '',
    price: product.price,
    mrp: product.mrp,
    discountPercent: product.mrp > product.price ? Math.round(((product.mrp - product.price) / product.mrp) * 100) : 0,
    // Convenience fields so the existing storefront card can use one image.
    image: primary ? primary.url : '',
    thumbUrl: primary ? primary.thumbUrl : '',
    images,
    colors: product.colors || [],
    stockQty: product.stockQty,
    inStock: product.stockQty > 0,
    isLowStock: product.stockQty > 0 && product.stockQty <= product.lowStockAlert,
    isFeatured: Boolean(product.isFeatured),
    isBestseller: Boolean(product.isBestseller),
    isActive: Boolean(product.isActive),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}
/** Admin panel shape — adds the two fields the public shape strips. */
function toAdminProduct(doc) {
  const product = doc.toObject ? doc.toObject() : doc;
  return {
    ...toPublicProduct(product),
    costPrice: product.costPrice || 0,
    lowStockAlert: product.lowStockAlert,
    images: mapImages(product.images, { includeDeleteUrl: true }),
    margin: product.costPrice > 0 ? Math.round(((product.price - product.costPrice) / product.price) * 100) : null,
  };
}
/* ------------------------------------------------------------------ *
 * Input normalisation / validation
 * ------------------------------------------------------------------ */
function toNumber(value, field, { required = false, integer = false, min = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw ApiError.badRequest(`${field} is required`);
    return undefined;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) throw ApiError.badRequest(`${field} must be a number`);
  if (integer && !Number.isInteger(num)) throw ApiError.badRequest(`${field} must be a whole number`);
  if (min !== null && num < min) throw ApiError.badRequest(`${field} cannot be less than ${min}`);
  return num;
}
function normaliseOccasionTags(tags) {
  if (tags === undefined || tags === null) return undefined;
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  return [...new Set(list.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
}
function normaliseColors(colors) {
  if (colors === undefined || colors === null) return undefined;
  const list = Array.isArray(colors) ? colors : String(colors).split(',');
  const cleaned = list.map((color) => String(color).trim()).filter(Boolean);
  const invalid = cleaned.filter((color) => !HEX_COLOR.test(color));
  if (invalid.length) {
    throw ApiError.badRequest(
      `Colours must be hex codes like #A62B4D or #FFF. Not valid: ${invalid.join(', ')}`
    );
  }
  return cleaned.map((color) => color.toUpperCase());
}
/** The admin panel sends back [{url, thumbUrl, isPrimary}] — never deleteUrl. */
function normaliseImages(images) {
  if (images === undefined || images === null) return undefined;
  if (!Array.isArray(images)) throw ApiError.badRequest('images must be an array');
  const cleaned = images
    .map((image) => (typeof image === 'string' ? { url: image } : image || {}))
    .map((image) => ({
      url: String(image.url || '').trim(),
      thumbUrl: String(image.thumbUrl || '').trim(),
      isPrimary: Boolean(image.isPrimary),
    }))
    .filter((image) => image.url);
  if (cleaned.length > MAX_IMAGES) {
    throw ApiError.badRequest(`A product can have at most ${MAX_IMAGES} images (received ${cleaned.length})`);
  }
  if (cleaned.some((image) => !/^https?:\/\//i.test(image.url))) {
    throw ApiError.badRequest('Every image needs a full http(s) URL — upload the photo through the admin panel');
  }
  // Exactly one primary: honour the admin's choice, otherwise the first image.
  const primaryIndex = cleaned.findIndex((image) => image.isPrimary);
  cleaned.forEach((image, index) => {
    image.isPrimary = index === (primaryIndex === -1 ? 0 : primaryIndex);
  });
  return cleaned;
}
/**
 * Re-attaches ImgBB's deleteUrl to images, server-side only (decision D21).
 * The admin panel never sees or sends that link.
 */
async function attachDeleteUrls(images) {
  if (!images || images.length === 0) return images;
  const urls = images.map((image) => image.url);
  const records = await UploadedImage.find({ url: { $in: urls } }).select('url deleteUrl').lean();
  const byUrl = new Map(records.map((record) => [record.url, record.deleteUrl || '']));
  return images.map((image) => ({ ...image, deleteUrl: byUrl.get(image.url) || '' }));
}
async function resolveCategory(categoryInput) {
  if (!categoryInput) throw ApiError.badRequest('Category is required');
  const value = String(categoryInput).trim();
  const category = mongoose.Types.ObjectId.isValid(value) && value.length === 24
    ? await Category.findById(value)
    : await Category.findOne({ slug: slugify(value) });
  if (!category) throw ApiError.badRequest('Category not found — pick a category from the list');
  if (!category.isActive) {
    throw ApiError.badRequest(
      `Category "${category.name}" is inactive. Reactivate it (or pick another) before saving products into it.`
    );
  }
  return category;
}
async function buildUniqueProductSlug(base, excludeId = null) {
  const root = slugify(base) || 'product';
  let candidate = root;
  let suffix = 1;
  while (suffix <= 100) {
    const clash = await Product.findOne({ slug: candidate }).select('_id');
    if (!clash || (excludeId && String(clash._id) === String(excludeId))) return candidate;
    suffix += 1;
    candidate = `${root}-${suffix}`;
  }
  throw ApiError.conflict(`Could not find a free slug based on "${root}" — rename the product slightly`);
}
/* ------------------------------------------------------------------ *
 * Write operations
 * ------------------------------------------------------------------ */
async function createProduct(payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) throw ApiError.badRequest('Product name is required');
  const category = await resolveCategory(payload.category);
  const price = toNumber(payload.price, 'Selling price', { required: true, min: 0 });
  const mrp = toNumber(payload.mrp, 'MRP', { required: true, min: 0 });
  if (mrp < price) {
    throw ApiError.badRequest(
      `MRP (₹${mrp}) cannot be less than the selling price (₹${price}) — the strikethrough price must be the higher one.`
    );
  }
  const styleHint = (payload.styleHint || (Array.isArray(payload.occasionTags) ? payload.occasionTags[0] : '') || '').toString();
  const sku = payload.sku
    ? normaliseManualSku(payload.sku)
    : await generateSku({ categoryCode: category.code || category.name, styleHint });
  const existingSku = await Product.findOne({ sku }).select('name');
  if (existingSku) {
    throw ApiError.conflict(`SKU "${sku}" is already used by "${existingSku.name}". Leave the SKU blank for an automatic one.`);
  }
  const slug = await buildUniqueProductSlug(payload.slug || name);
  const images = await attachDeleteUrls(normaliseImages(payload.images) || []);
  const product = await Product.create({
    sku,
    name,
    slug,
    category: category._id,
    occasionTags: normaliseOccasionTags(payload.occasionTags) || [],
    description: payload.description || '',
    price,
    mrp,
    costPrice: toNumber(payload.costPrice, 'Cost price', { min: 0 }) || 0,
    stockQty: toNumber(payload.stockQty, 'Stock', { integer: true, min: 0 }) || 0,
    lowStockAlert: payload.lowStockAlert === undefined ? 3 : toNumber(payload.lowStockAlert, 'Low stock alert', { integer: true, min: 0 }),
    colors: normaliseColors(payload.colors) || [],
    images,
    isFeatured: Boolean(payload.isFeatured),
    isBestseller: Boolean(payload.isBestseller),
    isActive: payload.isActive === undefined ? true : Boolean(payload.isActive),
  });
  await stampImages(product, images);
  logger.info(`product created: ${product.sku} "${product.name}"`);
  return toAdminProduct(await product.populate('category', 'name slug code'));
}
async function updateProduct(id, payload = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw ApiError.badRequest('Invalid product id');
  const product = await Product.findById(id);
  if (!product) throw ApiError.notFound('Product not found');
  const touched = EDITABLE_FIELDS.some((field) => payload[field] !== undefined);
  if (!touched) throw ApiError.badRequest(`No updatable fields sent. Allowed: ${EDITABLE_FIELDS.join(', ')}`);
  if (payload.name !== undefined) {
    const name = String(payload.name).trim();
    if (!name) throw ApiError.badRequest('Product name cannot be empty');
    product.name = name;
  }
  if (payload.slug !== undefined) {
    const requested = slugify(payload.slug);
    if (!requested) throw ApiError.badRequest('Slug cannot be empty');
    if (requested !== product.slug) product.slug = await buildUniqueProductSlug(requested, product._id);
  }
  if (payload.category !== undefined) {
    const category = await resolveCategory(payload.category);
    product.category = category._id;
    // NOTE: changing the category does NOT re-issue the SKU. The SKU is the
    // product's identity — it is already printed on tags, bills and WhatsApp
    // messages. Renaming the SKU is a deliberate, separate admin action.
  }
  if (payload.sku !== undefined && String(payload.sku).trim() !== product.sku) {
    const sku = normaliseManualSku(payload.sku);
    const clash = await Product.findOne({ sku, _id: { $ne: product._id } }).select('name');
    if (clash) throw ApiError.conflict(`SKU "${sku}" is already used by "${clash.name}"`);
    product.sku = sku;
  }
  const price = payload.price === undefined ? product.price : toNumber(payload.price, 'Selling price', { required: true, min: 0 });
  const mrp = payload.mrp === undefined ? product.mrp : toNumber(payload.mrp, 'MRP', { required: true, min: 0 });
  if (mrp < price) {
    throw ApiError.badRequest(
      `MRP (₹${mrp}) cannot be less than the selling price (₹${price}) — the strikethrough price must be the higher one.`
    );
  }
  product.price = price;
  product.mrp = mrp;
  if (payload.costPrice !== undefined) product.costPrice = toNumber(payload.costPrice, 'Cost price', { min: 0 }) || 0;
  if (payload.stockQty !== undefined) product.stockQty = toNumber(payload.stockQty, 'Stock', { integer: true, min: 0 });
  if (payload.lowStockAlert !== undefined) product.lowStockAlert = toNumber(payload.lowStockAlert, 'Low stock alert', { integer: true, min: 0 });
  if (payload.description !== undefined) product.description = payload.description;
  if (payload.occasionTags !== undefined) product.occasionTags = normaliseOccasionTags(payload.occasionTags);
  if (payload.colors !== undefined) product.colors = normaliseColors(payload.colors);
  if (payload.isFeatured !== undefined) product.isFeatured = Boolean(payload.isFeatured);
  if (payload.isBestseller !== undefined) product.isBestseller = Boolean(payload.isBestseller);
  if (payload.isActive !== undefined) product.isActive = Boolean(payload.isActive);
  if (payload.images !== undefined) {
    const images = await attachDeleteUrls(normaliseImages(payload.images));
    product.images = images;
    product.markModified('images');
    await stampImages(product, images);
  }
  await product.save();
  logger.info(`product updated: ${product.sku} "${product.name}"`);
  return toAdminProduct(await product.populate('category', 'name slug code'));
}
/** Links uploaded images to the product that now uses them (media library). */
async function stampImages(product, images) {
  if (!images || images.length === 0) return;
  try {
    await UploadedImage.updateMany(
      { url: { $in: images.map((image) => image.url) } },
      { $set: { productId: product._id } }
    );
  } catch (err) {
    logger.warn('could not stamp images with productId (non-fatal)', err.message);
  }
}
/** Soft delete: hidden from the storefront, never lost. */
async function deleteProduct(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw ApiError.badRequest('Invalid product id');
  const product = await Product.findById(id).populate('category', 'name slug code');
  if (!product) throw ApiError.notFound('Product not found');
  if (!product.isActive) return { ...toAdminProduct(product), alreadyInactive: true };
  product.isActive = false;
  await product.save();
  logger.info(`product deactivated: ${product.sku} "${product.name}"`);
  return toAdminProduct(product);
}
/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */
function parseBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}
function pagination(query) {
  const page = query.page === undefined ? 1 : toNumber(query.page, 'page', { integer: true, min: 1 });
  const rawLimit = query.limit === undefined ? DEFAULT_PAGE_SIZE : toNumber(query.limit, 'limit', { integer: true, min: 1 });
  if (rawLimit > MAX_PAGE_SIZE) throw ApiError.badRequest(`limit cannot be more than ${MAX_PAGE_SIZE}`);
  return { page, limit: rawLimit };
}
function resolveSort(sort) {
  if (!sort) return { key: 'newest', spec: SORTS.newest };
  const key = String(sort).trim();
  if (!SORTS[key]) throw ApiError.badRequest(`sort must be one of: ${Object.keys(SORTS).join(', ')}`);
  return { key, spec: SORTS[key] };
}
async function buildPublicFilter(query = {}) {
  const filter = { isActive: true };
  // Products in a hidden category must not surface either — the storefront has
  // no nav entry to reach them (mirrors the category rule from Block 2).
  const activeCategoryIds = await Category.find({ isActive: true }).distinct('_id');
  filter.category = { $in: activeCategoryIds };
  if (query.category) {
    const value = String(query.category).trim();
    const isObjectId = mongoose.Types.ObjectId.isValid(value) && value.length === 24;
    // isActive:true here too — a hidden category must not be reachable by
    // asking for it directly, only by the $in above.
    const category = isObjectId
      ? await Category.findOne({ _id: value, isActive: true }).select('_id')
      : await Category.findOne({ slug: slugify(value), isActive: true }).select('_id');
    if (!category) return null; // unknown or hidden category → no results, not an error
    filter.category = category._id;
  }
  if (query.occasion) filter.occasionTags = String(query.occasion).trim().toLowerCase();
  const featured = parseBool(query.featured);
  if (featured !== undefined) filter.isFeatured = featured;
  const bestseller = parseBool(query.bestseller);
  if (bestseller !== undefined) filter.isBestseller = bestseller;
  const minPrice = toNumber(query.minPrice, 'minPrice', { min: 0 });
  const maxPrice = toNumber(query.maxPrice, 'maxPrice', { min: 0 });
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.price = {};
    if (minPrice !== undefined) filter.price.$gte = minPrice;
    if (maxPrice !== undefined) filter.price.$lte = maxPrice;
    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
      throw ApiError.badRequest('minPrice cannot be greater than maxPrice');
    }
  }
  return filter;
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Runs the search: text index first, partial (regex) match as a fallback so
 * "neck" still finds "Peacock Necklace Choker".
 */
async function queryProducts(filter, { search, sortSpec, page, limit }) {
  const base = { ...filter };
  let searchMode = 'none';
  let searchFilter = null;
  if (search && String(search).trim()) {
    const term = String(search).trim();
    searchMode = term.length >= 3 ? 'text' : 'partial';
    searchFilter = searchMode === 'text'
      ? { $text: { $search: term } }
      : { $or: [{ name: new RegExp(escapeRegExp(term), 'i') }, { sku: new RegExp(escapeRegExp(term), 'i') }] };
  }
  const runQuery = async (extra) => {
    const combined = extra ? { ...base, ...extra } : base;
    const [products, total] = await Promise.all([
      Product.find(combined)
        .populate('category', 'name slug code isActive')
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(combined),
    ]);
    return { products, total };
  };
  if (!searchFilter) return { ...(await runQuery(null)), searchMode };
  let result;
  try {
    result = await runQuery(searchFilter);
  } catch (err) {
    // A production deployment with autoIndex disabled may not have built the
    // text index yet; degrade to a partial match instead of a 500.
    if (/text index/i.test(err.message || '')) {
      logger.warn('text index missing — falling back to partial search');
      searchMode = 'partial';
      result = await runQuery({
        $or: [
          { name: new RegExp(escapeRegExp(String(search).trim()), 'i') },
          { sku: new RegExp(escapeRegExp(String(search).trim()), 'i') },
        ],
      });
    } else {
      throw err;
    }
  }
  // Text search is whole-word: if it found nothing, try the partial match too.
  if (result.total === 0 && searchMode === 'text') {
    const partial = await runQuery({
      $or: [
        { name: new RegExp(escapeRegExp(String(search).trim()), 'i') },
        { sku: new RegExp(escapeRegExp(String(search).trim()), 'i') },
      ],
    });
    if (partial.total > 0) return { ...partial, searchMode: 'partial' };
  }
  return { ...result, searchMode };
}
function buildMeta({ page, limit, total, sortKey, searchMode, filters = {} }) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: page * limit < total,
    sort: sortKey,
    searchMode,
    filters,
  };
}
/** Public listing — active products in active categories only. */
async function listProducts(query = {}) {
  const filter = await buildPublicFilter(query);
  const { page, limit } = pagination(query);
  const { key: sortKey, spec: sortSpec } = resolveSort(query.sort);
  if (filter === null) {
    return { products: [], meta: buildMeta({ page, limit, total: 0, sortKey, searchMode: 'none', filters: { category: query.category } }) };
  }
  const { products, total, searchMode } = await queryProducts(filter, {
    search: query.search,
    sortSpec,
    page,
    limit,
  });
  return {
    products: products.map(toPublicProduct),
    meta: buildMeta({ page, limit, total, sortKey, searchMode }),
  };
}
/** Admin listing — includes inactive products, costPrice and deleteUrl. */
async function listProductsAdmin(query = {}) {
  const filter = {};
  const status = query.status ? String(query.status).toLowerCase() : 'all';
  if (status === 'active') filter.isActive = true;
  else if (status === 'inactive') filter.isActive = false;
  else if (status !== 'all') throw ApiError.badRequest('status must be one of: all, active, inactive');
  if (query.category) {
    const value = String(query.category).trim();
    const category = mongoose.Types.ObjectId.isValid(value) && value.length === 24
      ? await Category.findById(value).select('_id')
      : await Category.findOne({ slug: slugify(value) }).select('_id');
    if (!category) return { products: [], meta: buildMeta({ page: 1, limit: DEFAULT_PAGE_SIZE, total: 0, sortKey: 'newest', searchMode: 'none' }) };
    filter.category = category._id;
  }
  if (parseBool(query.lowStock) === true) {
    filter.$expr = { $and: [{ $gt: ['$stockQty', 0] }, { $lte: ['$stockQty', '$lowStockAlert'] }] };
  }
  if (parseBool(query.outOfStock) === true) filter.stockQty = 0;
  const { page, limit } = pagination(query);
  const { key: sortKey, spec: sortSpec } = resolveSort(query.sort);
  const { products, total, searchMode } = await queryProducts(filter, {
    search: query.search,
    sortSpec,
    page,
    limit,
  });
  return {
    products: products.map(toAdminProduct),
    meta: buildMeta({ page, limit, total, sortKey, searchMode, filters: { status } }),
  };
}
/** Public detail. Accepts a slug or a SKU; must be active with an active category. */
async function getProduct(identifier) {
  const product = await Product.findByIdOrSlugOrSku(identifier).populate('category', 'name slug code isActive');
  if (!product || !product.isActive) throw ApiError.notFound('Product not found');
  if (product.category && product.category.isActive === false) {
    throw ApiError.notFound('Product not found');
  }
  return toPublicProduct(product);
}
/** Admin detail — any state, includes costPrice + deleteUrl. */
async function getProductAdmin(identifier) {
  const product = await Product.findByIdOrSlugOrSku(identifier).populate('category', 'name slug code isActive');
  if (!product) throw ApiError.notFound('Product not found');
  return toAdminProduct(product);
}
/** Counters for the admin dashboard. */
async function getStats() {
  const [total, active, inactive, outOfStock, lowStock, featured, bestsellers, byCategory] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({ isActive: true }),
    Product.countDocuments({ isActive: false }),
    Product.countDocuments({ isActive: true, stockQty: 0 }),
    Product.countDocuments({
      isActive: true,
      $expr: { $and: [{ $gt: ['$stockQty', 0] }, { $lte: ['$stockQty', '$lowStockAlert'] }] },
    }),
    Product.countDocuments({ isActive: true, isFeatured: true }),
    Product.countDocuments({ isActive: true, isBestseller: true }),
    Product.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
      { $unwind: '$category' },
      { $project: { _id: 0, categoryId: '$_id', name: '$category.name', slug: '$category.slug', count: 1 } },
      { $sort: { count: -1 } },
    ]),
  ]);
  return { total, active, inactive, outOfStock, lowStock, featured, bestsellers, byCategory };
}
module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  listProducts,
  listProductsAdmin,
  getProduct,
  getProductAdmin,
  getStats,
  toPublicProduct,
  toAdminProduct,
  MAX_IMAGES,
  MAX_PAGE_SIZE,
  SORTS,
};
