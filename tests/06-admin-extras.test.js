'use strict';
/**
 * tests/06-admin-extras.test.js — Block 7 backend additions acceptance test.
 *
 * Covers the two admin-panel endpoints added for the frontend admin (D32):
 *   GET /v1/admin/categories      — all categories INCLUDING inactive ones
 *   GET /v1/admin/sku-suggestion  — pre-fill for ProductForm's SKU field
 *
 * Same harness as every other test file: real server.js on an ephemeral
 * in-memory MongoDB, driven over HTTP with the admin cookie.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'development';
process.env.PORT = '5066';
process.env.HOST = '127.0.0.1';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.JWT_SECRET = 'test-secret-'.padEnd(64, 'x');
process.env.ADMIN_EMAIL = 'owner@alankar.me';
process.env.ADMIN_PASSWORD = 'Surat-Jewellery-2026';
const { MongoMemoryServer } = require('mongodb-memory-server');
let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`); }
}
(async () => {
  const TEST_DB_ROOT = process.env.ALANKAR_TEST_DB_DIR || path.join(require('os').tmpdir(), 'alankar-test-dbs');
  require('fs').mkdirSync(TEST_DB_ROOT, { recursive: true });
  const TEST_DB_PATH = path.join(TEST_DB_ROOT, `blk6-${process.pid}-${Date.now()}`);
  require('fs').mkdirSync(TEST_DB_PATH, { recursive: true });
  const mongod = await MongoMemoryServer.create({
    instance: { dbPath: TEST_DB_PATH, args: ['--wiredTigerCacheSizeGB', '0.25'] },
  });
  process.env.MONGODB_URI = mongod.getUri('alankar_test');
  const { start } = require(path.join(REPO, 'server.js'));
  const { run: runSeed } = require(path.join(REPO, 'seedAdmin.js'));
  const { seedCategories } = require(path.join(REPO, 'seedCategories.js'));
  const Product = require(path.join(REPO, 'src/models/product.model.js'));
  const server = await start();
  await seedCategories({ quiet: true });
  await Product.init();
  const base = 'http://127.0.0.1:5066/v1';
  const api = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') || '' };
  };
  // Log in once; reuse the cookie everywhere below.
  await runSeed({});
  const login = await api('POST', '/admin/login', {
    body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  });
  const cookie = (login.setCookie.match(/alankar_admin_token=[^;]+/) || [''])[0];
  check('login succeeded and returned a cookie', login.status === 200 && cookie.length > 30);
  console.log('\n--- 1. GET /v1/admin/categories ---');
  const noAuth = await api('GET', '/admin/categories');
  check('401 without a session', noAuth.status === 401, `got ${noAuth.status}`);
  const list = await api('GET', '/admin/categories', { cookie });
  check('200 with the admin cookie', list.status === 200, `got ${list.status}`);
  check('lists all 9 seeded categories', list.body?.data?.count === 9, `got ${list.body?.data?.count}`);
  // Deactivate one, then confirm the admin list still shows it while the public list hides it.
  const watches = list.body.data.categories.find((c) => c.slug === 'watches');
  const deactivated = await api('DELETE', `/categories/${watches.id}`, { cookie });
  check('deactivated Watches for the test', deactivated.status === 200, `got ${deactivated.status}`);
  const afterHide = await api('GET', '/admin/categories', { cookie });
  const hiddenRow = afterHide.body.data.categories.find((c) => c.slug === 'watches');
  check('admin list STILL contains the inactive category', Boolean(hiddenRow), 'watches missing from admin list');
  check('and reports isActive:false for it', hiddenRow && hiddenRow.isActive === false);
  const publicList = await api('GET', '/categories');
  check('public list hides it (unchanged behaviour)', !publicList.body.data.categories.some((c) => c.slug === 'watches'));
  check('admin rows expose id, name, slug, code, sortOrder', ['id', 'name', 'slug', 'code', 'sortOrder'].every((k) => k in (afterHide.body.data.categories[0] || {})));
  console.log('\n--- 2. GET /v1/admin/sku-suggestion ---');
  const sugNoAuth = await api('GET', '/admin/sku-suggestion?category=necklace');
  check('401 without a session', sugNoAuth.status === 401, `got ${sugNoAuth.status}`);
  const missing = await api('GET', '/admin/sku-suggestion', { cookie });
  check('400 when category is missing', missing.status === 400 && /category is required/i.test(missing.body.message), `got ${missing.status}`);
  const unknown = await api('GET', '/admin/sku-suggestion?category=nope-not-real', { cookie });
  check('404 for an unknown category', unknown.status === 404, `got ${unknown.status}`);
  const first = await api('GET', '/admin/sku-suggestion?category=necklace&styleHint=oxidised', { cookie });
  check('suggests NK-OX-001 for an empty sequence', first.body?.data?.suggestion === 'NK-OX-001', `got ${first.body?.data?.suggestion}`);
  check('response explains the field is editable', /editable/i.test(first.body?.data?.note || ''));
  // Create that product, then the suggestion must move to 002. The panel flow
  // sends the pre-filled SKU back explicitly — mirror that here.
  const created = await api('POST', '/products', {
    cookie,
    body: { name: 'Test Oxidised Haar', category: 'necklace', price: 500, mrp: 900, occasionTags: ['navratri'], sku: 'NK-OX-001' },
  });
  check('created a product with the suggested SKU', created.status === 201 && created.body?.data?.product?.sku === 'NK-OX-001', `got ${created.body?.data?.product?.sku}`);
  const second = await api('GET', '/admin/sku-suggestion?category=necklace&styleHint=oxidised', { cookie });
  check('next suggestion is NK-OX-002', second.body?.data?.suggestion === 'NK-OX-002', `got ${second.body?.data?.suggestion}`);
  // Category by ObjectId works too.
  const necklaceRow = afterHide.body.data.categories.find((c) => c.slug === 'necklace');
  const byId = await api('GET', `/admin/sku-suggestion?category=${necklaceRow.id}&styleHint=daily`, { cookie });
  check('accepts the category by id → NK-DA-001', byId.body?.data?.suggestion === 'NK-DA-001', `got ${byId.body?.data?.suggestion}`);
  const noHint = await api('GET', '/admin/sku-suggestion?category=earrings', { cookie });
  check('no styleHint → GEN style code (ER-GEN-001)', noHint.body?.data?.suggestion === 'ER-GEN-001', `got ${noHint.body?.data?.suggestion}`);
  const inactiveCat = await api('GET', '/admin/sku-suggestion?category=watches', { cookie });
  check('still answers for an inactive category (product create itself will refuse)', inactiveCat.status === 200, `got ${inactiveCat.status}`);
  console.log('\n--- 3. leak scan ---');
  const raw = JSON.stringify({ list: list.body, afterHide: afterHide.body, first: first.body });
  check('no passwordHash / deleteUrl / costPrice anywhere in the new responses', !/passwordHash|deleteUrl|delete_url|costPrice/i.test(raw));
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  server.close();
  const { disconnectDB } = require(path.join(REPO, 'src/config/db'));
  await disconnectDB().catch(() => {});
  await mongod.stop();
  require('fs').rmSync(TEST_DB_PATH, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  console.log(`\n==== ${pass} passed, ${fail + 1} failed ====`);
  process.exit(1);
});
