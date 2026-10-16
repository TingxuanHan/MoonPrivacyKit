import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync('moon', ['build', '--target', 'js', '--release'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.error('Build failed. Install the MoonBit toolchain and add moon to PATH.');
  process.exit(1);
}
for (const [module, version] of [['ppyq882/moon-privacy-budget', '0.1.1'], ['123123213weqw/moon_scrub', '0.5.2']]) {
  const declaration = readFileSync(resolve(root, '.mooncakes', module, 'moon.mod'), 'utf8');
  if (!declaration.includes(`version = "${version}"`)) throw new Error(`Dependency version changed: ${module}; review the adapter before building.`);
}
const source = ['_build/js/release/build/bridge/bridge.js', 'target/js/release/build/bridge/bridge.js']
  .map(p => resolve(root, p)).find(existsSync);
if (!source) throw new Error('MoonBit JavaScript output was not found.');
mkdirSync(resolve(root, 'dist'), { recursive: true });
copyFileSync(source, resolve(root, 'dist/core.js'));
copyFileSync(resolve(root, 'THIRD_PARTY.md'), resolve(root, 'dist/THIRD_PARTY.md'));
mkdirSync(resolve(root, 'dist/licenses'), { recursive: true });
for (const name of ['moon-scrub-Apache-2.0.txt', 'moon-privacy-budget-Apache-2.0.txt', 'blindrsa-Apache-2.0.txt', 'sjcl-license.txt']) copyFileSync(resolve(root, 'licenses', name), resolve(root, 'dist/licenses', name));
await build({ entryPoints: [resolve(root, 'runtime/credential-client.mjs')], outfile: resolve(root, 'dist/credential-client.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'linked', external: ['../dist/core.js'] });
console.log('Built dist/core.js from MoonBit.');
