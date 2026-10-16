import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callCore } from '../runtime/client.mjs';
import { createLedger, ledgerStatus, savedRelease } from '../runtime/ledger.mjs';
import { publishPersonQuery, planPersonQuery } from '../runtime/person-query.mjs';
import { renderReport } from '../runtime/report-export.mjs';
const plan = JSON.parse(readFileSync(new URL('../examples/person-query.json', import.meta.url)));
const left = JSON.stringify([{person:'a'}, {person:'a'}, {person:'b'}]);
const right = JSON.stringify([{person:'a',hours:10},{person:'a',hours:-1},{person:'a',hours:4},{person:'a',hours:7},{person:'b',hours:3}]);
const map = (p = plan, l = left, r = right) => callCore({op:'mapPersonQuery',plan:p,left_format:'json',left:l,right_format:'json',right:r});

test('public explanation and private mapping enforce pre/post join caps', () => {
  const explanation = planPersonQuery(plan);
  assert.equal(explanation.l1_sensitivity,24);
  const mapped = map();
  assert.deepEqual(mapped.unit_ids,['a','a','a','b']);
  assert.deepEqual(mapped.values,[8,0,4,3]);
  assert.equal(JSON.stringify(explanation).includes('person'),true);
  const p = {...plan,left_cap:2,right_cap:3,output_cap:4};
  assert.equal(planPersonQuery(p).l1_sensitivity,32);
  assert.deepEqual(map(p).values,[8,0,4,8,3]);
});

test('removing one person from both tables leaves all other contributions unchanged', () => {
  for (let cap = 1; cap <= 4; cap++) {
    const p={...plan,left_cap:3,right_cap:3,output_cap:cap};
    const all=map(p);
    for (const removed of ['a','b']) {
      const remaining=map(p,JSON.stringify(JSON.parse(left).filter(r=>r.person!==removed)),JSON.stringify(JSON.parse(right).filter(r=>r.person!==removed)));
      const expected=all.values.filter((_,i)=>all.unit_ids[i]!==removed);
      assert.deepEqual(remaining.values,expected);
      assert.ok(all.values.reduce((a,b)=>a+b,0)-remaining.values.reduce((a,b)=>a+b,0)<=planPersonQuery(p).l1_sensitivity);
    }
  }
});

test('invalid ownership, ambiguous numbers and invalid clipped-out records are rejected', () => {
  assert.throws(()=>map(plan,left,'[{"person":"a","hours":1,"hours":2}]'));
  assert.throws(()=>map(plan,left,JSON.stringify([...JSON.parse(right),{person:'a',hours:'private-invalid'}])));
  assert.throws(()=>map(plan,'[{"person":123}]',right));
  assert.throws(()=>planPersonQuery({...plan,join:'arbitrary'}));
  assert.throws(()=>planPersonQuery({...plan,value_upper:1001}));
});

test('two-table publication persists one result, binds the plan and exports without resampling', () => {
  const path=join(mkdtempSync(join(tmpdir(),'mpk-person-')),'ledger.sqlite');
  createLedger(path,{scope:'person-test',totalEpsilon:'2'});
  const request={plan,leftFormat:'json',left,rightFormat:'json',right,requestId:'join-1',epsilon:'1'};
  const first=publishPersonQuery(path,request);
  assert.deepEqual(publishPersonQuery(path,request),first);
  assert.equal(ledgerStatus(path).spent_epsilon,'1');
  assert.equal(first.release.report.query,'bounded_sum');
  assert.equal(first.release.report.max_contributions,24);
  assert.equal(JSON.stringify(first).includes('"unit_ids"'),false);
  assert.throws(()=>publishPersonQuery(path,{...request,plan:{...plan,right_cap:4}}),/bound to different/);
  const html=renderReport('statistics',savedRelease(path,'join-1'));
  assert.match(html,/有界整数和/);
  assert.equal(renderReport('statistics',savedRelease(path,'join-1')),html);
  assert.equal(ledgerStatus(path).spent_epsilon,'1');
});
