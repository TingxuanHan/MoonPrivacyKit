import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createWorkbenchServer } from '../runtime/workbench-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
const server = createWorkbenchServer({ root, dataDir: process.env.MPK_DATA_DIR || resolve(root, 'private-data/workbench') });
server.listen(port, '127.0.0.1', () => console.log(`MoonPrivacyKit: http://127.0.0.1:${port}`));
server.on('error', () => { console.error('Local server could not start. Check whether the selected port is in use.'); process.exitCode = 1; });
