'use strict';
/**
 * src/services/category.service.js
 * All category business logic. Controllers stay thin and Express-free; this
 * layer is the only thing that talks to the Category model.
 *
 * Rules enforced here:
 *  - slug is always generated from the name unless the admin types one, and is
 *    always unique (auto-suffixed -2, -3 … rather than failing with a 409)
 *  - parentCategory must exist, cannot be the category itself, and cannot
 *    create a cycle
 *  - deleting a category is a soft delete (isActive:false) — products and
 *    historical orders must never point at a category that vanished
 */
const mongoose = require('mongoose');
const Category = require('../models/category.model');
const Product = require('../models/product.model');
const slugify = require('../utils/slugify');
const { ApiError } = require('../utils/apiResponse');
/** Maximum depth we will walk looking for a cycle — cheap insurance. */
const MAX_HIERARCHY_DEPTH = 25;
/** Whitelist — anything else in req.body is ignored, not written. */
const EDITABLE_FIELDS = ['name', 'slug', 'code', 'description', 'parentCategory', 'image', 'sortOrder', 'isActive'];
/** Public shape. Keeps `_id` for the admin panel and adds `id` for the frontend. */
function toPublicCategory(doc) {
  const category = doc.toObject ? doc.toObject() : doc;
  const parent = category.parentCategory;
  return {
    id: String(category._id),
    _id: String(category._id),
    name: category.name,
    slug: category.slug,
    code: category.code || '',
    description: category.description || '',
    image: {
      url: (category.image && category.image.url) || '',
      thumbUrl: (category.image && category.image.thumbUrl) || '',
    },
    parentCategory: parent && parent._id ? String(parent._id) : parent ? String(parent) : null,
    // Present only when the parent was populated (public list does populate).
    parentSlug: parent && parent.slug ? parent.slug : null,
    parentName: parent && parent.name ? parent.name : null,
    isSubcategory: Boolean(parent && (parent._id || parent)),
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}
/** "rings" taken → "rings-2", "rings-3" … (`excludeId` when renaming itself). */
async function buildUniqueSlug(base, excludeId = null) {
  const root = slugify(base) || 'category';
  let candidate = root;
  let suffix = 1;
  // Bounded loop: the data set is a jewellery catalogue, not a URL shortener.
  while (suffix <= 50) {
    const clash = await Category.findOne({ slug: candidate }).select('_id');
    if (!clash || (excludeId && String(clash._id) === String(excludeId))) return candidate;
    suffix += 1;
    candidate = `${root}-${suffix}`;
  }
  throw ApiError.conflict(`Could not find a free slug based on "${root}" — try a more specific name`);
}
async function assertValidParentId(parentId) {
  if (!mongoose.Types.ObjectId.isValid(String(parentId))) {
    throw ApiError.badRequest('parentCategory must be a valid category id');
  }
  const parent = await Category.findById(parentId).select('name');
  if (!parent) throw ApiError.badRequest('Parent category not found');
  return parent;
}
/** Walks up from the proposed parent; if we reach the category itself, it's a cycle. */
async function assertNoCycle(categoryId, parentId) {
  if (!parentId) return;
  await assertValidParentId(parentId);
  if (String(categoryId) === String(parentId)) {
    throw ApiError.badRequest('A category cannot be its own parent');
  }
  let cursor = await Category.findById(parentId).select('parentCategory');
  let depth = 0;
  while (cursor && cursor.parentCategory && depth < MAX_HIERARCHY_DEPTH) {
    const ancestorId = String(cursor.parentCategory);
    if (ancestorId === String(categoryId)) {
      throw ApiError.badRequest('That parent would create a circular category hierarchy');
    }
    cursor = await Category.findById(cursor.parentCategory).select('parentCategory');
    depth += 1;
  }
}
async function createCategory(payload = {}) {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) throw ApiError.badRequest('Category name is required');
  const existingName = await Category.findOne({ name }).select('_id');
  if (existingName) throw ApiError.conflict(`A category named "${name}" already exists`);
  const slugSource = payload.slug ? payload.slug : name;
  const slug = await buildUniqueSlug(slugSource);
  if (payload.parentCategory) await assertValidParentId(payload.parentCategory);
  const category = await Category.create({
    name,
    slug,
    code: payload.code ? String(payload.code).toUpperCase().slice(0, 3) : undefined, // hook derives it if absent
    description: payload.description || '',
    parentCategory: payload.parentCategory || null,
    image: payload.image || {},
    sortOrder: Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0,
    isActive: payload.isActive === undefined ? true : Boolean(payload.isActive),
  });
  return toPublicCategory(category);
}
/**
 * Public list: active categories only, in store display order.
 * A subcategory is hidden when its parent is inactive, so deactivating
 * "Necklace" does not leave orphaned "Chokers" on the storefront.
 */
async function listCategories() {
  const categories = await Category.find({ isActive: true })
    .populate('parentCategory', 'name slug isActive')
    .sort({ sortOrder: 1, name: 1 });
  const visible = categories.filter((category) => {
    const parent = category.parentCategory;
    if (!parent || !parent._id) return true; // top-level
    return parent.isActive !== false;
  });
  return visible.map(toPublicCategory);
}
/**
 * Admin list (Block 7 — CategoryManager): EVERY category, active and inactive,
 * in store display order. The public list deliberately hides inactive ones;
 * the panel cannot manage what it cannot see (same reasoning as D30).
 */
async function listCategoriesAdmin() {
  const categories = await Category.find()
    .populate('parentCategory', 'name slug isActive')
    .sort({ sortOrder: 1, name: 1 });
  return categories.map(toPublicCategory);
}
async function getCategoryById(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw ApiError.badRequest('Invalid category id');
  }
  const category = await Category.findById(id).populate('parentCategory', 'name slug isActive');
  if (!category) throw ApiError.notFound('Category not found');
  return toPublicCategory(category);
}
/** Used by the product filter (`?category=<slug>`) in Block 4. */
async function getCategoryBySlug(slug) {
  const category = await Category.findOne({ slug: slugify(slug) }).populate('parentCategory', 'name slug isActive');
  if (!category) throw ApiError.notFound(`Category "${slug}" not found`);
  return toPublicCategory(category);
}
async function updateCategory(id, payload = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw ApiError.badRequest('Invalid category id');
  }
  const category = await Category.findById(id);
  if (!category) throw ApiError.notFound('Category not found');
  if (payload.name !== undefined) {
    const name = String(payload.name).trim();
    if (!name) throw ApiError.badRequest('Category name cannot be empty');
    const clash = await Category.findOne({ name, _id: { $ne: category._id } }).select('_id');
    if (clash) throw ApiError.conflict(`A category named "${name}" already exists`);
    category.name = name;
  }
  // Renaming does NOT silently change the slug: slugs are live URLs, and a
  // surprise new URL breaks bookmarks, WhatsApp links and Google's index.
  // Changing the slug is an explicit admin action (pass `slug`).
  if (payload.slug !== undefined) {
    const requested = slugify(payload.slug);
    if (!requested) throw ApiError.badRequest('Slug cannot be empty');
    if (requested !== category.slug) {
      category.slug = await buildUniqueSlug(requested, category._id);
    }
  }
  if (payload.code !== undefined) category.code = String(payload.code).toUpperCase().slice(0, 3);
  if (payload.description !== undefined) category.description = payload.description;
  if (payload.parentCategory !== undefined) {
    if (payload.parentCategory === null || payload.parentCategory === '') {
      category.parentCategory = null;
    } else {
      await assertNoCycle(category._id, payload.parentCategory);
      category.parentCategory = payload.parentCategory;
    }
  }
  if (payload.image !== undefined) {
    category.image = { url: payload.image.url || '', thumbUrl: payload.image.thumbUrl || '' };
  }
  if (payload.sortOrder !== undefined && Number.isFinite(Number(payload.sortOrder))) {
    category.sortOrder = Number(payload.sortOrder);
  }
  if (payload.isActive !== undefined) category.isActive = Boolean(payload.isActive);
  // Nothing in EDITABLE_FIELDS was sent → say so instead of returning a no-op 200.
  const touched = EDITABLE_FIELDS.some((field) => payload[field] !== undefined);
  if (!touched) throw ApiError.badRequest(`No updatable fields sent. Allowed: ${EDITABLE_FIELDS.join(', ')}`);
  await category.save();
  return toPublicCategory(await category.populate('parentCategory', 'name slug isActive'));
}
/**
 * Soft delete, with the Block 4 guard.
 *
 * Hiding a category also hides every product inside it (the storefront has no
 * nav entry to reach them), so deactivating one that still holds live products
 * would silently delist the whole shelf. Refuse, and tell the owner exactly how
 * many products are in the way. `force: true` is the deliberate override for
 * when he really does want the whole shelf gone.
 */
async function deactivateCategory(id, { force = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw ApiError.badRequest('Invalid category id');
  }
  const category = await Category.findById(id);
  if (!category) throw ApiError.notFound('Category not found');
  if (!category.isActive) {
    return { ...toPublicCategory(category), alreadyInactive: true };
  }
  const activeProducts = await Product.countDocuments({ category: category._id, isActive: true });
  if (activeProducts > 0 && !force) {
    throw ApiError.conflict(
      `"${category.name}" still has ${activeProducts} active ${activeProducts === 1 ? 'product' : 'products'}. ` +
        'Move them to another category or hide them first — or confirm with force=true to hide the category (and those products) from the storefront.'
    );
  }
  category.isActive = false;
  await category.save();
  return { ...toPublicCategory(category), hiddenProductCount: activeProducts };
}
module.exports = {
  createCategory,
  listCategories,
  listCategoriesAdmin,
  getCategoryById,
  getCategoryBySlug,
  updateCategory,
  deactivateCategory,
  toPublicCategory,
};
