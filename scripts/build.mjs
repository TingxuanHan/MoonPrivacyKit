import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync('moon', ['build', '--target', 'js', '--release'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.error('Build failed. Install the MoonBit toolchain and add moon to PATH.');
  process.exit(1);
}
const source = ['_build/js/release/build/bridge/bridge.js', 'target/js/release/build/bridge/bridge.js']
  .map(p => resolve(root, p)).find(existsSync);
if (!source) throw new Error('MoonBit JavaScript output was not found.');
mkdirSync(resolve(root, 'dist'), { recursive: true });
copyFileSync(source, resolve(root, 'dist/core.js'));
console.log('Built dist/core.js from MoonBit.');
