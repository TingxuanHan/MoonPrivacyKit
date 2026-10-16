import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { callCore } from './client.mjs';

const suite=()=>RSABSSA.SHA384.PSS.Randomized();
export const toHex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export function fromHex(text, max=20000) {
  if(typeof text!=='string'||text.length===0||text.length>max||text.length%2||!/^[a-f0-9]+$/.test(text))throw new Error('INVALID_HEX');
  return Uint8Array.from(text.match(/../g),s=>parseInt(s,16));
}
function shape(value,keys){if(!value||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('INVALID_CREDENTIAL_OBJECT');}
export async function digest(text){return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))));}
export async function validateCredentialPublic(input, now=Math.floor(Date.now()/1000)) {
  shape(input,['context','public_key']);
  const context=callCore({op:'validateCredentialContext',context:input.context});
  if(!Number.isSafeInteger(now)||now>=context.expires_at)throw new Error('CREDENTIAL_CONTEXT_EXPIRED');
  shape(input.public_key,['kty','n','e']);
  if(input.public_key.kty!=='RSA'||input.public_key.e!=='AQAB'||typeof input.public_key.n!=='string'||!/^[A-Za-z0-9_-]{512}$/.test(input.public_key.n))throw new Error('INVALID_CREDENTIAL_KEY');
  const key=await crypto.subtle.importKey('jwk',input.public_key,{name:'RSA-PSS',hash:'SHA-384'},true,['verify']);
  if(key.algorithm.modulusLength!==3072)throw new Error('INVALID_CREDENTIAL_KEY');
  const normalized={context:{schema_version:1,kind:context.kind,survey_fingerprint:context.survey_fingerprint,expires_at:context.expires_at,suite:context.suite},public_key:{kty:'RSA',n:input.public_key.n,e:input.public_key.e}};
  return {manifest:normalized,key,contextId:await digest(JSON.stringify(normalized))};
}
function message(contextId,nonce){return new TextEncoder().encode(JSON.stringify(['MoonPrivacyKit anonymous participation v1',contextId,nonce]));}

// Retain state on the participant device. Send only request to the issuer.
export async function prepareCredential(manifest) {
  const {key,contextId}=await validateCredentialPublic(manifest);
  const nonce=toHex(crypto.getRandomValues(new Uint8Array(32)));
  const prepared=suite().prepare(message(contextId,nonce));
  const {blindedMsg,inv}=await suite().blind(key,prepared);
  return {
    request:{schema_version:1,context:contextId,blinded:toHex(blindedMsg)},
    state:{schema_version:1,kind:'moonprivacykit/private-credential-state',context:contextId,prepared:toHex(prepared),inverse:toHex(inv)},
  };
}
export async function finalizeCredential(manifest,state,response) {
  shape(state,['schema_version','kind','context','prepared','inverse']);
  shape(response,['schema_version','context','blind_signature']);
  const {key,contextId}=await validateCredentialPublic(manifest);
  if(state.schema_version!==1||state.kind!=='moonprivacykit/private-credential-state'||response.schema_version!==1||state.context!==contextId||response.context!==contextId)throw new Error('CREDENTIAL_CONTEXT_MISMATCH');
  const signature=await suite().finalize(key,fromHex(state.prepared),fromHex(response.blind_signature,768),fromHex(state.inverse,768));
  const token={schema_version:1,context:contextId,prepared:state.prepared,signature:toHex(signature)};
  await verifyCredential(manifest,token);
  return token;
}
export async function verifyCredential(manifest,token,now=Math.floor(Date.now()/1000)) {
  shape(token,['schema_version','context','prepared','signature']);
  const {key,contextId}=await validateCredentialPublic(manifest,now);
  if(token.schema_version!==1||token.context!==contextId)throw new Error('CREDENTIAL_CONTEXT_MISMATCH');
  const prepared=fromHex(token.prepared,2000);
  let fields;
  try{fields=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(prepared.slice(32)));}catch{throw new Error('INVALID_CREDENTIAL_MESSAGE');}
  if(!Array.isArray(fields)||fields.length!==3||fields[0]!=='MoonPrivacyKit anonymous participation v1'||fields[1]!==contextId||typeof fields[2]!=='string'||!/^[a-f0-9]{64}$/.test(fields[2]))throw new Error('INVALID_CREDENTIAL_MESSAGE');
  if(!await suite().verify(key,fromHex(token.signature,768),prepared))throw new Error('INVALID_CREDENTIAL_SIGNATURE');
  // One nonce is spent once even if the holder varies the signature encoding.
  return digest(JSON.stringify([contextId,fields[2]]));
}
