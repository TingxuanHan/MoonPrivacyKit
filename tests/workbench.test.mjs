import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createWorkbenchServer } from '../runtime/workbench-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'mpk-workbench-'));
let server, origin, session, project;
const input = 'person_id,answer,ignored\nprivate-person-123,yes,private-note-456\nprivate-person-123,no,private-note-789\nprivate-person-999,no,private-note-101';
const publication = requestId => ({ format: 'csv', input, plan: { requestId, query: 'histogram', epsilon: '0.1', maxContributions: 1, unitField: 'person_id', categoryField: 'answer', categories: ['yes', 'no'] } });
async function api(path, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-MoonPrivacyKit-Token': session, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
const endpoint = operation => `/api/projects/${project.id}/${operation}`;
before(async () => {
  server = createWorkbenchServer({ root, dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  session = (await (await fetch(`${origin}/api/session`)).json()).data.token;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

test('loopback API rejects cross-origin requests, forged hosts and missing session headers', async () => {
  assert.equal((await fetch(`${origin}/api/projects`)).status, 401);
  assert.equal((await api('/api/projects', undefined, { Origin: 'https://untrusted.test' })).status, 403);
  assert.equal((await api('/api/session', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await api('/api/projects', { name: 'blocked', totalEpsilon: '1' }, { Origin: '' })).status, 403);
  assert.equal((await api('/api/projects', undefined, { 'X-MoonPrivacyKit-Token': 'a'.repeat(64) })).status, 401);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${origin}/api/session`, { headers: { Host: 'rebinding.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 400);
  assert.deepEqual(readdirSync(dataDir), []);
});

test('project creation persists budgets and rejects unsafe names, duplicates and malformed requests', async () => {
  for (const name of ['../escape', 'a/b', 'CON', ' spaced ', '<script>', 'a'.repeat(61)]) {
    assert.equal((await api('/api/projects', { name, totalEpsilon: '1' })).status, 400);
  }
  assert.equal((await api('/api/projects', '{invalid')).status, 400);
  assert.equal((await api('/api/projects', { name: 'example', totalEpsilon: '1' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await api('/api/projects', { name: 'invalid', totalEpsilon: '0' })).status, 400);
  const result = await api('/api/projects', { name: '统计试验', totalEpsilon: '0.3' });
  assert.equal(result.status, 201);
  project = result.data.data;
  assert.equal(project.status.remaining_epsilon, '0.3');
  assert.equal((await api('/api/projects', { name: '统计试验', totalEpsilon: '2' })).status, 409);
  const listed = (await api('/api/projects')).data.data;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, project.id);
  assert.equal((await api(`/api/projects/${Buffer.from('../escape').toString('base64url')}/status`)).status, 400);
});

test('publication, concurrent retries, history and recovery reuse exactly one saved result', async () => {
  const retries = await Promise.all(Array.from({ length: 4 }, () => api(endpoint('publish'), publication('same-request'))));
  for (const r of retries) { assert.equal(r.status, 200); assert.deepEqual(r.data, retries[0].data); }
  const status = (await api(endpoint('status'))).data.data;
  assert.deepEqual([status.spent_epsilon, status.remaining_epsilon, status.release_count], ['0.1', '0.2', 1]);
  const recovered = await api(endpoint('releases/same-request'));
  assert.deepEqual(recovered.data, retries[0].data);
  const history = (await api(endpoint('releases'))).data.data;
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].request_id, 'same-request');
  for (const value of [retries[0].data, history, status]) {
    assert.ok(!JSON.stringify(value).includes('private-person'));
    assert.ok(!JSON.stringify(value).includes('private-note'));
  }
  for (const file of readdirSync(dataDir)) {
    const bytes = readFileSync(join(dataDir, file));
    assert.ok(!bytes.includes(Buffer.from('private-person')));
    assert.ok(!bytes.includes(Buffer.from('private-note')));
  }
});

test('invalid tables, changed request input and exhausted budget do not add reports', async () => {
  const before = (await api(endpoint('status'))).data;
  const invalid = { ...publication('bad-table'), input: 'person_id,answer\np1,unlisted-private-value' };
  const error = await api(endpoint('publish'), invalid);
  assert.equal(error.status, 400);
  assert.ok(!JSON.stringify(error).includes('unlisted-private-value'));
  assert.equal((await api(endpoint('publish'), { ...publication('same-request'), input: input.replace('private-person-123', 'different') })).status, 409);
  const over = publication('over'); over.plan.epsilon = '0.3';
  assert.equal((await api(endpoint('publish'), over)).data.code, 'BUDGET_EXHAUSTED');
  assert.deepEqual((await api(endpoint('status'))).data, before);
  assert.equal((await api(endpoint('releases/missing'))).status, 404);
  assert.equal((await api(endpoint('releases?offset=-1'))).status, 400);
  assert.equal((await api(endpoint('publish'), { ...publication('extra'), path: '../other.sqlite' })).status, 400);
});

test('server restart restores saved reports and replaces the session token', async () => {
  const previous = (await api(endpoint('releases/same-request'))).data;
  await new Promise(resolve => server.close(resolve));
  server = createWorkbenchServer({ root, dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await api('/api/projects')).status, 401);
  session = (await (await fetch(`${origin}/api/session`)).json()).data.token;
  assert.deepEqual((await api(endpoint('releases/same-request'))).data, previous);
  assert.equal((await api(endpoint('status'))).data.data.spent_epsilon, '0.1');
});

test('only workbench assets are served and responses prohibit caching and framing', async () => {
  for (const path of ['/.git/config', '/runtime/ledger.mjs', '/private-data/workbench', '/examples/table.csv', '/api/projects/unknown/status']) {
    assert.ok((await fetch(`${origin}${path}`)).status >= 400);
  }
  assert.equal((await fetch(origin, { method: 'POST', body: 'private' })).status, 405);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${origin}/web/statistics.mjs`)).status, 200);
  assert.equal((await fetch(`${origin}/runtime/templates.mjs`)).status, 200);
  for (const query of ['count', 'histogram']) {
    const template = await (await fetch(`${origin}/examples/statistics-${query}-template.json`)).json();
    assert.equal(template.kind, 'moonprivacykit/statistics-template');
    assert.equal(template.settings.query, query);
  }
});

test('HTTP input size and UTF-8 validation reject data before creating a project', async () => {
  const headers = { 'X-MoonPrivacyKit-Token': session, Origin: origin, 'Content-Type': 'application/json' };
  const before = (await api('/api/projects')).data;
  const invalid = await fetch(`${origin}/api/projects`, { method: 'POST', headers, body: Buffer.from([0x7b, 0xff, 0x7d]) });
  assert.equal(invalid.status, 400);
  const oversized = await fetch(`${origin}/api/projects`, { method: 'POST', headers, body: ' '.repeat(12_000_001) });
  assert.equal(oversized.status, 413);
  assert.deepEqual((await api('/api/projects')).data, before);
});
