import { callCore } from './client.mjs';
import { publishRelease } from './ledger.mjs';

function invalid() {
  throw new Error('Invalid table plan. Use schemaVersion 1, a count or histogram query, and only the documented fields.');
}

function tablePlan(input) {
  let plan;
  try {
    const encoded = JSON.stringify(input);
    if (typeof encoded !== 'string' || encoded.length > 100_000) invalid();
    plan = JSON.parse(encoded);
  } catch { invalid(); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.schemaVersion !== 1 ||
      !['count', 'histogram'].includes(plan.query)) invalid();
  const required = ['schemaVersion', 'scope', 'requestId', 'query', 'epsilon', 'unitField'];
  if (plan.query === 'histogram') required.push('categoryField', 'categories');
  const allowed = [...required, 'maxContributions'];
  if (required.some(key => !Object.hasOwn(plan, key)) || Object.keys(plan).some(key => !allowed.includes(key))) invalid();
  return plan;
}

// The mapped identifiers exist only in memory. Publish only the ledger's saved
// protected result, never the intermediate mapping or an exact row summary.
export function publishTableRelease(ledgerPath, format, input, configuration) {
  const plan = tablePlan(configuration);
  if (!['csv', 'json'].includes(format) || typeof input !== 'string' || input.length > 2_000_000) {
    throw new Error('Use csv or json table text of at most 2 million text units.');
  }
  const mapped = callCore({
    op: 'mapTable', format, input: input.replace(/^\uFEFF/, ''),
    mapping: {
      query: plan.query, unit_field: plan.unitField,
      category_field: plan.query === 'histogram' ? plan.categoryField : '',
      categories: plan.query === 'histogram' ? plan.categories : [],
    },
  });
  const request = {
    scope: plan.scope, requestId: plan.requestId, query: plan.query,
    epsilon: plan.epsilon, unitIds: mapped.unit_ids,
    ...(plan.maxContributions === undefined ? {} : { maxContributions: plan.maxContributions }),
  };
  if (plan.query === 'histogram') Object.assign(request, {
    categories: plan.categories, categoryIds: mapped.category_ids,
  });
  return publishRelease(ledgerPath, request);
}
