import { callCore } from '/runtime/client.mjs';
self.onmessage = event => {
  try { self.postMessage({ ok: true, report: callCore({ op: 'inspectDisclosure', model: event.data }) }); }
  catch { self.postMessage({ ok: false }); }
};
