import test from 'node:test';
import assert from 'node:assert/strict';
import { callCore, uniformIndex, protectResponse, surveyFingerprint, aggregateResponses } from '../runtime/client.mjs';

const survey = { schema_version: 1, id: 'feedback', title: 'Feedback', questions: [
  { id: 'q1', title: 'Satisfied?', options: ['Yes', 'No'], epsilon: 1 }
] };

test('secure sampler rejects the uneven upper tail instead of introducing modulo bias', () => {
  const words = [0xffffffff, 0xfffffffe];
  assert.equal(uniformIndex(3, () => words.shift()), 2);
  assert.equal(words.length, 0);
  assert.throws(() => uniformIndex(3, () => -1), /random word/);
  assert.throws(() => uniformIndex(3, () => 0xffffffff), /failed/);
});

test('configuration fingerprint is stable across object key order and changes with options', async () => {
  const reordered = { title: survey.title, questions: survey.questions, id: survey.id, schema_version: 1 };
  assert.equal(await surveyFingerprint(survey), await surveyFingerprint(reordered));
  const changed = structuredClone(survey);
  changed.questions[0].options.reverse();
  assert.notEqual(await surveyFingerprint(survey), await surveyFingerprint(changed));
});

test('real MoonBit bridge rejects invalid numeric data and returns no sensitive echo', () => {
  assert.throws(() => callCore({ op: 'mechanism', categories: 2.5, epsilon: 1 }));
  assert.throws(() => callCore({ op: 'mechanism', categories: 2, epsilon: NaN }));
  assert.throws(() => callCore({ op: 'private-string-never-log' }), e => !e.message.includes('private-string'));
});

test('Web Crypto responses expose only permitted fields and can be retried unchanged', async () => {
  const response = await protectResponse(survey, [1]);
  assert.deepEqual(Object.keys(response).sort(), ['answers', 'mechanism', 'response_id', 'schema_version', 'survey_fingerprint']);
  assert.match(response.response_id, /^[0-9a-f]{32}$/);
  assert.equal(response.answers.length, 1);
  assert.ok([0, 1].includes(response.answers[0]));
  assert.ok(Object.isFrozen(response));
  const report = await aggregateResponses(survey, [response, JSON.parse(JSON.stringify(response))]);
  assert.equal(report.accepted, 1);
  assert.equal(report.duplicates, 1);
  assert.ok(!JSON.stringify(report).includes(response.response_id));
  await assert.rejects(aggregateResponses(survey, [{ ...response, raw_answer: 1 }]));
});
