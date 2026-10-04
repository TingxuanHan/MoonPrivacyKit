import { dispatch } from '../dist/core.js';

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
