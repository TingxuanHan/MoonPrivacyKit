#!/usr/bin/env node
import { readFileSync,writeFileSync,existsSync,statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCredentialIssuer,issueCredential,createCredentialCollector,redeemCredential,collectedCredentialResponses } from '../runtime/credentials.mjs';
import { prepareCredential,finalizeCredential } from '../runtime/credential-client.mjs';
import { createAggregateIdentity,createAggregateNode,validateAggregateTask,registerAggregateTask,prepareAggregatePackets,acceptAggregatePacket,finalizeAggregateNode,combineAggregateParts } from '../runtime/secure-aggregation.mjs';

const usage=`MoonPrivacyKit 协作工具（所有输出拒绝覆盖）
init-issuer <新签发库.sqlite> <问卷.json> <账号列表.json> <公开配置.json> <私有资格列表.json>
prepare-credential <公开配置.json> <私有状态.json> <签发请求.json>
issue-credential <签发库.sqlite> <单个账号资格.json> <签发请求.json> <签名响应.json>
finalize-credential <公开配置.json> <私有状态.json> <签名响应.json> <凭证.json>
init-collector <新收卷库.sqlite> <公开配置.json> <问卷.json>
redeem-credential <收卷库.sqlite> <凭证.json> <受保护回答.json> <回执.json>
redeem-submission <收卷库.sqlite> <参与提交包.json> <回执.json>
export-collected <收卷库.sqlite> <受保护回答集合.json>
aggregate-identity <参与方代号> <私有身份.json> <公开身份.json>
init-aggregate-node <新节点库.sqlite> <A|B> <公开节点.json>
create-aggregate-task <任务代号> <单项上限> <类别数组.json> <公开身份数组.json> <节点A.json> <节点B.json> <任务.json>
register-aggregate-task <节点库.sqlite> <任务.json>
prepare-aggregate <任务.json> <私有身份.json> <整数数组.json> <发给A.json> <发给B.json>
accept-aggregate <节点库.sqlite> <加密份额.json> <回执.json>
finalize-aggregate <节点库.sqlite> <任务.json> <节点合计.json>
combine-aggregate <任务.json> <A合计.json> <B合计.json> <联合统计.json>

签发请求可交给资格核验方，私有状态只留在参与者设备。
服务模式：node scripts/protocol-service.mjs issuer|collector|aggregator 库文件 端口
服务只监听本机，网络部署需另外配置 TLS、身份与网络元数据保护。`;
function read(path){if(statSync(path).size>4000000)throw new Error('INPUT_LIMIT');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)));}
function fresh(paths){if(paths.some(existsSync)||new Set(paths.map(p=>resolve(p))).size!==paths.length)throw new Error('OUTPUT_EXISTS');}
function write(path,value){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
async function main(){
  const [command,...a]=process.argv.slice(2);
  if(!command||command==='--help'){console.log(usage);return;}
  if(command==='init-issuer'&&a.length===5){fresh([a[0],a[3],a[4]]);const result=await createCredentialIssuer(a[0],read(a[1]),read(a[2]));write(a[3],result.manifest);write(a[4],result.enrollment);}
  else if(command==='prepare-credential'&&a.length===3){fresh([a[1],a[2]]);const result=await prepareCredential(read(a[0]));write(a[1],result.state);write(a[2],result.request);}
  else if(command==='issue-credential'&&a.length===4){fresh([a[3]]);write(a[3],await issueCredential(a[0],{...read(a[1]),request:read(a[2])}));}
  else if(command==='finalize-credential'&&a.length===4){fresh([a[3]]);write(a[3],await finalizeCredential(read(a[0]),read(a[1]),read(a[2])));}
  else if(command==='init-collector'&&a.length===3){fresh([a[0]]);await createCredentialCollector(a[0],read(a[1]),read(a[2]));}
  else if(command==='redeem-credential'&&a.length===4){fresh([a[3]]);write(a[3],await redeemCredential(a[0],{token:read(a[1]),response:read(a[2])}));}
  else if(command==='redeem-submission'&&a.length===3){fresh([a[2]]);write(a[2],await redeemCredential(a[0],read(a[1])));}
  else if(command==='export-collected'&&a.length===2){fresh([a[1]]);write(a[1],collectedCredentialResponses(a[0]));}
  else if(command==='aggregate-identity'&&a.length===3){fresh([a[1],a[2]]);const identity=createAggregateIdentity(a[0]);write(a[1],identity);write(a[2],identity.participant);}
  else if(command==='init-aggregate-node'&&a.length===3){fresh([a[0],a[2]]);write(a[2],createAggregateNode(a[0],a[1]));}
  else if(command==='create-aggregate-task'&&a.length===7){fresh([a[6]]);write(a[6],validateAggregateTask({schema_version:1,kind:'moonprivacykit/two-server-sum',task_id:a[0],value_upper:Number(a[1]),labels:read(a[2]),participants:read(a[3]),nodes:[read(a[4]),read(a[5])]}).manifest);}
  else if(command==='register-aggregate-task'&&a.length===2){registerAggregateTask(a[0],read(a[1]));}
  else if(command==='prepare-aggregate'&&a.length===5){fresh([a[3],a[4]]);const packets=prepareAggregatePackets(read(a[0]),read(a[1]),read(a[2]));write(a[3],packets[0]);write(a[4],packets[1]);}
  else if(command==='accept-aggregate'&&a.length===3){fresh([a[2]]);write(a[2],acceptAggregatePacket(a[0],read(a[1])));}
  else if(command==='finalize-aggregate'&&a.length===3){fresh([a[2]]);write(a[2],finalizeAggregateNode(a[0],validateAggregateTask(read(a[1])).fingerprint));}
  else if(command==='combine-aggregate'&&a.length===4){fresh([a[3]]);write(a[3],combineAggregateParts(read(a[0]),[read(a[1]),read(a[2])]));}
  else throw new Error('INVALID_ARGUMENTS');
  console.log('完成。私有文件请由对应角色分别保管。');
}
main().catch(error=>{const code=/^[A-Z_]{3,60}$/.test(error.message)?error.message:'PROTOCOL_OPERATION_FAILED';console.error(`未完成：${code}`);process.exitCode=1;});
