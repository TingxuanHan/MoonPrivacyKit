import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
const routes = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/web/app.mjs', ['web/app.mjs', 'text/javascript; charset=utf-8']],
  ['/web/style.css', ['web/style.css', 'text/css; charset=utf-8']],
  ['/runtime/client.mjs', ['runtime/client.mjs', 'text/javascript; charset=utf-8']],
  ['/dist/core.js', ['dist/core.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  const end = (status, text) => { response.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); response.end(text); };
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) return end(400, 'Invalid host');
  if (!['GET', 'HEAD'].includes(request.method)) return end(405, 'Read-only local server');
  const route = routes.get(request.url.split('?')[0]);
  if (!route) return end(404, 'Not found');
  try {
    const data = await readFile(resolve(root, route[0]));
    response.writeHead(200, { ...headers, 'Content-Type': route[1] });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch { end(503, 'Build missing. Run npm run build first.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`MoonPrivacyKit: http://127.0.0.1:${port}`));
server.on('error', () => { console.error('Local server could not start. Check whether the selected port is in use.'); process.exitCode = 1; });
