'use strict';
/**
 * Import products from a CSV manifest and local image files.
 *
 * Usage:
 *   node bulkImportProducts.js "D:\\path\\to\\product_data" --dry-run
 *   node bulkImportProducts.js "D:\\path\\to\\product_data"
 *
 * The folder must contain products.csv and the images named in its imageFiles
 * column. No image analysis or AI service is used.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { connectDB, disconnectDB } = require('./src/config/db');
const Category = require('./src/models/category.model');
const Product = require('./src/models/product.model');
const UploadedImage = require('./src/models/uploadedImage.model');
const categoryService = require('./src/services/category.service');
const { createProduct } = require('./src/services/product.service');
const { compressImage } = require('./src/services/image.service');
const { uploadToImgbb } = require('./src/services/imgbb.service');
const slugify = require('./src/utils/slugify');

const MAX_IMAGES = 6;
const REQUIRED_COLUMNS = ['sku', 'name', 'category', 'price', 'mrp', 'stockQty', 'imageFiles'];
const OPTIONAL_COLUMNS = [
  'parentCategory', 'parentCategoryCode', 'parentCategoryDescription',
  'parentCategorySortOrder', 'categoryCode', 'categoryDescription',
  'categorySortOrder', 'slug', 'costPrice', 'lowStockAlert',
  'occasionTags', 'description', 'colors', 'isFeatured', 'isBestseller',
  'isActive',
];
const ALLOWED_IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif|gif)$/i;
const SKU_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      field = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV contains an unclosed quoted field');
  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function parseNumber(value, field, rowNumber, { required = false, integer = false, min = 0 } = {}) {
  const clean = String(value === undefined ? '' : value).trim();
  if (!clean) {
    if (required) throw new Error(`CSV row ${rowNumber}: "${field}" is required`);
    return undefined;
  }
  const parsed = Number(clean);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    const constraint = integer ? 'a whole number' : `a number greater than or equal to ${min}`;
    throw new Error(`CSV row ${rowNumber}: "${field}" must be ${constraint}`);
  }
  return parsed;
}

function parseBoolean(value, field, rowNumber, defaultValue) {
  const clean = String(value === undefined ? '' : value).trim().toLowerCase();
  if (!clean) return defaultValue;
  if (clean === 'true') return true;
  if (clean === 'false') return false;
  throw new Error(`CSV row ${rowNumber}: "${field}" must be true or false`);
}

function parseList(value) {
  return String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseManifest(text) {
  const records = parseCsv(text);
  if (records.length < 2) throw new Error('Manifest must contain a header and at least one product row');

  const headers = records[0].map((header) => header.replace(/^\uFEFF/, '').trim());
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length) throw new Error(`Duplicate CSV column: ${duplicateHeaders[0]}`);
  for (const column of REQUIRED_COLUMNS) {
    if (!headers.includes(column)) throw new Error(`Manifest is missing required column "${column}"`);
  }
  const unknownHeaders = headers.filter((header) => !REQUIRED_COLUMNS.includes(header) && !OPTIONAL_COLUMNS.includes(header));
  if (unknownHeaders.length) throw new Error(`Unknown CSV column "${unknownHeaders[0]}"`);

  const seenSkus = new Set();
  return records.slice(1).map((record, index) => {
    const rowNumber = index + 2;
    if (record.length !== headers.length) {
      throw new Error(`CSV row ${rowNumber} has ${record.length} cells; expected ${headers.length}`);
    }
    const input = Object.fromEntries(headers.map((header, cell) => [header, record[cell].trim()]));
    const sku = input.sku.toUpperCase();
    if (!sku || sku.length > 24 || !SKU_PATTERN.test(sku)) {
      throw new Error(`CSV row ${rowNumber}: "sku" must use letters, numbers and dashes (maximum 24 characters)`);
    }
    if (seenSkus.has(sku)) throw new Error(`CSV row ${rowNumber}: SKU "${sku}" is repeated in the manifest`);
    seenSkus.add(sku);

    const name = input.name.trim();
    const category = input.category.trim();
    const parentCategory = (input.parentCategory || '').trim();
    if (!name) throw new Error(`CSV row ${rowNumber}: "name" is required`);
    if (!category) throw new Error(`CSV row ${rowNumber}: "category" is required`);
    if (parentCategory && slugify(parentCategory) === slugify(category)) {
      throw new Error(`CSV row ${rowNumber}: parentCategory and category must be different categories`);
    }
    if (name.length > 120) throw new Error(`CSV row ${rowNumber}: product name cannot exceed 120 characters`);
    if (input.description && input.description.length > 2000) {
      throw new Error(`CSV row ${rowNumber}: description cannot exceed 2000 characters`);
    }

    const price = parseNumber(input.price, 'price', rowNumber, { required: true });
    const mrp = parseNumber(input.mrp, 'mrp', rowNumber, { required: true });
    if (mrp < price) throw new Error(`CSV row ${rowNumber}: mrp must be greater than or equal to price`);
    const stockQty = parseNumber(input.stockQty, 'stockQty', rowNumber, { required: true, integer: true });
    const costPrice = parseNumber(input.costPrice, 'costPrice', rowNumber);
    const lowStockAlert = parseNumber(input.lowStockAlert, 'lowStockAlert', rowNumber, { integer: true });

    const colors = parseList(input.colors).map((color) => color.startsWith('#') ? color : `#${color}`);
    const invalidColor = colors.find((color) => !HEX_COLOR.test(color));
    if (invalidColor) throw new Error(`CSV row ${rowNumber}: invalid hex color "${invalidColor}"`);

    const imageFiles = parseList(input.imageFiles);
    if (imageFiles.length === 0) throw new Error(`CSV row ${rowNumber}: add at least one filename to imageFiles`);
    if (imageFiles.length > MAX_IMAGES) {
      throw new Error(`CSV row ${rowNumber}: a product can have at most ${MAX_IMAGES} images`);
    }

    return {
      rowNumber,
      sku,
      name,
      slug: input.slug || undefined,
      parentCategory,
      parentCategoryCode: input.parentCategoryCode || undefined,
      parentCategoryDescription: input.parentCategoryDescription || '',
      parentCategorySortOrder: parseNumber(input.parentCategorySortOrder, 'parentCategorySortOrder', rowNumber, { integer: true }) || 0,
      category,
      categoryCode: input.categoryCode || undefined,
      categoryDescription: input.categoryDescription || '',
      categorySortOrder: parseNumber(input.categorySortOrder, 'categorySortOrder', rowNumber, { integer: true }) || 0,
      occasionTags: parseList(input.occasionTags).map((tag) => tag.toLowerCase()),
      description: input.description || '',
      price,
      mrp,
      costPrice: costPrice === undefined ? 0 : costPrice,
      stockQty,
      lowStockAlert: lowStockAlert === undefined ? 3 : lowStockAlert,
      colors,
      isFeatured: parseBoolean(input.isFeatured, 'isFeatured', rowNumber, false),
      isBestseller: parseBoolean(input.isBestseller, 'isBestseller', rowNumber, false),
      isActive: parseBoolean(input.isActive, 'isActive', rowNumber, true),
      imageFiles,
    };
  });
}

function resolveImagePaths(folderPath, rows) {
  const base = path.resolve(folderPath);
  const referenced = new Set();
  for (const row of rows) {
    for (const fileName of row.imageFiles) {
      if (path.basename(fileName) !== fileName || /[\\/]/.test(fileName)) {
        throw new Error(`CSV row ${row.rowNumber}: imageFiles must contain filenames only, not paths ("${fileName}")`);
      }
      if (!ALLOWED_IMAGE_EXTENSION.test(fileName)) {
        throw new Error(`CSV row ${row.rowNumber}: unsupported image type for "${fileName}"`);
      }
      const filePath = path.resolve(base, fileName);
      const relativePath = path.relative(base, filePath);
      if (
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error(`CSV row ${row.rowNumber}: image file is outside the selected folder`);
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`CSV row ${row.rowNumber}: image file not found: ${fileName}`);
      }
      referenced.add(fileName.toLowerCase());
    }
  }
  return referenced;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findCategoryByName(name) {
  const escapedName = escapeRegExp(name.trim());
  return Category.findOne({
    $or: [
      { slug: slugify(name) },
      { name: new RegExp(`^${escapedName}$`, 'i') },
    ],
  });
}

async function ensureCategory({ name, code, description, sortOrder, parent = null }) {
  let category = await findCategoryByName(name);
  if (!category) {
    const created = await categoryService.createCategory({
      name,
      code,
      description,
      sortOrder,
      parentCategory: parent ? parent._id : null,
      isActive: true,
    });
    category = await Category.findById(created.id);
  }
  if (!category) throw new Error(`Could not load category "${name}" after creating it`);
  if (category.isActive === false) {
    throw new Error(`Category "${category.name}" is inactive; activate it before importing products`);
  }
  const expectedParentId = parent ? String(parent._id) : null;
  const actualParentId = category.parentCategory ? String(category.parentCategory) : null;
  if (actualParentId !== expectedParentId) {
    const expected = parent ? `subcategory of "${parent.name}"` : 'top-level category';
    throw new Error(`Existing category "${category.name}" is not the expected ${expected}`);
  }
  return category;
}

async function ensureProductCategories(row) {
  const parent = row.parentCategory
    ? await ensureCategory({
      name: row.parentCategory,
      code: row.parentCategoryCode,
      description: row.parentCategoryDescription,
      sortOrder: row.parentCategorySortOrder,
    })
    : null;
  return ensureCategory({
    name: row.category,
    code: row.categoryCode,
    description: row.categoryDescription,
    sortOrder: row.categorySortOrder,
    parent,
  });
}

async function uploadImage(filePath, sku) {
  const original = fs.readFileSync(filePath);
  const compressed = await compressImage(original);
  const uploaded = await uploadToImgbb(compressed.buffer, `${sku.toLowerCase()}-${path.basename(filePath, path.extname(filePath))}`);
  const image = {
    url: uploaded.url,
    thumbUrl: uploaded.thumbUrl || uploaded.url,
  };
  await UploadedImage.findOneAndUpdate(
    { url: image.url },
    {
      $set: {
        ...image,
        deleteUrl: uploaded.deleteUrl || '',
        filename: path.basename(filePath, path.extname(filePath)),
        size: uploaded.size || compressed.size,
        originalSize: compressed.originalSize,
        width: uploaded.width || compressed.width,
        height: uploaded.height || compressed.height,
        imgbbId: uploaded.imgbbId || '',
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return image;
}

async function importManifest(folderPath, { manifestPath, dryRun = false } = {}) {
  const base = path.resolve(folderPath);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`Image folder not found: ${base}`);
  }
  const csvPath = path.resolve(manifestPath || path.join(base, 'products.csv'));
  if (!fs.existsSync(csvPath) || !fs.statSync(csvPath).isFile()) {
    throw new Error(`Manifest not found: ${csvPath}`);
  }

  const rows = parseManifest(fs.readFileSync(csvPath, 'utf8'));
  resolveImagePaths(base, rows);
  const existingProducts = await Product.find({ sku: { $in: rows.map((row) => row.sku) } })
    .select('sku name')
    .lean();
  const existingBySku = new Map(existingProducts.map((product) => [product.sku, product]));

  const results = [];
  for (const row of rows) {
    const existing = existingBySku.get(row.sku);
    if (existing) {
      if (existing.name.trim().toLowerCase() !== row.name.trim().toLowerCase()) {
        throw new Error(
          `CSV row ${row.rowNumber}: SKU "${row.sku}" already belongs to "${existing.name}", not "${row.name}"`
        );
      }
      results.push({ row: row.rowNumber, sku: row.sku, name: row.name, action: 'exists; skipped', existingName: existing.name });
      continue;
    }

    if (dryRun) {
      results.push({
        row: row.rowNumber,
        sku: row.sku,
        name: row.name,
        parentCategory: row.parentCategory || null,
        category: row.category,
        images: row.imageFiles,
        action: 'dry-run; no changes made',
      });
      continue;
    }

    const category = await ensureProductCategories(row);
    const images = [];
    for (let index = 0; index < row.imageFiles.length; index += 1) {
      const imagePath = path.join(base, row.imageFiles[index]);
      const uploaded = await uploadImage(imagePath, row.sku);
      images.push({ ...uploaded, isPrimary: index === 0 });
    }

    const product = await createProduct({
      sku: row.sku,
      name: row.name,
      slug: row.slug,
      category: category.slug,
      occasionTags: row.occasionTags,
      description: row.description,
      price: row.price,
      mrp: row.mrp,
      costPrice: row.costPrice,
      stockQty: row.stockQty,
      lowStockAlert: row.lowStockAlert,
      colors: row.colors,
      images,
      isFeatured: row.isFeatured,
      isBestseller: row.isBestseller,
      isActive: row.isActive,
    });
    results.push({
      row: row.rowNumber,
      sku: product.sku,
      name: product.name,
      category: category.name,
      imageCount: images.length,
      action: 'created',
    });
  }
  return results;
}

async function main() {
  const folderPath = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  const manifestIndex = process.argv.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
  if (!folderPath || (manifestIndex >= 0 && !manifestPath)) {
    console.error(
      'Usage: node bulkImportProducts.js "<image-folder>" [--manifest "<csv-path>"] [--dry-run]'
    );
    process.exitCode = 1;
    return;
  }

  try {
    await connectDB();
    const results = await importManifest(folderPath, { manifestPath, dryRun });
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(`Bulk product import failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseCsv, parseManifest, resolveImagePaths, importManifest };
