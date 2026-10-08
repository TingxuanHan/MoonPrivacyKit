import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createLedger, publishRelease, savedRelease, ledgerStatus, listReleases } from '../runtime/ledger.mjs';
import { callCore } from '../runtime/client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'moonprivacykit-ledger-test-'));
let serial = 0;
function book(total = '1') {
  const path = join(scratch, `book-${serial++}.sqlite`);
  createLedger(path, { scope: 'synthetic-october', totalEpsilon: total });
  return path;
}
const query = (id, epsilon = '0.1') => ({
  scope: 'synthetic-october', requestId: id, query: 'count', epsilon,
  unitIds: ['sensitive-person-alpha', 'sensitive-person-alpha', 'sensitive-person-beta'],
});
const code = expected => error => error.code === expected;
const cli = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('history paginates saved releases without spending budget or exposing private input', () => {
  const path = book();
  const first = publishRelease(path, query('oldest'));
  publishRelease(path, query('newest'));
  const before = ledgerStatus(path);
  const page = listReleases(path, { limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.has_more, true);
  assert.equal(page.items[0].request_id, 'newest');
  const next = listReleases(path, { offset: 1, limit: 1 });
  assert.equal(next.items[0].release_id, first.release_id);
  assert.equal(next.has_more, false);
  assert.deepEqual(listReleases(path, { offset: 2 }).items, []);
  assert.deepEqual(ledgerStatus(path), before);
  assert.ok(!JSON.stringify(page).includes('sensitive-person'));
  assert.ok(Object.isFrozen(page.items[0]));
  for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 101 }, { offset: .5 }]) {
    assert.throws(() => listReleases(path, options), code('INVALID_REQUEST'));
  }
});

test('history rejects corrupted reports instead of displaying unverified metadata', () => {
  const path = book();
  publishRelease(path, query('a'));
  const db = new DatabaseSync(path);
  db.prepare('UPDATE releases SET result_json = ?').run('{}');
  db.close();
  assert.throws(() => listReleases(path), code('INVALID_LEDGER'));
});

test('persistent decimal budgets compose exactly and refuse exhaustion before sampling', () => {
  const path = book('0.3');
  const a = publishRelease(path, query('a', '0.1'));
  publishRelease(path, query('b', '0.2'));
  assert.deepEqual([ledgerStatus(path).spent_epsilon, ledgerStatus(path).remaining_epsilon], ['0.3', '0']);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    assert.throws(() => publishRelease(path, query('c', '0.01')), code('BUDGET_EXHAUSTED'));
    assert.deepEqual(publishRelease(path, query('a', '0.100000')), a);
    assert.deepEqual(savedRelease(path, 'a'), a);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal(ledgerStatus(path).release_count, 2);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.report.counts));
});

test('request identity binds data order budget contribution limit and public category meanings', () => {
  const path = book();
  const request = { ...query('histogram'), query: 'histogram', categories: ['yes', 'no'], categoryIds: [0, 1, 1] };
  const saved = publishRelease(path, request);
  for (const changed of [
    { ...request, unitIds: ['different-person', ...request.unitIds.slice(1)] },
    { ...request, unitIds: [...request.unitIds].reverse() },
    { ...request, epsilon: '0.2' }, { ...request, maxContributions: 2 },
    { ...request, categories: ['no', 'yes'] }, { ...request, categoryIds: [1, 1, 1] },
  ]) assert.throws(() => publishRelease(path, changed), code('REQUEST_CONFLICT'));
  assert.throws(() => publishRelease(path, { ...request, scope: 'another-scope' }), code('SCOPE_MISMATCH'));
  assert.deepEqual(publishRelease(path, { ...request, maxContributions: 1 }), saved);
  const distinct = publishRelease(path, { ...request, requestId: 'second-release' });
  assert.notEqual(distinct.release_id, saved.release_id);
  assert.equal(ledgerStatus(path).spent_epsilon, '0.2');
});

test('invalid requests and unavailable entropy leave budget and release storage unchanged', () => {
  const path = book();
  for (const request of [
    { ...query('a'), epsilon: 0.1 }, { ...query('a'), epsilon: '0.1000001' },
    { ...query('a'), epsilon: '1e-1' }, { ...query('a'), epsilon: '0' },
    { ...query('a'), requestId: '' }, { ...query('a'), unitIds: [''] },
    { ...query('a'), maxContributions: 1.5 }, { ...query('a'), categoryIds: [] },
    { ...query('a'), query: 'histogram', categories: ['same', 'same'], categoryIds: [0, 0, 1] },
    { ...query('a'), query: 'histogram', categories: ['yes', 'no'], categoryIds: [0, 0.5, 1] },
  ]) assert.throws(() => publishRelease(path, request));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try { assert.throws(() => publishRelease(path, query('a')), code('RELEASE_FAILED')); }
  finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal(ledgerStatus(path).release_count, 0);
  assert.equal(ledgerStatus(path).spent_epsilon, '0');
  assert.throws(() => savedRelease(path, 'a'), code('RELEASE_NOT_FOUND'));
});

test('a failed commit returns no result and rolls back the charge', () => {
  const path = book();
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === 'COMMIT') throw new Error('synthetic write failure');
    return original.call(this, sql);
  };
  try { assert.throws(() => publishRelease(path, query('a')), code('LEDGER_IO')); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.equal(ledgerStatus(path).spent_epsilon, '0');
  assert.equal(ledgerStatus(path).release_count, 0);
  assert.equal(publishRelease(path, query('a')).report.query, 'count');
});

test('missing existing corrupt and foreign-version ledgers are never reset', () => {
  const path = book();
  const before = readFileSync(path);
  assert.throws(() => createLedger(path, { scope: 'synthetic-october', totalEpsilon: '100' }), code('LEDGER_IO'));
  assert.deepEqual(readFileSync(path), before);
  const missing = join(scratch, 'missing.sqlite');
  assert.throws(() => ledgerStatus(missing), code('LEDGER_IO'));
  assert.equal(existsSync(missing), false);
  const invalid = join(scratch, 'invalid.sqlite');
  writeFileSync(invalid, 'not a ledger');
  assert.throws(() => publishRelease(invalid, query('a')));
  assert.equal(readFileSync(invalid, 'utf8'), 'not a ledger');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => ledgerStatus(path), code('INVALID_LEDGER'));
});

test('ledger stores protected results and keyed bindings without raw person identifiers', () => {
  const path = book();
  const request = query('a');
  const output = publishRelease(path, request);
  const bytes = readFileSync(path);
  for (const id of request.unitIds) {
    assert.equal(bytes.includes(Buffer.from(id)), false);
    assert.equal(JSON.stringify(output).includes(id), false);
  }
  assert.deepEqual(Object.keys(output).sort(), ['schema_version', 'release_id', 'categories', 'report'].sort());
  assert.equal(JSON.stringify(output).includes('input_mac'), false);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE releases SET result_json = ? WHERE request_id = ?').run('{}', 'a'); db.close();
  assert.throws(() => savedRelease(path, 'a'), code('INVALID_LEDGER'));
});

test('fixed decimal charges conservatively cover actual integer mechanism calibration', () => {
  for (const cap of [1, 2, 32]) {
    for (const charge of [10000, 10001, 19999, 100000, 200000, 333333, 1000000, 7999999, 8000000]) {
      const m = callCore({ op: 'centralMechanism', category_count: 3, epsilon: charge / 1000000, max_contributions: cap });
      assert.ok(BigInt(cap) * BigInt(m.threshold) * 1000000n <= BigInt(charge) * (16777216n - BigInt(m.threshold)));
    }
  }
});

function worker(path, request, pause) {
  const input = join(scratch, `request-${serial++}.json`);
  const marker = join(scratch, `marker-${serial++}`);
  writeFileSync(input, JSON.stringify(request));
  const args = ['tests/fixtures/ledger-worker.mjs', path, input, pause || '', marker];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
  return { child, marker, done };
}

async function waitForMarker(run, path = run.marker) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() > deadline || run.child.exitCode !== null) throw new Error('Worker did not reach the requested transaction phase.');
    await delay(20);
  }
}

test('concurrent processes reuse one release and cannot jointly exceed the budget', { timeout: 30000 }, async () => {
  for (const secondId of ['first', 'different']) {
    const path = book('0.1');
    const first = worker(path, query('first'), 'hold-before-commit');
    let second;
    try {
      await waitForMarker(first);
      second = worker(path, query(secondId));
      await waitForMarker(second, `${second.marker}.started`);
      await delay(150);
      assert.equal(second.child.exitCode, null, 'A concurrent writer must wait for the first transaction.');
      writeFileSync(`${first.marker}.resume`, 'continue');
      const results = await Promise.all([first.done, second.done]);
      for (const result of results) assert.equal(result.exitCode, 0, result.stderr);
      const outputs = results.map(r => JSON.parse(r.stdout));
      assert.equal(outputs[0].ok, true);
      if (secondId === 'first') assert.deepEqual(outputs[0], outputs[1]);
      else assert.deepEqual(outputs[1], { ok: false, code: 'BUDGET_EXHAUSTED' });
      assert.equal(ledgerStatus(path).release_count, 1);
      assert.equal(ledgerStatus(path).spent_epsilon, '0.1');
    } finally {
      first.child.kill('SIGKILL'); second?.child.kill('SIGKILL');
      await Promise.all([first.done, second?.done]);
    }
  }
});

async function terminateAt(path, pause) {
  const run = worker(path, query('interrupted'), pause);
  try {
    await waitForMarker(run);
  } finally { run.child.kill('SIGKILL'); await run.done; }
}

test('process termination before commit rolls back and allows a clean retry', { timeout: 20000 }, async () => {
  const path = book();
  await terminateAt(path, 'before-commit');
  assert.equal(ledgerStatus(path).release_count, 0);
  assert.equal(ledgerStatus(path).spent_epsilon, '0');
  assert.throws(() => savedRelease(path, 'interrupted'), code('RELEASE_NOT_FOUND'));
  publishRelease(path, query('interrupted'));
  assert.equal(ledgerStatus(path).release_count, 1);
});

test('process termination after commit preserves the exact result without another charge', { timeout: 20000 }, async () => {
  const path = book('0.1');
  await terminateAt(path, 'after-commit');
  assert.equal(ledgerStatus(path).spent_epsilon, '0.1');
  const committed = savedRelease(path, 'interrupted');
  assert.deepEqual(publishRelease(path, query('interrupted')), committed);
  assert.equal(ledgerStatus(path).release_count, 1);
});

test('CLI can publish recover and inspect across processes while refusing output overwrite', () => {
  const path = join(scratch, 'cli.sqlite');
  const input = join(scratch, 'cli-request.json');
  const output = join(scratch, 'cli-report.json');
  const retry = join(scratch, 'cli-retry.json');
  writeFileSync(input, JSON.stringify(query('cli-request')));
  assert.equal(cli(['init-ledger', path, 'synthetic-october', '0.1']).status, 0);
  const first = cli(['publish', path, input, output]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(cli(['publish', path, input, output]).status, 1);
  const recovered = cli(['export-release', path, 'cli-request', retry]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(readFileSync(output, 'utf8'), readFileSync(retry, 'utf8'));
  const status = cli(['ledger-status', path]);
  assert.equal(JSON.parse(status.stdout).remaining_epsilon, '0');
  const again = worker(path, query('cli-request'));
  return again.done.then(r => assert.deepEqual(JSON.parse(r.stdout).result, JSON.parse(readFileSync(output))));
});

test('failed report export retains a recoverable charged release without disclosing input', () => {
  const path = book('0.1');
  const input = join(scratch, 'export-failure.json');
  writeFileSync(input, JSON.stringify(query('recoverable')));
  const missingFolder = join(scratch, 'uncreated-folder', 'report.json');
  const result = cli(['publish', path, input, missingFolder]);
  assert.equal(result.status, 1);
  assert.equal(ledgerStatus(path).spent_epsilon, '0.1');
  assert.equal(ledgerStatus(path).release_count, 1);
  assert.equal(result.stderr.includes('sensitive-person'), false);
  const output = join(scratch, 'recovered-report.json');
  assert.equal(cli(['export-release', path, 'recoverable', output]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(output)), savedRelease(path, 'recoverable'));
});
