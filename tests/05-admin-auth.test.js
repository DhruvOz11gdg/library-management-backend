/**
 * tests/05-admin-auth.test.js — Block 5 acceptance test.
 * Real API boot on an ephemeral Mongo; auth exercised over HTTP with cookies.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'development';
process.env.PORT = '5065';
process.env.HOST = '127.0.0.1';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.JWT_SECRET = 'test-secret-'.padEnd(64, 'x');
process.env.ADMIN_EMAIL = 'owner@alankar.me';
process.env.ADMIN_PASSWORD = 'Surat-Jewellery-2026';
process.env.ADMIN_LOGIN_RATE_LIMIT_MAX = '5';
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`); }
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
  const { run: runSeed } = require(path.join(REPO, 'seedAdmin.js'));
  const AdminUser = require(path.join(REPO, 'src/models/adminUser.model.js'));
  const Product = require(path.join(REPO, 'src/models/product.model.js'));
  const { seedCategories } = require(path.join(REPO, 'seedCategories.js'));
  const { COOKIE_NAME } = require(path.join(REPO, 'src/config/auth'));
  const server = await start();
  await seedCategories({ quiet: true });
  await Product.init();
  const base = 'http://127.0.0.1:5065/v1';
  const api = async (method, url, { body, cookie, headers } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return {
      status: res.status,
      body: parsed,
      setCookie: res.headers.get('set-cookie') || '',
    };
  };
  console.log('\n--- 1. seedAdmin: guards + idempotency ---');
  let r = await runSeed().catch((e) => ({ error: e.message }));
  check('seed creates the first admin', r.created === true && r.admin.email === 'owner@alankar.me', JSON.stringify(r));
  const stored = await AdminUser.findOne({ email: 'owner@alankar.me' }).select('+passwordHash');
  check('password stored as a bcrypt hash, never plaintext', /^\$2[aby]\$/.test(stored.passwordHash) && !stored.passwordHash.includes('Surat'), stored.passwordHash.slice(0, 12));
  check('admin count is 1', (await AdminUser.countDocuments()) === 1);
  const hashCode = stored.passwordHash;
  r = await runSeed();
  check('re-running the seed does not duplicate or reset', r.created === false && r.reset === false && (await AdminUser.countDocuments()) === 1);
  check('existing password hash untouched', (await AdminUser.findOne({ email: 'owner@alankar.me' }).select('+passwordHash')).passwordHash === hashCode);
  r = await runSeed({ resetPassword: true });
  check('--reset-password rotates the hash', r.reset === true && (await AdminUser.findOne({ email: 'owner@alankar.me' }).select('+passwordHash')).passwordHash !== hashCode);
  const loginPassword = 'Surat-Jewellery-2026'; // password value is unchanged; only the hash was re-salted
  r = await runSeed({ email: 'x@y.com', password: 'change-me-before-first-seed' }).catch((e) => ({ error: e.message }));
  check('placeholder password refused with a clear reason', /placeholder/.test(r.error || ''), r.error);
  r = await runSeed({ email: 'x@y.com', password: 'short' }).catch((e) => ({ error: e.message }));
  check('short password refused', /at least 8/.test(r.error || ''), r.error);
  r = await runSeed({ email: 'not-an-email', password: 'long-enough-password' }).catch((e) => ({ error: e.message }));
  check('invalid ADMIN_EMAIL refused', /not a valid email/.test(r.error || ''), r.error);
  console.log('\n--- 2. login ---');
  r = await api('POST', '/admin/login', { body: { email: 'owner@alankar.me', password: loginPassword } });
  check('correct credentials → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  check('httpOnly session cookie set', new RegExp(`^${COOKIE_NAME}=`).test(r.setCookie) && /HttpOnly/i.test(r.setCookie), r.setCookie.slice(0, 90));
  check('cookie is SameSite=Lax in dev, not Secure over http', /SameSite=Lax/i.test(r.setCookie) && !/Secure/i.test(r.setCookie), r.setCookie);
  check('login response NEVER contains the token or hash', !/eyJ/.test(JSON.stringify(r.body)) && !/passwordHash/.test(JSON.stringify(r.body)));
  check('lastLoginAt recorded', Boolean((await AdminUser.findOne({ email: 'owner@alankar.me' })).lastLoginAt));
  const cookie = `${COOKIE_NAME}=${r.setCookie.split(';')[0].split('=').slice(1).join('=')}`;
  r = await api('POST', '/admin/login', { body: { email: 'owner@alankar.me', password: 'wrong-password' } });
  check('wrong password → 401', r.status === 401, String(r.status));
  const wrongPasswordMessage = r.body.message;
  r = await api('POST', '/admin/login', { body: { email: 'nobody@alankar.me', password: 'wrong-password' } });
  check('unknown email → 401 with the SAME message (no account enumeration)', r.status === 401 && r.body.message === wrongPasswordMessage, r.body.message);
  r = await api('POST', '/admin/login', { body: { email: 'owner@alankar.me' } });
  check('missing password → 400', r.status === 400, `${r.status} ${r.body.message}`);
  console.log('\n--- 3. session check ---');
  r = await api('GET', '/admin/self', { cookie });
  check('GET /admin/self with cookie → 200', r.status === 200 && r.body.data.admin.email === 'owner@alankar.me', String(r.status));
  check('self never returns the hash', !/passwordHash/.test(JSON.stringify(r.body)));
  r = await api('GET', '/admin/self');
  check('self without cookie → 401', r.status === 401 && /login required/i.test(r.body.message), `${r.status} ${r.body.message}`);
  r = await api('GET', '/admin/self', { cookie: `${COOKIE_NAME}=not.a.real.token` });
  check('garbage token → 401', r.status === 401, String(r.status));
  const expired = jwt.sign({ sub: String(stored._id), email: stored.email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '-5s' });
  r = await api('GET', '/admin/self', { cookie: `${COOKIE_NAME}=${expired}` });
  check('expired token → 401 "session expired"', r.status === 401 && /expired/i.test(r.body.message), r.body.message);
  const foreign = jwt.sign({ sub: String(stored._id), role: 'admin' }, 'the-wrong-secret', { expiresIn: '1h' });
  r = await api('GET', '/admin/self', { cookie: `${COOKIE_NAME}=${foreign}` });
  check('token signed with another secret → 401', r.status === 401, String(r.status));
  r = await api('GET', '/admin/self', { headers: { Authorization: `Bearer ${r.body && ''}${jwt.sign({ sub: String(stored._id) }, process.env.JWT_SECRET, { expiresIn: '5m' })}` } });
  check('Authorization: Bearer also accepted (curl/Postman)', r.status === 200, String(r.status));
  console.log('\n--- 4. every write route rejects anonymous callers (D8 closed) ---');
  const anonAttempts = [
    ['POST', '/categories', { name: 'Hacked Category' }],
    ['PUT', '/categories/0123456789abcdef01234567', { name: 'x' }],
    ['DELETE', '/categories/0123456789abcdef01234567'],
    ['POST', '/products', { name: 'Hacked', category: 'necklace', price: 1, mrp: 2 }],
    ['PUT', '/products/0123456789abcdef01234567', { price: 1 }],
    ['DELETE', '/products/0123456789abcdef01234567'],
  ];
  for (const [method, url, body] of anonAttempts) {
    const attempt = await api(method, url, { body });
    check(`${method} ${url} without a session → 401`, attempt.status === 401, `${attempt.status} ${attempt.body.message}`);
  }
  const uploadAttempt = await fetch(`${base}/upload/product-image`, { method: 'POST' });
  check('POST /upload/product-image without a session → 401 (before multer)', uploadAttempt.status === 401, String(uploadAttempt.status));
  check('no category was created by the anonymous attempt', !(await require(path.join(REPO, 'src/models/category.model.js')).findOne({ name: 'Hacked Category' })));
  console.log('\n--- 5. the same routes work with a session ---');
  r = await api('POST', '/categories', { body: { name: 'Anklets' }, cookie });
  check('POST /categories with cookie → 201', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
  const ankletId = r.body.data.category.id;
  r = await api('POST', '/products', {
    cookie,
    body: { name: 'Peacock Choker', category: 'necklace', price: 499, mrp: 999, costPrice: 220, stockQty: 4, lowStockAlert: 3, occasionTags: ['wedding'], images: [{ url: 'https://i.ibb.co/x/a.jpg' }] },
  });
  check('POST /products with cookie → 201', r.status === 201 && r.body.data.product.sku === 'NK-WE-001', `${r.status} ${r.body.data?.product?.sku}`);
  const productId = r.body.data.product.id;
  const productSlug = r.body.data.product.slug;
  r = await api('PUT', `/products/${productId}`, { cookie, body: { price: 449 } });
  check('PUT /products/:id with cookie → 200', r.status === 200 && r.body.data.product.price === 449, String(r.status));
  r = await api('GET', `/admin/products/${productId}`, { cookie });
  check('admin detail keeps costPrice + deleteUrl field', r.status === 200 && r.body.data.product.costPrice === 220 && 'deleteUrl' in r.body.data.product.images[0]);
  r = await api('GET', `/products/${productSlug}`);
  check('…while the public detail still strips both', !/costPrice|deleteUrl/.test(JSON.stringify(r.body)));
  r = await api('PUT', `/categories/${ankletId}`, { cookie, body: { sortOrder: 5 } });
  check('PUT /categories/:id with cookie → 200', r.status === 200);
  r = await api('DELETE', `/categories/${ankletId}`, { cookie });
  check('DELETE /categories/:id with cookie → 200 (soft)', r.status === 200 && r.body.data.category.isActive === false);
  console.log('\n--- 6. admin product list + dashboard stats ---');
  r = await api('DELETE', `/products/${productId}`, { cookie });
  check('product hidden for the next checks', r.status === 200 && r.body.data.product.isActive === false);
  r = await api('GET', '/admin/products', { cookie });
  check('GET /admin/products includes hidden products', r.status === 200 && r.body.data.products.some((p) => p.isActive === false), `${r.status}`);
  r = await api('GET', '/admin/products?status=inactive', { cookie });
  check('?status=inactive filters', r.body.data.products.length === 1 && r.body.data.products[0].isActive === false, `${r.body.data.products.length}`);
  r = await api('GET', '/admin/products?status=bogus', { cookie });
  check('bad status → 400', r.status === 400, String(r.status));
  r = await api('POST', '/products', { cookie, body: { name: 'Almost Out', category: 'rings', price: 300, mrp: 400, stockQty: 2, lowStockAlert: 3 } });
  const lowStockId = r.body.data.product.id;
  r = await api('GET', '/admin/products?lowStock=true', { cookie });
  check('?lowStock=true finds stock <= alert', r.body.data.products.some((p) => p.id === lowStockId), JSON.stringify(r.body.data.products.map((p) => p.name)));
  r = await api('GET', '/admin/stats', { cookie });
  const stats = r.body.data;
  check('GET /admin/stats → counters', r.status === 200 && stats.total === 2 && stats.active === 1 && stats.inactive === 1, JSON.stringify(stats).slice(0, 160));
  check('stats counts low stock + byCategory', stats.lowStock === 1 && Array.isArray(stats.byCategory) && stats.byCategory.length >= 1, JSON.stringify(stats.byCategory));
  r = await api('GET', '/admin/stats');
  check('stats requires a session', r.status === 401, String(r.status));
  console.log('\n--- 7. logout ---');
  r = await api('POST', '/admin/logout', { cookie });
  check('logout → 200 and clears the cookie', r.status === 200 && /alankar_admin_token=;/.test(r.setCookie) || /Expires=Thu, 01 Jan 1970/.test(r.setCookie), r.setCookie.slice(0, 80));
  console.log('\n--- 8. login throttle (5 failures allowed) ---');
  let throttled = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const res = await api('POST', '/admin/login', { body: { email: 'owner@alankar.me', password: `wrong-${attempt}` } });
    if (res.status === 429) { throttled = { attempt, res }; break; }
  }
  check('brute force is throttled → 429', throttled !== null, 'never throttled');
  check('429 message is plain English', throttled && /Too many failed login attempts/.test(throttled.res.body.message), throttled && throttled.res.body.message);
  r = await api('POST', '/admin/login', { body: { email: 'owner@alankar.me', password: loginPassword } });
  check('even the correct password is blocked during lockout', r.status === 429, String(r.status));
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  server.close();
  await require(path.join(REPO, 'src/config/db.js')).disconnectDB();
  await mongod.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('TEST HARNESS ERROR', err); process.exit(2); });
