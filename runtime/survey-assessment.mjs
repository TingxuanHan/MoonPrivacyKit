import { callCore, validateSurvey, surveyFingerprint } from './client.mjs';

function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

// Only configuration is inspected. No answers, random samples or ledger access.
export async function assessSurvey(survey, { samples, targetRadius, collections = 1 }) {
  const snapshot = validateSurvey(survey);
  const assessment = callCore({ op: 'assessSurvey', survey: snapshot, samples, target_radius: targetRadius, collections });
  const fingerprint = await surveyFingerprint(snapshot);
  return freeze({
    schemaVersion: 1, kind: 'moonprivacykit/survey-assessment',
    surveyId: snapshot.id, surveyTitle: snapshot.title, surveyFingerprint: fingerprint,
    assessment,
  });
}
