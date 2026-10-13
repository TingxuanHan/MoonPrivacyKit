import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRedactionTemplate, createRedactionTemplate, checkRedactionTemplate, applyRedactionTemplate, prepareRedactionHandoff, createStatisticsTemplate } from '../runtime/templates.mjs';
import { publishRedactedRelease } from '../runtime/table.mjs';
import { createLedger, ledgerStatus } from '../runtime/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-generalization-'));
const source = readFileSync(join(root, 'examples/generalization-template.json'), 'utf8');
const template = parseRedactionTemplate(source);
const rows = [
  { person_id: 'private-p1', age: 23, visit_date: '2024-02-29', contact: 'secret-contact' },
  { person_id: 'private-p2', age: '46', visit_date: '2026-02-18', contact: 'secret-contact' },
  { person_id: 'private-p1', age: 23, visit_date: '2026-01-20', contact: 'secret-contact' },
];
const json = JSON.stringify(rows);
const csv = 'person_id,age,visit_date,contact\n' + rows.map(r => Object.values(r).join(',')).join('\n');
const categories = ['0-17', '18-29', '30-44', '45-59', '60+'];
const statistics = overrides => JSON.stringify(createStatisticsTemplate('年龄统计', {
  query: 'histogram', unitField: 'person_id', categoryField: 'age', categories,
  epsilon: '0.3', maxContributions: 1, ...overrides,
}));
const fieldTemplate = fields => JSON.stringify(createRedactionTemplate('泛化规则', { ...template.settings, fields }));
const cli = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });
let serial = 0;
const file = name => join(scratch, `${serial++}-${name}`);
function book() { const path = file('ledger.sqlite'); createLedger(path, { scope: 'same-people', totalEpsilon: '0.6' }); return path; }

test('versioned generalized rules round trip without changing old templates or accepting hidden parameters', () => {
  assert.deepEqual(createRedactionTemplate(template.name, template.settings), template);
  assert.equal(template.schemaVersion, 2);
  assert.ok(Object.isFrozen(template.settings.fields[1].boundaries));
  assert.equal(createRedactionTemplate('旧操作', { fields: [{ name: 'a', action: 'mask' }], spreadsheetSafe: true }).schemaVersion, 1);
  for (const fields of [
    [{ name: 'age', action: 'age', boundaries: [] }],
    [{ name: 'age', action: 'age', boundaries: [18, 18] }],
    [{ name: 'age', action: 'age', boundaries: Array.from({ length: 33 }, (_, i) => i + 1) }],
    [{ name: 'age', action: 'age', boundaries: [18], precision: 'year' }],
    [{ name: 'age', action: 'keep', boundaries: [18] }],
    [{ name: 'date', action: 'date', precision: 'day' }],
  ]) assert.throws(() => createRedactionTemplate('坏规则', { fields, spreadsheetSafe: true }));
  for (const bad of [JSON.stringify({ ...template, schemaVersion: 1 }), source.replace('"boundaries": [18, 30, 45, 60]', '"boundaries": [18], "boundaries": [30]')]) assert.throws(() => parseRedactionTemplate(bad));
});

test('CSV and JSON generalize fixed public categories while retaining all records and stable identities', () => {
  const a = prepareRedactionHandoff(template, 'csv', csv), b = prepareRedactionHandoff(template, 'json', json);
  assert.deepEqual(a.eligible_fields, ['person_id']);
  assert.deepEqual(a.generalized_fields, b.generalized_fields);
  assert.deepEqual(a.generalized_fields[0].categories, categories);
  assert.deepEqual(a.generalized_fields[1].categories, []);
  assert.deepEqual(a.excluded_fields, ['contact']);
  assert.deepEqual(a.result.audit, { records: 3, removed_values: 3, masked_values: 0, generalized_values: 6, spreadsheet_escapes: 0 });
  assert.deepEqual(JSON.parse(b.result.output), rows.map((r, i) => ({ person_id: r.person_id, age: i === 1 ? '45-59' : '18-29', visit_date: r.visit_date.slice(0, 7) })));
  assert.ok(!a.result.output.includes('secret-contact') && !b.result.output.includes('2024-02-29'));
  const empty = prepareRedactionHandoff(template, 'csv', 'person_id,age,visit_date,contact\n');
  assert.deepEqual(empty.generalized_fields, a.generalized_fields);
  assert.ok(Object.isFrozen(a.generalized_fields[0].categories));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    assert.equal(checkRedactionTemplate(template, 'json', json).compatible, true);
    assert.deepEqual(prepareRedactionHandoff(template, 'json', json), b);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('invalid ages and dates never silently coerce, drop a record, reveal the bad value, or spend budget', () => {
  const ledger = book(), before = readFileSync(ledger);
  for (const [name, value] of [
    ['age', null], ['age', -1], ['age', 131], ['age', '018'], ['age', ' 18'], ['age', 18.5], ['age', 'secret-age'],
    ['visit_date', '1900-02-29'], ['visit_date', '2026-04-31'], ['visit_date', '2026-01-01T00:00:00Z'], ['visit_date', 'secret-date'], ['visit_date', null],
  ]) {
    const input = JSON.stringify([rows[0], { ...rows[1], [name]: value }]);
    assert.equal(checkRedactionTemplate(template, 'json', input).issue, 'invalid_values');
    assert.throws(() => publishRedactedRelease(ledger, 'json', input, source, statistics(), 'retry-id'), error => !error.message.includes('secret'));
  }
  const missing = { ...rows[1] }; delete missing.age;
  assert.equal(checkRedactionTemplate(template, 'json', JSON.stringify([rows[0], missing])).issue, 'invalid_values');
  assert.throws(() => applyRedactionTemplate(template, 'csv', csv.replace(',46,', ',046,')));
  assert.deepEqual(readFileSync(ledger), before);
});

test('generalized statistics reuse equivalent releases and enforce cumulative budgets and request conflicts', () => {
  const ledger = book();
  const a = publishRedactedRelease(ledger, 'csv', csv, source, statistics(), 'release-1');
  assert.deepEqual(publishRedactedRelease(ledger, 'json', json, source, statistics(), 'release-1'), a);
  // Day or age changes inside a public bucket do not change the mapped query.
  const sameBins = JSON.stringify(rows.map(r => ({ ...r, age: Number(r.age) + 1, visit_date: '2025-01-01' })));
  assert.deepEqual(publishRedactedRelease(ledger, 'json', sameBins, source, statistics(), 'release-1'), a);
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
  assert.throws(() => publishRedactedRelease(ledger, 'json', json.replace('"age":23', '"age":30'), source, statistics(), 'release-1'), e => e.code === 'REQUEST_CONFLICT');
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv.replace('private-p2', 'private-p3'), source, statistics(), 'release-1'), e => e.code === 'REQUEST_CONFLICT');
  const changed = fieldTemplate(template.settings.fields.map(f => f.action === 'age' ? { ...f, boundaries: [18, 40, 60] } : f));
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv, changed, statistics({ categories: ['0-17', '18-39', '40-59', '60+'] }), 'release-1'), e => e.code === 'REQUEST_CONFLICT');
  publishRedactedRelease(ledger, 'csv', csv, source, statistics(), 'release-2');
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.6');
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv, source, statistics(), 'release-3'), e => e.code === 'BUDGET_EXHAUSTED');
  assert.deepEqual(publishRedactedRelease(ledger, 'csv', csv, source, statistics(), 'release-1'), a);
  for (const secret of ['private-p', 'secret-contact', '2024-02-29', 'unitField']) assert.ok(!JSON.stringify(a).includes(secret) && !readFileSync(ledger).includes(Buffer.from(secret)));
});

test('generalized columns are categories only and date categories require an explicit public domain', () => {
  const ledger = book(), before = ledgerStatus(ledger);
  for (const unitField of ['age', 'visit_date', 'contact']) assert.throws(() => publishRedactedRelease(ledger, 'json', json, source, statistics({ unitField }), 'same'), /unchanged fields/);
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv.replace('private-p2', '=private-p2'), source, statistics(), 'same'), /unchanged fields/);
  assert.throws(() => publishRedactedRelease(ledger, 'json', json, source, statistics({ categoryField: 'contact' }), 'same'), /unchanged fields/);
  assert.throws(() => publishRedactedRelease(ledger, 'json', json, source, statistics({ categoryField: 'visit_date', categories: ['2026-02'] }), 'same'));
  assert.deepEqual(ledgerStatus(ledger), before);
  const report = publishRedactedRelease(ledger, 'json', json, source, statistics({ categoryField: 'visit_date', categories: ['2024-02', '2026-01', '2026-02', '2026-03'] }), 'same');
  assert.deepEqual(report.categories, ['2024-02', '2026-01', '2026-02', '2026-03']);
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
});

test('CSV formula escaping still blocks changed generalized headers and preserves quoted kept values', () => {
  const rules = createRedactionTemplate('列名检查', { fields: [{ name: 'id', action: 'keep' }, { name: '=age', action: 'age', boundaries: [18] }], spreadsheetSafe: true });
  const processed = prepareRedactionHandoff(rules, 'csv', 'id,=age\n"p""a""b",18');
  assert.deepEqual(processed.eligible_fields, ['id']);
  assert.deepEqual(processed.generalized_fields, []);
  assert.deepEqual(processed.excluded_fields, ['=age']);
  assert.match(processed.result.output, /"p""a""b"/);
  const collision = createRedactionTemplate('列名碰撞', { fields: [...rules.settings.fields, { name: "'=age", action: 'keep' }], spreadsheetSafe: true });
  assert.throws(() => prepareRedactionHandoff(collision, 'csv', "id,=age,'=age\np1,18,secret"));
});

test('CLI checks and applies version two, writes value-free audits and leaves invalid input without output', () => {
  const input = file('data.csv'), config = file('template.json'), output = file('result.csv');
  writeFileSync(input, csv); writeFileSync(config, source);
  const check = cli(['check-redaction-template', 'csv', input, config]);
  assert.equal(check.status, 0, check.stderr);
  const result = cli(['redact-template', 'csv', input, output, config]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), applyRedactionTemplate(template, 'csv', csv).output);
  const audit = readFileSync(`${output}.audit.json`, 'utf8');
  assert.equal(JSON.parse(audit).generalized_values, 6);
  assert.ok(!audit.includes('private') && !audit.includes('2024') && !audit.includes('contact'));
  assert.equal(cli(['redact-template', 'csv', input, output, config]).status, 1);
  for (const invalid of [csv.replace('2024-02-29', '2024-02-30'), csv.replace(',46,', ',secret-age,')]) {
    writeFileSync(input, invalid); const blocked = file('blocked.csv');
    const check = cli(['check-redaction-template', 'csv', input, config]);
    assert.equal(check.status, 1); assert.equal(JSON.parse(check.stdout).issue, 'invalid_values');
    const result = cli(['redact-template', 'csv', input, blocked, config]);
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('secret-age'));
    assert.equal(existsSync(blocked), false); assert.equal(existsSync(`${blocked}.audit.json`), false);
    assert.equal(readFileSync(input, 'utf8'), invalid);
  }
});
