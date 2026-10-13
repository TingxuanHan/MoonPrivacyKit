import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessSurvey } from '../runtime/survey-assessment.mjs';
import { surveyFingerprint, callCore } from '../runtime/client.mjs';
import { createLedger, ledgerStatus } from '../runtime/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-assessment-'));
const survey = { schema_version: 1, id: 'heterogeneous', title: '逐题评估', questions: [
  { id: 'binary', title: '满意吗？', options: ['是', '否'], epsilon: 0.5 },
  { id: 'priority', title: '改进方向？', options: ['工具', '安排', '沟通'], epsilon: 1.5 },
] };

test('assessment snapshot binds heterogeneous questions to the original survey fingerprint', async () => {
  const edited = structuredClone(survey);
  const pending = assessSurvey(edited, { samples: 1000, targetRadius: 0.05, collections: 4 });
  edited.title = 'later change'; edited.questions[0].epsilon = 8;
  const report = await pending, a = report.assessment;
  assert.equal(report.surveyFingerprint, await surveyFingerprint(survey));
  assert.equal(report.surveyTitle, survey.title);
  assert.ok(Object.isFrozen(a.questions[0]));
  assert.equal(a.total_epsilon, 8);
  assert.equal(a.single_epsilon, 2);
  assert.equal(a.confidence, 0.95);
  assert.notEqual(a.questions[0].radius, a.questions[1].radius);
  assert.equal(a.required_samples, Math.max(...a.questions.map(q => q.required_samples)));
  const sufficient = await assessSurvey(survey, { samples: a.required_samples, targetRadius: 0.05 });
  assert.equal(sufficient.assessment.target_met, true);
  assert.ok(!JSON.stringify(report).includes('answers') && !JSON.stringify(report).includes('response_id'));
});

test('precision matches the existing simultaneous bound and repetition only changes budget', async () => {
  const ledger = join(scratch, 'budget.sqlite');
  createLedger(ledger, { scope: 'preserved-project', totalEpsilon: '0.3' });
  const before = ledgerStatus(ledger);
  const uniform = { ...survey, questions: survey.questions.map((q, i) => ({ ...survey.questions[0], id: `q${i}` })) };
  const reference = callCore({ op: 'plan', categories: 2, questions: 2, epsilon: 0.5, samples: 1000, radius: 0.05, collections: 3 });
  assert.equal(typeof reference.required_samples, 'number');
  assert.equal(callCore({ op: 'plan', categories: 256, questions: 2, epsilon: 0.01, samples: 1000, radius: 0.0001, collections: 1 }).required_samples, null);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: crypto.subtle, getRandomValues() { throw new Error('Assessment must not sample'); } } });
  try {
    const repeated = await assessSurvey(uniform, { samples: 1000, targetRadius: 0.05, collections: 3 });
    const once = await assessSurvey(uniform, { samples: 1000, targetRadius: 0.05 });
    assert.deepEqual(repeated.assessment.questions.map(q => q.radius), reference.plan.per_question_radius);
    assert.equal(repeated.assessment.required_samples, reference.required_samples);
    assert.deepEqual(once.assessment.questions, repeated.assessment.questions);
    assert.equal(repeated.assessment.total_epsilon, once.assessment.total_epsilon * 3);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.deepEqual(ledgerStatus(ledger), before);
});

test('zero and tiny signals, oversized requirements and malformed parameters are explicit', async () => {
  const mixed = structuredClone(survey); mixed.questions[0].epsilon = 0;
  const report = await assessSurvey(mixed, { samples: 1000, targetRadius: 0.05 });
  assert.equal(report.assessment.reason, 'no_signal');
  assert.equal(report.assessment.questions[0].radius, null);
  assert.ok(report.assessment.questions[1].radius > 0);
  for (const q of mixed.questions) q.epsilon = 0.01;
  assert.equal((await assessSurvey(mixed, { samples: 1000, targetRadius: 0.0001 })).assessment.reason, 'above_limit');
  for (const settings of [
    { samples: 1.5 }, { samples: 0 }, { samples: '1000' }, { samples: 10000001 },
    { targetRadius: 0 }, { targetRadius: 1 }, { targetRadius: NaN },
    { collections: 0 }, { collections: 1.5 }, { collections: 10001 },
  ]) await assert.rejects(assessSurvey(survey, { samples: 1000, targetRadius: 0.05, ...settings }));
  await assert.rejects(assessSurvey({ ...survey, answers: 'secret-value' }, { samples: 1000, targetRadius: 0.05 }), e => !e.message.includes('secret'));
});

test('CLI exports reproducible assessments and refuses invalid encoding and existing files', async () => {
  const file = join(scratch, 'survey.json'), report = join(scratch, 'assessment.json'), invalid = join(scratch, 'invalid.json');
  writeFileSync(file, JSON.stringify(survey));
  const cli = args => spawnSync(process.execPath, ['cli/main.mjs', 'assess-survey', ...args], { cwd: root, encoding: 'utf8' });
  const result = cli([file, '1000', '5', '3', report]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(report)), await assessSurvey(survey, { samples: 1000, targetRadius: 0.05, collections: 3 }));
  assert.equal(cli([file, '1000', '5', '3', report]).status, 1);
  assert.equal(cli([file, '1000', '0', '3', invalid]).status, 1);
  assert.equal(existsSync(invalid), false);
  writeFileSync(file, Buffer.from([0xff]));
  assert.equal(cli([file, '1000', '5', '3', invalid]).status, 1);
  assert.equal(existsSync(invalid), false);
});
