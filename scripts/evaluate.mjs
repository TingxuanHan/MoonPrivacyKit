import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { callCore, uniformIndex } from '../runtime/client.mjs';

// Deterministic data for utility experiments only. Never use this generator
// with participant answers; runtime/client.mjs uses Web Crypto instead.
function simulationWords(seed) {
  let state = seed >>> 0;
  if (!state) throw new Error('Simulation seed must be nonzero.');
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state >>> 0;
  };
}

export function evaluateScenario(population, epsilon, trials = 50, seed = 20261005) {
  if (!Array.isArray(population) || !population.every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isInteger(trials) || trials < 1 || trials > 500) throw new Error('Invalid simulation configuration.');
  const categories = population.length;
  const samples = population.reduce((sum, n) => sum + n, 0);
  if (samples < 1 || samples > 100000) throw new Error('Simulation sample size is outside the supported range.');
  callCore({ op: 'mechanism', categories, epsilon });
  const truth = population.flatMap((n, i) => Array(n).fill(i));
  const proportions = population.map(n => n / samples);
  const next = simulationWords(seed);
  let squaredError = 0, covered = 0, radius;
  for (let trial = 0; trial < trials; trial++) {
    const reports = callCore({ op: 'randomizeBatch', categories, epsilon, answers: truth,
      gates: truth.map(() => next() >>> 8), fallbacks: truth.map(() => uniformIndex(categories, next)) });
    const counts = Array(categories).fill(0);
    for (const value of reports) counts[value]++;
    const result = callCore({ op: 'estimate', categories, epsilon, counts });
    radius = result.simultaneous_radius;
    let allCovered = true;
    for (let i = 0; i < categories; i++) {
      squaredError += (result.categories[i].raw_proportion - proportions[i]) ** 2;
      allCovered &&= result.categories[i].lower <= proportions[i] && proportions[i] <= result.categories[i].upper;
    }
    covered += Number(allCovered);
  }
  return { population, samples, epsilon, trials, seed, rmse: Math.sqrt(squaredError / (trials * categories)), simultaneous_radius: radius, simultaneous_coverage: covered / trials };
}

export function evaluationReport() {
  return { kind: 'synthetic-utility-evaluation', mechanism: 'rr24-v1',
    note: 'Synthetic fixed populations and seeded simulation only; coverage is observed, not a privacy proof or a guarantee for future surveys.',
    scenarios: [[800, 200], [600, 300, 100]].flatMap(population => [0.5, 1, 2].map(epsilon => evaluateScenario(population, epsilon))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output || existsSync(output)) { console.error('Usage: node scripts/evaluate.mjs <new-report.json>'); process.exitCode = 1; }
  else { writeFileSync(output, `${JSON.stringify(evaluationReport(), null, 2)}\n`, { flag: 'wx' }); console.log('Synthetic evaluation saved.'); }
}
