'use strict';
/**
 * src/routes/admin.routes.js
 * Mounted at /v1/admin in routes/index.js.
 *
 *   POST /v1/admin/login        public (rate-limited) → sets httpOnly cookie
 *   POST /v1/admin/logout       admin
 *   GET  /v1/admin/self         admin — session check used by the panel on mount
 *   GET  /v1/admin/products     admin — all products incl. hidden, costPrice + deleteUrl
 *   GET  /v1/admin/products/:id admin — by id or slug
 *   GET  /v1/admin/stats        admin — dashboard counters
 *
 * There is intentionally NO register route. The first admin comes from
 * `node seedAdmin.js` (see admin.service.js).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const adminController = require('../controllers/admin.controller');
const adminAuth = require('../middlewares/adminAuth.middleware');
const router = express.Router();
/**
 * Login throttle: 10 failed attempts per 15 minutes per IP.
 * `skipSuccessfulRequests` matters for a one-person shop — a legitimate admin
 * signing in repeatedly must never lock himself out; only failures count.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.ADMIN_LOGIN_RATE_LIMIT_MAX) || 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler(req, res) {
    res.status(429).json({
      success: false,
      message: 'Too many failed login attempts. Please wait 15 minutes and try again.',
      data: null,
      errors: [],
    });
  },
});
router.post('/login', loginLimiter, adminController.login);
router.post('/logout', adminAuth, adminController.logout);
router.get('/self', adminAuth, adminController.self);
router.get('/products', adminAuth, adminController.listProducts);
router.get('/products/:id', adminAuth, adminController.getProduct);
router.get('/stats', adminAuth, adminController.stats);
// Block 7 — the panel needs categories including inactive ones (the public
// route hides them), and a SKU suggestion to pre-fill ProductForm's SKU field.
router.get('/categories', adminAuth, adminController.listCategories);
router.get('/sku-suggestion', adminAuth, adminController.skuSuggestion);
module.exports = router;
