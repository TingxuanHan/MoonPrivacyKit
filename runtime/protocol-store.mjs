import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';

export function protocolError(code) { const e = new Error(code); e.code = code; return e; }
export function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) throw protocolError('INVALID_PROTOCOL_OBJECT');
  return value;
}
export function createProtocolStore(path, kind, metadata, schema, initialize = () => {}) {
  closeSync(openSync(path,'wx',0o600));
  const db=new DatabaseSync(path,{allowExtension:false});
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE;');
    db.exec('CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), kind TEXT NOT NULL, value TEXT NOT NULL) STRICT;');
    db.prepare('INSERT INTO metadata VALUES(1,?,?)').run(kind,JSON.stringify(metadata));
    db.exec(schema); initialize(db); db.exec('COMMIT');
  } catch(e) { try{db.exec('ROLLBACK');}catch{} throw e; }
  finally { db.close(); }
}
export function withProtocolStore(path,kind,write,action) {
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()) throw protocolError('INVALID_PROTOCOL_STORE');
  const db=new DatabaseSync(path,{allowExtension:false});
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA;');
    if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete') throw protocolError('INVALID_PROTOCOL_STORE');
    db.exec(write?'BEGIN IMMEDIATE':'BEGIN');
    const rows=db.prepare('SELECT * FROM metadata').all();
    if(rows.length!==1||rows[0].kind!==kind||rows[0].singleton!==1)throw protocolError('INVALID_PROTOCOL_STORE');
    const result=action(db,JSON.parse(rows[0].value));
    if(result && typeof result.then==='function')throw protocolError('ASYNC_STORE_TRANSACTION');
    db.exec('COMMIT');return result;
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}
export const protocolMetadata=(path,kind)=>withProtocolStore(path,kind,false,(_db,meta)=>meta);
