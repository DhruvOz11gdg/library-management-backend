'use strict';
/**
 * src/controllers/category.controller.js
 * Thin HTTP layer: read the request, call the service, shape the response.
 * No Mongoose queries and no business rules live in here (golden rule: the
 * service owns the logic). Every handler is wrapped in asyncHandler, so a
 * thrown ApiError goes straight to the central error handler.
 */
const categoryService = require('../services/category.service');
const { sendSuccess } = require('../utils/apiResponse');
const asyncHandler = require('../utils/asyncHandler');
/** GET /v1/categories — public */
const listCategories = asyncHandler(async (req, res) => {
  const categories = await categoryService.listCategories();
  return sendSuccess(res, {
    message: `${categories.length} active ${categories.length === 1 ? 'category' : 'categories'}`,
    data: { categories, count: categories.length },
  });
});
/** POST /v1/categories — admin (protected in Block 5) */
const createCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.createCategory(req.body);
  return sendSuccess(res, {
    statusCode: 201,
    message: `Category "${category.name}" created`,
    data: { category },
  });
});
/** PUT /v1/categories/:id — admin (protected in Block 5) */
const updateCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.updateCategory(req.params.id, req.body);
  return sendSuccess(res, {
    message: `Category "${category.name}" updated`,
    data: { category },
  });
});
/**
 * DELETE /v1/categories/:id — admin (protected in Block 5). Soft delete.
 * `?force=true` overrides the "category still has active products" guard.
 */
const deactivateCategory = asyncHandler(async (req, res) => {
  const force = ['true', '1', 'yes'].includes(String(req.query.force || '').toLowerCase());
  const category = await categoryService.deactivateCategory(req.params.id, { force });
  return sendSuccess(res, {
    message: category.alreadyInactive
      ? `Category "${category.name}" was already inactive`
      : category.hiddenProductCount > 0
        ? `Category "${category.name}" deactivated — ${category.hiddenProductCount} product(s) are now hidden from the storefront too`
        : `Category "${category.name}" deactivated — it is hidden from the storefront but no data was deleted`,
    data: { category },
  });
});
module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  deactivateCategory,
};
