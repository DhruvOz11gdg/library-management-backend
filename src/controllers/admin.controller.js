'use strict';
/**
 * src/controllers/admin.controller.js
 * Admin login/logout/session, plus the admin-only reads the panel needs
 * (products including hidden ones, and dashboard counters).
 */
const adminService = require('../services/admin.service');
const productService = require('../services/product.service');
const categoryService = require('../services/category.service');
const { generateSku } = require('../services/sku.service');
const Category = require('../models/category.model');
const { sendSuccess, ApiError } = require('../utils/apiResponse');
const asyncHandler = require('../utils/asyncHandler');
const { COOKIE_NAME, getCookieOptions } = require('../config/auth');
/** POST /v1/admin/login — public, rate-limited. Sets the httpOnly cookie. */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const { token, admin } = await adminService.login(email, password);
  // The token goes back ONLY as an httpOnly cookie: frontend JavaScript never
  // sees it, so an XSS bug cannot steal the session.
  res.cookie(COOKIE_NAME, token, getCookieOptions());
  return sendSuccess(res, {
    message: `Welcome back, ${admin.email}`,
    data: { admin },
  });
});
/** POST /v1/admin/logout */
const logout = asyncHandler(async (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...getCookieOptions(), maxAge: undefined });
  return sendSuccess(res, { message: 'Signed out' });
});
/** GET /v1/admin/self — the admin panel calls this on mount to check the session. */
const self = asyncHandler(async (req, res) => {
  const admin = await adminService.getAdminById(req.admin.id);
  return sendSuccess(res, { message: `Signed in as ${admin.email}`, data: { admin } });
});
/** GET /v1/admin/products — every product, including hidden ones. */
const listProducts = asyncHandler(async (req, res) => {
  const { products, meta } = await productService.listProductsAdmin(req.query);
  return sendSuccess(res, {
    message: products.length === 0 ? 'No products matched' : `${products.length} of ${meta.total} products`,
    data: { products, meta },
  });
});
/** GET /v1/admin/products/:id — by id or slug, any state, admin shape. */
const getProduct = asyncHandler(async (req, res) => {
  const product = await productService.getProductAdmin(req.params.id);
  return sendSuccess(res, { message: product.name, data: { product } });
});
/** GET /v1/admin/stats — dashboard counters. */
const stats = asyncHandler(async (req, res) => {
  const statsData = await productService.getStats();
  return sendSuccess(res, { message: 'Dashboard stats', data: statsData });
});
/**
 * GET /v1/admin/categories — every category, active AND inactive (Block 7).
 * The public /v1/categories hides inactive ones; the CategoryManager cannot
 * manage (or reactivate) what it cannot see. Same reasoning as D30.
 */
const listCategories = asyncHandler(async (req, res) => {
  const categories = await categoryService.listCategoriesAdmin();
  return sendSuccess(res, {
    message: `${categories.length} ${categories.length === 1 ? 'category' : 'categories'} (including inactive)`,
    data: { categories, count: categories.length },
  });
});
/**
 * GET /v1/admin/sku-suggestion?category=<slug|id>&styleHint=<tag> (Block 7).
 * The ProductForm pre-fills the SKU field with this suggestion — the admin can
 * always overwrite it, or clear it and let product creation auto-generate.
 */
const skuSuggestion = asyncHandler(async (req, res) => {
  const { category: categoryInput, styleHint } = req.query;
  if (!categoryInput) {
    throw ApiError.badRequest('category is required — pass a category slug or id');
  }
  const category = await Category.findByIdOrSlug(String(categoryInput).trim());
  if (!category) throw ApiError.notFound(`Category "${categoryInput}" not found`);
  const hint = String(styleHint || '').trim();
  const suggestion = await generateSku({
    categoryCode: category.code || category.name,
    styleHint: hint,
  });
  return sendSuccess(res, {
    message: `Next SKU in ${category.name}: ${suggestion}`,
    data: {
      suggestion,
      categoryId: String(category._id),
      categoryName: category.name,
      categoryCode: category.code || '',
      styleHint: hint,
      note: 'Editable — type your own SKU or clear the field to auto-generate on save.',
    },
  });
});
module.exports = { login, logout, self, listProducts, getProduct, stats, listCategories, skuSuggestion };
