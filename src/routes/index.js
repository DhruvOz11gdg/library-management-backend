'use strict';
/**
 * src/routes/index.js
 * Aggregates every domain router and is mounted once, at `/v1`, in server.js.
 * Mirror of the legacy server-bil routes/index.js pattern: each block adds one
 * `router.use(...)` line here and nothing else in this file changes.
 *
 * Order of mounting does not matter yet (no wildcard routes), but keep the
 * specific paths above any future catch-all.
 */
const express = require('express');
const router = express.Router();
/* ------------------------------------------------------------------ *
 * Service index — handy sanity check that the API is up and which
 * environment it is talking to. Not part of the public product API.
 * ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  const { dbStatus } = require('../config/db');
  res.status(200).json({
    success: true,
    message: 'alankar.me API is running',
    data: {
      service: 'alankar-backend',
      version: 'v1',
      env: process.env.NODE_ENV || 'development',
      database: dbStatus(),
      time: new Date().toISOString(),
    },
  });
});
/* ------------------------------------------------------------------ *
 * Domain routers — uncommented as each block lands.
 * ------------------------------------------------------------------ */
// Block 2 — categories
router.use('/categories', require('./category.routes'));
// Block 3 — image upload (ImgBB)
router.use('/upload', require('./upload.routes'));
// Block 4 — products / SKUs
router.use('/products', require('./product.routes'));
// Block 5 — admin auth + admin-only operations
router.use('/admin', require('./admin.routes'));
// Block 10 — OrderIntent (Phase 2)
// router.use('/orders', require('./order.routes'));
module.exports = router;
