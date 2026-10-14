'use strict';
/**
 * src/utils/slugify.js
 * One slug implementation for the whole API — categories (Block 2), products
 * (Block 4) and anything later. Slugs are what the storefront puts in URLs
 * (`/products/nk-ox-001-peacock-choker`) and what `GET /v1/products?category=`
 * filters on, so they must be stable, lowercase and URL-safe.
 *
 *   "Bangles/Kadas"      → "bangles-kadas"
 *   "Navratri/Oxidised"  → "navratri-oxidised"
 *   "Chandbali & Jhumka" → "chandbali-and-jhumka"
 *   "  Kundan  Set  "    → "kundan-set"
 */
function slugify(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKD') // split accented characters into base + combining mark
    .replace(/[\u0300-\u036f]/g, '') // drop the combining marks
    .replace(/&/g, ' and ')
    .replace(/[^a-zA-Z0-9]+/g, '-') // everything non-alphanumeric → single dash
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
/**
 * Short uppercase code used to build SKUs (Block 4).
 * Multi-word names take the initials, single words the first two letters:
 *   "Bridal Sets"     → "BS"
 *   "Bangles/Kadas"   → "BK"
 *   "Necklace"        → "NE"
 * The admin-editable `code` field on a category overrides this whenever the
 * derived value is not what the store wants.
 */
function deriveCode(input) {
  if (typeof input !== 'string') return 'GEN';
  const words = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return 'GEN';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join('');
}
module.exports = slugify;
module.exports.slugify = slugify;
module.exports.deriveCode = deriveCode;
