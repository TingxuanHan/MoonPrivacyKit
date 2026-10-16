import { callCore } from './client.mjs';
const encoder=new TextEncoder();
const shape=(v,keys)=>{if(!v||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('INVALID_JOINT_FILE');};
function decode64(text,max=32000){if(typeof text!=='string'||text.length>max||!/^[A-Za-z0-9_-]+$/.test(text))throw new Error('INVALID_JOINT_ENCODING');const bytes=Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));if(encode64(bytes)!==text)throw new Error('INVALID_JOINT_ENCODING');return bytes;}
function encode64(bytes){return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
function pemBytes(text,label){if(typeof text!=='string'||text.length>6000||!text.startsWith(`-----BEGIN ${label}-----`)||!text.trimEnd().endsWith(`-----END ${label}-----`))throw new Error('INVALID_JOINT_KEY');return Uint8Array.from(atob(text.replace(`-----BEGIN ${label}-----`,'').replace(`-----END ${label}-----`,'').replace(/\s/g,'')),c=>c.charCodeAt(0));}
function pem(bytes){const b64=btoa(String.fromCharCode(...new Uint8Array(bytes)));return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;}
async function publicKey(text,algorithm,usages){const key=await crypto.subtle.importKey('spki',pemBytes(text,'PUBLIC KEY'),algorithm,true,usages);if(algorithm.name==='RSA-OAEP'&&key.algorithm.modulusLength!==3072)throw new Error('INVALID_JOINT_KEY');return key;}
async function hash(text){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),v=>v.toString(16).padStart(2,'0')).join('');}
export async function validateJointTask(input){
  shape(input,['schema_version','kind','task_id','participants','nodes','labels','value_upper']);
  if(input.schema_version!==1||input.kind!=='moonprivacykit/two-server-sum'||!Array.isArray(input.participants)||input.participants.length<3||input.participants.length>1000||!Array.isArray(input.nodes)||input.nodes.length!==2||!Array.isArray(input.labels)||input.labels.length<1||input.labels.length>16)throw new Error('INVALID_JOINT_TASK');
  const value=structuredClone(input);
  if(value.labels.some(l=>typeof l!=='string'||!l.trim()||l.length>80)||new Set(value.labels).size!==value.labels.length)throw new Error('INVALID_JOINT_LABELS');
  const participants=[];
  for(const p of value.participants){shape(p,['id','verification_key']);participants.push({id:p.id,verification_key:pem(await crypto.subtle.exportKey('spki',await publicKey(p.verification_key,{name:'Ed25519'},['verify'])))});}
  participants.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const nodes=[];
  for(const n of value.nodes){shape(n,['role','encryption_key','signing_key']);nodes.push({role:n.role,encryption_key:pem(await crypto.subtle.exportKey('spki',await publicKey(n.encryption_key,{name:'RSA-OAEP',hash:'SHA-256'},['encrypt']))),signing_key:pem(await crypto.subtle.exportKey('spki',await publicKey(n.signing_key,{name:'Ed25519'},['verify'])))});}
  nodes.sort((a,b)=>String(a.role).localeCompare(String(b.role)));
  if(nodes[0].role!=='A'||nodes[1].role!=='B'||nodes[0].encryption_key===nodes[1].encryption_key||nodes[0].signing_key===nodes[1].signing_key||new Set(participants.map(p=>p.verification_key)).size!==participants.length)throw new Error('JOINT_KEYS_MUST_BE_DISTINCT');
  callCore({op:'validateAggregateConfig',config:{schema_version:1,task_id:value.task_id,participants:participants.map(p=>p.id),dimensions:value.labels.length,value_upper:value.value_upper}});
  const manifest={schema_version:1,kind:value.kind,task_id:value.task_id,participants,nodes,labels:value.labels,value_upper:value.value_upper};
  return {manifest,fingerprint:await hash(JSON.stringify(manifest))};
}
const packetBytes=p=>encoder.encode(JSON.stringify(['MoonPrivacyKit aggregate packet v1',p.task,p.participant,p.role,p.wrapped_key,p.iv,p.ciphertext,p.tag]));
export async function prepareJointPackets(task,identity,values){
  const {manifest,fingerprint}=await validateJointTask(task);
  shape(identity,['participant','private_key']);shape(identity.participant,['id','verification_key']);
  const participant=manifest.participants.find(p=>p.id===identity.participant.id);
  if(!participant||participant.verification_key!==identity.participant.verification_key)throw new Error('JOINT_IDENTITY_MISMATCH');
  const signing=await crypto.subtle.importKey('pkcs8',pemBytes(identity.private_key,'PRIVATE KEY'),{name:'Ed25519'},false,['sign']);
  const verification=await publicKey(participant.verification_key,{name:'Ed25519'},['verify']);
  const proof=await crypto.subtle.sign('Ed25519',signing,encoder.encode(fingerprint));
  if(!await crypto.subtle.verify('Ed25519',verification,proof,encoder.encode(fingerprint)))throw new Error('JOINT_IDENTITY_MISMATCH');
  if(!Array.isArray(values)||values.length!==manifest.labels.length)throw new Error('INVALID_JOINT_VECTOR');
  const split=callCore({op:'splitAggregate',values,masks:Array.from(crypto.getRandomValues(new Uint32Array(values.length)),n=>n&0xffffff),upper:manifest.value_upper});
  const packets=[];
  for(let i=0;i<2;i++){
    const node=manifest.nodes[i],iv=crypto.getRandomValues(new Uint8Array(12));
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
    const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify([fingerprint,participant.id,node.role])),tagLength:128},key,encoder.encode(JSON.stringify(i===0?split.left:split.right))));
    const wrapped=await crypto.subtle.encrypt({name:'RSA-OAEP'},await publicKey(node.encryption_key,{name:'RSA-OAEP',hash:'SHA-256'},['encrypt']),await crypto.subtle.exportKey('raw',key));
    const p={schema_version:1,task:fingerprint,participant:participant.id,role:node.role,wrapped_key:encode64(new Uint8Array(wrapped)),iv:encode64(iv),ciphertext:encode64(encrypted.slice(0,-16)),tag:encode64(encrypted.slice(-16))};
    p.signature=encode64(new Uint8Array(await crypto.subtle.sign('Ed25519',signing,packetBytes(p))));packets.push(p);
  }
  return packets;
}
export async function combineJointParts(task,input){
  const {manifest,fingerprint}=await validateJointTask(task);
  if(!Array.isArray(input)||input.length!==2)throw new Error('TWO_JOINT_PARTS_REQUIRED');
  const parts=structuredClone(input).sort((a,b)=>String(a.role).localeCompare(String(b.role)));
  for(let i=0;i<2;i++){
    const p=parts[i];shape(p,['schema_version','task','role','participant_count','sum','signature']);
    if(p.schema_version!==1||p.task!==fingerprint||p.role!==manifest.nodes[i].role||p.participant_count!==manifest.participants.length||!Array.isArray(p.sum)||p.sum.length!==manifest.labels.length)throw new Error('JOINT_PART_MISMATCH');
    const bytes=encoder.encode(JSON.stringify(['MoonPrivacyKit aggregate part v1',p.task,p.role,p.participant_count,p.sum]));
    if(!await crypto.subtle.verify('Ed25519',await publicKey(manifest.nodes[i].signing_key,{name:'Ed25519'},['verify']),decode64(p.signature,100),bytes))throw new Error('JOINT_PART_SIGNATURE_REJECTED');
  }
  const totals=callCore({op:'combineAggregateShares',left:parts[0].sum,right:parts[1].sum,participants:manifest.participants.length,upper:manifest.value_upper});
  return {schema_version:1,kind:'moonprivacykit/joint-statistics',task_fingerprint:fingerprint,participant_count:manifest.participants.length,labels:manifest.labels,totals,input_protection:'two-server additive sharing; semi-honest participants; at least one noncolluding aggregator',output_protection:'exact aggregate, not differential privacy'};
}
