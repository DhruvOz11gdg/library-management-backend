'use strict';
/**
 * alankar-backend/seedDemoProducts.js
 * Run any time (idempotent):  npm run seed:demo
 *
 * Creates the 8 sample products from src/data/seed-demo-products.json — the
 * same pieces the original static landing page showed — so the storefront has
 * realistic content before the owner photographs real stock.
 *
 * Idempotency rules (same philosophy as seedCategories.js):
 *  - matched by `slug` (derived from the product name); an existing product is
 *    LEFT UNTOUCHED — a re-seed never overwrites the owner's price/stock edits
 *  - goes through the REAL product.service.createProduct path, so SKUs are
 *    auto-generated exactly like they are from the admin panel
 *  - requires categories to exist first (run seedCategories.js / dev:demo)
 *
 * When real stock arrives, hide these from the admin panel (soft delete) —
 * nothing is ever hard-deleted.
 */
require('dotenv').config();
const { connectDB, disconnectDB } = require('./src/config/db');
const Product = require('./src/models/product.model');
const Category = require('./src/models/category.model');
const { createProduct } = require('./src/services/product.service');
const slugify = require('./src/utils/slugify');
const logger = require('./src/utils/logger');
const seedData = require('./src/data/seed-demo-products.json');
/**
 * @returns {Promise<{created: number, existing: number, results: Array}>}
 */
async function seedDemoProducts({ quiet = false } = {}) {
  const entries = Array.isArray(seedData) ? seedData : [];
  if (entries.length === 0) throw new Error('seed-demo-products.json is empty — nothing to seed');
  const results = [];
  for (const entry of entries) {
    const name = String(entry.name || '').trim();
    if (!name) throw new Error(`Demo seed entry is missing a name: ${JSON.stringify(entry)}`);
    const slug = slugify(name);
    const existing = await Product.findOne({ slug }).select('sku');
    if (existing) {
      results.push({ name, sku: existing.sku, action: 'exists (left untouched)' });
      continue;
    }
    const category = await Category.findOne({ slug: slugify(entry.categorySlug || '') });
    if (!category) {
      throw new Error(
        `Demo product "${name}" needs category slug "${entry.categorySlug}" — run seedCategories.js first`
      );
    }
    const created = await createProduct({
      name,
      category: category.slug,
      price: entry.price,
      mrp: entry.mrp,
      costPrice: entry.costPrice,
      stockQty: entry.stockQty === undefined ? 10 : entry.stockQty,
      occasionTags: entry.occasionTags || [],
      description: entry.description || '',
      colors: entry.colors || [],
      images: entry.image ? [{ url: entry.image }] : [],
      isFeatured: Boolean(entry.isFeatured),
      isBestseller: Boolean(entry.isBestseller),
    });
    results.push({ name, sku: created.sku, action: 'created' });
  }
  const created = results.filter((r) => r.action === 'created').length;
  const existing = results.length - created;
  if (!quiet) {
    logger.info('—'.repeat(72));
    for (const row of results) {
      logger.info(`  ${row.action.padEnd(26)} ${String(row.sku).padEnd(12)} ${row.name}`);
    }
    logger.info('—'.repeat(72));
    logger.info(`seedDemoProducts: ${created} created, ${existing} already existed (untouched)`);
  }
  return { created, existing, results };
}
if (require.main === module) {
  (async () => {
    try {
      await connectDB();
      await seedDemoProducts();
      await disconnectDB();
      process.exit(0);
    } catch (err) {
      logger.error(`seedDemoProducts failed: ${err.message}`);
      await disconnectDB().catch(() => {});
      process.exit(1);
    }
  })();
}
module.exports = { seedDemoProducts };
