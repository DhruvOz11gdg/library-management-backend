'use strict';
/**
 * alankar-backend/seedCategories.js
 * Run once (or any time — it is idempotent):  node seedCategories.js
 *
 * Loads src/data/seed-categories.json into MongoDB.
 *
 * Idempotency rules, deliberately chosen for a shop that will be edited daily:
 *  - matched by `slug` (the stable identifier, not the display name)
 *  - a category that already exists is LEFT UNTOUCHED. Re-running the seed must
 *    never undo the owner's edits — his sortOrder, renamed category, new photo
 *    or deactivation all stay exactly as he left them.
 *  - entries with `parentSlug` are linked to their parent (pass 1 creates
 *    parents, pass 2 links children, so file order inside a level does not matter)
 */
require('dotenv').config();
const { connectDB, disconnectDB } = require('./src/config/db');
const Category = require('./src/models/category.model');
const slugify = require('./src/utils/slugify');
const logger = require('./src/utils/logger');
const seedData = require('./src/data/seed-categories.json');
/**
 * @returns {Promise<{created: number, existing: number, results: Array}>}
 */
async function seedCategories({ quiet = false } = {}) {
  const entries = Array.isArray(seedData) ? seedData : seedData.categories || [];
  if (entries.length === 0) throw new Error('seed-categories.json is empty — nothing to seed');
  const bySlug = new Map();
  const results = [];
  // Pass 1 — create/collect every category (parents first, in file order).
  for (const entry of entries) {
    const name = String(entry.name || '').trim();
    if (!name) throw new Error(`Seed entry is missing a name: ${JSON.stringify(entry)}`);
    const slug = slugify(entry.slug || name);
    const existing = await Category.findOne({ slug });
    if (existing) {
      bySlug.set(slug, existing);
      results.push({ name, slug, action: 'exists (left untouched)' });
      continue;
    }
    const created = await Category.create({
      name,
      slug,
      code: entry.code,
      description: entry.description || '',
      sortOrder: Number.isFinite(Number(entry.sortOrder)) ? Number(entry.sortOrder) : 0,
      isActive: entry.isActive === undefined ? true : Boolean(entry.isActive),
    });
    bySlug.set(slug, created);
    results.push({ name, slug, action: 'created' });
  }
  // Pass 2 — link subcategories to parents (only where the link is missing).
  for (const entry of entries) {
    if (!entry.parentSlug) continue;
    const slug = slugify(entry.slug || entry.name);
    const child = bySlug.get(slug);
    const parentSlug = slugify(entry.parentSlug);
    const parent = bySlug.get(parentSlug) || (await Category.findOne({ slug: parentSlug }));
    if (!parent) throw new Error(`"${entry.name}" references parentSlug "${entry.parentSlug}", which does not exist`);
    if (!child.parentCategory) {
      child.parentCategory = parent._id;
      await child.save();
      const row = results.find((r) => r.slug === slug);
      if (row) row.action = `${row.action} + linked to ${parent.name}`;
    }
  }
  const created = results.filter((r) => r.action.startsWith('created')).length;
  const existing = results.length - created;
  if (!quiet) {
    logger.info('—'.repeat(72));
    for (const row of results) {
      logger.info(`  ${row.action.padEnd(34)} ${row.name.padEnd(20)} /${row.slug}`);
    }
    logger.info('—'.repeat(72));
    logger.info(`seedCategories: ${created} created, ${existing} already existed (untouched)`);
  }
  return { created, existing, results };
}
if (require.main === module) {
  (async () => {
    try {
      await connectDB();
      await seedCategories();
      await disconnectDB();
      process.exit(0);
    } catch (err) {
      logger.error('seedCategories failed', err);
      await disconnectDB().catch(() => {});
      process.exit(1);
    }
  })();
}
module.exports = { seedCategories };
