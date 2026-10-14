/**
 * tests/04-products.test.js — Block 4 acceptance test.
 * Real API boot on an ephemeral Mongo, driven over HTTP.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'development';
process.env.PORT = '5059';
process.env.HOST = '127.0.0.1';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.JWT_SECRET = 'test-secret-'.padEnd(64, 'x');
const { MongoMemoryServer } = require('mongodb-memory-server');
let pass = 0, fail = 0;
let adminCookie = ''; // Block 5 locked the write routes behind admin auth
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`); }
}
/** Recursively collect keys/values so a leak cannot hide in a nested object. */
function deepScan(value, predicate, pathStr = 'root', hits = []) {
  if (value === null || value === undefined) return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => deepScan(v, predicate, `${pathStr}[${i}]`, hits));
    return hits;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (predicate(key, val)) hits.push(`${pathStr}.${key}`);
      deepScan(val, predicate, `${pathStr}.${key}`, hits);
    }
  }
  return hits;
}
(async () => {
  // Ephemeral Mongo data dir (override with ALANKAR_TEST_DB_DIR if your temp drive is small).
  const TEST_DB_ROOT = process.env.ALANKAR_TEST_DB_DIR || path.join(require('os').tmpdir(), 'alankar-test-dbs');
  require('fs').mkdirSync(TEST_DB_ROOT, { recursive: true });
  const TEST_DB_PATH = path.join(TEST_DB_ROOT, `blk-${process.pid}-${Date.now()}`);
  require('fs').mkdirSync(TEST_DB_PATH, { recursive: true });
  const mongod = await MongoMemoryServer.create({
    instance: { dbPath: TEST_DB_PATH, args: ['--wiredTigerCacheSizeGB', '0.25'] },
  });
  process.env.MONGODB_URI = mongod.getUri('alankar_test');
  const { start } = require(path.join(REPO, 'server.js'));
  const Product = require(path.join(REPO, 'src/models/product.model.js'));
  const Category = require(path.join(REPO, 'src/models/category.model.js'));
  const UploadedImage = require(path.join(REPO, 'src/models/uploadedImage.model.js'));
  const { seedCategories } = require(path.join(REPO, 'seedCategories.js'));
  const server = await start();
  await seedCategories({ quiet: true });
  await Product.init(); // make sure the text index exists before searching
  const base = 'http://127.0.0.1:5059/v1';
  // Block 5 locked the mutating routes behind adminAuth — sign in first.
  process.env.ADMIN_EMAIL = 'catalogue-test@alankar.me';
  process.env.ADMIN_PASSWORD = 'Test-Admin-Pass-2026';
  const { run: runSeedAdmin } = require(path.join(REPO, 'seedAdmin.js'));
  await runSeedAdmin();
  const loginRes = await fetch(`${base}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  adminCookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  if (!adminCookie) throw new Error('test setup: could not obtain an admin session');
  const api = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(adminCookie ? { Cookie: adminCookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const newProduct = (over = {}) => ({
    name: 'Peacock Choker Necklace', category: 'necklace', price: 450, mrp: 899,
    stockQty: 5, occasionTags: ['navratri', 'wedding'], ...over,
  });
  console.log('\n--- 1. SKU generation (auto + manual) ---');
  let r = await api('POST', '/products', newProduct({ occasionTags: ['oxidised'] }));
  check('create → 201', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  const a = r.body.data.product;
  check('SKU auto-generated NK-OX-001', a.sku === 'NK-OX-001', a.sku);
  check('slug derived from the name', a.slug === 'peacock-choker-necklace', a.slug);
  check('create response is the ADMIN shape (has costPrice)', 'costPrice' in a, Object.keys(a).join(','));
  r = await api('POST', '/products', newProduct({ name: 'Oxidised Jhumka', category: 'earrings', occasionTags: ['oxidised'] }));
  const b = r.body.data.product;
  check('Earrings → ER-OX-001 (category code from Category.code)', b.sku === 'ER-OX-001', b.sku);
  r = await api('POST', '/products', newProduct({ name: 'Kundan Bridal Set', category: 'bridal-sets', price: 1200, mrp: 1500, occasionTags: ['wedding'] }));
  const c = r.body.data.product;
  check('first occasion tag becomes the style code: BS-WE-001', c.sku === 'BS-WE-001', c.sku);
  r = await api('POST', '/products', newProduct({ name: 'Plain Bridal Set', category: 'bridal-sets', price: 800, mrp: 999, occasionTags: [] }));
  check('no style hint and no tags → GEN: BS-GEN-001', r.body.data.product.sku === 'BS-GEN-001', r.body.data.product.sku);
  r = await api('POST', '/products', newProduct({ name: 'Pearl Bangles', category: 'bangles-kadas', sku: 'my-custom-9' }));
  check('manual SKU accepted + uppercased → MY-CUSTOM-9', r.status === 201 && r.body.data.product.sku === 'MY-CUSTOM-9', `${r.status} ${r.body.data?.product?.sku}`);
  r = await api('POST', '/products', newProduct({ name: 'Another', sku: 'MY-CUSTOM-9' }));
  check('duplicate manual SKU → 409 naming the existing product', r.status === 409 && /Pearl Bangles/.test(r.body.message), `${r.status} ${r.body.message}`);
  r = await api('POST', '/products', newProduct({ name: 'Bad sku', sku: 'has spaces!' }));
  check('malformed SKU → 400 with the allowed format', r.status === 400 && /capital letters/.test(r.body.message), r.body.message);
  // Sequence must be a NUMERIC max, not a string sort ("NK-OX-1000" < "NK-OX-999" as strings).
  await Product.create({ sku: 'NK-OX-1000', name: 'Future product', slug: 'future-product', category: (await Category.findOne({ slug: 'necklace' }))._id, price: 10, mrp: 20 });
  r = await api('POST', '/products', newProduct({ name: 'After 999', occasionTags: ['oxidised'] }));
  check('sequence past 999 is correct (NK-OX-1001, not a duplicate)', r.body.data.product.sku === 'NK-OX-1001', r.body.data.product.sku);
  console.log('\n--- 2. validation the owner will actually trigger ---');
  r = await api('POST', '/products', newProduct({ name: '' }));
  check('missing name → 400', r.status === 400 && /name is required/i.test(r.body.message), r.body.message);
  r = await api('POST', '/products', newProduct({ price: undefined }));
  check('missing price → 400', r.status === 400 && /price is required/i.test(r.body.message), r.body.message);
  r = await api('POST', '/products', newProduct({ mrp: 100, price: 450 }));
  check('MRP below selling price → 400 with a plain-English reason', r.status === 400 && /higher one/.test(r.body.message), r.body.message);
  r = await api('POST', '/products', newProduct({ stockQty: -5 }));
  check('negative stock → 400', r.status === 400, r.body.message);
  r = await api('POST', '/products', newProduct({ stockQty: 2.5 }));
  check('fractional stock → 400 (whole number)', r.status === 400 && /whole number/.test(r.body.message), r.body.message);
  r = await api('POST', '/products', newProduct({ category: 'no-such-category' }));
  check('unknown category → 400', r.status === 400 && /Category not found/.test(r.body.message), r.body.message);
  r = await api('POST', '/products', newProduct({ colors: ['red'] }));
  check('non-hex colour → 400 explaining the format', r.status === 400 && /hex codes/.test(r.body.message), r.body.message);
  r = await api('POST', '/products', newProduct({ images: Array.from({ length: 7 }, (_, i) => ({ url: `https://i.ibb.co/x/${i}.jpg` })) }));
  check('7 images → 400 (limit 6)', r.status === 400 && /at most 6/.test(r.body.message), r.body.message);
  r = await api('POST', '/products', newProduct({ images: [{ url: '/local/file.jpg' }] }));
  check('relative image URL → 400', r.status === 400 && /full http/.test(r.body.message), r.body.message);
  console.log('\n--- 3. images: primary handling + deleteUrl re-attachment (D21) ---');
  await UploadedImage.create({ url: 'https://i.ibb.co/real/one.jpg', thumbUrl: 'https://i.ibb.co/real/one-t.jpg', deleteUrl: 'https://ibb.co/DELETE-SECRET-1' });
  await UploadedImage.create({ url: 'https://i.ibb.co/real/two.jpg', thumbUrl: 'https://i.ibb.co/real/two-t.jpg', deleteUrl: 'https://ibb.co/DELETE-SECRET-2' });
  r = await api('POST', '/products', newProduct({
    name: 'Imaged Product', category: 'rings', occasionTags: ['daily'],
    images: [{ url: 'https://i.ibb.co/real/one.jpg', thumbUrl: 'https://i.ibb.co/real/one-t.jpg' },
             { url: 'https://i.ibb.co/real/two.jpg', thumbUrl: 'https://i.ibb.co/real/two-t.jpg', isPrimary: true }],
  }));
  const imaged = r.body.data.product;
  check('exactly one primary, primary ordered first', imaged.images[0].url.endsWith('two.jpg') && imaged.images.filter((i) => i.isPrimary).length === 1, JSON.stringify(imaged.images.map((i) => `${i.url.slice(-8)}:${i.isPrimary}`)));
  check('admin shape carries deleteUrl (re-attached server-side)', imaged.images[0].deleteUrl === 'https://ibb.co/DELETE-SECRET-2', imaged.images[0].deleteUrl);
  check('admin card field `image` = primary url', imaged.image.endsWith('two.jpg'), imaged.image);
  const stamped = await UploadedImage.findOne({ url: 'https://i.ibb.co/real/two.jpg' });
  check('media library stamped with productId', String(stamped.productId) === String(imaged.id));
  console.log('\n--- 4. PUBLIC responses must never leak costPrice or deleteUrl ---');
  await api('PUT', `/products/${imaged.id}`, { costPrice: 210 });
  let res = await api('GET', '/products');
  let leaks = deepScan(res.body, (key, val) => /delete/i.test(key) || /cost/i.test(key) || (typeof val === 'string' && val.includes('DELETE-SECRET')));
  check('GET /v1/products: no cost/delete fields anywhere', leaks.length === 0, leaks.join(', '));
  res = await api('GET', `/products/${imaged.slug}`);
  leaks = deepScan(res.body, (key, val) => /delete/i.test(key) || /cost/i.test(key) || (typeof val === 'string' && val.includes('DELETE-SECRET')));
  check('GET /v1/products/:slug: clean too', leaks.length === 0, leaks.join(', '));
  check('public detail still exposes images + image + thumbUrl', res.body.data.product.images.length === 2 && !!res.body.data.product.image);
  check('discountPercent computed for the strike-through (mrp 899 / price 450)', res.body.data.product.discountPercent === Math.round(((899 - 450) / 899) * 100));
  console.log('\n--- 5. filters, search, sort, pagination ---');
  await api('POST', '/products', newProduct({ name: 'Daily Wear Studs', category: 'earrings', price: 250, mrp: 250, occasionTags: ['daily'], isFeatured: true }));
  await api('POST', '/products', newProduct({ name: 'Navratri Anklet', category: 'necklace', price: 1200, mrp: 1500, occasionTags: ['navratri'], isBestseller: true }));
  let list = (await api('GET', '/products')).body;
  check('unfiltered list returns active products only', list.data.products.length >= 6 && list.data.meta.total >= 6, `total=${list.data.meta.total}`);
  list = (await api('GET', '/products?category=earrings')).body;
  check('?category=earrings filters by slug', list.data.products.every((p) => p.category.slug === 'earrings') && list.data.products.length === 2, `${list.data.products.length}`);
  list = (await api('GET', '/products?occasion=oxidised')).body;
  check('?occasion=oxidised matches every tagged product', list.data.products.length === 3 && list.data.products.every((p) => p.occasionTags.includes('oxidised')), `${list.data.products.length}`);
  list = (await api('GET', '/products?minPrice=400&maxPrice=1300')).body;
  check('?minPrice/?maxPrice range', list.data.products.every((p) => p.price >= 400 && p.price <= 1300), list.data.products.map((p) => p.price).join(','));
  list = (await api('GET', '/products?featured=true')).body;
  check('?featured=true', list.data.products.length === 1 && list.data.products[0].name === 'Daily Wear Studs', `${list.data.products.length}`);
  list = (await api('GET', '/products?bestseller=true')).body;
  check('?bestseller=true', list.data.products.length === 1 && list.data.products[0].name === 'Navratri Anklet');
  list = (await api('GET', '/products?sort=price_asc')).body;
  const prices = list.data.products.map((p) => p.price);
  check('?sort=price_asc ascending', prices.join(',') === [...prices].sort((x, y) => x - y).join(','), prices.join(','));
  list = (await api('GET', '/products?sort=price_desc')).body;
  const pricesDesc = list.data.products.map((p) => p.price);
  check('?sort=price_desc descending', pricesDesc.join(',') === [...pricesDesc].sort((x, y) => y - x).join(','), pricesDesc.join(','));
  list = (await api('GET', '/products?search=choker')).body;
  check('?search=choker uses the text index', list.data.meta.searchMode === 'text' && list.data.products.length === 1, `${list.data.meta.searchMode} ${list.data.products.length}`);
  list = (await api('GET', '/products?search=neck')).body;
  check('?search=neck falls back to partial match', list.data.meta.searchMode === 'partial' && list.data.products.some((p) => /Necklace/.test(p.name)), `${list.data.meta.searchMode} ${list.data.products.map((p) => p.name).join('|')}`);
  list = (await api('GET', `/products?search=${c.sku}`)).body;
  check(`search by full SKU (${c.sku}) finds it via the partial fallback`, list.data.products.some((p) => p.sku === c.sku), list.data.products.map((p) => p.sku).join(','));
  list = (await api('GET', '/products?search=zzzznothing')).body;
  check('no matches → empty array + total 0 (not an error)', list.data.products.length === 0 && list.data.meta.total === 0);
  list = (await api('GET', '/products?page=1&limit=2')).body;
  check('pagination: limit honoured + meta', list.data.products.length === 2 && list.data.meta.limit === 2 && list.data.meta.hasMore === true, JSON.stringify(list.data.meta));
  const page2 = (await api('GET', '/products?page=2&limit=2')).body;
  check('page 2 returns a different set', page2.data.products[0].id !== list.data.products[0].id);
  r = await api('GET', '/products?sort=bogus');
  check('bad sort → 400 listing the options', r.status === 400 && /price_asc/.test(r.body.message), r.body.message);
  r = await api('GET', '/products?limit=500');
  check('limit above the cap → 400', r.status === 400 && /60/.test(r.body.message), r.body.message);
  r = await api('GET', '/products?minPrice=abc');
  check('non-numeric minPrice → 400', r.status === 400, r.body.message);
  r = await api('GET', '/products?minPrice=1000&maxPrice=100');
  check('minPrice > maxPrice → 400', r.status === 400 && /greater than maxPrice/.test(r.body.message), r.body.message);
  console.log('\n--- 6. detail lookup + visibility ---');
  r = await api('GET', '/products/peacock-choker-necklace');
  check('detail by slug → 200', r.status === 200 && r.body.data.product.sku === 'NK-OX-001', String(r.status));
  r = await api('GET', '/products/NK-OX-001');
  check('detail by SKU works (WhatsApp links use SKUs)', r.status === 200 && r.body.data.product.slug === 'peacock-choker-necklace', String(r.status));
  r = await api('GET', '/products/nope-nope');
  check('unknown slug → 404', r.status === 404, String(r.status));
  console.log('\n--- 7. updates ---');
  r = await api('PUT', `/products/${a.id}`, { price: 399, mrp: 899 });
  check('price update accepted', r.status === 200 && r.body.data.product.price === 399);
  r = await api('PUT', `/products/${a.id}`, { mrp: 300 });
  check('MRP below the existing price → 400 (cross-field check on partial update)', r.status === 400 && /higher one/.test(r.body.message), r.body.message);
  r = await api('PUT', `/products/${a.id}`, {});
  check('empty update → 400 listing allowed fields', r.status === 400 && /No updatable fields/.test(r.body.message), r.body.message);
  r = await api('PUT', `/products/${a.id}`, { sku: c.sku });
  check('SKU changed to an existing one → 409 naming the holder', r.status === 409 && /Kundan Bridal Set/.test(r.body.message), `${r.status} ${r.body.message}`);
  r = await api('PUT', '0123456789abcdef01234567', { price: 1 });
  check('unknown id → 404', r.status === 404, String(r.status));
  r = await api('PUT', `/products/${a.id}`, { costPrice: 150, stockQty: 2, lowStockAlert: 3, isFeatured: true, colors: ['#A62B4D'] });
  check('admin fields update together', r.status === 200 && r.body.data.product.costPrice === 150 && r.body.data.product.colors[0] === '#A62B4D');
  check('low-stock flag computed from stock <= alert', r.body.data.product.isLowStock === true);
  check('margin computed for the admin (price 399, cost 150)', r.body.data.product.margin === Math.round(((399 - 150) / 399) * 100), String(r.body.data.product.margin));
  console.log('\n--- 8. soft delete + category guard ---');
  r = await api('DELETE', `/products/${b.id}`);
  check('DELETE product → hidden, not removed', r.status === 200 && r.body.data.product.isActive === false);
  check('row still in the database', (await Product.countDocuments({ _id: b.id })) === 1);
  r = await api('GET', '/products?category=earrings&search=Jhumka');
  check('hidden product gone from the public list', !r.body.data.products.some((p) => p.slug === 'oxidised-jhumka'), r.body.data.products.map((p) => p.slug).join(','));
  r = await api('GET', '/products/oxidised-jhumka');
  check('hidden product → 404 on public detail', r.status === 404, String(r.status));
  r = await api('DELETE', `/products/${b.id}`);
  check('second DELETE is idempotent', r.status === 200 && /already hidden/.test(r.body.message), r.body.message);
  const ringsCategory = await Category.findOne({ slug: 'rings' });
  r = await api('DELETE', `/categories/${ringsCategory._id}`);
  check('deactivating a category with live products → 409 (Block 2 guard)', r.status === 409 && /1 active product/.test(r.body.message), `${r.status} ${r.body.message}`);
  r = await api('DELETE', `/categories/${ringsCategory._id}?force=true`);
  check('force=true overrides the guard and reports what it hid', r.status === 200 && /1 product/.test(r.body.message), r.body.message);
  r = await api('GET', '/products?category=rings');
  check('products of a force-hidden category are unreachable, even by slug', r.status === 200 && r.body.data.products.length === 0, `${r.status} n=${r.body.data.products?.length}`);
  r = await api('GET', '/products/imaged-product');
  check('…and their detail page 404s', r.status === 404, String(r.status));
  r = await api('GET', '/products');
  check('…and they are absent from the unfiltered list', !r.body.data.products.some((p) => p.slug === 'imaged-product'));
  await api('PUT', `/categories/${ringsCategory._id}`, { isActive: true });
  await api('PUT', `/products/${imaged.id}`, { isActive: false });
  console.log('\n--- 9. creating into an inactive category ---');
  const temp = await Category.create({ name: 'Temporary', slug: 'temporary', code: 'TP', isActive: false });
  r = await api('POST', '/products', newProduct({ name: 'Into hidden category', category: 'temporary' }));
  check('product into an inactive category → 400 with guidance', r.status === 400 && /inactive/.test(r.body.message), r.body.message);
  await Category.deleteOne({ _id: temp._id });
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  server.close();
  await require(path.join(REPO, 'src/config/db.js')).disconnectDB();
  await mongod.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('TEST HARNESS ERROR', err); process.exit(2); });
