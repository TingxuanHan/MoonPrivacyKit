import { generateKeyPairSync,createPublicKey,createPrivateKey,randomBytes,createHash,createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,sign,verify,constants } from 'node:crypto';
import { callCore } from './client.mjs';
import { createProtocolStore,withProtocolStore,protocolMetadata,protocolError,exactObject } from './protocol-store.mjs';
const fail=code=>{throw protocolError(code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const publicEncoding={type:'spki',format:'pem'},privateEncoding={type:'pkcs8',format:'pem'};
function b64(value,max=32000){if(typeof value!=='string'||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value))fail('INVALID_AGGREGATE_ENCODING');const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)fail('INVALID_AGGREGATE_ENCODING');return bytes;}
function publicKey(value,type){if(typeof value!=='string'||value.length>3000)fail('INVALID_AGGREGATE_KEY');const key=createPublicKey(value);if(key.asymmetricKeyType!==type||(type==='rsa'&&key.asymmetricKeyDetails.modulusLength!==3072))fail('INVALID_AGGREGATE_KEY');return key;}
function nodeDescriptor(value){exactObject(value,['role','encryption_key','signing_key']);if(!['A','B'].includes(value.role))fail('INVALID_AGGREGATE_ROLE');return {role:value.role,encryption_key:publicKey(value.encryption_key,'rsa').export(publicEncoding),signing_key:publicKey(value.signing_key,'ed25519').export(publicEncoding)};}

export function createAggregateIdentity(id) {
  if(typeof id!=='string'||id.length<1||id.length>80)fail('INVALID_AGGREGATE_ID');
  const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:publicEncoding,privateKeyEncoding:privateEncoding});
  return {participant:{id,verification_key:keys.publicKey},private_key:keys.privateKey};
}
export function createAggregateNode(path,role) {
  if(!['A','B'].includes(role))fail('INVALID_AGGREGATE_ROLE');
  const rsa=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:publicEncoding,privateKeyEncoding:privateEncoding});
  const signing=generateKeyPairSync('ed25519',{publicKeyEncoding:publicEncoding,privateKeyEncoding:privateEncoding});
  const descriptor={role,encryption_key:rsa.publicKey,signing_key:signing.publicKey};
  createProtocolStore(path,'aggregate-node-v1',{descriptor,decryption_key:rsa.privateKey,signing_key:signing.privateKey},`
    CREATE TABLE tasks(fingerprint TEXT PRIMARY KEY,manifest TEXT NOT NULL,result TEXT) STRICT;
    CREATE TABLE shares(task TEXT NOT NULL,participant TEXT NOT NULL,share_hash TEXT NOT NULL,vector TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(task,participant)) STRICT;
  `);
  return descriptor;
}
export function validateAggregateTask(value) {
  exactObject(value,['schema_version','kind','task_id','participants','nodes','labels','value_upper']);
  if(value.schema_version!==1||value.kind!=='moonprivacykit/two-server-sum'||!Array.isArray(value.participants)||value.participants.length<3||value.participants.length>1000||!Array.isArray(value.nodes)||value.nodes.length!==2||!Array.isArray(value.labels)||value.labels.length<1||value.labels.length>16)fail('INVALID_AGGREGATE_TASK');
  const participants=value.participants.map(p=>{exactObject(p,['id','verification_key']);return {id:p.id,verification_key:publicKey(p.verification_key,'ed25519').export(publicEncoding)};}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const nodes=value.nodes.map(nodeDescriptor).sort((a,b)=>a.role.localeCompare(b.role));
  if(nodes[0].role!=='A'||nodes[1].role!=='B'||nodes[0].encryption_key===nodes[1].encryption_key||nodes[0].signing_key===nodes[1].signing_key)fail('AGGREGATORS_MUST_BE_DISTINCT');
  if(new Set(participants.map(p=>p.verification_key)).size!==participants.length)fail('PARTICIPANTS_MUST_HAVE_DISTINCT_KEYS');
  if(value.labels.some(l=>typeof l!=='string'||!l.trim()||l.length>80)||new Set(value.labels).size!==value.labels.length)fail('INVALID_AGGREGATE_LABELS');
  callCore({op:'validateAggregateConfig',config:{schema_version:1,task_id:value.task_id,participants:participants.map(p=>p.id),dimensions:value.labels.length,value_upper:value.value_upper}});
  const manifest={schema_version:1,kind:value.kind,task_id:value.task_id,participants,nodes,labels:[...value.labels],value_upper:value.value_upper};
  return {manifest,fingerprint:hash(JSON.stringify(manifest))};
}
export function registerAggregateTask(path,input) {
  const {manifest,fingerprint}=validateAggregateTask(input);
  return withProtocolStore(path,'aggregate-node-v1',true,(db,meta)=>{
    const expected=manifest.nodes.find(n=>n.role===meta.descriptor.role);
    if(JSON.stringify(expected)!==JSON.stringify(meta.descriptor))fail('AGGREGATE_NODE_MISMATCH');
    const previous=db.prepare('SELECT manifest FROM tasks WHERE fingerprint=?').get(fingerprint);
    if(!previous)db.prepare('INSERT INTO tasks VALUES(?,?,NULL)').run(fingerprint,JSON.stringify(manifest));
    return {task:fingerprint,role:meta.descriptor.role};
  });
}
function packetBytes(p){return Buffer.from(JSON.stringify(['MoonPrivacyKit aggregate packet v1',p.task,p.participant,p.role,p.wrapped_key,p.iv,p.ciphertext,p.tag]));}
function aad(task,participant,role){return Buffer.from(JSON.stringify([task,participant,role]));}
export function prepareAggregatePackets(task,identity,values) {
  const {manifest,fingerprint}=validateAggregateTask(task);
  exactObject(identity,['participant','private_key']);
  const participant=manifest.participants.find(p=>p.id===identity.participant?.id);
  if(!participant||JSON.stringify(participant)!==JSON.stringify(identity.participant))fail('AGGREGATE_PARTICIPANT_MISMATCH');
  const privateKey=createPrivateKey(identity.private_key);
  if(createPublicKey(privateKey).export(publicEncoding)!==participant.verification_key)fail('AGGREGATE_PARTICIPANT_MISMATCH');
  if(!Array.isArray(values)||values.length!==manifest.labels.length)fail('INVALID_AGGREGATE_VECTOR');
  const masks=Array.from(crypto.getRandomValues(new Uint32Array(values.length)),n=>n&0xffffff);
  const split=callCore({op:'splitAggregate',values,masks,upper:manifest.value_upper});
  return manifest.nodes.map((node,i)=>{
    const key=randomBytes(32),iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(aad(fingerprint,participant.id,node.role));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(i===0?split.left:split.right),'utf8'),cipher.final()]);
    const packet={schema_version:1,task:fingerprint,participant:participant.id,role:node.role,wrapped_key:publicEncrypt({key:node.encryption_key,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64url'),iv:iv.toString('base64url'),ciphertext:ciphertext.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')};
    packet.signature=sign(null,packetBytes(packet),privateKey).toString('base64url');
    return packet;
  });
}
export function acceptAggregatePacket(path,packet) {
  exactObject(packet,['schema_version','task','participant','role','wrapped_key','iv','ciphertext','tag','signature']);
  if(packet.schema_version!==1||typeof packet.task!=='string'||!/^[a-f0-9]{64}$/.test(packet.task)||typeof packet.participant!=='string')fail('INVALID_AGGREGATE_PACKET');
  return withProtocolStore(path,'aggregate-node-v1',true,(db,meta)=>{
    if(packet.role!==meta.descriptor.role)fail('AGGREGATE_ROLE_MISMATCH');
    const row=db.prepare('SELECT * FROM tasks WHERE fingerprint=?').get(packet.task);
    if(!row)fail('AGGREGATE_TASK_NOT_REGISTERED');
    const {manifest,fingerprint}=validateAggregateTask(JSON.parse(row.manifest));
    if(fingerprint!==packet.task)fail('INVALID_AGGREGATE_STORE');
    const participant=manifest.participants.find(p=>p.id===packet.participant);
    if(!participant||!verify(null,packetBytes(packet),participant.verification_key,b64(packet.signature,100)))fail('AGGREGATE_SIGNATURE_REJECTED');
    const key=privateDecrypt({key:meta.decryption_key,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},b64(packet.wrapped_key,512));
    const iv=b64(packet.iv,16),tag=b64(packet.tag,22);
    if(key.length!==32||iv.length!==12||tag.length!==16)fail('INVALID_AGGREGATE_ENVELOPE');
    const decipher=createDecipheriv('aes-256-gcm',key,iv);
    decipher.setAAD(aad(packet.task,packet.participant,packet.role));decipher.setAuthTag(tag);
    const clear=Buffer.concat([decipher.update(b64(packet.ciphertext,2000)),decipher.final()]);
    const vector=callCore({op:'sumAggregateShares',vectors:[JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(clear))],dimensions:manifest.labels.length});
    const encoded=JSON.stringify(vector),shareHash=hash(encoded);
    const previous=db.prepare('SELECT * FROM shares WHERE task=? AND participant=?').get(packet.task,packet.participant);
    if(previous){if(previous.share_hash!==shareHash)fail('AGGREGATE_SHARE_CONFLICT');return JSON.parse(previous.receipt);}
    if(row.result)fail('AGGREGATE_ALREADY_FINALIZED');
    const receipt={schema_version:1,task:packet.task,participant:packet.participant,role:packet.role,accepted:true};
    db.prepare('INSERT INTO shares VALUES(?,?,?,?,?)').run(packet.task,packet.participant,shareHash,encoded,JSON.stringify(receipt));return receipt;
  });
}
function partBytes(part){return Buffer.from(JSON.stringify(['MoonPrivacyKit aggregate part v1',part.task,part.role,part.participant_count,part.sum]));}
export function finalizeAggregateNode(path,taskFingerprint) {
  if(typeof taskFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(taskFingerprint))fail('INVALID_AGGREGATE_TASK');
  return withProtocolStore(path,'aggregate-node-v1',true,(db,meta)=>{
    const row=db.prepare('SELECT * FROM tasks WHERE fingerprint=?').get(taskFingerprint);
    if(!row)fail('AGGREGATE_TASK_NOT_REGISTERED');
    if(row.result)return JSON.parse(row.result);
    const {manifest,fingerprint}=validateAggregateTask(JSON.parse(row.manifest));
    if(fingerprint!==taskFingerprint)fail('INVALID_AGGREGATE_STORE');
    const rows=db.prepare('SELECT participant,vector FROM shares WHERE task=? ORDER BY participant').all(taskFingerprint);
    if(rows.length!==manifest.participants.length||manifest.participants.some(p=>!rows.some(r=>r.participant===p.id)))fail('AGGREGATE_WAITING_FOR_PARTICIPANTS');
    const sum=callCore({op:'sumAggregateShares',vectors:rows.map(r=>JSON.parse(r.vector)),dimensions:manifest.labels.length});
    const part={schema_version:1,task:taskFingerprint,role:meta.descriptor.role,participant_count:rows.length,sum};
    part.signature=sign(null,partBytes(part),meta.signing_key).toString('base64url');
    db.prepare('UPDATE tasks SET result=? WHERE fingerprint=?').run(JSON.stringify(part),taskFingerprint);return part;
  });
}
export function combineAggregateParts(task,parts) {
  const {manifest,fingerprint}=validateAggregateTask(task);
  if(!Array.isArray(parts)||parts.length!==2)fail('TWO_AGGREGATE_PARTS_REQUIRED');
  const ordered=[...parts].sort((a,b)=>String(a.role).localeCompare(String(b.role)));
  ordered.forEach((p,i)=>{
    exactObject(p,['schema_version','task','role','participant_count','sum','signature']);
    if(p.schema_version!==1||p.task!==fingerprint||p.role!==manifest.nodes[i].role||p.participant_count!==manifest.participants.length||!Array.isArray(p.sum)||p.sum.length!==manifest.labels.length||!verify(null,partBytes(p),manifest.nodes[i].signing_key,b64(p.signature,100)))fail('AGGREGATE_PART_REJECTED');
  });
  const totals=callCore({op:'combineAggregateShares',left:ordered[0].sum,right:ordered[1].sum,participants:manifest.participants.length,upper:manifest.value_upper});
  return {schema_version:1,kind:'moonprivacykit/joint-statistics',task_fingerprint:fingerprint,participant_count:manifest.participants.length,labels:manifest.labels,totals,input_protection:'two-server additive sharing; semi-honest participants; at least one noncolluding aggregator',output_protection:'exact aggregate, not differential privacy'};
}
