import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { callCore, centralCount, centralHistogram } from './client.mjs';

const SCALE = 1_000_000;
const APPLICATION_ID = 0x4d504b31;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;

export class LedgerError extends Error {
  constructor(code, message) { super(message); this.name = 'LedgerError'; this.code = code; }
}

function fail(code, message) { throw new LedgerError(code, message); }
function guarded(action) {
  try { return action(); }
  catch (error) {
    if (error instanceof LedgerError) throw error;
    if (error.errcode === 5 || error.errcode === 6) fail('LEDGER_BUSY', 'Ledger is busy. Retry the same request later.');
    fail('LEDGER_IO', 'Ledger operation failed. Keep the existing ledger and retry the same request; do not reset it.');
  }
}

function token(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('INVALID_REQUEST', 'Use an opaque scope or request ID of 1 to 128 letters, digits, dots, colons, underscores or hyphens.');
  return value;
}

function units(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/.test(value)) {
    fail('INVALID_BUDGET', 'Epsilon must be a decimal string with at most six fractional digits.');
  }
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * SCALE + Number(fraction.padEnd(6, '0'));
}

function decimal(value) {
  const fraction = String(value % SCALE).padStart(6, '0').replace(/0+$/, '');
  return `${Math.floor(value / SCALE)}${fraction ? `.${fraction}` : ''}`;
}

function budgetState(total, spent) {
  try { return callCore({ op: 'budgetState', total_units: total, spent_units: spent }); }
  catch { fail('INVALID_LEDGER', 'Ledger budget is invalid. Do not reset or overwrite this ledger.'); }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
}

function labels(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256 ||
      value.some(v => typeof v !== 'string' || v.trim().length === 0 || v.length > 128) || new Set(value).size !== value.length) {
    fail('INVALID_REQUEST', 'Declare 1 to 256 distinct public category labels before querying.');
  }
  return value;
}

function normalizeRequest(input) {
  let value;
  try {
    const encoded = JSON.stringify(input);
    if (typeof encoded !== 'string' || encoded.length > 10_000_000) throw new Error();
    value = JSON.parse(encoded);
  } catch { fail('INVALID_REQUEST', 'Cannot read this central release request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['count', 'histogram'].includes(value.query)) {
    fail('INVALID_REQUEST', 'Choose a count or histogram query.');
  }
  const allowed = ['scope', 'requestId', 'query', 'epsilon', 'maxContributions', 'unitIds'];
  if (value.query === 'histogram') allowed.push('categories', 'categoryIds');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_REQUEST', 'Unsupported release request field.');
  const scope = token(value.scope);
  const requestId = token(value.requestId);
  const charge = units(value.epsilon);
  const categories = value.query === 'histogram' ? labels(value.categories) : [];
  const maxContributions = value.maxContributions === undefined ? 1 : value.maxContributions;
  const coreRequest = {
    op: value.query === 'count' ? 'centralCount' : 'centralHistogram',
    epsilon: charge / SCALE, max_contributions: maxContributions, unit_ids: value.unitIds,
  };
  if (value.query === 'histogram') Object.assign(coreRequest, { category_count: categories.length, category_ids: value.categoryIds });
  // Validate in MoonBit before any database change or random draw. No exact
  // statistic is returned from this validation boundary.
  try { callCore({ op: 'validateCentral', request: coreRequest }); }
  catch { fail('INVALID_REQUEST', 'Invalid central data, contribution limit or release budget.'); }
  return { scope, requestId, charge, categories, coreRequest };
}

function configure(db, create = false) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA;');
  if (create) db.exec('PRAGMA journal_mode=DELETE;');
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') {
    fail('INVALID_LEDGER', 'Unsupported ledger journal mode.');
  }
}

function metadata(db) {
  if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID ||
      db.prepare('PRAGMA user_version').get().user_version !== 1) {
    fail('INVALID_LEDGER', 'Unrecognized ledger format or version.');
  }
  const rows = db.prepare('SELECT * FROM ledger').all();
  const meta = rows[0];
  if (rows.length !== 1 || meta.singleton !== 1 || !TOKEN.test(meta.scope) ||
      !/^[a-f0-9-]{36}$/.test(meta.ledger_id) || !(meta.fingerprint_key instanceof Uint8Array) || meta.fingerprint_key.length !== 32) {
    fail('INVALID_LEDGER', 'Invalid ledger metadata.');
  }
  budgetState(meta.total_units, 0);
  return meta;
}

function summary(db, meta) {
  const row = db.prepare('SELECT COALESCE(SUM(charge_units), 0) AS spent, COUNT(*) AS releases FROM releases').get();
  const state = budgetState(meta.total_units, row.spent);
  return deepFreeze({
    schema_version: 1, ledger_id: meta.ledger_id, scope: meta.scope,
    total_epsilon: decimal(state.total_units), spent_epsilon: decimal(state.spent_units),
    remaining_epsilon: decimal(state.remaining_units), release_count: row.releases,
  });
}

function transaction(db, write, action) {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* An uncertain commit must be retried by the same request ID. */ }
    throw error;
  }
}

function withLedger(path, write, action) {
  return guarded(() => {
    const location = resolve(path);
    const stat = lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_LEDGER', 'Ledger must be an existing regular local file.');
    const db = new DatabaseSync(location, { allowExtension: false });
    try {
      configure(db);
      return transaction(db, write, () => action(db, metadata(db)));
    } finally { db.close(); }
  });
}

function mac(meta, domain, text) {
  return createHmac('sha256', meta.fingerprint_key).update(domain).update('\0').update(text).digest('hex');
}

function equalMac(left, right) {
  return typeof left === 'string' && HEX.test(left) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function storedRelease(row, meta) {
  if (!row) fail('RELEASE_NOT_FOUND', 'No saved release exists for this request ID.');
  const authenticated = JSON.stringify([row.request_id, row.charge_units, row.result_json]);
  if (!equalMac(row.result_mac, mac(meta, 'release-v1', authenticated))) fail('INVALID_LEDGER', 'Saved release integrity check failed.');
  const result = JSON.parse(row.result_json);
  if (result.schema_version !== 1 || result.report?.mechanism !== 'central-geometric24-v1') fail('INVALID_LEDGER', 'Unsupported saved release version.');
  return deepFreeze(result);
}

export function createLedger(path, { scope, totalEpsilon }) {
  return guarded(() => {
    token(scope);
    const total = units(totalEpsilon);
    try { callCore({ op: 'budgetState', total_units: total, spent_units: 0 }); }
    catch { fail('INVALID_BUDGET', 'Total epsilon must be between 0.01 and 1000.'); }
    const location = resolve(path);
    // Never overwrite or implicitly reinitialize an existing ledger, including
    // an incomplete creation. A failed creation remains visible for inspection.
    closeSync(openSync(location, 'wx', 0o600));
    const db = new DatabaseSync(location, { allowExtension: false });
    try {
      configure(db, true);
      return transaction(db, true, () => {
        db.exec(`
          PRAGMA application_id=${APPLICATION_ID};
          PRAGMA user_version=1;
          CREATE TABLE ledger (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            ledger_id TEXT NOT NULL, scope TEXT NOT NULL,
            total_units INTEGER NOT NULL CHECK(total_units BETWEEN 10000 AND 1000000000),
            fingerprint_key BLOB NOT NULL CHECK(length(fingerprint_key) = 32)
          ) STRICT;
          CREATE TABLE releases (
            request_id TEXT PRIMARY KEY, input_mac TEXT NOT NULL CHECK(length(input_mac) = 64),
            charge_units INTEGER NOT NULL CHECK(charge_units BETWEEN 10000 AND 8000000),
            result_json TEXT NOT NULL, result_mac TEXT NOT NULL CHECK(length(result_mac) = 64)
          ) STRICT;
        `);
        db.prepare('INSERT INTO ledger VALUES (1, ?, ?, ?, ?)').run(randomUUID(), scope, total, randomBytes(32));
        return summary(db, metadata(db));
      });
    } finally { db.close(); }
  });
}

export function ledgerStatus(path) {
  return withLedger(path, false, (db, meta) => summary(db, meta));
}

export function savedRelease(path, requestId) {
  token(requestId);
  return withLedger(path, false, (db, meta) => storedRelease(db.prepare('SELECT * FROM releases WHERE request_id = ?').get(requestId), meta));
}

export function publishRelease(path, input) {
  return guarded(() => {
    const request = normalizeRequest(input);
    return withLedger(path, true, (db, meta) => {
      if (request.scope !== meta.scope) fail('SCOPE_MISMATCH', 'Request scope does not match this ledger.');
      const fingerprint = mac(meta, 'request-v1', JSON.stringify({
        mechanism: 'central-geometric24-v1', scope: request.scope,
        categories: request.categories, request: request.coreRequest,
      }));
      const previous = db.prepare('SELECT * FROM releases WHERE request_id = ?').get(request.requestId);
      if (previous) {
        if (!equalMac(previous.input_mac, fingerprint)) fail('REQUEST_CONFLICT', 'This request ID is already bound to different data or settings.');
        return storedRelease(previous, meta);
      }
      const state = summary(db, meta);
      try {
        callCore({ op: 'chargeBudget', total_units: meta.total_units, spent_units: units(state.spent_epsilon), charge_units: request.charge });
      } catch { fail('BUDGET_EXHAUSTED', 'Privacy budget exhausted. No new release was generated.'); }
      const query = request.coreRequest;
      const options = { epsilon: query.epsilon, maxContributions: query.max_contributions };
      let report;
      try {
        report = query.op === 'centralCount' ? centralCount(query.unit_ids, options) :
          centralHistogram(query.unit_ids, query.category_ids, { ...options, categoryCount: query.category_count });
      } catch { fail('RELEASE_FAILED', 'Protected statistics could not be generated. Retry the same request.'); }
      const result = { schema_version: 1, release_id: randomUUID(), categories: request.categories, report };
      const encoded = JSON.stringify(result);
      const resultMac = mac(meta, 'release-v1', JSON.stringify([request.requestId, request.charge, encoded]));
      db.prepare('INSERT INTO releases VALUES (?, ?, ?, ?, ?)').run(request.requestId, fingerprint, request.charge, encoded, resultMac);
      // The enclosing transaction commits budget and result before either can
      // escape this function. After an uncertain commit, use this same ID again.
      return deepFreeze(result);
    });
  });
}
