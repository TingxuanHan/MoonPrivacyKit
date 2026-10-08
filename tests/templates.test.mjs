import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStatisticsTemplate, createStatisticsTemplate, checkStatisticsTemplate } from '../runtime/templates.mjs';
import { publishTemplateRelease, publishTableRelease } from '../runtime/table.mjs';
import { createLedger, ledgerStatus } from '../runtime/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-templates-'));
const source = readFileSync(join(root, 'examples/statistics-histogram-template.json'), 'utf8');
const template = parseStatisticsTemplate(source);
const csv = 'person_id,answer,note\nprivate-person,满意,private-note\nprivate-person,一般,private-note\nanother-person,不满意,private-note';
const json = JSON.stringify([{ person_id: 'private-person', answer: '满意' }, { person_id: 'private-person', answer: '一般' }, { person_id: 'another-person', answer: '不满意' }]);
let serial = 0;
const file = name => join(scratch, `${serial++}-${name}`);
const cli = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });
function book(total = '0.6') {
  const path = file('ledger.sqlite'); createLedger(path, { scope: 'existing-scope', totalEpsilon: total }); return path;
}

test('template files round trip and contain only validated portable settings', () => {
  assert.deepEqual(parseStatisticsTemplate(`\uFEFF${source}`), template);
  assert.deepEqual(createStatisticsTemplate(template.name, template.settings), template);
  assert.ok(Object.isFrozen(template) && Object.isFrozen(template.settings.categories));
  assert.deepEqual(Object.keys(template).sort(), ['kind', 'name', 'schemaVersion', 'settings']);
  const count = parseStatisticsTemplate(readFileSync(join(root, 'examples/statistics-count-template.json'), 'utf8'));
  assert.equal(count.settings.categories, undefined);
  assert.equal(count.settings.categoryField, undefined);
});

test('raw template text rejects duplicate keys, unknown schema and identity or data injection', () => {
  const good = JSON.stringify(template);
  const invalid = [
    good.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    good.replace('"epsilon":"0.3"', '"epsilon":"0.3","eps\\u0069lon":"0.1"'),
    good.replace('"schemaVersion":1', '"schemaVersion":2'),
    good.replace('"maxContributions":1', '"maxContributions":1.5'),
    good.replace('"epsilon":"0.3"', '"epsilon":0.3'),
    'secret-invalid-json', ' '.repeat(100001),
  ];
  for (const key of ['scope', 'requestId', 'projectId', 'totalEpsilon', 'spentEpsilon', 'data', 'unitIds', '__proto__']) {
    invalid.push(JSON.stringify({ ...template, [key]: 'secret-data' }));
    invalid.push(JSON.stringify({ ...template, settings: { ...template.settings, [key]: 'secret-data' } }));
  }
  for (const input of invalid) assert.throws(() => parseStatisticsTemplate(input), error => !error.message.includes('secret'));
  assert.throws(() => parseStatisticsTemplate(template));
});

test('compatibility checks work across formats without sampling, charging or disclosing original values', () => {
  const ledger = book();
  const before = ledgerStatus(ledger);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    for (const [format, input] of [['csv', csv], ['json', json], ['csv', 'person_id,answer']]) {
      assert.deepEqual(checkStatisticsTemplate(template, format, input), { compatible: true, missing_fields: [], issue: '' });
    }
    const missing = checkStatisticsTemplate(template, 'csv', 'unrelated\nsecret-value');
    assert.deepEqual(missing.missing_fields, ['person_id', 'answer']);
    const bad = checkStatisticsTemplate(template, 'json', json.replace('不满意', 'secret-category'));
    assert.equal(bad.compatible, false);
    assert.equal(bad.issue, 'invalid_values');
    assert.ok(!JSON.stringify(bad).includes('secret'));
    assert.throws(() => checkStatisticsTemplate(template, 'csv', 'a,a\nsecret,secret'));
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.deepEqual(ledgerStatus(ledger), before);
});

test('template releases reuse existing ledger scope and request identity across CSV JSON and direct plans', () => {
  const ledger = book();
  const a = publishTemplateRelease(ledger, 'csv', csv, source, 'stable-request');
  assert.deepEqual(publishTemplateRelease(ledger, 'json', json, source, 'stable-request'), a);
  const renamed = JSON.stringify({ ...template, name: '另一个模板名称' });
  assert.deepEqual(publishTemplateRelease(ledger, 'csv', csv, renamed, 'stable-request'), a);
  assert.deepEqual(publishTableRelease(ledger, 'csv', csv, { ...template.settings, schemaVersion: 1, scope: 'existing-scope', requestId: 'stable-request' }), a);
  const changed = JSON.stringify({ ...template, settings: { ...template.settings, epsilon: '0.2' } });
  assert.throws(() => publishTemplateRelease(ledger, 'csv', csv, changed, 'stable-request'), error => error.code === 'REQUEST_CONFLICT');
  publishTemplateRelease(ledger, 'csv', csv, source, 'next-request');
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.6');
  assert.throws(() => publishTemplateRelease(ledger, 'csv', csv, source, 'over-budget'), error => error.code === 'BUDGET_EXHAUSTED');
  assert.deepEqual(publishTemplateRelease(ledger, 'csv', csv, source, 'stable-request'), a);
  assert.ok(!JSON.stringify(a).includes('private-'));
});

test('invalid templates and tables cannot create ledgers or change their balance', () => {
  const ledger = book();
  const before = ledgerStatus(ledger);
  assert.throws(() => publishTemplateRelease(ledger, 'csv', csv, JSON.stringify({ ...template, requestId: 'secret-id' }), 'attempt'));
  assert.throws(() => publishTemplateRelease(ledger, 'csv', csv.replace('满意', 'secret-value'), source, 'attempt'));
  assert.throws(() => publishTemplateRelease(ledger, 'csv', csv, source, undefined));
  assert.deepEqual(ledgerStatus(ledger), before);
  const missing = file('missing.sqlite');
  assert.throws(() => publishTemplateRelease(missing, 'csv', csv, source, 'attempt'));
  assert.equal(existsSync(missing), false);
});

test('CLI template checks report compatibility without publishing or exposing private records', () => {
  const input = file('input.csv'), config = file('template.json');
  writeFileSync(input, csv); writeFileSync(config, source);
  const ok = cli(['check-template', 'csv', input, config]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).compatible, true);
  writeFileSync(input, 'person_id,answer\nprivate-person,secret-category');
  const bad = cli(['check-template', 'csv', input, config]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).issue, 'invalid_values');
  assert.ok(!bad.stdout.includes('secret') && !bad.stderr.includes('secret'));
});

test('CLI applies exported templates, protects output files and recovers saved reports', () => {
  const ledger = book();
  const input = file('input.csv'), config = file('template.json'), output = file('report.json'), retry = file('retry.json');
  writeFileSync(input, csv); writeFileSync(config, `\uFEFF${source}`);
  const args = ['publish-template', 'csv', ledger, input, config, 'cli-stable'];
  assert.equal(cli([...args, output]).status, 0);
  const saved = readFileSync(output, 'utf8');
  assert.equal(cli([...args, retry]).status, 0);
  assert.equal(readFileSync(retry, 'utf8'), saved);
  assert.equal(cli([...args, output]).status, 1);
  assert.equal(readFileSync(input, 'utf8'), csv);
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
  writeFileSync(config, Buffer.from([0xff]));
  const invalid = file('invalid.json');
  assert.equal(cli([...args, invalid]).status, 1);
  assert.equal(existsSync(invalid), false);
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
});
