import { createHash } from 'node:crypto';
import { callCore } from './client.mjs';
import { publishRelease, ledgerStatus } from './ledger.mjs';

export function planPersonQuery(plan) { return callCore({ op: 'planPersonQuery', plan }); }

export function publishPersonQuery(path, { plan, leftFormat, left, rightFormat, right, requestId, epsilon }) {
  const explanation = planPersonQuery(plan);
  const context = createHash('sha256').update(JSON.stringify({ plan: explanation, unit: plan.unit_field, value: plan.value_field })).digest('hex');
  const mapped = callCore({ op: 'mapPersonQuery', plan, left_format: leftFormat, left, right_format: rightFormat, right });
  const release = publishRelease(path, {
    scope: ledgerStatus(path).scope, requestId, query: plan.query, epsilon,
    maxContributions: explanation.output_rows_per_person, unitIds: mapped.unit_ids, context,
    ...(plan.query === 'bounded_sum' ? { values: mapped.values, valueUpper: plan.value_upper } : {}),
  });
  return Object.freeze({ schema_version: 1, kind: 'moonprivacykit/person-query-release', plan: explanation, plan_fingerprint: context, release });
}
