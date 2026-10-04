import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'moonprivacykit-test-'));
const run = (args, input) => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, input, encoding: 'utf8' });

test('CLI survey creation, protected file collection, retry and aggregation run end to end', () => {
  const survey = join(scratch, 'survey.json');
  const response = join(scratch, 'response.json');
  const report = join(scratch, 'report.json');
  assert.equal(run(['init-survey', survey]).status, 0);
  assert.equal(run(['protect', survey, response], '[1,2]').status, 0);
  const result = run(['aggregate', survey, report, response, response]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(report)).accepted, 1);
  assert.equal(JSON.parse(readFileSync(report)).duplicates, 1);
  const before = readFileSync(response, 'utf8');
  assert.equal(run(['protect', survey, response], '[0,0]').status, 1);
  assert.equal(readFileSync(response, 'utf8'), before);
});

test('CLI exports redacted data and prevents preexisting audit or source overwrite', () => {
  const output = join(scratch, 'clean.csv');
  const result = run(['redact', 'csv', 'examples/sample.csv', output, 'examples/policy.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!readFileSync(output, 'utf8').includes('example.test'));
  assert.deepEqual(JSON.parse(readFileSync(`${output}.audit.json`)), { records: 2, removed_values: 2, masked_values: 2, spreadsheet_escapes: 0 });
  const next = join(scratch, 'conflict.csv');
  writeFileSync(`${next}.audit.json`, 'existing');
  assert.equal(run(['redact', 'csv', 'examples/sample.csv', next, 'examples/policy.json']).status, 1);
  assert.ok(!existsSync(next));
  assert.equal(run(['redact', 'csv', 'examples/sample.csv', 'examples/sample.csv', 'examples/policy.json']).status, 1);
});

test('CLI plans actual precision and refuses invalid answers without writing a response', () => {
  const plan = join(scratch, 'plan.json');
  assert.equal(run(['plan', 'examples/plan.json', plan]).status, 0);
  assert.ok(JSON.parse(readFileSync(plan)).required_samples > 1000);
  const invalid = join(scratch, 'invalid.json');
  const result = run(['protect', 'examples/survey.json', invalid], '[0.5,1]');
  assert.equal(result.status, 1);
  assert.ok(!existsSync(invalid));
  assert.ok(!result.stderr.includes('0.5'));
});
