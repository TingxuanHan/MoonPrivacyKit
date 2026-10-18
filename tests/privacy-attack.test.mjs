import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { evaluatePrivacyAttack, parsePrivacyAttackPlan } from '../runtime/privacy-attack.mjs';
import { createLedger, ledgerStatus, savedRelease } from '../runtime/ledger.mjs';
import { publishSynthetic } from '../runtime/synthetic.mjs';

const config = JSON.parse(readFileSync(new URL('../examples/privacy-attack-plan.json', import.meta.url)));
const demo = JSON.parse(readFileSync(new URL('../examples/privacy-attack-demo.json', import.meta.url)));
const source = rows => ({ format: 'json', input: JSON.stringify(rows) });
const request = () => ({ config: structuredClone(config), members: source(demo.members), nonmembers: source(demo.nonmembers), released: source(demo.released) });
const run = patch => evaluatePrivacyAttack({ ...request(), ...patch });

test('copied records produce test evidence without returning identifiers, raw values or predictions', () => {
  const report = run();
  assert.equal(report.membership.threshold_mismatches, 0);
  assert.equal(report.membership.true_positive_rate.rate, 1);
  assert.equal(report.membership.false_positive_rate.rate, 0);
  assert.ok(report.membership.advantage.lower95 > 0);
  assert.equal(report.attribute.members.accuracy.rate, 1);
  assert.equal(report.audience, 'internal');
  for (const raw of ['member-0', 'control-0', 'pattern-0', 'row_predictions', 'yes', 'no']) {
    assert.ok(!JSON.stringify(report).includes(`"${raw}"`));
  }
  assert.equal(report.membership.true_positive_rate.trials, 20);
  assert.ok(report.membership.true_positive_rate.lower95 < 1);
});

// Independent BigInt recurrence; unlike the core this does not use Schrage
// arithmetic. Brute-force predictions provide a separate numeric oracle.
function split(rows, seed) {
  const result = [...rows].sort((a, b) => a.person < b.person ? -1 : a.person > b.person ? 1 : 0);
  let state = BigInt(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const bound = BigInt(i + 1), limit = 2147483646n / bound * bound;
    let draw;
    do { state = state * 48271n % 2147483647n; draw = state - 1n; } while (draw >= limit);
    const j = Number(draw % bound); [result[i], result[j]] = [result[j], result[i]];
  }
  return [result.slice(0, Math.floor(result.length / 2)), result.slice(Math.floor(result.length / 2))];
}
function oracle(members, controls, released, seed) {
  const [mc, mt] = split(members, seed), [nc, nt] = split(controls, seed === 2147483646 ? 1 : seed + 1);
  const score = r => Math.min(...released.map(s => Number(r.group !== s.group) + Number(r.choice !== s.choice)));
  const positives = (rows, t) => rows.filter(r => score(r) <= t).length;
  const candidates = [-1, 0, 1, 2].map(t => ({ t, advantage: positives(mc, t) * nc.length - positives(nc, t) * mc.length }));
  candidates.sort((a, b) => b.advantage - a.advantage || a.t - b.t);
  const t = candidates[0].t;
  const most = rows => rows.filter(r => r.choice === 'yes').length >= rows.filter(r => r.choice === 'no').length ? 'yes' : 'no';
  const baseline = most(nc);
  const attribute = rows => {
    const correct = rows.filter(r => {
      const matches = released.filter(s => s.group === r.group);
      return most(matches.length ? matches : released) === r.choice;
    }).length;
    return [correct, rows.filter(r => r.choice === baseline).length];
  };
  return { t, tp: positives(mt, t), fp: positives(nt, t), attributes: [attribute(mt), attribute(nt)], mc, mt, nc, nt };
}

test('all threshold choices agree with independent enumeration across seeds and uneven samples', () => {
  const members = Array.from({ length: 43 }, (_, i) => ({ person: `m-${i}`, group: String(i % 4), choice: i % 3 ? 'yes' : 'no' }));
  const controls = Array.from({ length: 61 }, (_, i) => ({ person: `n-${i}`, group: String(i % 5), choice: i % 2 ? 'yes' : 'no' }));
  for (const seed of [1, 17, 20261018, 2147483646]) {
    for (const released of [[{ group: '0', choice: 'yes' }], [{ group: '4', choice: 'no' }], [{ group: '0', choice: 'no' }, { group: '1', choice: 'yes' }]]) {
      const expected = oracle(members, controls, released, seed);
      const actual = run({ config: { ...config, split_seed: seed }, members: source(members), nonmembers: source(controls), released: source(released) });
      assert.deepEqual([actual.membership.threshold_mismatches, actual.membership.true_positives, actual.membership.false_positives], [expected.t, expected.tp, expected.fp], JSON.stringify({seed,released}));
      assert.deepEqual(['members', 'nonmembers'].map(group => [actual.attribute[group].accuracy.successes, actual.attribute[group].baseline_accuracy.successes]), expected.attributes);
    }
  }
});

test('test labels never select the membership threshold or the attribute baseline', () => {
  const seed = 17, cut = oracle(demo.members, demo.nonmembers, demo.released, seed);
  const a = run({ config: { ...config, split_seed: seed } });
  const memberTestIds = new Set(cut.mt.map(r => r.person)), nonmemberTestIds = new Set(cut.nt.map(r => r.person));
  const change = (rows, ids) => rows.map(r => ids.has(r.person) ? { ...r, group: 'held-out-change', choice: r.choice === 'yes' ? 'no' : 'yes' } : r);
  const b = run({ config: { ...config, split_seed: seed }, members: source(change(demo.members, memberTestIds)), nonmembers: source(change(demo.nonmembers, nonmemberTestIds)) });
  assert.equal(a.membership.threshold_mismatches, b.membership.threshold_mismatches);
  assert.notEqual(a.membership.true_positives, b.membership.true_positives);
  // Flipping every held-out truth reverses the fixed baseline's accuracy. A
  // baseline improperly refitted on those labels would not have this property.
  assert.equal(a.attribute.nonmembers.baseline_accuracy.rate + b.attribute.nonmembers.baseline_accuracy.rate, 1);
});

test('indistinguishable groups yield an inconclusive all-negative attack and a fair prevalence baseline', () => {
  const rows = prefix => Array.from({ length: 40 }, (_, i) => ({ person: `${prefix}${i}`, group: 'same', choice: 'yes' }));
  const r = run({ members: source(rows('m')), nonmembers: source(rows('n')), released: source([{ group: 'same', choice: 'yes' }]) });
  assert.equal(r.membership.threshold_mismatches, -1);
  assert.equal(r.membership.balanced_accuracy, .5);
  assert.equal(r.membership.advantage.estimate, 0);
  assert.ok(r.membership.advantage.lower95 < 0 && r.membership.advantage.upper95 > 0);
  assert.equal(r.attribute.members.accuracy.rate, 1);
  assert.equal(r.attribute.members.baseline_accuracy.rate, 1);
  assert.equal(r.attribute.members.gain.estimate, 0);
});

test('row order changes and repeated evaluation preserve the complete report', () => {
  assert.deepEqual(run(), run());
  assert.deepEqual(run(), run({ members: source([...demo.members].reverse()), nonmembers: source([...demo.nonmembers].reverse()), released: source([...demo.released].reverse()) }));
});

test('overlapping people, malformed fields, private identifiers and unsupported scope fail closed', () => {
  const bad = [
    { members: source(demo.members.slice(0, 19)) },
    { nonmembers: source(demo.members) },
    { members: source([...demo.members, demo.members[0]]) },
    { members: source(demo.members.map(r => ({ ...r, choice: 'unlisted-private-value' }))) },
    { released: source(demo.members) },
    { released: source(demo.released.map(r => ({ ...r, extra: 'unexamined' }))) },
    { released: source([]) },
    { released: source([{ group: 1, choice: 'yes' }]) },
    { config: { ...config, known_fields: ['person'] } },
    { config: { ...config, split_seed: 1.5 } },
    { config: { ...config, sensitive_values: ['yes', 'yes'] } },
    { config: { ...config, unexpected: true } },
    { released: { format: 'json', input: '[{"group":"x","group":"y","choice":"yes"}]' } },
  ];
  for (const patch of bad) assert.throws(() => run(patch), error => !/unlisted-private-value|unexamined/.test(error.message));
  assert.throws(() => parsePrivacyAttackPlan(JSON.stringify(config).replace('"schema_version":1', '"schema_version":1,"schema_version":2')));
  const many = prefix => Array.from({ length: 2000 }, (_, i) => ({ person: prefix + i, group: 'a', choice: 'yes' }));
  assert.throws(() => run({ members: source(many('m')), nonmembers: source(many('n')), released: source(Array(5000).fill({ group: 'a', choice: 'yes' })) }), /work limit/);
});

test('artifact and CSV imports agree without stripping literal formula prefixes', () => {
  const csv = rows => Object.keys(rows[0]).join(',') + '\n' + rows.map(row => Object.values(row).join(',')).join('\n');
  assert.deepEqual(run(), run({ members: { format: 'csv', input: '\uFEFF' + csv(demo.members) }, released: { format: 'csv', input: csv(demo.released) } }));
  const artifact = { synthetic: { schema_version: 1, kind: 'moonprivacykit/synthetic-table', columns: ['group', 'choice'], rows: demo.released.map(r => [r.group, r.choice]) } };
  assert.deepEqual(run(), run({ released: source(artifact) }));
  assert.throws(() => run({ released: source({ synthetic: { ...artifact.synthetic, columns: ['group', 'group'] } }) }));
  const literal = demo.released.map(r => ({ ...r, group: "'" + r.group }));
  assert.notEqual(run().membership.threshold_mismatches, run({ released: source(literal) }).membership.threshold_mismatches);
});

test('evaluating a saved release does not sample again or modify its budget and saved result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpk-attack-ledger-')), ledger = join(dir, 'book.sqlite');
  createLedger(ledger, { scope: 'audit-cohort', totalEpsilon: '2' });
  const rows = prefix => Array.from({ length: 40 }, (_, i) => ({ person: prefix + i, group: i % 2 ? 'a' : 'b', choice: i % 3 ? 'yes' : 'no' }));
  const plan = { schema_version: 1, unit_field: 'person', output_rows: 50, fields: [{ name: 'group', categories: ['a', 'b'], parent: -1 }, { name: 'choice', categories: ['yes', 'no'], parent: 0 }] };
  const release = publishSynthetic(ledger, { plan, format: 'json', input: JSON.stringify(rows('m')), requestId: 'saved-audit', epsilon: '1' });
  const before = ledgerStatus(ledger), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    const req = { members: source(rows('m')), nonmembers: source(rows('n')), released: source(release) };
    assert.deepEqual(run(req), run(req));
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.deepEqual(ledgerStatus(ledger), before);
  assert.deepEqual(savedRelease(ledger, 'saved-audit'), release);
});

test('CLI creates an internal report, refuses overwrite, and never writes output after validation failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpk-attack-cli-'));
  const paths = ['config', 'members', 'nonmembers', 'released'].map((name, i) => {
    const path = join(dir, name + '.json'); writeFileSync(path, JSON.stringify([config, demo.members, demo.nonmembers, demo.released][i])); return path;
  });
  const output = join(dir, 'report.json'), cli = out => spawnSync(process.execPath, ['cli/main.mjs', 'audit-synthetic', ...paths, out], { encoding: 'utf8' });
  const result = cli(output); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output)), run());
  assert.notEqual(cli(output).status, 0);
  writeFileSync(paths[2], JSON.stringify(demo.members));
  const failed = join(dir, 'failed.json'); assert.notEqual(cli(failed).status, 0); assert.equal(existsSync(failed), false);
});
