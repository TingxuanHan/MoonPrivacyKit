import { callCore } from '/runtime/client.mjs';
self.onmessage = event => {
  try {
    const request = event.data.op ? event.data : { op: 'inspectDisclosure', model: event.data };
    if (!['inspectDisclosure', 'comparePrivacyPlans', 'comparePrivateVersions', 'scanSensitiveFields'].includes(request.op)) throw new Error('Unsupported worker task');
    self.postMessage({ ok: true, report: callCore(request) });
  }
  catch { self.postMessage({ ok: false }); }
};
