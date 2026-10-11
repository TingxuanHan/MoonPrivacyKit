import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRedactionTemplate, createRedactionTemplate, checkRedactionTemplate, applyRedactionTemplate, prepareRedactionHandoff } from '../runtime/templates.mjs';
import { publishRedactedRelease, publishTemplateRelease } from '../runtime/table.mjs';
import { createLedger, ledgerStatus } from '../runtime/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-redaction-templates-'));
const source = readFileSync(join(root, 'examples/redaction-template.json'), 'utf8');
const statistics = readFileSync(join(root, 'examples/statistics-histogram-template.json'), 'utf8');
const template = parseRedactionTemplate(source);
const csv = 'person_id,answer,contact\nprivate-p1,满意,secret-contact\nprivate-p1,一般,secret-contact\nprivate-p2,不满意,secret-contact';
const json = JSON.stringify([{ person_id: 'private-p1', answer: '满意', contact: 'secret-contact' }, { person_id: 'private-p1', answer: '一般', contact: 'secret-contact' }, { person_id: 'private-p2', answer: '不满意', contact: 'secret-contact' }]);
let serial = 0;
const file = name => join(scratch, `${serial++}-${name}`);
const cli = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });
function book() { const path = file('ledger.sqlite'); createLedger(path, { scope: 'same-people', totalEpsilon: '0.6' }); return path; }
function changeField(name, action) {
  return JSON.stringify({ ...template, settings: { ...template.settings, fields: template.settings.fields.map(f => f.name === name ? { ...f, action } : f) } });
}

test('field templates round trip explicit rules, remain immutable and reject ambiguous or injected fields', () => {
  assert.deepEqual(createRedactionTemplate(template.name, template.settings), template);
  assert.deepEqual(parseRedactionTemplate(`\uFEFF${source}`), template);
  assert.ok(Object.isFrozen(template.settings.fields[0]));
  const raw = JSON.stringify(template);
  for (const bad of [
    raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    raw.replace('"action":"keep"', '"action":"keep","act\\u0069on":"mask"'),
    raw.replace('"schemaVersion":1', '"schemaVersion":2'),
    raw.replace('"spreadsheetSafe":true', '"spreadsheetSafe":"true"'),
    JSON.stringify({ ...template, requestId: 'secret-identity' }),
    JSON.stringify({ ...template, settings: { ...template.settings, data: 'secret-data' } }),
    ' '.repeat(100001),
  ]) assert.throws(() => parseRedactionTemplate(bad), error => !error.message.includes('secret'));
  assert.throws(() => parseRedactionTemplate(template));
});

test('compatibility requires all columns, allows reordered fields and performs no sampling or ledger writes', () => {
  const ledger = book(), before = ledgerStatus(ledger);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    for (const [format, input] of [['csv', csv], ['json', json], ['csv', 'contact,answer,person_id']]) {
      assert.equal(checkRedactionTemplate(template, format, input).compatible, true);
      assert.ok(!applyRedactionTemplate(template, format, input).output.includes('secret'));
    }
    const check = checkRedactionTemplate(template, 'csv', 'person_id,answer,phone\np,满意,secret-contact');
    assert.deepEqual(check, { compatible: false, missing_fields: ['contact'], unexpected_fields: ['phone'], issue: 'field_mismatch' });
    assert.ok(!JSON.stringify(check).includes('secret'));
    assert.throws(() => applyRedactionTemplate(template, 'csv', 'person_id,answer,contact,phone\np,满意,secret,secret'));
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.deepEqual(ledgerStatus(ledger), before);
});

test('handoff allows only kept values and rejects ambiguity introduced by CSV formula escaping', () => {
  const prepared = prepareRedactionHandoff(template, 'csv', csv);
  assert.deepEqual(prepared.eligible_fields, ['person_id', 'answer']);
  assert.deepEqual(prepared.excluded_fields, ['contact']);
  assert.ok(Object.isFrozen(prepared.result.audit));
  assert.deepEqual(prepareRedactionHandoff(template, 'csv', csv.replace('private-p2', '=private-p2')).eligible_fields, ['answer']);
  assert.deepEqual(prepareRedactionHandoff(template, 'csv', csv.replace('不满意', '-不满意')).eligible_fields, ['person_id']);
  const masked = parseRedactionTemplate(changeField('person_id', 'mask'));
  assert.deepEqual(prepareRedactionHandoff(masked, 'json', json).eligible_fields, ['answer']);
  const headers = createRedactionTemplate('CSV 列名', { spreadsheetSafe: true, fields: [{ name: '=id', action: 'keep' }, { name: "'=id", action: 'keep' }, { name: 'contact', action: 'remove' }] });
  assert.throws(() => prepareRedactionHandoff(headers, 'csv', "=id,'=id,contact\np1,p2,secret"));
});

test('guarded redaction releases preserve original statistics, request identity and cumulative budget', () => {
  const ledger = book();
  const a = publishRedactedRelease(ledger, 'csv', csv, source, statistics, 'original-request');
  assert.deepEqual(publishRedactedRelease(ledger, 'json', json, source, statistics, 'original-request'), a);
  assert.deepEqual(publishTemplateRelease(ledger, 'csv', csv, statistics, 'original-request'), a);
  const renamed = JSON.stringify({ ...template, name: '改名仍是同一口径' });
  assert.deepEqual(publishRedactedRelease(ledger, 'csv', csv, renamed, statistics, 'original-request'), a);
  assert.equal(ledgerStatus(ledger).spent_epsilon, '0.3');
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv.replace('private-p2', 'private-p3'), source, statistics, 'original-request'), e => e.code === 'REQUEST_CONFLICT');
  publishRedactedRelease(ledger, 'csv', csv, source, statistics, 'next-request');
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv, source, statistics, 'over-budget'), e => e.code === 'BUDGET_EXHAUSTED');
  assert.deepEqual(publishRedactedRelease(ledger, 'csv', csv, source, statistics, 'original-request'), a);
  assert.ok(!JSON.stringify(a).includes('private-') && !readFileSync(ledger).includes(Buffer.from('secret-contact')));
});

test('removed masked or escaped statistical fields fail before publication without touching the ledger', () => {
  const ledger = book(), before = ledgerStatus(ledger);
  for (const name of ['person_id', 'answer']) for (const action of ['remove', 'mask']) {
    assert.throws(() => publishRedactedRelease(ledger, 'csv', csv, changeField(name, action), statistics, 'attempt'), /unchanged fields/);
  }
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv.replace('private-p1', '=private-p1'), source, statistics, 'attempt'), /unchanged fields/);
  assert.throws(() => publishRedactedRelease(ledger, 'csv', csv, source, statistics, undefined));
  const missing = file('absent.sqlite');
  assert.throws(() => publishRedactedRelease(missing, 'csv', csv, source, statistics, 'attempt'));
  assert.equal(existsSync(missing), false);
  assert.deepEqual(ledgerStatus(ledger), before);
});

test('ambiguous JSON is rejected before redaction can erase duplicate-key evidence', () => {
  for (const input of [json.replace('"person_id":"private-p1"', '"person_id":"private-p1","person_\\u0069d":"secret"'), json.replace('"contact":"secret-contact"', '"contact":{"a":"secret","a":"secret"}')]) {
    assert.throws(() => applyRedactionTemplate(template, 'json', input), error => !error.message.includes('secret'));
    assert.throws(() => prepareRedactionHandoff(template, 'json', input), error => !error.message.includes('secret'));
  }
});

test('CLI checks and applies portable field rules without overwriting files or leaking input into audits', () => {
  const input = file('table.csv'), config = file('template.json'), output = file('processed.csv');
  writeFileSync(input, csv); writeFileSync(config, source);
  const check = cli(['check-redaction-template', 'csv', input, config]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).compatible, true);
  const apply = cli(['redact-template', 'csv', input, output, config]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.ok(!readFileSync(output, 'utf8').includes('secret-contact'));
  assert.equal(JSON.parse(readFileSync(`${output}.audit.json`)).removed_values, 3);
  assert.ok(!readFileSync(`${output}.audit.json`, 'utf8').includes('private-'));
  assert.equal(cli(['redact-template', 'csv', input, output, config]).status, 1);
  assert.equal(cli(['redact-template', 'csv', input, input, config]).status, 1);
  assert.equal(readFileSync(input, 'utf8'), csv);
});

test('CLI refuses new fields, duplicate keys and invalid UTF-8 without creating output', () => {
  const input = file('table.json'), config = file('template.json'); writeFileSync(config, source);
  writeFileSync(input, json.replace('"contact":"secret-contact"', '"phone":"secret-contact"'));
  const bad = cli(['check-redaction-template', 'json', input, config]);
  assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stdout).compatible, false);
  assert.ok(!bad.stdout.includes('secret-contact'));
  for (const content of [json.replace('"person_id":"private-p1"', '"person_id":"private-p1","person_id":"secret"'), Buffer.from([0xff])]) {
    writeFileSync(input, content); const output = file('blocked.json');
    assert.equal(cli(['redact-template', 'json', input, output, config]).status, 1);
    assert.equal(existsSync(output), false); assert.equal(existsSync(`${output}.audit.json`), false);
  }
  writeFileSync(input, json); writeFileSync(config, Buffer.from([0xff]));
  assert.equal(cli(['check-redaction-template', 'json', input, config]).status, 1);
});
