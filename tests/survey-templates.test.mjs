import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { surveyPresets, parseSurveyTemplate, createSurveyTemplate, surveyFromTemplate, parseSurvey, surveyBudget, participantGuide } from '../runtime/survey-templates.mjs';
import { protectResponse, aggregateResponses, surveyFingerprint } from '../runtime/client.mjs';
import { createLedger, ledgerStatus } from '../runtime/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-surveys-'));
const template = surveyPresets[0].template;
const cli = args => spawnSync(process.execPath, ['cli/main.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('all three scenario templates round trip and create isolated questionnaire instances', async () => {
  assert.equal(surveyPresets.length, 3);
  for (const { template } of surveyPresets) {
    assert.ok(Object.isFrozen(template.settings.questions[0].options));
    assert.deepEqual(parseSurveyTemplate(`\uFEFF${JSON.stringify(template)}`), template);
    const a = surveyFromTemplate(template), b = surveyFromTemplate(template);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(createSurveyTemplate(template.name, a, 1), template);
    assert.deepEqual(a.questions, template.settings.questions);
    const response = await protectResponse(a, a.questions.map(() => 0));
    assert.equal((await aggregateResponses(a, [response, response])).duplicates, 1);
    await assert.rejects(aggregateResponses(b, [response]), /does not belong/);
  }
});

test('import rejects unknown data fields, duplicate keys, unsupported versions and editor loss', () => {
  const source = JSON.stringify(template);
  const invalid = [
    source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    source.replace('"epsilon":1', '"epsilon":1,"eps\\u0069lon":2'),
    source.replace('"schemaVersion":1', '"schemaVersion":2'),
    source.replace('"plannedCollections":1', '"plannedCollections":1.5'),
    'secret-json', ' '.repeat(100001),
  ];
  for (const key of ['id', 'answers', 'response_id', 'survey_fingerprint', 'spentEpsilon', 'requestId', '__proto__']) {
    invalid.push(JSON.stringify({ ...template, [key]: 'secret-value' }));
    invalid.push(JSON.stringify({ ...template, settings: { ...template.settings, [key]: 'secret-value' } }));
    if (key !== 'id') {
      const other = structuredClone(template);
      Object.defineProperty(other.settings.questions[0], key, { value: 'secret-value', enumerable: true });
      invalid.push(JSON.stringify(other));
    }
  }
  for (const label of [' leading', 'trailing ', 'two\nlines', 'two\rlines']) {
    const other = structuredClone(template); other.settings.questions[0].options[0] = label;
    invalid.push(JSON.stringify(other));
  }
  const many = structuredClone(template);
  many.settings.questions = Array.from({ length: 21 }, (_, i) => ({ ...template.settings.questions[0], id: `q${i}` }));
  invalid.push(JSON.stringify(many));
  for (const input of invalid) assert.throws(() => parseSurveyTemplate(input), error => !error.message.includes('secret'));
  assert.throws(() => parseSurveyTemplate(template));
});

test('mixed question budgets and repeat planning do not reset another tool ledger or sample answers', async () => {
  const survey = structuredClone(surveyFromTemplate(template));
  survey.questions[0].epsilon = 0.25; survey.questions[1].epsilon = 0.5;
  const ledger = join(scratch, 'unchanged.sqlite');
  createLedger(ledger, { scope: 'original-scope', totalEpsilon: '1' });
  const before = ledgerStatus(ledger);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: crypto.subtle, getRandomValues() { throw new Error('Must not sample'); } } });
  try {
    assert.deepEqual(surveyBudget(survey, 3), { questions: 2, collections: 3, single_epsilon: 0.75, total_epsilon: 2.25 });
    const saved = createSurveyTemplate('重复计划', survey, 3);
    assert.equal(saved.settings.plannedCollections, 3);
    const guide = await participantGuide(survey, 3);
    assert.match(guide, /ε 约为 0.75/); assert.match(guide, /ε 约为 2.25/);
    assert.ok(guide.includes(await surveyFingerprint(survey)));
    assert.match(guide, /不阻止同一人重新生成/);
    assert.match(guide, /参与身份/);
    assert.ok(!guide.includes('answers') && !guide.includes('response_id'));
    assert.throws(() => surveyFromTemplate(saved), /secure context/);
  } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.deepEqual(ledgerStatus(ledger), before);
  for (const count of [0, -1, 1.5, 10001, null, '2']) assert.throws(() => surveyBudget(survey, count));
  for (const q of survey.questions) q.epsilon = 0;
  assert.equal(surveyBudget(survey, 2).total_epsilon, 0);
});

test('instructions take a snapshot and raw survey parsing preserves a matching configuration', async () => {
  const survey = structuredClone(surveyFromTemplate(template));
  const original = structuredClone(survey);
  const pending = participantGuide(survey, 2);
  survey.questions[0].epsilon = 8; survey.title = 'changed-after-start';
  const guide = await pending;
  assert.ok(guide.includes(await surveyFingerprint(original)));
  assert.ok(!guide.includes('changed-after-start'));
  assert.deepEqual(parseSurvey(`\uFEFF${JSON.stringify(original)}`), original);
  const raw = JSON.stringify(original).replace('"schema_version":1', '"schema_version":1,"schema_version":2');
  assert.throws(() => parseSurvey(raw));
  await assert.rejects(participantGuide(original, 0));
});

test('CLI creates separate surveys, exports bound instructions and refuses output overwrite or invalid text', async () => {
  const source = join(scratch, 'template.json'), surveyFile = join(scratch, 'survey.json'), otherFile = join(scratch, 'other.json'), guideFile = join(scratch, 'guide.txt');
  writeFileSync(source, JSON.stringify(template));
  for (const output of [surveyFile, otherFile]) {
    const result = cli(['survey-from-template', source, output]);
    assert.equal(result.status, 0, result.stderr);
  }
  const survey = parseSurvey(readFileSync(surveyFile, 'utf8'));
  assert.notEqual(survey.id, parseSurvey(readFileSync(otherFile, 'utf8')).id);
  const result = cli(['survey-guide', surveyFile, '3', guideFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(guideFile, 'utf8'), await participantGuide(survey, 3));
  assert.equal(cli(['survey-from-template', source, surveyFile]).status, 1);
  assert.equal(cli(['survey-guide', surveyFile, '1', guideFile]).status, 1);
  assert.equal(readFileSync(guideFile, 'utf8'), await participantGuide(survey, 3));
  const invalid = join(scratch, 'invalid-output.txt');
  assert.equal(cli(['survey-guide', surveyFile, '0', invalid]).status, 1);
  assert.equal(existsSync(invalid), false);
  writeFileSync(source, Buffer.from([0xff]));
  assert.equal(cli(['survey-from-template', source, invalid]).status, 1);
  assert.equal(existsSync(invalid), false);
});
