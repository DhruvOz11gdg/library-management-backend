'use strict';
/**
 * src/routes/category.routes.js
 * Mounted at /v1/categories in routes/index.js.
 *
 *   GET    /v1/categories       public  — storefront category nav
 *   POST   /v1/categories       admin
 *   PUT    /v1/categories/:id   admin
 *   DELETE /v1/categories/:id   admin — soft delete (isActive:false)
 *
 * Decision D8 is now closed: the mutating routes are behind adminAuth.
 */
const express = require('express');
const categoryController = require('../controllers/category.controller');
const adminAuth = require('../middlewares/adminAuth.middleware');
const router = express.Router();
router.get('/', categoryController.listCategories);
router.post('/', adminAuth, categoryController.createCategory);
router.put('/:id', adminAuth, categoryController.updateCategory);
router.delete('/:id', adminAuth, categoryController.deactivateCategory);
module.exports = router;
