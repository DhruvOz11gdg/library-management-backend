'use strict';
/**
 * src/services/sku.service.js
 * Auto-generates SKUs when the admin leaves the field blank.
 *
 * Format:  <CATEGORY_CODE>-<STYLE_CODE>-<SEQUENCE>     e.g. NK-OX-001
 *
 * Two deliberate departures from a naive implementation:
 *
 * 1. The category part comes from `Category.code` (NK, OX, BS …) rather than
 *    the first two letters of the name. Deriving from the name collides:
 *    "Bracelets" and "Bridal Sets" both give BR, so two unrelated categories
 *    would share one running sequence. (Decision D13.)
 *
 * 2. The next sequence number is the NUMERIC maximum, not the string-sorted
 *    last one. `sort({sku:-1})` is wrong past 999: as strings, "NK-OX-1000"
 *    sorts before "NK-OX-999", which would hand out a duplicate SKU.
 *
 * The admin can always type a manual SKU — this is only the pre-filled default.
 */
const Product = require('../models/product.model');
const { ApiError } = require('../utils/apiResponse');
const DEFAULT_CATEGORY_CODE = 'GEN';
const DEFAULT_STYLE_CODE = 'GEN';
const SEQUENCE_PAD = 3;
const SKU_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** "oxidised" → OX, "kundan" → KU, nothing usable → GEN */
function deriveStyleCode(styleHint) {
  if (!styleHint) return DEFAULT_STYLE_CODE;
  const letters = String(styleHint).normalize('NFKD').replace(/[^a-zA-Z]/g, '');
  if (letters.length < 2) return DEFAULT_STYLE_CODE;
  return letters.slice(0, 2).toUpperCase();
}
function normaliseCategoryCode(categoryCode) {
  const code = String(categoryCode || '').trim().toUpperCase().slice(0, 3);
  return code || DEFAULT_CATEGORY_CODE;
}
/** @returns {string} e.g. "NK-OX-001" */
async function generateSku({ categoryCode, styleHint } = {}) {
  const prefix = `${normaliseCategoryCode(categoryCode)}-${deriveStyleCode(styleHint)}-`;
  const existing = await Product.find({ sku: new RegExp(`^${escapeRegExp(prefix)}`) })
    .select('sku')
    .lean();
  let highest = 0;
  for (const row of existing) {
    const parsed = parseInt(String(row.sku).slice(prefix.length), 10);
    if (Number.isFinite(parsed) && parsed > highest) highest = parsed;
  }
  return `${prefix}${String(highest + 1).padStart(SEQUENCE_PAD, '0')}`;
}
/** Manual SKUs are allowed — they still have to look like SKUs. */
function normaliseManualSku(sku) {
  const value = String(sku || '').trim().toUpperCase();
  if (!value) throw ApiError.badRequest('SKU cannot be empty');
  if (value.length > 24 || !SKU_PATTERN.test(value)) {
    throw ApiError.badRequest(
      'SKU may contain only capital letters, numbers and dashes — for example NK-OX-001. ' +
        'Leave the field blank to let the system generate one.'
    );
  }
  return value;
}
module.exports = { generateSku, deriveStyleCode, normaliseCategoryCode, normaliseManualSku, SKU_PATTERN };
