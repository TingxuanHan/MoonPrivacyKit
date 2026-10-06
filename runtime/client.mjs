import { dispatch, dispatch_central } from '../dist/core.js';

export function callCore(request) {
  const result = JSON.parse(dispatch(JSON.stringify(request)));
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function cryptoProvider() {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error('A secure context with Web Crypto is required.');
  }
  return globalThis.crypto;
}

function nextWord() {
  return cryptoProvider().getRandomValues(new Uint32Array(1))[0];
}

// Rejection sampling prevents modulo bias. The injectable source is for tests;
// real response generation below always uses the private Web Crypto source.
export function uniformIndex(size, word = nextWord) {
  if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error('Invalid category count.');
  const limit = Math.floor(0x100000000 / size) * size;
  for (let attempt = 0; attempt < 1024; attempt++) {
    const value = word();
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid random word.');
    if (value < limit) return value % size;
  }
  throw new Error('Random source failed rejection sampling.');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateSurvey(survey) {
  return callCore({ op: 'validateSurvey', survey });
}

export async function surveyFingerprint(survey) {
  const normalized = validateSurvey(survey);
  const bytes = new TextEncoder().encode(canonical({ mechanism: 'rr24-v1', survey: normalized }));
  const digest = await cryptoProvider().subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Call once per response. Keep and resend the returned object for retries.
export async function protectResponse(survey, answers) {
  const normalized = validateSurvey(survey);
  const fingerprint = await surveyFingerprint(normalized);
  const idBytes = cryptoProvider().getRandomValues(new Uint8Array(16));
  const response_id = Array.from(idBytes, b => b.toString(16).padStart(2, '0')).join('');
  const gates = normalized.questions.map(() => nextWord() >>> 8);
  const fallbacks = normalized.questions.map(q => uniformIndex(q.options.length));
  const response = callCore({ op: 'protect', survey: normalized, fingerprint, response_id, answers, gates, fallbacks });
  Object.freeze(response.answers);
  return Object.freeze(response);
}

export async function aggregateResponses(survey, responses) {
  const fingerprint = await surveyFingerprint(survey);
  return callCore({ op: 'aggregate', survey, fingerprint, responses });
}

// Private, per-release buffer. Rejection sampling is exact for every bound used
// by the integer mechanism. Neither words nor a seed leave this closure.
function centralRandomSource() {
  const provider = cryptoProvider();
  const words = new Uint32Array(1024);
  let cursor = words.length;
  return size => {
    if (!Number.isInteger(size) || size < 2 || size > 0x2000000) {
      throw new Error('Invalid central random bound.');
    }
    const limit = Math.floor(0x100000000 / size) * size;
    for (;;) {
      if (cursor === words.length) {
        provider.getRandomValues(words);
        cursor = 0;
      }
      const value = words[cursor++];
      if (value < limit) return value % size;
    }
  };
}

function releaseCentral(request) {
  const result = JSON.parse(dispatch_central(JSON.stringify(request), centralRandomSource()));
  if (!result.ok) throw new Error(result.error);
  Object.freeze(result.data.counts);
  return Object.freeze(result.data);
}

// Each invocation spends a fresh epsilon. Store and reuse its returned release
// for retries or repeated downloads; this adapter does not maintain a ledger.
export function centralCount(unitIds, { epsilon, maxContributions = 1 } = {}) {
  return releaseCentral({ op: 'centralCount', epsilon, max_contributions: maxContributions, unit_ids: unitIds });
}

export function centralHistogram(unitIds, categoryIds, { categoryCount, epsilon, maxContributions = 1 } = {}) {
  return releaseCentral({
    op: 'centralHistogram', epsilon, max_contributions: maxContributions,
    category_count: categoryCount, unit_ids: unitIds, category_ids: categoryIds,
  });
}
