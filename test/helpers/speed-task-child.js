import { SqliteStore } from '../../src/services/sqlite-store.js';
import { SpeedTaskStore } from '../../src/services/speed-task-store.js';
import { SpeedDeployService } from '../../src/services/cloudflare/speed-deploy-service.js';
import { CloudflareClient } from '../../src/services/cloudflare/cloudflare-client.js';
import { SpeedDeployTransaction } from '../../src/services/cloudflare/speed-deploy-transaction.js';
import { DnsRecordsService } from '../../src/services/cloudflare/dns-records-service.js';
const store=new SqliteStore({databasePath:process.argv[2],secretKey:'test-key'});
const client=new CloudflareClient({apiBaseUrl:process.argv[3],email:'test@example.com',globalApiKey:'secret-key',requestTimeoutMs:60000});
client.getCredentials=()=>({accountId:'local-account',email:'test@example.com',globalApiKey:'secret-key'});
const journal=new SpeedTaskStore({store});
const service=new SpeedDeployService({cloudflareClient:client,dnsRecordsService:new DnsRecordsService({cloudflareClient:client}),speedTaskStore:journal});
if(process.argv[4]==='confirmed-checkpoint'){
 const zoneId='a'.repeat(32);journal.acquireScope('local-account',zoneId);
 const id=journal.begin('local-account',{zoneId,zoneName:'alpha.example',accessDomain:'cdn.alpha.example'});
 const transaction=new SpeedDeployTransaction({journal:operations=>journal.save(id,'local-account',{steps:operations.map(o=>({type:o.type,zoneId:o.zoneId,label:o.label,before:o.before,expected:o.expected,creationBody:o.creationBody,confirmed:Boolean(o.confirmed),status:o.status})),audit:[]})});
 await transaction.apply(service.dnsOperation(zoneId,null,{type:'A',name:'saas.alpha.example',content:'6.6.6.6',ttl:1,proxied:true,comment:'checkpoint'},'回退源 DNS'));
 process.send({ready:true});setInterval(()=>{},60000);
}else if(['pending-update','pending-rollback'].includes(process.argv[4])){
 const zoneId='a'.repeat(32);journal.acquireScope('local-account',zoneId);
 const id=journal.begin('local-account',{zoneId,zoneName:'alpha.example',accessDomain:'cdn.alpha.example'});
 const before=(await service.listRawDnsRecords(zoneId)).find(r=>r.name==='cdn.alpha.example');
 const operation=service.dnsOperation(zoneId,before,{type:'CNAME',name:before.name,content:'changed.example',ttl:1,proxied:false,comment:'checkpoint'},'访问域名 DNS');
 const snapshot={steps:[{type:operation.type,zoneId,label:operation.label,before,expected:operation.expected,creationBody:operation.creationBody,confirmed:false,status:'pending'}],audit:[]};
 journal.save(id,'local-account',snapshot);const result=await operation.write();
 if(process.argv[4]==='pending-rollback'){
  snapshot.steps[0].expected=result.result;snapshot.steps[0].confirmed=true;snapshot.steps[0].status='rollback_pending';
  journal.save(id,'local-account',snapshot);await operation.restore(result.result);
 }
 process.send({ready:true});setInterval(()=>{},60000);
}else await service.deploy('a'.repeat(32),{zoneName:'alpha.example',accessDomain:'cdn.alpha.example',targetDomain:'origin.alpha.example',optimizedDomain:'saas.sin.fan'});
