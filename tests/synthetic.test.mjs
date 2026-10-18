import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { callCore } from '../runtime/client.mjs';
import { planSynthetic, parseSyntheticPlan, publishSynthetic } from '../runtime/synthetic.mjs';
import { createLedger, ledgerStatus, listReleases, savedRelease, publishRelease } from '../runtime/ledger.mjs';
import { createWorkbenchServer } from '../runtime/workbench-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-synthetic-'));
let serial = 0;
const plan = { schema_version: 1, unit_field: 'person', output_rows: 40, fields: [
  { name: 'group', categories: ['student', 'staff'], parent: -1 },
  { name: 'choice', categories: ['yes', 'no'], parent: 0 },
] };
const input = 'person,group,choice,secret\nprivate-person-a,student,yes,private-salary\nprivate-person-b,staff,no,private-address\n';
const request = (changes = {}) => ({ plan, input, format: 'csv', requestId: 'release-a', epsilon: '1', ...changes });
const code = value => error => error.code === value;
function book(total = '2') {
  const path = join(scratch, `${serial++}.sqlite`);
  createLedger(path, { scope: 'cohort', totalEpsilon: total }); return path;
}
function withoutCrypto(action) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try { return action(); } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
}
const cli = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('public synthetic plan rejects cycles, private identifiers, ambiguous domains and oversized models', () => {
  assert.equal(planSynthetic(plan).l1_sensitivity, 2);
  assert.equal(planSynthetic(plan).measurement_cells, 6);
  assert.deepEqual(parseSyntheticPlan(JSON.stringify(plan)), plan);
  assert.throws(() => parseSyntheticPlan(JSON.stringify(plan).replace('"schema_version":1', '"schema_version":1,"schema_version":2')));
  const changed = patch => ({ ...structuredClone(plan), ...patch });
  for (const bad of [
    changed({ schema_version: 2 }), changed({ output_rows: .5 }), changed({ output_rows: 5001 }),
    changed({ inferred: true }), changed({ fields: [] }),
    changed({ fields: [{ ...plan.fields[0], parent: 0 }] }),
    changed({ fields: [plan.fields[0], { ...plan.fields[1], parent: 1 }] }),
    changed({ fields: [{ ...plan.fields[0], name: 'person' }] }),
    changed({ fields: [{ ...plan.fields[0], categories: ['x', 'x'] }] }),
    changed({ unit_field: 'person\n' }),
    changed({ fields: [{ ...plan.fields[0], name: 'new\nfield' }] }),
    changed({ fields: [{ ...plan.fields[0], categories: ['line\nbreak'] }] }),
    changed({ fields: [plan.fields[0], { ...plan.fields[1], name: 'group' }] }),
    changed({ fields: Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, parent: i - 1, categories: Array.from({ length: 8 }, (_, j) => String(j)) })) }),
  ]) assert.throws(() => planSynthetic(bad));
});

test('mapping matches CSV and JSON, drops unrelated values and bounds each valid person across measurements', () => {
  const map = (format, input) => callCore({ op: 'mapSynthetic', plan, format, input });
  const csv = map('csv', input);
  assert.deepEqual(csv.category_ids, [0, 2, 1, 5]);
  assert.deepEqual(csv, map('json', JSON.stringify([
    { person: 'private-person-a', group: 'student', choice: 'yes', secret: 'private-salary' },
    { person: 'private-person-b', group: 'staff', choice: 'no', secret: 'private-address' },
  ])));
  for (const bad of [input + 'private-person-a,student,no,x\n', input.replace('student', 'private-unknown'), input.replace('private-person-a', ''), 'person,group,choice\na,student\n']) {
    assert.throws(() => map('csv', bad), error => !error.message.includes('private-'));
  }
  assert.throws(() => map('json', '[{"person":"a","person":"b","group":"staff","choice":"no"}]'));
  assert.throws(() => map('json', '[{"person":"a","group":12,"choice":"no"}]'));
});

test('one atomic budget release saves only protected model and synthetic output; retries never resample', () => {
  const path = book('1');
  const result = publishSynthetic(path, request());
  assert.equal(result.synthetic.rows.length, 40);
  assert.deepEqual(result.synthetic.columns, ['group', 'choice']);
  for (const [a, b] of result.synthetic.rows) { assert.ok(['student', 'staff'].includes(a)); assert.ok(['yes', 'no'].includes(b)); }
  assert.equal(result.report.max_contributions, 2);
  assert.equal(result.report.category_count, 6);
  assert.ok(result.report.epsilon_upper_bound <= 1);
  assert.equal(ledgerStatus(path).spent_epsilon, '1');
  assert.equal(ledgerStatus(path).release_count, 1);
  assert.equal(listReleases(path).items[0].kind, 'synthetic-table');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('private-'));
  assert.ok(!readFileSync(path).includes(Buffer.from('private-')));
  assert.ok(Object.isFrozen(result.synthetic.rows[0]));
  withoutCrypto(() => {
    assert.equal(JSON.stringify(publishSynthetic(path, request())), serialized);
    const reordered = { fields: plan.fields.map(f => ({ parent: f.parent, categories: f.categories, name: f.name })), output_rows: plan.output_rows, unit_field: plan.unit_field, schema_version: 1 };
    assert.equal(JSON.stringify(publishSynthetic(path, request({ plan: reordered }))), serialized);
    assert.equal(JSON.stringify(savedRelease(path, 'release-a')), serialized);
    assert.throws(() => publishSynthetic(path, request({ requestId: 'release-b' })), code('BUDGET_EXHAUSTED'));
  });
  assert.equal(ledgerStatus(path).release_count, 1);
});

test('request identity binds the public tree and requested output size; invalid input spends nothing', () => {
  const path = book();
  for (const change of [ { input: input.replace('student', 'unknown') }, { input: input + 'private-person-a,staff,no,x\n' }, { plan: { ...plan, output_rows: 0 } } ]) {
    assert.throws(() => publishSynthetic(path, request(change)));
    assert.equal(ledgerStatus(path).spent_epsilon, '0');
  }
  publishSynthetic(path, request());
  assert.throws(() => publishSynthetic(path, request({ plan: { ...plan, output_rows: 41 } })), code('REQUEST_CONFLICT'));
  assert.throws(() => publishRelease(path, { scope: 'cohort', requestId: 'invalid', epsilon: '1', query: 'histogram', unitIds: [], categoryIds: [], categories: ['cell:0'], maxContributions: 1, syntheticPlan: plan }), code('INVALID_REQUEST'));
  assert.equal(ledgerStatus(path).release_count, 1);
});

test('postprocessing failure rolls back both report and budget; no partial output is returned', () => {
  const path = book();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let calls = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    subtle: {}, getRandomValues(words) { if (++calls > 1) throw new Error('sampler unavailable'); words.fill(0); return words; },
  } });
  try { assert.throws(() => publishSynthetic(path, request()), code('RELEASE_FAILED')); }
  finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal(calls, 2);
  assert.equal(ledgerStatus(path).spent_epsilon, '0');
  assert.throws(() => savedRelease(path, 'release-a'), code('RELEASE_NOT_FOUND'));
  publishSynthetic(path, request());
  assert.equal(ledgerStatus(path).release_count, 1);
});

test('empty input still uses public output size; saved synthetic artifacts are integrity checked', () => {
  const path = book();
  const result = publishSynthetic(path, request({ input: '[]', format: 'json' }));
  assert.equal(result.synthetic.rows.length, 40);
  assert.equal(result.synthetic.plan.output_rows, 40);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE releases SET result_json = ?').run(JSON.stringify({ ...result, synthetic: { rows: [] } })); db.close();
  assert.throws(() => savedRelease(path, 'release-a'), code('INVALID_LEDGER'));
});

test('CLI generates once and recovers identical spreadsheet-safe CSV without raw source', () => {
  const path = book(), planPath = join(scratch, 'plan.json'), source = join(scratch, 'source.csv'), out = join(scratch, 'result.json');
  writeFileSync(planPath, JSON.stringify(plan)); writeFileSync(source, input);
  const generated = cli(['synthesize', path, planPath, 'csv', source, 'from-cli', '1', out]); assert.equal(generated.status, 0, generated.stderr);
  const result = JSON.parse(readFileSync(out));
  for (const name of ['first.csv', 'second.csv']) {
    const target = join(scratch, name);
    const exported = cli(['export-synthetic', path, 'from-cli', target]); assert.equal(exported.status, 0, exported.stderr);
    assert.equal(readFileSync(target, 'utf8'), result.synthetic.csv);
  }
  assert.notEqual(cli(['export-synthetic', path, 'from-cli', join(scratch, 'first.csv')]).status, 0);
  assert.equal(ledgerStatus(path).release_count, 1);
});

test('local API preserves shared budget and retry identity, and rejects unauthenticated writes', async () => {
  const server = createWorkbenchServer({ root, dataDir: join(scratch, 'projects') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const token = (await (await fetch(origin + '/api/session')).json()).data.token;
    const post = async (path, data, auth = true) => (await fetch(origin + '/api/' + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(auth ? { 'x-moonprivacykit-token': token } : {}) }, body: JSON.stringify(data) })).json();
    const project = (await post('projects', { name: 'Synthetic', totalEpsilon: '1' })).data;
    const endpoint = `projects/${project.id}/publish-synthetic`;
    assert.equal((await post(endpoint, request(), false)).code, 'SESSION_REQUIRED');
    const invalid = await post(endpoint, request({ input: input.replace('student', 'private-value') }));
    assert.equal(invalid.code, 'INVALID_TABLE'); assert.ok(!JSON.stringify(invalid).includes('private-value'));
    const first = await post(endpoint, request()); assert.equal(first.ok, true);
    assert.deepEqual(await post(endpoint, request()), first);
    assert.equal((await post(endpoint, request({ requestId: 'next' }))).code, 'BUDGET_EXHAUSTED');
  } finally { await new Promise(r => server.close(r)); }
});
