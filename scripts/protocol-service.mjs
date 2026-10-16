import { createProtocolServer } from '../runtime/protocol-server.mjs';
const [role,path,portText='0']=process.argv.slice(2);
const port=Number(portText);
if(!path||!Number.isInteger(port)||port<0||port>65535)throw new Error('Usage: node scripts/protocol-service.mjs issuer|collector database.sqlite port');
const server=createProtocolServer(role,path);
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({role,port:server.address().port})));
