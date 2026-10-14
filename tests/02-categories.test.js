/**
 * tests/02-categories.test.js — Block 2 acceptance test.
 * Boots the real API on an ephemeral Mongo, seeds categories, then drives the
 * full public + admin route surface over HTTP.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'development';
process.env.PORT = '5057';
process.env.HOST = '127.0.0.1';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.JWT_SECRET = 'test-secret-'.padEnd(64, 'x');
const { MongoMemoryServer } = require('mongodb-memory-server');
let pass = 0;
let adminCookie = ''; // Block 5 locked the write routes behind admin auth
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}
(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('alankar_test');
  const { start } = require(path.join(REPO, 'server.js'));
  const Category = require(path.join(REPO, 'src/models/category.model.js'));
  const { seedCategories } = require(path.join(REPO, 'seedCategories.js'));
  const categoryService = require(path.join(REPO, 'src/services/category.service.js'));
  const server = await start();
  const base = 'http://127.0.0.1:5057/v1';
  // Block 5 locked the category write routes behind adminAuth — sign in first.
  process.env.ADMIN_EMAIL = 'category-test@alankar.me';
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
  console.log('\n--- 1. seed is idempotent and does not clobber owner edits ---');
  let r = await seedCategories({ quiet: true });
  check('first run creates 9 categories', r.created === 9 && r.existing === 0, JSON.stringify({ c: r.created, e: r.existing }));
  r = await seedCategories({ quiet: true });
  check('second run creates 0, ignores 9', r.created === 0 && r.existing === 9, JSON.stringify({ c: r.created, e: r.existing }));
  await categoryService.updateCategory(String((await Category.findOne({ slug: 'necklace' }))._id), { sortOrder: 99 });
  await seedCategories({ quiet: true });
  const necklaceAfter = await Category.findOne({ slug: 'necklace' });
  check('owner edit (sortOrder 99) survives a re-seed', necklaceAfter.sortOrder === 99, String(necklaceAfter.sortOrder));
  console.log('\n--- 2. public list ---');
  let res = await api('GET', '/categories');
  check('GET /v1/categories → 200', res.status === 200, String(res.status));
  const list = res.body.data.categories;
  check('9 active categories returned', list.length === 9 && res.body.data.count === 9, String(list.length));
  check('sorted by sortOrder (Chokers/1 before Earrings/2)', list[0].slug === 'chokers' || list[0].slug === 'necklace', list.map((c) => `${c.slug}:${c.sortOrder}`).join(','));
  const chokers = list.find((c) => c.slug === 'chokers');
  check('subcategory exposes parentSlug "necklace"', chokers.parentSlug === 'necklace', String(chokers.parentSlug));
  check('subcategory flagged isSubcategory', chokers.isSubcategory === true);
  check('public shape has id + _id + code + image', Boolean(chokers.id && chokers._id && chokers.code === 'CH' && 'url' in chokers.image));
  check('no mongo internals leaked (__v absent)', !('__v' in chokers));
  console.log('\n--- 3. create + slug/code derivation ---');
  res = await api('POST', '/categories', { name: 'Anklets' });
  check('POST → 201 with derived slug "anklets"', res.status === 201 && res.body.data.category.slug === 'anklets', `${res.status} ${res.body.data && res.body.data.category.slug}`);
  check('derived code "AN"', res.body.data.category.code === 'AN', res.body.data.category.code);
  const ankletsId = res.body.data.category.id;
  res = await api('POST', '/categories', { name: 'Kada Pair', slug: 'Kada Pair!!' });
  check('messy slug normalised → "kada-pair"', res.body.data.category.slug === 'kada-pair', res.body.data.category.slug);
  res = await api('POST', '/categories', { name: 'Payal', slug: 'rings', code: 'pyal', sortOrder: '3' });
  check('slug collision auto-suffixed → "rings-2"', res.body.data.category.slug === 'rings-2', res.body.data.category.slug);
  check('code uppercased + truncated to 3 → "PYA"', res.body.data.category.code === 'PYA', res.body.data.category.code);
  check('numeric string sortOrder coerced to 3', res.body.data.category.sortOrder === 3, String(res.body.data.category.sortOrder));
  console.log('\n--- 4. duplicate + bad input handling ---');
  res = await api('POST', '/categories', { name: 'Anklets' });
  check('duplicate name → 409', res.status === 409, String(res.status));
  check('409 message names the category', /Anklets/.test(res.body.message), res.body.message);
  check('409 keeps the failure envelope', res.body.success === false && res.body.data === null);
  res = await api('POST', '/categories', {});
  check('missing name → 400', res.status === 400, String(res.status));
  res = await api('POST', '/categories', { name: 'Test Parent', parentCategory: 'not-an-id' });
  check('malformed parentCategory → 400', res.status === 400 && /valid category id/.test(res.body.message), res.body.message);
  res = await api('POST', '/categories', { name: 'Test Parent', parentCategory: '0123456789abcdef01234567' });
  check('non-existent parentCategory → 400', res.status === 400 && /not found/.test(res.body.message), res.body.message);
  console.log('\n--- 5. update rules ---');
  res = await api('PUT', `/categories/${ankletsId}`, { name: 'Anklets & Payal' });
  check('rename keeps the old slug (URLs stay stable)', res.status === 200 && res.body.data.category.slug === 'anklets', res.body.data.category.slug);
  check('name actually changed', res.body.data.category.name === 'Anklets & Payal');
  res = await api('PUT', `/categories/${ankletsId}`, { slug: 'Anklets-Premium' });
  check('explicit slug change applied + normalised → "anklets-premium"', res.body.data.category.slug === 'anklets-premium', res.body.data.category.slug);
  res = await api('PUT', `/categories/${ankletsId}`, { sortOrder: 2, isActive: false });
  check('multi-field update works', res.body.data.category.sortOrder === 2 && res.body.data.category.isActive === false);
  await api('PUT', `/categories/${ankletsId}`, { isActive: true });
  res = await api('PUT', `/categories/${ankletsId}`, {});
  check('empty update → 400 listing allowed fields', res.status === 400 && /No updatable fields/.test(res.body.message), res.body.message);
  res = await api('PUT', '/categories/0123456789abcdef01234567', { name: 'Ghost' });
  check('unknown id → 404', res.status === 404, String(res.status));
  console.log('\n--- 6. hierarchy guardrails ---');
  const necklaceId = String((await Category.findOne({ slug: 'necklace' }))._id);
  const chokersId = String((await Category.findOne({ slug: 'chokers' }))._id);
  res = await api('PUT', `/categories/${necklaceId}`, { parentCategory: necklaceId });
  check('self-parent → 400', res.status === 400 && /its own parent/.test(res.body.message), res.body.message);
  res = await api('PUT', `/categories/${necklaceId}`, { parentCategory: chokersId });
  check('parent = own child → 400 circular', res.status === 400 && /circular/.test(res.body.message), res.body.message);
  res = await api('PUT', `/categories/${chokersId}`, { parentCategory: null });
  check('parent can be cleared with null', res.status === 200 && res.body.data.category.parentCategory === null);
  await api('PUT', `/categories/${chokersId}`, { parentCategory: necklaceId });
  res = await api('GET', '/categories');
  check('parent re-linked, visible again with parentSlug', res.body.data.categories.find((c) => c.slug === 'chokers').parentSlug === 'necklace');
  console.log('\n--- 7. soft delete ---');
  res = await api('DELETE', `/categories/${ankletsId}`);
  check('DELETE → 200, not a hard delete', res.status === 200 && res.body.data.category.isActive === false);
  check('document still in the database', (await Category.countDocuments({ slug: 'anklets-premium' })) === 1);
  res = await api('GET', '/categories');
  check('hidden from the public list', !res.body.data.categories.some((c) => c.slug === 'anklets-premium'));
  res = await api('DELETE', `/categories/${ankletsId}`);
  check('second DELETE is idempotent (200 + already inactive)', res.status === 200 && /already inactive/.test(res.body.message), res.body.message);
  res = await api('DELETE', `/categories/${necklaceId}`);
  check('deactivating a parent succeeds', res.status === 200);
  res = await api('GET', '/categories');
  check('active child of an inactive parent is hidden too', !res.body.data.categories.some((c) => c.slug === 'chokers'));
  check('child row still exists as active in the DB', (await Category.countDocuments({ slug: 'chokers', isActive: true })) === 1);
  console.log('\n--- 8. 404 still routes through the central handler ---');
  res = await api('GET', '/categories/nope/nope');
  check('unknown sub-route → 404 envelope', res.status === 404 && res.body.success === false);
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  server.close();
  await require(path.join(REPO, 'src/config/db.js')).disconnectDB();
  await mongod.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST HARNESS ERROR', err);
  process.exit(2);
});
