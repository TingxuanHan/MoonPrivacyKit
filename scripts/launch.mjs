import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: '4173' }, stdio: ['inherit', 'pipe', 'inherit'] });
let opened = false;
server.stdout.on('data', data => {
  process.stdout.write(data);
  if (opened) return;
  opened = true;
  const url = 'http://127.0.0.1:4173';
  const [command, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const browser = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log(`Open ${url} in your browser.`));
});
server.on('error', () => { console.error('Could not launch the local server.'); process.exitCode = 1; });
server.on('exit', code => { process.exitCode = code || 0; });
process.on('SIGINT', () => server.kill());
process.on('SIGTERM', () => server.kill());
