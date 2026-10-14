/**
 * /tmp/block1-test.js — Block 1 acceptance test.
 * NOT part of the repo. Boots the real server.js against an ephemeral
 * mongodb-memory-server instance (this sandbox has no mongod), then exercises
 * the request pipeline, the response envelope, CORS and the error handler.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'development';
process.env.PORT = '5055';
process.env.HOST = '127.0.0.1';
process.env.CORS_ORIGIN = 'http://localhost:5173,https://alankar.me';
const { MongoMemoryServer } = require('mongodb-memory-server');
let pass = 0;
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
  process.env.MONGODB_URI = mongod.getUri('alankar');
  console.log(`[test] ephemeral mongo at ${process.env.MONGODB_URI}\n`);
  const { start } = require(path.join(REPO, 'server.js'));
  const server = await start();
  const base = 'http://127.0.0.1:5055';
  console.log('\n--- 1. service index ---');
  let res = await fetch(`${base}/v1`);
  let body = await res.json();
  check('GET /v1 → 200', res.status === 200, `got ${res.status}`);
  check('envelope has success/message/data', body.success === true && typeof body.message === 'string' && !!body.data);
  check('db reported connected', body.data.database === 'connected', body.data.database);
  console.log('\n--- 2. 404 through the central handler ---');
  res = await fetch(`${base}/v1/does-not-exist`);
  body = await res.json();
  check('GET /v1/does-not-exist → 404', res.status === 404, `got ${res.status}`);
  check('failure envelope shape', body.success === false && body.data === null && Array.isArray(body.errors));
  check('message names the route', body.message.includes('GET /v1/does-not-exist'), body.message);
  console.log('\n--- 3. malformed JSON body ---');
  res = await fetch(`${base}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broken":',
  });
  body = await res.json();
  check('POST malformed JSON → 400', res.status === 400, `got ${res.status}`);
  check('message explains the problem', body.message === 'Invalid JSON in request body', body.message);
  console.log('\n--- 4. CORS ---');
  res = await fetch(`${base}/v1`, { headers: { Origin: 'https://alankar.me' } });
  check('allowed origin → 200', res.status === 200, `got ${res.status}`);
  check('Access-Control-Allow-Origin echoed', res.headers.get('access-control-allow-origin') === 'https://alankar.me', String(res.headers.get('access-control-allow-origin')));
  check('Access-Control-Allow-Credentials true', res.headers.get('access-control-allow-credentials') === 'true');
  res = await fetch(`${base}/v1`, { headers: { Origin: 'https://evil.example' } });
  body = await res.json();
  check('disallowed origin → 403', res.status === 403, `got ${res.status}`);
  check('message is explicit', /CORS blocked/.test(body.message), body.message);
  res = await fetch(`${base}/v1`); // no Origin header (curl/Postman)
  check('no Origin header → 200 (curl/Postman work)', res.status === 200, `got ${res.status}`);
  console.log('\n--- 5. error handler maps Mongoose-style errors ---');
  const express = require('express');
  const { errorHandler } = require(path.join(REPO, 'src/middlewares/errorHandler.middleware.js'));
  const { ApiError } = require(path.join(REPO, 'src/utils/apiResponse.js'));
  const probe = express();
  const cases = {
    '/api-error': (req, res, next) => next(ApiError.notFound('Product "nk-ox-999" not found')),
    '/cast': (req, res, next) => next(Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError', path: '_id', value: 'abc' })),
    '/duplicate': (req, res, next) => next(Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyValue: { sku: 'NK-OX-001' } })),
    '/validation': (req, res, next) => {
      const e = new Error('Product validation failed');
      e.name = 'ValidationError';
      e.errors = { price: { path: 'price', message: 'Path `price` is required.' } };
      next(e);
    },
    '/multer': (req, res, next) => next(Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' })),
    '/bug': (req, res, next) => next(new Error('undefined is not a function')),
  };
  Object.entries(cases).forEach(([p, h]) => probe.get(p, h));
  probe.use(errorHandler);
  const probeServer = probe.listen(5056, '127.0.0.1');
  const expectations = {
    '/api-error': [404, 'Product "nk-ox-999" not found'],
    '/cast': [400, 'Invalid value for "_id"'],
    '/duplicate': [409, 'Duplicate value for "sku"'],
    '/validation': [400, 'Validation failed'],
    '/multer': [400, 'Image is too large — the limit is 5MB per file'],
    '/bug': [500, 'undefined is not a function'],
  };
  for (const [p, [expectedStatus, expectedMessage]] of Object.entries(expectations)) {
    const r = await fetch(`http://127.0.0.1:5056${p}`);
    const b = await r.json();
    check(`${p} → ${expectedStatus}`, r.status === expectedStatus, `got ${r.status}`);
    check(`${p} message`, b.message === expectedMessage, b.message);
    if (expectedStatus === 500) check(`${p} attaches stack in dev`, typeof b.stack === 'string');
    else check(`${p} has no stack leak`, b.stack === undefined);
  }
  probeServer.close();
  console.log('\n--- 6. logger wrote to disk ---');
  const fs = require('fs');
  const appLog = path.join(REPO, 'logs', 'app.log');
  const errLog = path.join(REPO, 'logs', 'error.log');
  check('logs/app.log exists', fs.existsSync(appLog));
  check('logs/error.log exists', fs.existsSync(errLog));
  if (fs.existsSync(appLog)) {
    const text = fs.readFileSync(appLog, 'utf8');
    check('app.log has HTTP request lines', /\[HTTP\] GET \/v1/.test(text));
    check('app.log has the Mongo connection line', /MongoDB connected/.test(text));
    console.log('\n  --- app.log tail ---');
    console.log(text.trim().split('\n').slice(-8).map((l) => '  ' + l).join('\n'));
  }
  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  server.close();
  await require(path.join(REPO, 'src/config/db.js')).disconnectDB();
  await mongod.stop();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('TEST HARNESS ERROR', err);
  process.exit(2);
});
