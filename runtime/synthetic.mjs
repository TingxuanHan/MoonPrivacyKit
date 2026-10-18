import { callCore } from './client.mjs';
import { ledgerStatus, publishRelease } from './ledger.mjs';

export function planSynthetic(plan) { return callCore({ op: 'planSynthetic', plan }); }
export function parseSyntheticPlan(input) { return callCore({ op: 'parseSyntheticPlan', input }); }

export function publishSynthetic(path, { plan, format, input, requestId, epsilon }) {
  // Snapshot before validation; only this explicit public plan can reach the
  // saved result. Never infer a domain, tree or output size from private rows.
  const snapshot = JSON.parse(JSON.stringify(plan));
  const explanation = planSynthetic(snapshot);
  if (typeof input !== 'string' || input.length > 2_000_000) throw new Error('Invalid synthetic input length.');
  const mapped = callCore({ op: 'mapSynthetic', plan: snapshot, format, input: input.replace(/^\uFEFF/, '') });
  return publishRelease(path, {
    scope: ledgerStatus(path).scope, requestId, epsilon, query: 'histogram',
    categories: Array.from({ length: explanation.measurement_cells }, (_, i) => `cell:${i}`),
    maxContributions: explanation.l1_sensitivity,
    unitIds: mapped.unit_ids, categoryIds: mapped.category_ids, syntheticPlan: snapshot,
  });
}
