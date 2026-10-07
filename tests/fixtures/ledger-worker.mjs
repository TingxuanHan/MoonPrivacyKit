import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { publishRelease } from '../../runtime/ledger.mjs';

const [ledger, input, pause, marker] = process.argv.slice(2);
// Fault injection belongs only to this subprocess fixture, never the public API.
if (pause) {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === 'COMMIT' && pause === 'hold-before-commit') {
      writeFileSync(marker, 'ready');
      while (!existsSync(`${marker}.resume`)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    if (sql === 'COMMIT' && pause === 'before-commit') {
      writeFileSync(marker, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    const result = original.call(this, sql);
    if (sql === 'COMMIT' && pause === 'after-commit') {
      writeFileSync(marker, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return result;
  };
}
try {
  if (marker) writeFileSync(`${marker}.started`, 'ready');
  const result = publishRelease(ledger, JSON.parse(readFileSync(input, 'utf8')));
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code }));
}
