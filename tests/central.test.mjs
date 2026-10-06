import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch_central } from '../dist/core.js';
import { callCore, centralCount, centralHistogram } from '../runtime/client.mjs';

const countRequest = { op: 'centralCount', epsilon: 1, max_contributions: 1, unit_ids: ['person-a', 'person-a', 'person-b'] };
const lowLevel = (request, draw = () => 0) => JSON.parse(dispatch_central(JSON.stringify(request), draw));
const mechanism = (epsilon, cap = 1, categories = 1) => callCore({
  op: 'centralMechanism', epsilon, max_contributions: cap, category_count: categories,
});

// Exact fraction for the supplied positive IEEE-754 budget, avoiding an
// approximate floating-point comparison in the calibration regression check.
function fraction(value) {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  const bits = bytes.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn) - 1023 - 52;
  const significand = (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  return exponent < 0 ? [significand, 1n << BigInt(-exponent)] : [significand << BigInt(exponent), 1n];
}

test('central calibration respects the exact supplied budget across the supported range', () => {
  for (const cap of [1, 2, 3, 16, 32]) {
    for (let index = 0; index <= 512; index++) {
      const epsilon = 0.01 + (8 - 0.01) * index / 512;
      const m = mechanism(epsilon, cap, 3);
      const [numerator, denominator] = fraction(epsilon);
      assert.ok(BigInt(cap) * BigInt(m.threshold) * denominator <= numerator * (16777216n - BigInt(m.threshold)));
    }
  }
});

test('compiled callback boundary clips per user and returns only protected release fields', () => {
  assert.deepEqual(lowLevel(countRequest).data.counts, [2]);
  const response = lowLevel({
    op: 'centralHistogram', epsilon: 1, max_contributions: 2, category_count: 3,
    unit_ids: ['person-a', 'person-a', 'person-a', 'person-b'], category_ids: [0, 1, 2, 2],
  });
  assert.deepEqual(response.data.counts, [1, 1, 1]);
  assert.deepEqual(Object.keys(response.data).sort(), [
    'schema_version', 'mechanism', 'query', 'adjacency', 'epsilon', 'epsilon_upper_bound',
    'max_contributions', 'category_count', 'output_upper', 'confidence', 'absolute_error_bound', 'counts',
  ].sort());
  assert.equal(JSON.stringify(response).includes('person-'), false);
});

test('central JSON inputs reject fractional dimensions and invalid private data before sampling', () => {
  const invalid = [
    { ...countRequest, epsilon: 0 }, { ...countRequest, epsilon: NaN },
    { ...countRequest, epsilon: Infinity }, { ...countRequest, epsilon: '1' },
    { ...countRequest, max_contributions: 1.5 }, { ...countRequest, max_contributions: 33 },
    { ...countRequest, unit_ids: ['secret-value', ''] },
    { ...countRequest, unit_ids: ['x'.repeat(129)] },
    { ...countRequest, unit_ids: [17] },
    { ...countRequest, unit_ids: Array(100001).fill('a') },
    { ...countRequest, op: 'centralHistogram', category_count: 2.5, category_ids: [0, 0, 1] },
    { ...countRequest, op: 'centralHistogram', category_count: 2, category_ids: [0, 0.5, 1] },
    { ...countRequest, op: 'centralHistogram', category_count: 2, category_ids: [0, 2, 1] },
    { ...countRequest, op: 'centralHistogram', category_count: 2, category_ids: [] },
    { ...countRequest, op: 'unknown' },
  ];
  for (const request of invalid) {
    let draws = 0;
    const result = lowLevel(request, () => { draws++; return 0; });
    assert.equal(result.ok, false);
    assert.equal(draws, 0);
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
    assert.equal('data' in result, false);
  }
  assert.equal(JSON.parse(dispatch_central('{', () => 0)).ok, false);
});

test('central callback validates integers and propagates random source failure', () => {
  for (const draw of [() => -1, size => size, () => NaN, () => Infinity, () => 0.5]) {
    assert.equal(lowLevel(countRequest, draw).ok, false);
  }
  assert.throws(() => lowLevel(countRequest, () => { throw new Error('source unavailable'); }), /source unavailable/);
});

test('secure central adapters work without Math.random and freeze repeat-download results', () => {
  const original = Math.random;
  Math.random = () => { throw new Error('insecure source used'); };
  try {
    const count = centralCount(countRequest.unit_ids, { epsilon: 1 });
    const histogram = centralHistogram([], [], { categoryCount: 4, epsilon: 1 });
    assert.equal(count.counts.length, 1);
    assert.equal(histogram.counts.length, 4);
    for (const report of [count, histogram]) {
      assert.ok(report.counts.every(n => Number.isInteger(n) && n >= 0 && n <= 100000));
      assert.ok(Object.isFrozen(report) && Object.isFrozen(report.counts));
      const saved = JSON.stringify(report);
      assert.equal(JSON.stringify(report), saved);
      assert.equal(saved.includes('person-'), false);
    }
  } finally {
    Math.random = original;
  }
});

test('secure adapter rejects biased upper-tail words and fails closed without Web Crypto', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const subtle = globalThis.crypto.subtle;
  try {
    let fills = 0;
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      subtle,
      getRandomValues(words) { fills++; words.fill(0); words[0] = 0xffffffff; return words; },
    } });
    assert.deepEqual(centralCount(countRequest.unit_ids, { epsilon: 1 }).counts, [2]);
    assert.equal(fills, 1);
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    assert.throws(() => centralCount([], { epsilon: 1 }), /Web Crypto/);
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
      subtle, getRandomValues() { throw new Error('entropy unavailable'); },
    } });
    assert.throws(() => centralCount([], { epsilon: 1 }), /entropy unavailable/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

// Deterministic source for synthetic tests ONLY. Real adapters expose no RNG or
// seed option. The tests compare against the infinite geometric distribution.
function syntheticUniform(seed) {
  let state = seed >>> 0;
  return size => {
    const limit = Math.floor(0x100000000 / size) * size;
    for (;;) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const word = state >>> 0;
      if (word < limit) return word % size;
    }
  };
}

test('synthetic count noise matches geometric moments and tail frequencies', () => {
  const request = { ...countRequest, unit_ids: Array.from({ length: 100 }, (_, i) => `synthetic-${i}`) };
  const draw = syntheticUniform(20261007);
  const n = 12000;
  let sum = 0; let squares = 0; let zero = 0; let tail = 0;
  for (let i = 0; i < n; i++) {
    const result = lowLevel(request, draw);
    assert.equal(result.ok, true);
    const z = result.data.counts[0] - 100;
    sum += z; squares += z * z; zero += Number(z === 0); tail += Number(Math.abs(z) > 3);
  }
  const q = 1 - mechanism(1).threshold / 16777216;
  assert.ok(Math.abs(sum / n) < 0.07, `mean=${sum / n}`);
  assert.ok(Math.abs(squares / n - 2 * q / (1 - q) ** 2) < 0.3, `secondMoment=${squares / n}`);
  assert.ok(Math.abs(zero / n - (1 - q) / (1 + q)) < 0.015);
  assert.ok(Math.abs(tail / n - 2 * q ** 4 / (1 + q)) < 0.012);
});

test('synthetic histogram respects simultaneous error bound after contribution clipping', () => {
  const ids = []; const bins = [];
  for (let i = 0; i < 100; i++) {
    for (let j = 0; j < 5; j++) { ids.push(`synthetic-${i}`); bins.push(j); }
  }
  const request = { op: 'centralHistogram', epsilon: 1, max_contributions: 2, category_count: 5, unit_ids: ids, category_ids: bins };
  const expected = [100, 100, 0, 0, 0];
  const draw = syntheticUniform(314159);
  let covered = 0;
  for (let i = 0; i < 3000; i++) {
    const { data } = lowLevel(request, draw);
    covered += Number(data.counts.every((n, bin) => Math.abs(n - expected[bin]) <= data.absolute_error_bound));
  }
  assert.ok(covered / 3000 >= 0.95);
});
