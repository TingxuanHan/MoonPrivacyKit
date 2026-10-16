import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callCore } from '../runtime/client.mjs';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const rows = [22,23,42,43].map((age,i)=>({id:`private-${i}`,age,department:i<2?'A':'B'}));
const candidate = (name,rule) => ({schemaVersion:2,kind:'moonprivacykit/redaction-template',name,settings:{fields:[{name:'id',action:'remove'},{name:'age',...rule},{name:'department',action:'keep'}],spreadsheetSafe:false}});
const config = {schema_version:1,quasi_fields:['age','department'],required_unchanged:['department'],k:2,candidates:[candidate('fine',{action:'keep'}),candidate('coarse',{action:'age',boundaries:[30,60]}),candidate('removed',{action:'remove'})]};
const compare = (c=config,input=JSON.stringify(rows))=>callCore({op:'comparePrivacyPlans',format:'json',input,config:c});
test('candidate comparison computes explicit risk, loss and a feasible frontier',()=>{
  const r=compare(); assert.equal(r.baseline.minimum_group,1);
  assert.deepEqual(r.candidates.map(c=>c.metrics.minimum_group),[1,2,2]);
  assert.deepEqual(r.candidates.map(c=>c.meets_constraints),[false,true,true]);
  assert.deepEqual(r.frontier,['coarse']); assert.ok(!JSON.stringify(r).includes('private-0'));
  assert.deepEqual(compare({...config,k:5}).frontier,[]);
  assert.throws(()=>compare({...config,candidates:Array(65).fill(config.candidates[0])}));
  assert.throws(()=>compare({...config,quasi_fields:['missing']}));
  assert.deepEqual(compare({...config,required_unchanged:['id']}).frontier,[]);
});
test('candidate metrics preserve duplicate rows and distinguish missing scalar values',()=>{
  const r=compare(config,JSON.stringify([...rows,rows[0]]));
  assert.equal(r.baseline.unique_fraction,3/5);
  const c={...config,quasi_fields:['department'],candidates:[candidate('fine',{action:'keep'})]};
  const changed=rows.map((r,i)=>({...r,department:i===0?null:r.department}));
  assert.equal(compare(c,JSON.stringify(changed)).candidates[0].missing_rows,1);
  assert.throws(()=>compare(c,JSON.stringify(rows.map(r=>({...r,department:{nested:true}})))));
});
const left=rows.map((r,i)=>({id:r.id,x:i<2?0:1}));
const right=rows.map((r,i)=>({id:r.id,y:i%2}));
const version={schema_version:1,unit_field:'id',left_fields:['x'],right_fields:['y'],k:2,assume_linkable:true};
const cross=(a=left,b=right,c=version)=>callCore({op:'comparePrivateVersions',left_format:'json',left:JSON.stringify(a),right_format:'json',right:JSON.stringify(b),config:c});
test('cross-version analysis detects intersection disclosure and is invariant to row order',()=>{
  const report=cross(); assert.deepEqual([report.left.minimum_group,report.right.minimum_group,report.joint.minimum_group],[2,2,1]);
  assert.equal(report.newly_below_k_rows,4); assert.equal(report.smaller_group_rows,4);
  assert.deepEqual(cross(left,[...right].reverse()),report);
  assert.equal(JSON.stringify(report).includes('private-0'),false);
  assert.equal(cross(left,left,{...version,right_fields:['x']}).newly_below_k_rows,0);
});
test('unreliable private correspondence never produces a no-risk verdict',()=>{
  assert.throws(()=>cross(left,right.slice(1)));
  assert.throws(()=>cross(left,[right[0],right[0],right[2],right[3]]));
  assert.throws(()=>cross(left,right,{...version,assume_linkable:false}));
  assert.throws(()=>cross(left,right,{...version,left_fields:['id']}));
  assert.throws(()=>cross(left,right.map(r=>({...r,id:r.id+'other'}))));
});
test('upstream scanning reports categories without values and exact budget remains authoritative',()=>{
  const r=callCore({op:'scanSensitiveFields',format:'json',input:JSON.stringify([{contact:'person@private-company.org',id:'001'}])});
  assert.equal(r.findings[0].field,'contact'); assert.ok(!JSON.stringify(r).includes('person@'));
  const s=callCore({op:'scrubText',input:'Email person@private-company.org'}); assert.ok(!s.output.includes('person@'));
  let spent=0;
  for(let i=0;i<30;i++)spent=callCore({op:'chargeBudget',total_units:300000,spent_units:spent,charge_units:10000}).spent_units;
  assert.equal(spent,300000); assert.throws(()=>callCore({op:'chargeBudget',total_units:300000,spent_units:spent,charge_units:10000}));
});

test('CLI comparisons and scanning refuse output overwrites and preserve original files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mpk-planning-cli-'));
  const write=(name,value)=>{const path=join(dir,name);writeFileSync(path,JSON.stringify(value));return path;};
  const input=write('data.json',rows), settings=write('config.json',config), l=write('left.json',left), r=write('right.json',right), v=write('versions.json',version);
  const run=(args)=>spawnSync(process.execPath,['cli/main.mjs',...args],{encoding:'utf8'});
  const commands=[['compare-plans','json',input,settings],['compare-versions','json',l,'json',r,v],['scan-fields','json',input],['scrub-text',input]];
  commands.forEach((args,i)=>{const output=join(dir,`result-${i}.json`);const result=run([...args,output]);assert.equal(result.status,0,result.stderr);JSON.parse(readFileSync(output));assert.notEqual(run([...args,output]).status,0);});
  assert.deepEqual(JSON.parse(readFileSync(input)),rows);
});
