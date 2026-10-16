import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPrivacyWorkflow as check } from '../runtime/privacy-workflow.mjs';

const example = readFileSync(new URL('../examples/privacy-workflow.json', import.meta.url), 'utf8');
const valid = () => JSON.parse(example);
const step = (id, op, input, settings) => ({ id, op, input, settings });
const code = (report, name) => report.issues.some(i => i.code === name);

test('a bounded person remains bounded after identifiers are removed; report reuse spends once', () => {
  const plan = valid(), before = structuredClone(plan), result = check(plan);
  assert.deepEqual(plan, before);
  assert.equal(result.status, 'compatible');
  assert.equal(result.checks.find(s => s.node === 'total').l1_sensitivity, 30);
  assert.equal(result.checks.find(s => s.node === 'minimized').person_field_available, false);
  assert.equal(result.checks.at(-1).release_node, 'release');
  assert.deepEqual(result.budget, { total_epsilon_units: 1000000, spent_epsilon_units: 200000, planned_epsilon_units: 300000, remaining_after_plan_units: 500000, estimate_complete: true, charged: false });
  assert.deepEqual(check(plan), result);
});

test('early deletion points to the failing step and blocks its descendants', () => {
  const result = check(readFileSync(new URL('../examples/privacy-workflow-missing-person.json', import.meta.url), 'utf8'));
  assert.equal(result.status, 'blocked');
  assert.equal(result.issues[0].code, 'PERSON_FIELD_MISSING');
  assert.deepEqual(result.issues[0].path, ['source', 'minimized', 'bounded']);
  assert.equal(result.outputs[0].status, 'blocked');
  assert.equal(result.budget.estimate_complete, false);
});

test('all new releases compose across branches while presentation-only branches reuse the release', () => {
  const plan = valid();
  plan.steps.push(step('second', 'dp_release', 'total', { epsilon_units: 500000, trust: 'trusted_holder' }));
  plan.outputs.push({ node: 'second', audience: 'public' });
  assert.equal(check(plan).budget.remaining_after_plan_units, 0);
  plan.steps.at(-1).settings.epsilon_units++;
  const result = check(plan);
  assert.equal(result.status, 'blocked'); assert.ok(code(result, 'BUDGET_EXCEEDED'));
  assert.equal(result.budget.remaining_after_plan_units, -1);
  assert.equal(result.checks.find(s => s.node === 'chart').status, 'valid');
});

test('one branch cannot erase fields, narrow bounds or grant protection to another', () => {
  const plan = valid();
  plan.steps.splice(1, 0, step('private_copy', 'select_fields', 'source', { keep: ['score'] }));
  plan.steps.splice(2, 0, step('narrower', 'bound_person', 'bounded', { max_rows: 1, origin: 'public' }));
  const result = check(plan);
  assert.equal(result.status, 'compatible');
  assert.equal(result.checks.find(s => s.node === 'source').person_field_available, true);
  assert.equal(result.checks.find(s => s.node === 'total').l1_sensitivity, 30);
  plan.outputs.push({ node: 'private_copy', audience: 'public' });
  assert.ok(code(check(plan), 'OUTPUT_NOT_PROTECTED'));
});

test('private and unknown parameter origins do not silently inherit a DP guarantee', () => {
  for (const origin of ['private', 'unknown']) {
    for (const location of ['upper', 'cap', 'selection']) {
      const plan = valid();
      if (location === 'upper') plan.steps[2].settings.origin = origin;
      if (location === 'cap') plan.steps[0].settings.origin = origin;
      if (location === 'selection') plan.sources[0].selection_origin = origin;
      const result = check(plan);
      assert.equal(result.status, origin === 'private' ? 'blocked' : 'inconclusive');
      assert.ok(code(result, 'PARAMETER_NOT_PUBLIC'));
      assert.equal(result.budget.estimate_complete, false);
    }
  }
});

test('exact encrypted totals and field-minimized tables are not public DP reports', () => {
  const plan = valid(); plan.steps = []; plan.outputs = [{ node: 'source', audience: 'public' }];
  assert.ok(code(check(plan), 'OUTPUT_NOT_PROTECTED'));
  plan.sources[0] = { id: 'source', kind: 'exact_joint_total', fields: [], person_field: '', selection_origin: 'public' };
  assert.ok(code(check(plan), 'OUTPUT_NOT_PROTECTED'));
  plan.outputs[0].audience = 'internal'; assert.equal(check(plan).status, 'compatible');
  plan.steps = [step('dp', 'dp_release', 'source', { epsilon_units: 300000, trust: 'trusted_holder' })];
  plan.outputs = [{ node: 'dp', audience: 'public' }];
  const result = check(plan); assert.equal(result.status, 'inconclusive');
  assert.ok(code(result, 'JOINT_BOUND_UNVERIFIED'));
});

test('unknown steps cannot be laundered through postprocessing or an internal destination', () => {
  const plan = valid(); plan.steps[3].op = 'external_dp';
  const result = check(plan);
  assert.equal(result.status, 'inconclusive');
  assert.ok(code(result, 'UNSUPPORTED_OPERATION'));
  assert.equal(result.outputs[0].status, 'unverified');
  plan.outputs = [{ node: 'chart', audience: 'internal' }];
  assert.equal(check(plan).status, 'inconclusive');
});

test('missing contribution bounds, wrong trust and raw-data postprocessing are rejected', () => {
  const unbounded = valid(); unbounded.steps[1].input = 'source';
  assert.ok(code(check(unbounded), 'PERSON_BOUND_MISSING'));
  const untrusted = valid(); untrusted.steps[3].settings.trust = 'untrusted';
  assert.ok(code(check(untrusted), 'TRUST_MISMATCH'));
  const raw = valid(); raw.steps[4].input = 'source';
  assert.ok(code(check(raw), 'PROTECTED_REPORT_REQUIRED'));
  const twice = valid(); twice.steps[4] = step('chart', 'dp_release', 'release', { epsilon_units: 100000, trust: 'trusted_holder' });
  assert.ok(code(check(twice), 'EXACT_TOTAL_REQUIRED'));
});

test('strict schema rejects ambiguous files, forged source reports, cycles and oversized plans', () => {
  assert.throws(() => check(example.replace('"schema_version": 1', '"schema_version": 1, "schema_\\u0076ersion": 1')));
  const mutations = [
    p => { p.sources[0].kind = 'dp_report'; },
    p => { p.sources[0].raw_data = ['should-not-be-accepted']; },
    p => { p.sources[0].fields.push('score'); },
    p => { p.steps[0].input = 'chart'; },
    p => { p.steps[0].id = 'source'; },
    p => { p.steps[0].settings.max_rows = 1.5; },
    p => { p.steps[3].settings.epsilon_units = 0; },
    p => { p.steps[3].settings.epsilon_units = 2147483647; },
    p => { p.steps[4].settings.script = 'fetch(secret)'; },
    p => { p.steps = Array(33).fill(p.steps[0]); },
    p => { p.outputs.push(p.outputs[0]); },
    p => { p.outputs[0].node = 'missing'; },
    p => { p.budget.spent_epsilon_units = p.budget.total_epsilon_units + 1; },
  ];
  mutations.forEach(mutate => { const plan = valid(); mutate(plan); assert.throws(() => check(plan)); });
  assert.throws(() => check(' '.repeat(128001)));
});

test('schema bounds keep sensitivity and branch accounting within exact integers', () => {
  const plan = valid(); plan.budget.total_epsilon_units = 1000000000;
  plan.steps = [step('bound', 'bound_person', 'source', { max_rows: 32, origin: 'public' }), step('sum', 'aggregate', 'bound', { query: 'bounded_sum', value_field: 'score', upper: 1000, origin: 'public' })];
  for (let i = 0; i < 30; i++) plan.steps.push(step(`r${i}`, 'dp_release', 'sum', { epsilon_units: 10000000, trust: 'trusted_holder' }));
  plan.outputs = [{ node: 'r29', audience: 'public' }];
  const result = check(plan);
  assert.equal(result.status, 'compatible');
  assert.equal(result.checks[2].l1_sensitivity, 32000);
  assert.equal(result.budget.planned_epsilon_units, 300000000);
});

test('CLI gives actionable exit statuses without overwriting input or creating a ledger', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mpk-workflow-'));
  const input = join(directory, 'plan.json'); writeFileSync(input, example);
  const run = output => spawnSync(process.execPath, ['cli/main.mjs', 'check-workflow', input, output], { encoding: 'utf8' });
  const output = join(directory, 'compatible.json'); assert.equal(run(output).status, 0);
  assert.equal(run(output).status, 1); assert.equal(readFileSync(input, 'utf8'), example);
  const plan = valid(); plan.steps[0].settings.origin = 'private'; writeFileSync(input, JSON.stringify(plan));
  assert.equal(run(join(directory, 'blocked.json')).status, 2);
  plan.steps[0].settings.origin = 'unknown'; writeFileSync(input, JSON.stringify(plan));
  assert.equal(run(join(directory, 'unknown.json')).status, 3);
  assert.ok(readdirSync(directory).every(name => name.endsWith('.json')));
});
