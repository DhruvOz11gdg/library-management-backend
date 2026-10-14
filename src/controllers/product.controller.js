'use strict';
/**
 * src/controllers/product.controller.js
 * Thin HTTP layer over product.service.js. No queries, no business rules.
 */
const productService = require('../services/product.service');
const { sendSuccess } = require('../utils/apiResponse');
const asyncHandler = require('../utils/asyncHandler');
/** GET /v1/products — public list with filters, search, sort and pagination. */
const listProducts = asyncHandler(async (req, res) => {
  const { products, meta } = await productService.listProducts(req.query);
  return sendSuccess(res, {
    message: products.length === 0
      ? 'No products matched those filters'
      : `${products.length} of ${meta.total} products`,
    data: { products, meta },
  });
});
/** GET /v1/products/:slug — public detail, by slug or SKU. */
const getProduct = asyncHandler(async (req, res) => {
  const product = await productService.getProduct(req.params.slug);
  return sendSuccess(res, { message: product.name, data: { product } });
});
/** POST /v1/products — admin (protected in Block 5). */
const createProduct = asyncHandler(async (req, res) => {
  const product = await productService.createProduct(req.body);
  return sendSuccess(res, {
    statusCode: 201,
    message: `Product "${product.name}" saved with SKU ${product.sku}`,
    data: { product },
  });
});
/** PUT /v1/products/:id — admin (protected in Block 5). */
const updateProduct = asyncHandler(async (req, res) => {
  const product = await productService.updateProduct(req.params.id, req.body);
  return sendSuccess(res, {
    message: `Product "${product.name}" updated`,
    data: { product },
  });
});
/** DELETE /v1/products/:id — admin (protected in Block 5). Soft delete. */
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await productService.deleteProduct(req.params.id);
  return sendSuccess(res, {
    message: product.alreadyInactive
      ? `Product "${product.name}" was already hidden`
      : `Product "${product.name}" hidden from the storefront — nothing was deleted`,
    data: { product },
  });
});
module.exports = { listProducts, getProduct, createProduct, updateProduct, deleteProduct };
