'use strict';
/**
 * tests/run-all.js — runs every block's acceptance test in order.
 *
 *   npm test
 *
 * What these tests are: each file boots the REAL server.js against a throwaway
 * in-memory MongoDB (mongodb-memory-server), then drives it over HTTP. No mocks
 * of our own code, no test doubles for the database. The ImgBB test uses a local
 * stub so no upload quota is spent.
 *
 * They are the executable version of TASK_TRACKER.md's "Test executed"
 * sections — if a later block breaks an earlier one, this suite is how you find
 * out before the storefront does.
 *
 * Requirements: `npm install` (mongodb-memory-server is a devDependency). The
 * first run downloads a mongod binary, so it needs a working internet
 * connection once.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const TEST_DIR = __dirname;
const files = fs
  .readdirSync(TEST_DIR)
  .filter((file) => /^\d{2}-.*\.test\.js$/.test(file))
  .sort();
const results = [];
let totalPassed = 0;
let totalFailed = 0;
console.log(`\nRunning ${files.length} test files (real server + in-memory MongoDB)\n`);
for (const file of files) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const summary = output.match(/==== (\d+) passed, (\d+) failed ====/);
  if (summary) {
    totalPassed += Number(summary[1]);
    totalFailed += Number(summary[2]);
  }
  const ok = run.status === 0 && summary && Number(summary[2]) === 0;
  results.push({
    file,
    ok,
    status: run.status,
    summary: summary ? summary[0].replace('==== ', '').replace(' ====', '') : 'no summary — crashed',
    ms: Date.now() - started,
    output,
  });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(26)} ${results[results.length - 1].summary}  (${results[results.length - 1].ms}ms)`);
  if (!ok) console.log(output.split('\n').filter((line) => /FAIL|Error/.test(line)).slice(0, 12).map((line) => `        ${line}`).join('\n'));
}
console.log('');
console.log('─'.repeat(72));
console.log(`  ${results.filter((r) => r.ok).length}/${results.length} files passed — ${totalPassed} assertions passed, ${totalFailed} failed`);
console.log('─'.repeat(72));
process.exit(totalFailed === 0 && results.every((r) => r.ok) ? 0 : 1);
