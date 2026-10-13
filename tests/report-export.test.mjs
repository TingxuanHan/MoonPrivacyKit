import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderReport } from '../runtime/report-export.mjs';
import { callCore, aggregateResponses, surveyFingerprint } from '../runtime/client.mjs';
import { assessSurvey } from '../runtime/survey-assessment.mjs';
import { createLedger, publishRelease, savedRelease, ledgerStatus } from '../runtime/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-readable-'));
const survey = { schema_version: 1, id: 'readable', title: '团队意见', questions: [
  { id: 'q1', title: '满意吗？', options: ['满意', '不满意'], epsilon: 1 },
] };
async function surveyFixture(source = survey) {
  const fingerprint = await surveyFingerprint(source);
  const response = callCore({ op: 'protect', survey: source, fingerprint, response_id: 'a'.repeat(32), answers: [0], gates: [0], fallbacks: [0] });
  return aggregateResponses(source, [response, response]);
}
function centralFixture(name = 'ledger', query = 'histogram') {
  const ledger = join(scratch, `${name}.sqlite`);
  createLedger(ledger, { scope: 'private-scope', totalEpsilon: '1' });
  const request = { scope: 'private-scope', requestId: 'private-request-id', query, epsilon: '0.3', maxContributions: 1, unitIds: ['private-person-a', 'private-person-b'] };
  if (query === 'histogram') Object.assign(request, { categories: ['满意', '一般'], categoryIds: [0, 1] });
  return { ledger, result: publishRelease(ledger, request) };
}

test('survey reports bind a stable configuration snapshot and convert legacy results without inventing metadata', async () => {
  const editable = structuredClone(survey), fingerprint = await surveyFingerprint(survey);
  const response = callCore({ op: 'protect', survey, fingerprint, response_id: 'b'.repeat(32), answers: [1], gates: [0], fallbacks: [0] });
  const pending = aggregateResponses(editable, [response, response]);
  editable.title = 'changed later'; editable.questions[0].epsilon = 8;
  const result = await pending;
  assert.equal(result.survey_title, survey.title);
  assert.equal(result.survey_fingerprint, fingerprint);
  assert.equal(result.questions[0].epsilon, 1);
  assert.equal(result.single_epsilon, 1);
  const html = renderReport('survey', result);
  assert.match(html, /团队意见/); assert.match(html, /1 个|1 份/);
  assert.ok(html.includes(fingerprint));
  assert.ok(!html.includes(response.response_id) && !html.includes('reported_count') && !html.includes('raw_proportion'));
  const legacy = { survey_id: result.survey_id, accepted: result.accepted, duplicates: result.duplicates, questionnaire_confidence: result.questionnaire_confidence, questions: result.questions.map(({ epsilon, ...q }) => q) };
  assert.match(renderReport('survey', legacy), /旧版报告未保存/);
  assert.equal(renderReport('survey', result), html);
});

test('all supplied labels are escaped and unexpected private fields cannot enter readable reports', async () => {
  const hostile = '<img src="https://example.invalid/leak" onerror="alert(1)"> & </style><script>bad()</script>';
  const source = structuredClone(survey); source.title = hostile; source.questions[0].title = hostile; source.questions[0].options[0] = hostile;
  const report = await surveyFixture(source), html = renderReport('survey', report);
  assert.ok(html.includes('&lt;img') && html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script') && !html.includes('<img') && !html.includes('<iframe'));
  assert.match(html, /default-src 'none'/);
  assert.throws(() => renderReport('survey', { ...report, unitIds: ['private-value'] }), e => !e.message.includes('private-value'));
  const nested = structuredClone(report); nested.questions[0].answers = ['private-value'];
  assert.throws(() => renderReport('survey', nested), e => !e.message.includes('private-value'));
});

test('readable rounding never narrows intervals or turns a tiny privacy parameter into zero', async () => {
  const survey_fingerprint = await surveyFingerprint(survey);
  const result = await aggregateResponses(survey, Array.from({ length: 300 }, (_, i) => ({
    schema_version: 1, mechanism: 'rr24-v1', survey_fingerprint,
    response_id: i.toString(16).padStart(32, '0'), answers: [i % 2],
  })));
  const rendered = [...renderReport('survey', result).matchAll(/>([\d.]+)% – ([\d.]+)%<\/td>/g)];
  assert.equal(rendered.length, result.questions[0].statistics.categories.length);
  for (const [i, match] of rendered.entries()) {
    const original = result.questions[0].statistics.categories[i];
    assert.ok(Number(match[1]) / 100 <= original.lower);
    assert.ok(Number(match[2]) / 100 >= original.upper);
  }
  const tiny = structuredClone(survey); tiny.questions[0].epsilon = 1e-12;
  const report = await assessSurvey(tiny, { samples: 1000, targetRadius: .05 });
  assert.match(renderReport('assessment', report), /ε 1e-12/);
});

test('saved central report exports preserve results and budget with random sampling unavailable', () => {
  const { ledger, result } = centralFixture(), original = JSON.stringify(result), before = ledgerStatus(ledger);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    const html = renderReport('statistics', result);
    assert.equal(html, renderReport('statistics', savedRelease(ledger, 'private-request-id')));
    for (const secret of ['private-person', 'private-request-id', 'private-scope', 'remaining_epsilon', 'fingerprint_key']) assert.ok(!html.includes(secret));
    assert.match(html, /受保护类别分布/); assert.match(html, /不是剩余预算/);
    assert.deepEqual(ledgerStatus(ledger), before);
    assert.equal(JSON.stringify(result), original);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  const count = centralFixture('count', 'count').result;
  assert.match(renderReport('statistics', count), /受保护人数/);
});

test('assessment export preserves no-signal and above-limit states and supports uniform planning', async () => {
  const source = structuredClone(survey); source.questions[0].epsilon = 0;
  const noSignal = await assessSurvey(source, { samples: 1000, targetRadius: .05, collections: 3 });
  assert.match(renderReport('assessment', noSignal), /增加人数不能解决/);
  source.questions[0].epsilon = .01;
  const over = await assessSurvey(source, { samples: 1000, targetRadius: .0001 });
  assert.match(renderReport('assessment', over), /超过 1,000 万人/);
  const valid = await assessSurvey(survey, { samples: 1000, targetRadius: .5, collections: 2 });
  assert.match(renderReport('assessment', valid), /达到全部题目/);
  const config = JSON.parse(readFileSync(join(root, 'examples/plan.json')));
  const result = { configuration: config, ...callCore({ ...config, op: 'plan' }) };
  assert.match(renderReport('plan', result), /统一参数精度评估/);
});

test('malformed versions, nonfinite values and inconsistent result dimensions fail without echoing content', async () => {
  const good = await surveyFixture();
  const invalid = [null, [], { ...good, schema_version: 99 }, { ...good, accepted: 0 }, { ...good, single_epsilon: 2 }, { ...good, survey_fingerprint: 'private-secret' }];
  const wrongCount = structuredClone(good); wrongCount.questions[0].statistics.categories.pop(); invalid.push(wrongCount);
  const wrongNumber = structuredClone(good); wrongNumber.questions[0].statistics.simultaneous_radius = Infinity; invalid.push(wrongNumber);
  for (const report of invalid) assert.throws(() => renderReport('survey', report), e => !e.message.includes('private-secret'));
  assert.throws(() => renderReport('constructor', good));
  const { result } = centralFixture('invalid-central');
  const wrongCategories = structuredClone(result); wrongCategories.categories.push('unexpected');
  assert.throws(() => renderReport('statistics', wrongCategories));
  const wrongAdjacency = structuredClone(result); wrongAdjacency.report.adjacency = 'different';
  assert.throws(() => renderReport('statistics', wrongAdjacency));
  const assessment = structuredClone(await assessSurvey(survey, { samples: 1000, targetRadius: .05 }));
  assessment.assessment.target_met = !assessment.assessment.target_met;
  assert.throws(() => renderReport('assessment', assessment));
});

test('CLI converts existing results with strict encoding and overwrite protection', async () => {
  const run = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const inputs = { survey: await surveyFixture(), assessment: await assessSurvey(survey, { samples: 1000, targetRadius: .05 }), statistics: centralFixture('cli').result };
  for (const [kind, report] of Object.entries(inputs)) {
    const input = join(scratch, `${kind}.json`), output = join(scratch, `${kind}.html`);
    writeFileSync(input, JSON.stringify(report));
    const before = readFileSync(input, 'utf8'), result = run(['export-report', kind, input, output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), renderReport(kind, report));
    assert.equal(run(['export-report', kind, input, output]).status, 1);
    assert.equal(run(['export-report', kind, input, input]).status, 1);
    assert.equal(readFileSync(input, 'utf8'), before);
  }
  const plan = join(scratch, 'plan.json'), planHtml = join(scratch, 'plan.html');
  assert.equal(run(['plan', 'examples/plan.json', plan]).status, 0);
  assert.equal(run(['export-report', 'plan', plan, planHtml]).status, 0);
  const invalid = join(scratch, 'invalid.json'), absent = join(scratch, 'absent.html');
  for (const content of [Buffer.from([0xff]), '{"private-secret":', '{"private-secret":true}']) {
    writeFileSync(invalid, content);
    const result = run(['export-report', 'survey', invalid, absent]);
    assert.equal(result.status, 1); assert.ok(!result.stderr.includes('private-secret')); assert.equal(existsSync(absent), false);
  }
});
