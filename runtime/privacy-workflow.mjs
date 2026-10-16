import { callCore } from './client.mjs';

// Pass file text unchanged so escaped duplicate keys cannot silently override
// declarations before the MoonBit parser has inspected them.
export function checkPrivacyWorkflow(plan) {
  const input = typeof plan === 'string' ? plan : JSON.stringify(plan);
  return callCore({ op: 'checkPrivacyWorkflow', input });
}
