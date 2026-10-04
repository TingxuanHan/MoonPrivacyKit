import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScenario } from '../scripts/evaluate.mjs';
import { callCore, aggregateResponses, protectResponse } from '../runtime/client.mjs';

test('seeded experiments exercise the compiled sampler and are reproducible', () => {
  const first = evaluateScenario([800, 200], 1, 20, 7);
  assert.deepEqual(first, evaluateScenario([800, 200], 1, 20, 7));
  assert.ok(first.rmse < first.simultaneous_radius);
  assert.ok(first.simultaneous_coverage >= 0.9);
  assert.ok(evaluateScenario([800, 200], 2, 20, 7).rmse < first.rmse);
});

test('batch randomization rejects partial or fractional samples', () => {
  assert.throws(() => callCore({ op: 'randomizeBatch', categories: 2, epsilon: 1, answers: [0], gates: [], fallbacks: [1] }));
  assert.throws(() => callCore({ op: 'randomizeBatch', categories: 2, epsilon: 1, answers: [0.1], gates: [0], fallbacks: [1] }));
});

test('version and category fields cannot silently truncate fractional JSON numbers', async () => {
  const survey = { schema_version: 1, id: 'test', title: 'Test', questions: [{ id: 'q', title: 'Q?', options: ['A', 'B'], epsilon: 1 }] };
  assert.throws(() => callCore({ op: 'validateSurvey', survey: { ...survey, schema_version: 1.5 } }));
  const response = await protectResponse(survey, [0]);
  await assert.rejects(aggregateResponses(survey, [{ ...response, answers: [0.5] }]));
  await assert.rejects(aggregateResponses(survey, [{ ...response, schema_version: 1.5 }]));
});
