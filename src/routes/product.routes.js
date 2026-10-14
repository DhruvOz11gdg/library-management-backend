'use strict';
/**
 * src/routes/product.routes.js
 * Mounted at /v1/products in routes/index.js.
 *
 *   GET    /v1/products        public — ?category=&occasion=&search=&minPrice=
 *                                       &maxPrice=&featured=&bestseller=&page=
 *                                       &limit=&sort=price_asc|price_desc|newest
 *   GET    /v1/products/:slug  public — accepts a slug or a SKU
 *   POST   /v1/products        admin
 *   PUT    /v1/products/:id    admin
 *   DELETE /v1/products/:id    admin — soft delete (isActive:false)
 *
 * Decision D8 is now closed: the mutating routes are behind adminAuth.
 */
const express = require('express');
const productController = require('../controllers/product.controller');
const adminAuth = require('../middlewares/adminAuth.middleware');
const router = express.Router();
router.get('/', productController.listProducts);
router.get('/:slug', productController.getProduct);
router.post('/', adminAuth, productController.createProduct);
router.put('/:id', adminAuth, productController.updateProduct);
router.delete('/:id', adminAuth, productController.deleteProduct);
module.exports = router;
