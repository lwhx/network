import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { SqliteStore } from '../src/services/sqlite-store.js';
import { SpeedTaskStore } from '../src/services/speed-task-store.js';
import { SpeedDeployService } from '../src/services/cloudflare/speed-deploy-service.js';
import { CloudflareClient } from '../src/services/cloudflare/cloudflare-client.js';
import { DnsRecordsService } from '../src/services/cloudflare/dns-records-service.js';
import { createSpeedCloudflareMock } from './helpers/speed-cloudflare-mock.js';
const zoneId = 'a'.repeat(32);
const input = {zoneName:'alpha.example',accessDomain:'cdn.alpha.example',targetDomain:'origin.alpha.example',optimizedDomain:'saas.sin.fan'};
const origin = {id:'d'.repeat(32),type:'A',name:input.targetDomain,content:'192.0.2.10',ttl:300,proxied:false,tags:[]};
async function setup(t, options={}) {
 const dir=mkdtempSync(join(tmpdir(),'speed-task-')); const databasePath=join(dir,'tasks.db');
 const sqlite = new SqliteStore({databasePath,secretKey:'test-key'}); t.after(()=>sqlite.close());
 const account = sqlite.createCloudflareAccount({email:'test@example.com',globalApiKey:'secret-key',name:'Recovery fixture'});
 sqlite.database.prepare('UPDATE cloudflare_accounts SET id=? WHERE id=?').run('local-account',account.id);
 const journal = new SpeedTaskStore({store:sqlite});
 const mock = createSpeedCloudflareMock({dnsRecords:[origin],...options});mock.server.listen(0,'127.0.0.1'); await once(mock.server,'listening');
 t.after(()=>{mock.server.closeAllConnections();mock.server.close();});
 const apiBaseUrl=`http://127.0.0.1:${mock.server.address().port}`;
 const client=new CloudflareClient({apiBaseUrl,email:'test@example.com',globalApiKey:'secret-key',requestTimeoutMs:3000});
 // Legacy client can be used by this test while the root integrates scoped accountId.
 client.getCredentials=()=>({accountId:'local-account',email:'test@example.com',globalApiKey:'secret-key'});
 const service=new SpeedDeployService({cloudflareClient:client,dnsRecordsService:new DnsRecordsService({cloudflareClient:client}),speedTaskStore:journal});
 return {...mock,sqlite,journal,service,client,databasePath,apiBaseUrl};
}
test('completed deployments are encrypted, scoped, and never offered for rollback',async t=>{
 const env=await setup(t); const result=await env.service.deploy(zoneId,input);
 assert.ok(result.taskId);const tasks=env.service.listTasks(); assert.equal(tasks[0].status,'completed');
 assert.equal(JSON.stringify(tasks).includes('secret-key'),false);
 assert.equal(env.sqlite.database.prepare('SELECT snapshot FROM speed_tasks').get().snapshot.startsWith('enc:v1:'),true);
 await assert.rejects(env.service.recoverTask(result.taskId),e=>e.statusCode===409);
 env.client.getCredentials=()=>({accountId:'different',email:'test@example.com',globalApiKey:'secret-key'});
 assert.deepEqual(env.service.listTasks(),[]);await assert.rejects(env.service.inspectTask(result.taskId),e=>e.statusCode===404);
});
test('captured credentials cannot create an orphan task after the saved account is deleted',async t=>{
 const env=await setup(t);
 env.sqlite.deleteCloudflareAccount('local-account');
 await assert.rejects(env.service.deploy(zoneId,input),e=>e.statusCode===404);
 assert.equal(env.sqlite.database.prepare('SELECT COUNT(*) AS count FROM speed_tasks').get().count,0);
 assert.equal(env.requests.length,0);
});
test('a compensation DELETE returning HTTP 500 remains uncertain after an original-state read',async t=>{
 const env=await setup(t,{intercept({call,apply,send}){if(call.method==='DELETE'){apply();send(null,500);return true;}return false;}});
 await env.service.deploy(zoneId,input);
 const record=env.state.dnsRecords.find(r=>r.name==='cdn.alpha.example');
 env.journal.acquireScope('local-account',zoneId);
 const id=env.journal.begin('local-account',{zoneId,zoneName:input.zoneName,accessDomain:input.accessDomain});
 env.journal.save(id,'local-account',{steps:[{type:'dns',zoneId,label:'访问域名 DNS',before:null,expected:record,
   creationBody:{type:record.type,name:record.name,content:record.content,ttl:record.ttl,proxied:record.proxied,comment:record.comment},confirmed:true,status:'confirmed'}],audit:[]},{status:'manual_needed'});
 const task=await env.service.recoverTask(id);
 assert.equal(task.status,'manual_needed');
 assert.equal(task.rollback.status,'incomplete');
 assert.equal(task.steps[0].status,'rollback_pending');
 await assert.rejects(env.service.deploy(zoneId,input),e=>e.statusCode===409);
});
test('an old managed-domain deletion cannot write after another worker reclaims its scope',async t=>{
 let paused=false,enter,release;const started=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const env=await setup(t,{async intercept({call}){if(paused&&call.method==='GET'&&call.path.endsWith('/dns_records')){enter();await gate;}return false;}});
 await env.service.deploy(zoneId,input);
 env.journal.owner=JSON.stringify({...JSON.parse(env.journal.owner),namespace:'pid:[foreign-fixture]'});
 paused=true;const deleting=env.service.deleteManagedDomain(zoneId,input.accessDomain);await started;
 env.sqlite.database.prepare('UPDATE speed_task_locks SET lease_until=0').run();
 const other=new SpeedTaskStore({store:env.sqlite});other.acquireScope('local-account',zoneId);
 other.begin('local-account',{zoneId,zoneName:input.zoneName,accessDomain:input.accessDomain});
 release();await assert.rejects(deleting,e=>e.statusCode===409);
 assert.equal(env.requests.filter(call=>call.method==='DELETE').length,0);
});
test('an uncertain managed-domain DELETE is journaled and blocks new deployments',async t=>{
 const env=await setup(t,{intercept({call,apply,send}){if(call.method==='DELETE'){apply();send(null,500);return true;}return false;}});
 await env.service.deploy(zoneId,input);
 await assert.rejects(env.service.deleteManagedDomain(zoneId,input.accessDomain),e=>Boolean(e.taskId)&&e.summary?.unknown===1);
 const pending=env.service.listTasks().find(task=>task.kind==='deletion'&&task.status==='manual_needed');
 assert.ok(pending);assert.equal(pending.steps[0].status,'pending');
 await assert.rejects(env.service.deploy(zoneId,input),e=>e.statusCode===409);
 const inspected=await env.service.inspectTask(pending.id);
 assert.equal(inspected.steps[0].classification,'unknown_write');
});
test('another SQLite connection cannot invalidate or interleave an active deployment',async t=>{
 let release,entered;const gate=new Promise(r=>release=r);const started=new Promise(r=>entered=r);
 const env=await setup(t,{async intercept({call}){if(call.method==='POST'&&call.body?.name==='saas.alpha.example'){entered();await gate;}return false;}});
 const deployment=env.service.deploy(zoneId,input);await started;
 const sqlite2=new SqliteStore({databasePath:env.databasePath,secretKey:'test-key'});t.after(()=>sqlite2.close());
 const service2=new SpeedDeployService({cloudflareClient:env.client,dnsRecordsService:env.service.dnsRecordsService,speedTaskStore:new SpeedTaskStore({store:sqlite2})});
 try{assert.equal(service2.listTasks()[0].status,'running');await assert.rejects(service2.deploy(zoneId,input),e=>e.statusCode===409);await assert.rejects(service2.recoverTask(service2.listTasks()[0].id),e=>e.statusCode===409);}finally{release();await deployment;}
});
test('kill during a confirmed step restores it, leaves the pending write manual, and startup performs no writes',async t=>{
 let entered;const blocked=new Promise(r=>entered=r);
 const env=await setup(t,{async intercept({call}){if(call.method==='PUT'){entered();return true;}return false;}});
 const child=spawn(process.execPath,['test/helpers/speed-task-child.js',env.databasePath,env.apiBaseUrl],{stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',b=>errors+=b);t.after(()=>child.kill('SIGKILL'));
 await Promise.race([blocked,once(child,'exit').then(()=>{throw new Error(errors);})]);
 child.kill('SIGKILL');await once(child,'exit');const writes=env.requests.filter(x=>x.method!=='GET').length;
 const second=new SpeedTaskStore({store:env.sqlite}); assert.equal(env.requests.filter(x=>x.method!=='GET').length,writes);
 const task=env.service.listTasks()[0];assert.equal(task.status,'manual_needed');
 const inspected=await env.service.inspectTask(task.id);assert.ok(inspected.steps.some(x=>x.classification==='applied'));assert.equal(env.requests.filter(x=>x.method!=='GET').length,writes);
 const result=await env.service.recoverTask(task.id);assert.equal(result.status,'manual_needed');assert.equal(result.rollback.status,'incomplete');
 assert.deepEqual(env.state.dnsRecords,[origin]);assert.equal(second.list('local-account')[0].status,'manual_needed');
 await assert.rejects(env.service.deploy(zoneId,input),e=>e.statusCode===409);
 await assert.rejects(env.service.deleteManagedDomain(zoneId,input.accessDomain),e=>e.statusCode===409);
 await env.service.inspectTask(task.id);const acknowledged=env.service.resolveManualTask(task.id);assert.equal(acknowledged.status,'manual_resolved');
});
test('lost create response does not establish ownership from a matching record',async t=>{
 let failed=false;const env=await setup(t,{intercept({call,apply,disconnect}){if(!failed&&call.method==='POST'){failed=true;apply();disconnect();return true;}return false;}});
 await assert.rejects(env.service.deploy(zoneId,input),e=>Boolean(e.taskId)&&e.rollback.status==='incomplete');
 assert.equal(env.state.dnsRecords.length,2);const task=env.service.listTasks()[0];await env.service.inspectTask(task.id);
 const recovered=await env.service.recoverTask(task.id);assert.equal(recovered.status,'manual_needed');assert.equal(env.state.dnsRecords.length,2);
});
test('recovery preserves external DNS edits and replacement identity after a real worker dies',async t=>{
 let entered;const blocked=new Promise(r=>entered=r);
 const env=await setup(t,{async intercept({call}){if(call.method==='PUT'){entered();return true;}return false;}});
 const child=spawn(process.execPath,['test/helpers/speed-task-child.js',env.databasePath,env.apiBaseUrl],{stdio:['ignore','ignore','pipe']});t.after(()=>child.kill('SIGKILL'));
 await Promise.race([blocked,once(child,'exit').then(()=>{throw new Error('worker exited before checkpoint');})]);child.kill('SIGKILL');await once(child,'exit');
 const task=env.service.listTasks()[0];const record=env.state.dnsRecords.find(x=>x.name==='saas.alpha.example');
 record.id='replacement-id';record.comment='externally replaced';
 const before=structuredClone(env.state);const inspection=await env.service.inspectTask(task.id);
 assert.equal(inspection.steps[0].classification,'external_change');
 const recovered=await env.service.recoverTask(task.id);assert.equal(recovered.status,'manual_needed');assert.deepEqual(env.state,before);
 await assert.rejects(Promise.resolve().then(()=>env.service.resolveManualTask(task.id)),e=>e.statusCode===409);
 await env.service.inspectTask(task.id);env.service.resolveManualTask(task.id);assert.deepEqual(env.state,before);
});
test('edited metadata is encrypted, credential-shaped keys are excluded, and no raw fields leave inspection',async t=>{
 const hostname={id:'existing-host',hostname:input.accessDomain,custom_origin_server:'private-before.example',custom_metadata:{note:'private-customer-value',apiKey:'never-persist-me'},ssl:{method:'txt',type:'dv',settings:{min_tls_version:'1.3'}}};
 const env=await setup(t,{customHostnames:[hostname]});const result=await env.service.deploy(zoneId,input);
 const {snapshot}=env.journal.load(result.taskId,'local-account');const serialized=JSON.stringify(snapshot);
 assert.ok(serialized.includes('private-customer-value'));assert.equal(serialized.includes('never-persist-me'),false);
 const inspect=await env.service.inspectTask(result.taskId);assert.equal(JSON.stringify(inspect).includes('private-customer-value'),false);
 const raw=env.sqlite.database.prepare('SELECT * FROM speed_tasks').get();assert.equal(JSON.stringify(raw).includes('private-before.example'),false);assert.equal(JSON.stringify(raw).includes('private-customer-value'),false);
 assert.equal(env.journal.hasUnresolvedAccountTasks('local-account'),false);
 env.client.getCredentials=()=>({email:'test@example.com',globalApiKey:'secret-key'});
 assert.throws(()=>env.service.listTasks(),e=>e.statusCode===412);
});
test('a persisted confirmed checkpoint recovers exactly once and journals compensation before DELETE',async t=>{
 let env;let sawIntent=false;
 env=await setup(t,{intercept({call}){if(call.method==='DELETE'){const task=env.service.listTasks()[0];const {snapshot}=env.journal.load(task.id,'local-account');assert.equal(snapshot.steps[0].status,'rollback_pending');assert.equal(snapshot.audit.at(-1).action,'rollback_requested');sawIntent=true;}return false;}});
 const child=spawn(process.execPath,['test/helpers/speed-task-child.js',env.databasePath,env.apiBaseUrl,'confirmed-checkpoint'],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>child.kill('SIGKILL'));
 await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('checkpoint failed');})]);child.kill('SIGKILL');await once(child,'exit');
 const task=env.service.listTasks()[0];assert.equal(env.journal.hasUnresolvedAccountTasks('local-account'),true);
 await env.service.inspectTask(task.id);const recovered=await env.service.recoverTask(task.id);
 assert.equal(recovered.status,'rolled_back');assert.equal(recovered.rollback.status,'complete');assert.equal(sawIntent,true);
 assert.deepEqual(env.state.dnsRecords,[origin]);assert.equal(env.journal.hasUnresolvedAccountTasks('local-account'),false);
 const writeCount=env.requests.filter(x=>x.method!=='GET').length;
 await assert.rejects(env.service.recoverTask(task.id),e=>e.statusCode===409);assert.equal(env.requests.filter(x=>x.method!=='GET').length,writeCount);
});
for (const checkpoint of ['pending-update','pending-rollback']) test(`${checkpoint} remains uncertain even when current fields match an expected snapshot`,async t=>{
 const access={id:'e'.repeat(32),type:'CNAME',name:input.accessDomain,content:'old.example',ttl:300,proxied:false,comment:'original',tags:[]};
 const env=await setup(t,{dnsRecords:[origin,access]});
 const child=spawn(process.execPath,['test/helpers/speed-task-child.js',env.databasePath,env.apiBaseUrl,checkpoint],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>child.kill('SIGKILL'));
 await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('checkpoint failed');})]);child.kill('SIGKILL');await once(child,'exit');
 const task=env.service.listTasks()[0];const before=structuredClone(env.state);const inspection=await env.service.inspectTask(task.id);
 assert.equal(inspection.steps[0].classification,'unknown_write');const writes=env.requests.filter(x=>x.method!=='GET').length;
 const result=await env.service.recoverTask(task.id);assert.equal(result.status,'manual_needed');assert.deepEqual(env.state,before);assert.equal(env.requests.filter(x=>x.method!=='GET').length,writes);
 await assert.rejects(env.service.deploy(zoneId,input),e=>e.statusCode===409);
});
test('a foreign Docker PID namespace is not declared dead using local process lookup',async t=>{
 const env=await setup(t);env.journal.acquireScope('local-account',zoneId);const id=env.journal.begin('local-account',{zoneId,...input});
 const lock=env.sqlite.database.prepare('SELECT * FROM speed_task_locks WHERE task_id=?').get(id);const owner=JSON.parse(lock.owner);
 owner.namespace='foreign-pid-namespace';owner.pid=999999;owner.identity=(owner.identity||'unknown').split(':')[0]+':999999:0';
 env.sqlite.database.prepare('UPDATE speed_task_locks SET owner=? WHERE task_id=?').run(JSON.stringify(owner),id);
 assert.throws(()=>env.journal.claim(id,'local-account'),e=>e.statusCode===409);
 env.sqlite.database.prepare('UPDATE speed_task_locks SET lease_until=? WHERE task_id=?').run(Date.now()-1,id);
 assert.deepEqual(env.journal.claim(id,'local-account').steps,[]);
});
test('a successful creation response missing its identity cannot prove record ownership',async t=>{
 let malformed=false;const env=await setup(t,{intercept({call,apply,send}){if(!malformed&&call.method==='POST'){malformed=true;const resource=apply();const {id,...withoutId}=resource;send(withoutId);return true;}return false;}});
 await assert.rejects(env.service.deploy(zoneId,input),e=>e.rollback.status==='incomplete');
 assert.equal(env.service.listTasks()[0].status,'manual_needed');assert.equal(env.state.dnsRecords.length,2);
});
