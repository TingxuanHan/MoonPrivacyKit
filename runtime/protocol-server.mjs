import { createServer } from 'node:http';
import { issueCredential,redeemCredential } from './credentials.mjs';
import { acceptAggregatePacket,finalizeAggregateNode } from './secure-aggregation.mjs';

// Separate role processes; no endpoint combines an issuer account and a token.
// Loopback laboratory transport. Remote deployment requires authenticated TLS,
// network-metadata protection and independent administration outside this server.
export function createProtocolServer(role,path) {
  const operations=role==='issuer'?{'/issue':v=>issueCredential(path,v)}:role==='collector'?{'/redeem':v=>redeemCredential(path,v)}:role==='aggregator'?{'/share':v=>acceptAggregatePacket(path,v.packet),'/finalize':v=>finalizeAggregateNode(path,v.task)}:null;
  if(!operations)throw new Error('INVALID_SERVICE_ROLE');
  const server=createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    try{
      if(![`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`].includes(req.headers.host)||req.headers.origin||req.headers['sec-fetch-site'])throw new Error('REQUEST_REJECTED');
      if(req.method==='GET'&&req.url==='/health'){send(200,{role});return;}
      const action=Object.hasOwn(operations,req.url)?operations[req.url]:null;
      if(req.method!=='POST'||!action||req.headers['content-type']!=='application/json'||req.headers['content-encoding'])throw new Error('REQUEST_REJECTED');
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>128000)throw new Error('INPUT_LIMIT');chunks.push(chunk);}
      const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      const keys=role==='issuer'?['account','secret','request']:role==='collector'?['token','response']:req.url==='/share'?['packet']:['task'];
      if(!input||Array.isArray(input)||Object.keys(input).length!==keys.length||keys.some(k=>!Object.hasOwn(input,k)))throw new Error('REQUEST_REJECTED');
      send(200,{ok:true,data:await action(input)});
    }catch(e){const known=['ELIGIBILITY_REJECTED','ALREADY_ISSUED','CREDENTIAL_ALREADY_SPENT','RESPONSE_ALREADY_COLLECTED','CREDENTIAL_CONTEXT_MISMATCH','CREDENTIAL_CONTEXT_EXPIRED','AGGREGATE_WAITING_FOR_PARTICIPANTS','AGGREGATE_SHARE_CONFLICT','AGGREGATE_TASK_NOT_REGISTERED'];send(400,{ok:false,error:known.includes(e.message)?e.message:'PROTOCOL_REQUEST_REJECTED'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
