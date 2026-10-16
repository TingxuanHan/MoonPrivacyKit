import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createPublicKey,verify,constants } from 'node:crypto';
import { createCredentialIssuer,issueCredential,createCredentialCollector,redeemCredential,collectedCredentialResponses } from '../runtime/credentials.mjs';
import { prepareCredential,finalizeCredential,verifyCredential,validateCredentialPublic,fromHex } from '../runtime/credential-client.mjs';
import { protectResponse } from '../runtime/client.mjs';
const dir=mkdtempSync(join(tmpdir(),'mpk-credentials-'));
const issuer=join(dir,'issuer.sqlite'),collector=join(dir,'collector.sqlite');
const survey=JSON.parse(readFileSync(new URL('../examples/survey.json',import.meta.url)));
let config,enrollment,prepared,token,response;
const children=[];
before(async()=>{
  ({manifest:config,enrollment}=await createCredentialIssuer(issuer,survey,['private-alice-identifier','private-bob-identifier']));
  await createCredentialCollector(collector,config,survey);
  prepared=await prepareCredential(config);
  const signed=await issueCredential(issuer,{...enrollment[0],request:prepared.request});
  token=await finalizeCredential(config,prepared.state,signed);
  response=await protectResponse(survey,survey.questions.map(()=>0));
});
after(()=>{for(const child of children)child.kill();});

test('standard RSA-PSS verifies the unblinded credential independently',async()=>{
  const key=createPublicKey({key:config.public_key,format:'jwk'});
  assert.equal(verify('sha384',fromHex(token.prepared),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:48},fromHex(token.signature)),true);
  assert.match(await verifyCredential(config,token),/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(prepared.request).includes(prepared.state.prepared),false);
});
test('eligibility is authenticated and a new blinded request cannot obtain a second credential',async()=>{
  const request={...enrollment[0],request:prepared.request};
  assert.deepEqual(await issueCredential(issuer,request),await issueCredential(issuer,request));
  await assert.rejects(issueCredential(issuer,{...request,secret:'0'.repeat(64)}),/ELIGIBILITY/);
  await assert.rejects(issueCredential(issuer,{...request,request:(await prepareCredential(config)).request}),/ALREADY_ISSUED/);
});
test('redemption is atomic, retryable, tied to one survey and binds the response',async()=>{
  const input={token,response};
  const receipt=await redeemCredential(collector,input);
  assert.deepEqual(await redeemCredential(collector,input),receipt);
  assert.equal(collectedCredentialResponses(collector).length,1);
  await assert.rejects(redeemCredential(collector,{token,response:{...response,response_id:'b'.repeat(32)}}),/ALREADY_SPENT/);
  await assert.rejects(redeemCredential(collector,{token,response:{...response,survey_fingerprint:'0'.repeat(64)}}));
  await assert.rejects(verifyCredential(config,{...token,context:'0'.repeat(64)}),/CONTEXT_MISMATCH/);
  await assert.rejects(verifyCredential(config,{...token,signature:'0'.repeat(768)}),/SIGNATURE/);
  await assert.rejects(validateCredentialPublic(config,config.context.expires_at),/EXPIRED/);
  assert.equal(readFileSync(collector).includes(Buffer.from(enrollment[0].account)),false);
  assert.equal(readFileSync(collector).includes(Buffer.from(enrollment[0].secret)),false);
  assert.equal(readFileSync(issuer).includes(Buffer.from(token.prepared)),false);
});
async function service(role,path){
  const child=spawn(process.execPath,['scripts/protocol-service.mjs',role,path,'0'],{stdio:['ignore','pipe','pipe']});children.push(child);
  const [data]=await once(child.stdout,'data');return `http://127.0.0.1:${JSON.parse(data.toString()).port}`;
}
test('separate issuer and collector processes accept one concurrent redemption',async()=>{
  const issueOrigin=await service('issuer',issuer),collectOrigin=await service('collector',collector);
  const state=await prepareCredential(config);
  const post=async(origin,endpoint,body,headers={})=>(await fetch(origin+endpoint,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})).json();
  const signed=await post(issueOrigin,'/issue',{...enrollment[1],request:state.request});
  assert.equal(signed.ok,true);
  const issued=await finalizeCredential(config,state.state,signed.data);
  const protectedAnswer=await protectResponse(survey,survey.questions.map(()=>0));
  const answers=await Promise.all([1,2].map(()=>post(collectOrigin,'/redeem',{token:issued,response:protectedAnswer})));
  assert.equal(answers.every(a=>a.ok),true);
  assert.deepEqual(answers[0].data,answers[1].data);
  assert.equal(collectedCredentialResponses(collector).length,2);
  assert.equal((await post(issueOrigin,'/issue',{...enrollment[1],request:state.request},{origin:'https://untrusted.example'})).ok,false);
  assert.equal((await post(collectOrigin,'/issue',{...enrollment[1],request:state.request})).ok,false);
});
