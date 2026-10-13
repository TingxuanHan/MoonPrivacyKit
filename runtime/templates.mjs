import { callCore } from './client.mjs';

function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

// Accept text so the core can reject duplicate JSON keys before parsing loses them.
export function parseStatisticsTemplate(input) {
  if (typeof input !== 'string') throw new Error('Statistics templates must be JSON text.');
  return freeze(callCore({ op: 'parseStatisticsTemplate', input: input.replace(/^\uFEFF/, '') }));
}

export function createStatisticsTemplate(name, settings) {
  return parseStatisticsTemplate(JSON.stringify({ schemaVersion: 1, kind: 'moonprivacykit/statistics-template', name, settings }));
}

export function checkStatisticsTemplate(template, format, input) {
  return freeze(callCore({ op: 'checkStatisticsTemplate', template: JSON.stringify(template), format, input: input.replace(/^\uFEFF/, '') }));
}

export function parseRedactionTemplate(input) {
  if (typeof input !== 'string') throw new Error('Redaction templates must be JSON text.');
  return freeze(callCore({ op: 'parseRedactionTemplate', input: input.replace(/^\uFEFF/, '') }));
}

export function createRedactionTemplate(name, settings) {
  const schemaVersion = settings?.fields?.some(f => ['age', 'date'].includes(f.action)) ? 2 : 1;
  return parseRedactionTemplate(JSON.stringify({ schemaVersion, kind: 'moonprivacykit/redaction-template', name, settings }));
}

function redactionOperation(op, template, format, input) {
  return freeze(callCore({ op, template: JSON.stringify(template), format, input: input.replace(/^\uFEFF/, '') }));
}

export const checkRedactionTemplate = (template, format, input) => redactionOperation('checkRedactionTemplate', template, format, input);
export const applyRedactionTemplate = (template, format, input) => redactionOperation('applyRedactionTemplate', template, format, input);
export const prepareRedactionHandoff = (template, format, input) => redactionOperation('prepareRedactionHandoff', template, format, input);
