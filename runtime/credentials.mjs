import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { randomBytes,createHash,createHmac,randomUUID } from 'node:crypto';
import { validateSurvey,surveyFingerprint,callCore } from './client.mjs';
import { validateCredentialPublic,verifyCredential,fromHex,toHex } from './credential-client.mjs';
import { createProtocolStore,withProtocolStore,protocolMetadata,protocolError,exactObject } from './protocol-store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw protocolError(code);};
const accountId=(meta,account)=>createHmac('sha256',meta.account_key).update(account).digest('hex');
export async function createCredentialIssuer(path,survey,accounts,{expiresAt}={}) {
  const normalized=validateSurvey(survey);
  if(!Array.isArray(accounts)||accounts.length<1||accounts.length>10000||accounts.some(a=>typeof a!=='string'||!a.trim()||a.length>128)||new Set(accounts).size!==accounts.length)fail('INVALID_ENROLLMENT');
  const expires=expiresAt??Math.floor(Date.now()/1000)+7*86400;
  const context={schema_version:1,kind:'moonprivacykit/anonymous-survey',survey_fingerprint:await surveyFingerprint(normalized),expires_at:expires,suite:'RSABSSA-SHA384-PSS-Randomized'};
  callCore({op:'validateCredentialContext',context});
  if(expires<=Math.floor(Date.now()/1000))fail('CREDENTIAL_CONTEXT_EXPIRED');
  const pair=await RSABSSA.SHA384.PSS.Randomized().generateKey({publicExponent:new Uint8Array([1,0,1]),modulusLength:3072});
  const pub=await crypto.subtle.exportKey('jwk',pair.publicKey);
  const manifest={context,public_key:{kty:pub.kty,n:pub.n,e:pub.e}};
  const {contextId}=await validateCredentialPublic(manifest);
  const metadata={manifest,context_id:contextId,private_key:await crypto.subtle.exportKey('jwk',pair.privateKey),account_key:randomBytes(32).toString('hex')};
  const enrollment=accounts.map(account=>({account,secret:randomBytes(32).toString('hex')}));
  createProtocolStore(path,'credential-issuer-v1',metadata,`
    CREATE TABLE accounts(account_hash TEXT PRIMARY KEY,secret_hash TEXT NOT NULL UNIQUE) STRICT;
    CREATE TABLE issued(account_hash TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response TEXT NOT NULL) STRICT;
  `,db=>{for(const item of enrollment)db.prepare('INSERT INTO accounts VALUES(?,?)').run(accountId(metadata,item.account),hash(item.secret));});
  return {manifest,enrollment};
}
export async function issueCredential(path,{account,secret,request}) {
  if(typeof account!=='string'||account.length>128||typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))fail('ELIGIBILITY_REJECTED');
  exactObject(request,['schema_version','context','blinded']);
  const meta=protocolMetadata(path,'credential-issuer-v1');
  const {contextId}=await validateCredentialPublic(meta.manifest);
  if(request.schema_version!==1||request.context!==contextId)fail('CREDENTIAL_CONTEXT_MISMATCH');
  const blinded=fromHex(request.blinded,768);
  if(blinded.length!==384)fail('INVALID_BLINDED_REQUEST');
  const accountHash=accountId(meta,account),requestHash=hash(request.blinded);
  const authenticate=db=>{
    const row=db.prepare('SELECT secret_hash FROM accounts WHERE account_hash=?').get(accountHash);
    if(!row||row.secret_hash!==hash(secret))fail('ELIGIBILITY_REJECTED');
    const previous=db.prepare('SELECT * FROM issued WHERE account_hash=?').get(accountHash);
    if(previous&&previous.request_hash!==requestHash)fail('ALREADY_ISSUED');
    return previous?JSON.parse(previous.response):null;
  };
  const existing=withProtocolStore(path,'credential-issuer-v1',false,authenticate);
  if(existing)return existing;
  const privateKey=await crypto.subtle.importKey('jwk',meta.private_key,{name:'RSA-PSS',hash:'SHA-384'},true,['sign']);
  const signature=await RSABSSA.SHA384.PSS.Randomized().blindSign(privateKey,blinded);
  const response={schema_version:1,context:contextId,blind_signature:toHex(signature)};
  return withProtocolStore(path,'credential-issuer-v1',true,db=>{
    const previous=authenticate(db);if(previous)return previous;
    db.prepare('INSERT INTO issued VALUES(?,?,?)').run(accountHash,requestHash,JSON.stringify(response));return response;
  });
}
export async function createCredentialCollector(path,manifest,survey) {
  const normalized=validateSurvey(survey);
  const validated=await validateCredentialPublic(manifest);
  if(await surveyFingerprint(normalized)!==validated.manifest.context.survey_fingerprint)fail('SURVEY_CONTEXT_MISMATCH');
  createProtocolStore(path,'credential-collector-v1',{manifest:validated.manifest,survey:normalized},`
    CREATE TABLE responses(token_hash TEXT PRIMARY KEY,response_hash TEXT NOT NULL,response_id TEXT NOT NULL UNIQUE,response TEXT NOT NULL,receipt TEXT NOT NULL) STRICT;
  `);
}
export async function redeemCredential(path,{token,response}) {
  const meta=protocolMetadata(path,'credential-collector-v1');
  const tokenHash=await verifyCredential(meta.manifest,token);
  const normalized=callCore({op:'validateCredentialResponse',survey:meta.survey,fingerprint:meta.manifest.context.survey_fingerprint,response});
  const encoded=JSON.stringify(normalized), responseHash=hash(encoded);
  return withProtocolStore(path,'credential-collector-v1',true,db=>{
    const previous=db.prepare('SELECT * FROM responses WHERE token_hash=?').get(tokenHash);
    if(previous){if(previous.response_hash!==responseHash)fail('CREDENTIAL_ALREADY_SPENT');return JSON.parse(previous.receipt);}
    if(db.prepare('SELECT 1 FROM responses WHERE response_id=?').get(normalized.response_id))fail('RESPONSE_ALREADY_COLLECTED');
    const receipt={schema_version:1,kind:'moonprivacykit/anonymous-receipt',receipt_id:randomUUID(),survey_fingerprint:meta.manifest.context.survey_fingerprint};
    db.prepare('INSERT INTO responses VALUES(?,?,?,?,?)').run(tokenHash,responseHash,normalized.response_id,encoded,JSON.stringify(receipt));return receipt;
  });
}
export function collectedCredentialResponses(path) {
  return withProtocolStore(path,'credential-collector-v1',false,db=>db.prepare('SELECT response FROM responses ORDER BY rowid').all().map(r=>JSON.parse(r.response)));
}
