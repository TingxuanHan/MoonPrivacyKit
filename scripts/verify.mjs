import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = [
  ['moon', ['check', '--deny-warn', '--target', 'wasm']],
  ['moon', ['check', '--deny-warn', '--target', 'js']],
  ['moon', ['test', '--target', 'wasm']],
  ['moon', ['test', '--target', 'js']],
  [process.execPath, ['scripts/build.mjs']],
  [process.execPath, ['--test', 'tests/runtime.test.mjs', 'tests/cli.test.mjs', 'tests/evaluation.test.mjs']],
];
if (process.argv.includes('--ui')) commands.push([process.execPath, ['--test', 'tests/ui.test.mjs']]);
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) { console.error('Verification stopped at the failed check.'); process.exit(result.status || 1); }
}
console.log('All requested checks passed.');
