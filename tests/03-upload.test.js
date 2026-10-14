/**
 * tests/03-upload.test.js — Block 3 acceptance test.
 *
 * Runs the REAL upload pipeline (multer → sharp → ImgBB client → DB record)
 * against a local ImgBB stub on 127.0.0.1:5999, so no real quota is spent and
 * the error paths (400 / timeout / unreachable) can be driven deterministically.
 */
const path = require('path');
const http = require('http');
const REPO = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'development';
process.env.PORT = '5058';
process.env.HOST = '127.0.0.1';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.JWT_SECRET = 'test-secret-'.padEnd(64, 'x');
process.env.IMGBB_API_KEY = 'test-key-not-real';
process.env.IMGBB_API_URL = 'http://127.0.0.1:5999/1/upload';
const { MongoMemoryServer } = require('mongodb-memory-server');
const sharp = require('sharp');
let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`); }
}
/* ---------------- ImgBB stub ---------------- */
const stubCalls = [];
let adminCookie = ''; // Block 5 put the upload route behind admin auth
let stubMode = 'ok';
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    // Pull the base64 image + the `name` part out of the multipart body.
    const b64 = (raw.match(/name="image"\r?\n\r?\n([\s\S]*?)\r?\n--/) || [])[1] || '';
    const name = (raw.match(/name="name"\r?\n\r?\n([\s\S]*?)\r?\n--/) || [])[1] || '';
    stubCalls.push({ url: req.url, b64, name, bytes: Buffer.byteLength(b64, 'base64') });
    if (stubMode === 'imgbb400') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status_code: 400, error: { message: 'Invalid image source' } }));
    }
    if (stubMode === 'garbage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status_code: 200, success: true, data: {} }));
    }
    // Like the real service: report the dimensions/size of what we actually
    // received, not hardcoded values.
    const receceived = Buffer.from(b64, 'base64');
    let dims = { width: null, height: null };
    try {
      const m = await sharp(receceived).metadata();
      dims = { width: m.width || null, height: m.height || null };
    } catch { /* non-image payloads only reach the error modes above */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status_code: 200, success: true,
      data: {
        id: 'stubId' + stubCalls.length, url: `https://i.ibb.co/stub/img-${stubCalls.length}.jpg`,
        thumb: { url: `https://i.ibb.co/stub/img-${stubCalls.length}-thumb.jpg` },
        delete_url: `https://ibb.co/stub/DELETE-SECRET-TOKEN-${stubCalls.length}`,
        size: receceived.length, width: dims.width, height: dims.height,
      },
    }));
  });
});
function postImage(base, fileBuffer, filename, mimetype) {
  const boundary = '----alankartest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
    `Content-Type: ${mimetype}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return fetch(`${base}/upload/product-image`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...(adminCookie ? { Cookie: adminCookie } : {}) },
    body: Buffer.concat([head, fileBuffer, tail]),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
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
  await new Promise((resolve) => stub.listen(5999, '127.0.0.1', resolve));
  const { start } = require(path.join(REPO, 'server.js'));
  const UploadedImage = require(path.join(REPO, 'src/models/uploadedImage.model.js'));
  const server = await start();
  const base = 'http://127.0.0.1:5058/v1';
  // Block 5 locked /upload/product-image behind adminAuth — sign in like the panel does.
  process.env.ADMIN_EMAIL = 'upload-test@alankar.me';
  process.env.ADMIN_PASSWORD = 'Test-Admin-Pass-2026';
  const { run: runSeedAdmin } = require(path.join(REPO, 'seedAdmin.js'));
  await runSeedAdmin();
  const loginRes = await fetch(`${base}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  adminCookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  if (!adminCookie) throw new Error('test setup: could not obtain an admin session');
  // Test images
  const bigJpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 170, g: 30, b: 60 } } })
    .jpeg({ quality: 100 }).toBuffer();
  const smallJpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 10, g: 90, b: 160 } } })
    .jpeg({ quality: 90 }).toBuffer();
  const transparentPng = await sharp({ create: { width: 1600, height: 1600, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } } })
    .png().toBuffer();
  const animatedGif = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 200, b: 0 } } })
    .gif().toBuffer();
  console.log('\n--- 1. happy path: real JPEG through multer → sharp → ImgBB → DB ---');
  let r = await postImage(base, bigJpeg, 'peacock-choker.jpg', 'image/jpeg');
  check('POST /v1/upload/product-image → 201', r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  check('returns url + thumbUrl', /^https:\/\//.test(r.body.data.url) && /^https:\/\//.test(r.body.data.thumbUrl));
  check('response contains NO deleteUrl (critical)', !JSON.stringify(r.body).includes('DELETE-SECRET-TOKEN') && r.body.data.deleteUrl === undefined, JSON.stringify(r.body.data));
  check('response contains no delete_url key at all', !Object.keys(r.body.data).some((k) => /delete/i.test(k)), Object.keys(r.body.data).join(','));
  check('2400px image resized to ≤1200px', r.body.data.width <= 1200 && r.body.data.height <= 1200, `${r.body.data.width}x${r.body.data.height}`);
  check('compression reported', r.body.data.savedPercent >= 0 && /saved \d+%/.test(r.body.message), r.body.message);
  check('format preserved as jpeg', r.body.data.format === 'jpeg', r.body.data.format);
  const call = stubCalls[stubCalls.length - 1];
  check('API key sent to ImgBB as a query param', /key=test-key-not-real/.test(call.url), call.url);
  check('image sent base64-encoded', call.b64.length > 100 && !call.b64.startsWith('data:'), `${call.b64.length} chars`);
  check('human-readable filename sent (alankar-…)', /^alankar-peacock-choker-\d+$/.test(call.name), call.name);
  const decoded = Buffer.from(call.b64, 'base64');
  const decodedMeta = await sharp(decoded).metadata();
  check('bytes that reached ImgBB are the compressed 1200px image', decodedMeta.width <= 1200, `${decodedMeta.width}x${decodedMeta.height}`);
  check('compressed payload is smaller than the original', decoded.length < bigJpeg.length, `${(decoded.length/1024).toFixed(0)}KB < ${(bigJpeg.length/1024).toFixed(0)}KB`);
  const record = await UploadedImage.findOne({ url: r.body.data.url });
  check('UploadedImage row saved (media library)', Boolean(record));
  const deleteUrlPattern = new RegExp('^https://ibb\\.co/stub/DELETE-SECRET-TOKEN-\\d+$');
  check('deleteUrl stored SERVER-SIDE only', deleteUrlPattern.test(record.deleteUrl), record.deleteUrl);
  check('filename + size recorded', /^alankar-/.test(record.filename) && record.size > 0);
  console.log('\n--- 2. format handling ---');
  r = await postImage(base, smallJpeg, 'studs.jpg', 'image/jpeg');
  check('small JPEG (600px) not upscaled', r.body.data.width === 600 && r.body.data.height === 400, `${r.body.data.width}x${r.body.data.height}`);
  r = await postImage(base, transparentPng, 'kundan.png', 'image/png');
  const pngCall = stubCalls[stubCalls.length - 1];
  const pngMeta = await sharp(Buffer.from(pngCall.b64, 'base64')).metadata();
  check('PNG stays PNG (transparency preserved)', pngMeta.format === 'png' && pngMeta.hasAlpha === true, `${pngMeta.format} alpha=${pngMeta.hasAlpha}`);
  check('oversized PNG downscaled to 1200', pngMeta.width <= 1200, String(pngMeta.width));
  r = await postImage(base, animatedGif, 'sparkle.gif', 'image/gif');
  const gifCall = stubCalls[stubCalls.length - 1];
  check('GIF passed through untouched (animation kept)', r.status === 201 && Buffer.from(gifCall.b64, 'base64').equals(animatedGif), `status ${r.status}`);
  console.log('\n--- 3. rejection paths (these are the ones the owner will hit) ---');
  r = await postImage(base, Buffer.from('%PDF-1.4 not an image'), 'invoice.pdf', 'application/pdf');
  check('PDF → 400 with allowed-types message', r.status === 400 && /not a supported image/.test(r.body.message), `${r.status} ${r.body.message}`);
  r = await postImage(base, Buffer.from('hello'), 'notes.txt', 'text/plain');
  check('.txt → 400', r.status === 400, String(r.status));
  r = await postImage(base, bigJpeg, 'fake.jpg', 'text/plain');
  check('image bytes with a text/plain MIME → 400 (mime checked)', r.status === 400, String(r.status));
  r = await postImage(base, Buffer.from('PK\x03\x04zipdata'), 'malware.jpg', 'image/jpeg');
  check('non-image bytes with .jpg name → 400 from sharp', r.status === 400 && /could not be read as an image/.test(r.body.message), `${r.status} ${r.body.message}`);
  const over5mb = Buffer.alloc(5 * 1024 * 1024 + 1024, 7);
  r = await postImage(base, over5mb, 'huge.jpg', 'image/jpeg');
  check('>5MB → 400 "too large" (5MB limit)', r.status === 400 && /too large/.test(r.body.message), `${r.status} ${r.body.message}`);
  const emptyBoundary = '----empty';
  const emptyRes = await fetch(`${base}/upload/product-image`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${emptyBoundary}`, ...(adminCookie ? { Cookie: adminCookie } : {}) },
    body: Buffer.from(`--${emptyBoundary}--\r\n`),
  });
  r = { status: emptyRes.status, body: await emptyRes.json() };
  check('no file in the request → 400 with instructions', r.status === 400 && /No image received/.test(r.body.message), `${r.status} ${r.body.message}`);
  console.log('\n--- 4. ImgBB failure handling ---');
  stubMode = 'imgbb400';
  r = await postImage(base, smallJpeg, 'rejected.jpg', 'image/jpeg');
  check('ImgBB 400 → our 400 quoting ImgBB\'s reason', r.status === 400 && /Invalid image source/.test(r.body.message), `${r.status} ${r.body.message}`);
  stubMode = 'garbage';
  r = await postImage(base, smallJpeg, 'weird.jpg', 'image/jpeg');
  check('ImgBB 200 with empty payload → 502, nothing saved', r.status === 502 && /unexpected response/.test(r.body.message), `${r.status} ${r.body.message}`);
  stubMode = 'ok';
  const beforeUnreachable = await UploadedImage.countDocuments();
  process.env.IMGBB_API_URL = 'http://127.0.0.1:5998/1/upload'; // nothing listening
  r = await postImage(base, smallJpeg, 'offline.jpg', 'image/jpeg');
  check('ImgBB unreachable → 502 with actionable message', r.status === 502 && /Could not reach the image host/.test(r.body.message), `${r.status} ${r.body.message}`);
  check('no DB record written on failure', (await UploadedImage.countDocuments()) === beforeUnreachable);
  process.env.IMGBB_API_URL = 'http://127.0.0.1:5999/1/upload';
  console.log('\n--- 5. missing API key → clear 503, not a crash ---');
  const savedKey = process.env.IMGBB_API_KEY;
  delete process.env.IMGBB_API_KEY;
  r = await postImage(base, smallJpeg, 'nokey.jpg', 'image/jpeg');
  check('no IMGBB_API_KEY → 503 naming the variable', r.status === 503 && /IMGBB_API_KEY is missing/.test(r.body.message), `${r.status} ${r.body.message}`);
  process.env.IMGBB_API_KEY = savedKey;
  console.log('\n--- 6. boot-time config check ---');
  const { checkImgbbConfig } = require(path.join(REPO, 'src/config/imgbb.js'));
  let cfg = checkImgbbConfig();
  check('configured + stub detected', cfg.configured === true && cfg.usingStub === true, JSON.stringify(cfg));
  delete process.env.IMGBB_API_KEY;
  cfg = checkImgbbConfig();
  check('missing key reported as not configured (server still boots)', cfg.configured === false);
  process.env.IMGBB_API_KEY = savedKey;
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  server.close();
  stub.close();
  await require(path.join(REPO, 'src/config/db.js')).disconnectDB();
  await mongod.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('TEST HARNESS ERROR', err); process.exit(2); });
