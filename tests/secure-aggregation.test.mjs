import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAggregateIdentity,createAggregateNode,validateAggregateTask,registerAggregateTask,prepareAggregatePackets,acceptAggregatePacket,finalizeAggregateNode,combineAggregateParts } from '../runtime/secure-aggregation.mjs';
const dir=mkdtempSync(join(tmpdir(),'mpk-aggregate-')),files=[join(dir,'A.sqlite'),join(dir,'B.sqlite')];
const identities=['one','two','three'].map(createAggregateIdentity),values=[[2,3],[5,6],[7,8]];
let task,fp,packets;const children=[];
before(()=>{
  task={schema_version:1,kind:'moonprivacykit/two-server-sum',task_id:'synthetic-2026',participants:identities.map(i=>i.participant),nodes:files.map((p,i)=>createAggregateNode(p,i===0?'A':'B')),labels:['workshops','hours'],value_upper:10};
  fp=validateAggregateTask(task).fingerprint;
  files.forEach(path=>registerAggregateTask(path,task));
  packets=identities.map((identity,i)=>prepareAggregatePackets(task,identity,values[i]));
});
after(()=>{for(const child of children)child.kill();});
test('the fixed task refuses subsets and invalid participant/value domains',()=>{
  assert.throws(()=>validateAggregateTask({...task,participants:task.participants.slice(1)}));
  assert.throws(()=>validateAggregateTask({...task,nodes:[task.nodes[0],{...task.nodes[0],role:'B'}]}));
  assert.throws(()=>prepareAggregatePackets(task,identities[0],[11,0]));
  assert.throws(()=>prepareAggregatePackets(task,identities[0],[1.5,0]));
  assert.throws(()=>finalizeAggregateNode(files[0],fp),/WAITING/);
});
test('encrypted packets authenticate the participant, role, task and ciphertext',()=>{
  const packet=packets[0][0];
  assert.equal(Object.hasOwn(packet,'share'),false);
  assert.throws(()=>acceptAggregatePacket(files[1],packet),/ROLE_MISMATCH/);
  assert.throws(()=>acceptAggregatePacket(files[0],{...packet,participant:'two'}),/SIGNATURE_REJECTED/);
  assert.throws(()=>acceptAggregatePacket(files[0],{...packet,ciphertext:'A'+packet.ciphertext.slice(1)}));
  const receipt=acceptAggregatePacket(files[0],packet);
  assert.deepEqual(acceptAggregatePacket(files[0],packet),receipt);
  const replacement=prepareAggregatePackets(task,identities[0],values[0])[0];
  assert.throws(()=>acceptAggregatePacket(files[0],replacement),/SHARE_CONFLICT/);
});
async function service(file){const child=spawn(process.execPath,['scripts/protocol-service.mjs','aggregator',file,'0'],{stdio:['ignore','pipe','pipe']});children.push(child);const [data]=await once(child.stdout,'data');return `http://127.0.0.1:${JSON.parse(data.toString()).port}`;}
test('independent aggregation services reveal only signed whole-batch sums',async()=>{
  const origins=await Promise.all(files.map(service));
  const post=async(origin,endpoint,body)=>(await fetch(origin+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  assert.equal((await post(origins[1],'/finalize',{task:fp})).error,'AGGREGATE_WAITING_FOR_PARTICIPANTS');
  for(const pair of packets)for(let i=0;i<2;i++)assert.equal((await post(origins[i],'/share',{packet:pair[i]})).ok,true);
  const parts=await Promise.all(origins.map(async origin=>{const result=await post(origin,'/finalize',{task:fp});assert.equal(result.ok,true);return result.data;}));
  assert.deepEqual(finalizeAggregateNode(files[0],fp),parts[0]);
  const report=combineAggregateParts(task,parts);
  assert.deepEqual(report.totals,values[0].map((_,i)=>values.reduce((sum,v)=>sum+v[i],0)));
  assert.equal(report.output_protection,'exact aggregate, not differential privacy');
  assert.throws(()=>combineAggregateParts(task,[parts[0],parts[0]]),/PART_REJECTED/);
  assert.throws(()=>combineAggregateParts(task,[{...parts[0],sum:[0,0]},parts[1]]),/PART_REJECTED/);
  assert.throws(()=>combineAggregateParts({...task,task_id:'different-task'},parts),/PART_REJECTED/);
});
