import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callCore } from '../runtime/client.mjs';
const example = JSON.parse(readFileSync(new URL('../examples/disclosure.json', import.meta.url)));
const inspect = model => callCore({ op: 'inspectDisclosure', model });

test('hidden count is derived and only the draft is proposed for removal', () => {
  const report = inspect(example);
  assert.equal(report.status, 'risk_found');
  assert.deepEqual([report.findings[0].minimum, report.findings[0].maximum], [1, 1]);
  assert.deepEqual(report.repairs.map(r => r.remove_drafts), [['待发布类别B']]);
  const repaired = structuredClone(example); repaired.equations.pop();
  const check = inspect(repaired);
  assert.equal(check.status, 'no_risk_in_model');
  assert.deepEqual([check.findings[0].minimum, check.findings[0].maximum], [0, 17]);
});

test('published evidence cannot be revoked by a repair', () => {
  const model = structuredClone(example); model.equations.at(-1).published = true;
  assert.equal(inspect(model).status, 'risk_found');
  assert.deepEqual(inspect(model).repairs, []);
});

test('integer infeasibility, changed cohort assumptions and noisy input are explicit', () => {
  const model = structuredClone(example); model.equations[0].total = 20;
  assert.equal(inspect(model).status, 'inconsistent');
  assert.deepEqual(inspect(model).findings, []);
  for (const patch of [{ kind: 'dp-counts' }, { cohort: '' }, { node_limit: 0 }, { extra: true }]) {
    assert.throws(() => inspect({ ...example, ...patch }));
  }
  const duplicate = structuredClone(example); duplicate.equations[0].cells.push('A');
  assert.throws(() => inspect(duplicate));
});

test('node exhaustion never invents ranges or a successful verdict', () => {
  const model = structuredClone(example); model.node_limit = 100;
  model.equations = [{ id: 'sum', cells: ['A', 'B', 'C'], total: 52, published: true }];
  const report = inspect(model);
  assert.equal(report.status, 'inconclusive');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.repairs, []);
});

test('independent brute force agrees with bounds on small crossing equations', () => {
  for (let total = 0; total <= 8; total++) {
    const model = structuredClone(example); model.cells.forEach(c => { c.upper = 4; c.protected = true; c.min_width = 1; });
    model.equations = [{ id: 'ab', cells: ['A', 'B'], total, published: true }, { id: 'bc', cells: ['B', 'C'], total: 4, published: true }];
    const solutions = [];
    for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) for (let c = 0; c <= 4; c++) if (a + b === total && b + c === 4) solutions.push([a, b, c]);
    const report = inspect(model);
    assert.equal(report.complete, true);
    report.findings.forEach((f, i) => assert.deepEqual([f.minimum, f.maximum], [Math.min(...solutions.map(s => s[i])), Math.max(...solutions.map(s => s[i]))]));
  }
});
