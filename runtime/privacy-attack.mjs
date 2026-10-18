import { callCore } from './client.mjs';

export function parsePrivacyAttackPlan(input) {
  return callCore({ op: 'parsePrivacyAttackPlan', input: input.replace(/^\uFEFF/, '') });
}

export function evaluatePrivacyAttack({ config, members, nonmembers, released }) {
  const source = value => {
    if (!value || typeof value.input !== 'string' || value.input.length > 2_000_000) throw new Error('Audit file exceeds the 2 MB text limit.');
    let format = value.format;
    const input = value.input.replace(/^\uFEFF/, '');
    // Preserve the original JSON text for the core's duplicate-key checks.
    if (format === 'json' && input.trimStart().startsWith('{')) format = 'artifact';
    return { format, input };
  };
  return callCore({ op: 'evaluatePrivacyAttack', config, members: source(members), nonmembers: source(nonmembers), released: source(released) });
}
