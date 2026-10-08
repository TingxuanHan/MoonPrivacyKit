import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createLedger, publishRelease, savedRelease, ledgerStatus } from '../runtime/ledger.mjs';
import { publishTableRelease } from '../runtime/table.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'moonprivacykit-table-test-'));
let serial = 0;
const path = name => join(scratch, `${serial++}-${name}`);
const cli = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });
const rows = [
  { person_id: 'private-person-alpha', choice: '满意', private_note: 'unselected-private-note' },
  { person_id: 'private-person-alpha', choice: '不满意' },
  { person_id: 'private-person-beta', choice: '一般' },
];
const csv = 'person_id,choice,private_note\r\nprivate-person-alpha,满意,unselected-private-note\r\nprivate-person-alpha,不满意,\r\nprivate-person-beta,一般,\r\n';
const json = JSON.stringify(rows);
const plan = (query = 'histogram') => ({
  schemaVersion: 1, scope: 'table-example', requestId: `table-${query}`, query,
  epsilon: '0.3', maxContributions: 1, unitField: 'person_id',
  ...(query === 'histogram' ? { categoryField: 'choice', categories: ['满意', '一般', '不满意'] } : {}),
});
function book(total = '1') {
  const location = path('ledger.sqlite');
  createLedger(location, { scope: 'table-example', totalEpsilon: total });
  return location;
}
const code = expected => error => error.code === expected;

test('CSV JSON and direct release requests share protected results and exact budget accounting', () => {
  const ledger = book();
  for (const query of ['count', 'histogram']) {
    const configuration = plan(query);
    const result = publishTableRelease(ledger, 'csv', `\uFEFF${csv}`, configuration);
    assert.deepEqual(publishTableRelease(ledger, 'json', json, configuration), result);
    const request = { scope: configuration.scope, requestId: configuration.requestId, query,
      epsilon: configuration.epsilon, maxContributions: 1, unitIds: rows.map(r => r.person_id),
      ...(query === 'histogram' ? { categories: configuration.categories, categoryIds: [0, 2, 1] } : {}),
    };
    assert.deepEqual(publishRelease(ledger, request), result);
    assert.deepEqual(savedRelease(ledger, configuration.requestId), result);
  }
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.6');
  assert.equal(ledgerStatus(ledger).release_count, 2);
});

test('changed mapped data conflicts while irrelevant columns can reuse the same release', () => {
  const ledger = book();
  const configuration = plan();
  const result = publishTableRelease(ledger, 'json', json, configuration);
  assert.deepEqual(publishTableRelease(ledger, 'json', JSON.stringify(rows.map(r => ({ ...r, private_note: 'changed' }))), configuration), result);
  for (const changed of [
    [rows[2], rows[1], rows[0]],
    rows.map((r, i) => i === 0 ? { ...r, person_id: 'changed-person' } : r),
    rows.map((r, i) => i === 0 ? { ...r, choice: '不满意' } : r),
  ]) assert.throws(() => publishTableRelease(ledger, 'json', JSON.stringify(changed), configuration), code('REQUEST_CONFLICT'));
  assert.throws(() => publishTableRelease(ledger, 'json', json, { ...configuration, categories: [...configuration.categories].reverse() }), code('REQUEST_CONFLICT'));
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
});

test('invalid tables never charge or disclose private values including rows beyond the contribution cap', () => {
  const ledger = book();
  for (const [format, input] of [
    ['csv', 'person_id,choice\nprivate-person-alpha,满意\nprivate-person-alpha,private-unknown-category'],
    ['csv', 'person_id,person_id,choice\na,b,满意'],
    ['csv', 'person_id,choice\na'],
    ['json', '[{"person_id":"private-person-alpha","choice":"满意"},{"choice":"一般"}]'],
    ['json', '[{"person_id":123,"choice":"满意"}]'],
    ['json', '[{"person_id":"private-person-alpha","choice":false}]'],
    ['json', '[{"person_id":"a","person_id":"b","choice":"满意"}]'],
    ['json', 'private-malformed-json'],
    ['json', '[{"person_id":" private-person-alpha","choice":"满意"}]'],
    ['tsv', 'private-text'], ['csv', 'x'.repeat(2_000_001)],
  ]) {
    assert.throws(() => publishTableRelease(ledger, format, input, plan()), error => {
      assert.equal(error.message.includes('private-'), false);
      return true;
    });
  }
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0');
  assert.equal(ledgerStatus(ledger).release_count, 0);
});

test('table plans reject unsupported schemas coercions and accidental raw request fields', () => {
  const ledger = book();
  const configuration = plan();
  for (const invalid of [
    null, [], { ...configuration, schemaVersion: 2 }, { ...configuration, schemaVersion: '1' },
    { ...configuration, unitField: undefined }, { ...configuration, unitField: 1 },
    { ...configuration, categories: undefined }, { ...configuration, categories: ['满意', '满意'] },
    { ...configuration, categories: [1, 2] }, { ...configuration, query: 'mean' },
    { ...configuration, epsilon: 0.3 }, { ...configuration, maxContributions: 1.5 },
    { ...configuration, unitIds: ['private-person-alpha'] },
    { ...plan('count'), categoryField: 'choice' }, { ...plan('count'), categories: [] },
  ]) assert.throws(() => publishTableRelease(ledger, 'json', json, invalid));
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0');
});

test('table reports and ledger contain no original identifiers unselected data or mapping columns', () => {
  const ledger = book();
  const result = publishTableRelease(ledger, 'csv', csv, plan());
  const encoded = JSON.stringify(result);
  const stored = readFileSync(ledger);
  for (const secret of ['private-person-alpha', 'private-person-beta', 'unselected-private-note', 'person_id', 'private_note']) {
    assert.equal(encoded.includes(secret), false);
    assert.equal(stored.includes(Buffer.from(secret)), false);
  }
  assert.deepEqual(Object.keys(result).sort(), ['categories', 'release_id', 'report', 'schema_version']);
  assert.equal(result.report.counts.length, 3);
  assert.equal(result.report.confidence, 0.95);
});

test('exhausted budgets allow table retry without entropy but reject another request', () => {
  const ledger = book('0.3');
  const result = publishTableRelease(ledger, 'json', json, plan());
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    assert.deepEqual(publishTableRelease(ledger, 'csv', csv, plan()), result);
    assert.throws(() => publishTableRelease(ledger, 'json', json, { ...plan(), requestId: 'new-request' }), code('BUDGET_EXHAUSTED'));
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal(ledgerStatus(ledger).release_count, 1);
});

test('CLI publishes real table files across formats without modifying source or existing output', () => {
  const ledger = book('0.3');
  const source = path('input.csv'), other = path('input.json'), config = path('plan.json');
  const report = path('report.json'), retry = path('retry.json');
  writeFileSync(source, `\uFEFF${csv}`); writeFileSync(other, json); writeFileSync(config, JSON.stringify(plan()));
  const before = readFileSync(source);
  const result = cli(['publish-table', 'csv', ledger, source, config, report]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('private-'), false);
  assert.equal(cli(['publish-table', 'json', ledger, other, config, retry]).status, 0);
  assert.equal(readFileSync(report, 'utf8'), readFileSync(retry, 'utf8'));
  assert.equal(cli(['publish-table', 'csv', ledger, source, config, source]).status, 1);
  assert.equal(cli(['publish-table', 'csv', ledger, source, config, report]).status, 1);
  assert.deepEqual(readFileSync(source), before);
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
});

test('CLI rejects invalid UTF-8 and malformed table input before writing a report or spending', () => {
  const ledger = book();
  const config = path('plan.json');
  writeFileSync(config, JSON.stringify(plan()));
  for (const input of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.from('person_id,choice\nprivate-secret,private-unknown')]) {
    const source = path('invalid.csv'), report = path('absent.json');
    writeFileSync(source, input);
    const result = cli(['publish-table', 'csv', ledger, source, config, report]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes('private-'), false);
    assert.equal(existsSync(report), false);
  }
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0');
});

test('failed table report export can be recovered without resampling or charging twice', () => {
  const ledger = book('0.3');
  const source = path('source.csv'), config = path('plan.json');
  writeFileSync(source, csv); writeFileSync(config, JSON.stringify(plan()));
  const missing = join(scratch, 'missing-folder', 'report.json');
  const failed = cli(['publish-table', 'csv', ledger, source, config, missing]);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr.includes('private-'), false);
  const report = path('recovered.json');
  const recovered = cli(['export-release', ledger, plan().requestId, report]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), savedRelease(ledger, plan().requestId));
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
  assert.equal(ledgerStatus(ledger).release_count, 1);
});
