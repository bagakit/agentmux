import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { terminalPromptPhaseOperationIdentity } from '../../src/prompt-submission-record.ts'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.ts'
const legacy=await import(process.env.AGENTMUX_INSTALLED_CORE_URL),root=process.env.AGENTMUX_SETTLEMENT_ROOT
assert.ok(root);await mkdir(root,{recursive:true})
const key={kind:'prompt',agentSessionId:'sid',expectedRun:{runId:'run'},submissionId:'original-input'},text='Original immutable input 原文'
const plan={kind:'native-rpc',protocolId:'original-contract',sourceId:'original-source',actorId:'original-actor',threadId:'original-thread',operation:'start-or-steer'}
const session={kind:'agent',agentSessionId:'sid',hostId:'local',providerId:'codex',executorId:'proof',hookBindingId:'synthetic-binding',hookToken:'synthetic-token',workspacePath:root,run:key.expectedRun,retiredRuns:[],createdAt:1,updatedAt:1,
 promptCompletionAdmission:{transport:'native',operationId:key.submissionId,submissionId:key.submissionId,inputKey:key,acknowledged:false,native:{plan,outcome:'unknown'},intent:{run:key.expectedRun,ownerInstanceId:'original-producer',prompt:text,message:{userContent:text},plan,admissionIntent:{kind:'session-conversation',expectedRun:key.expectedRun},execution:'immediate'}}}
const dump=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return{version:Number(db.prepare('PRAGMA user_version').get().user_version),schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>[row.name,db.prepare('SELECT * FROM '+row.name+' ORDER BY rowid').all()]))}}finally{db.close()}}
const rows=[]
for(const version of [1,2,3]){
 const path=join(root,'v'+version+'.sqlite'),old=new legacy.AgentMuxFileAgentSessionStore(path)
 await old.compareAndSwap(null,structuredClone(session));const seed=dump(path);assert.equal(seed.version,1,'fixture is created by actual installed v1 owner')
 const current=new AgentMuxFileAgentSessionStore(path)
 if(version!==1){const before=await current.readMetadata('sid');await current.compareAndSwapMetadata(before,{...before,updatedAt:before.updatedAt+1});assert.equal(dump(path).version,2,'ordinary write retains creation owner schema upgrade')}
 // Deliberate acknowledged-v3 namespace gap: ACK metadata repair must not rebuild or downgrade its roles.
 if(version===3){const db=new DatabaseSync(path);db.exec('PRAGMA user_version=3');db.close()}
 const before=dump(path),record=await current.readPromptAdmission('sid',key.expectedRun,key.submissionId);assert.ok(record?.admission)
 const next=structuredClone(record);next.admission.acknowledged=true;next.admission.native.outcome='admitted';next.admission.native.turnId='original-admitted-turn'
 await current.withPromptSubmission('sid',()=>current.settlePromptAdmission(record,next))
 const actual=await new AgentMuxFileAgentSessionStore(path).readPromptAdmission('sid',key.expectedRun,key.submissionId)
 assert.deepEqual(actual,next,'complete original ACK survives independent current owner read')
 const after=dump(path);assert.equal(after.version,version,'settlement must not change the unrelated creation schema generation');assert.deepEqual(after.schema,before.schema,'settlement creates no unrelated table or index')
 for(const [name,value]of Object.entries(before.tables))if(!['sessions','prompt_admissions'].includes(name))assert.deepEqual(after.tables[name],value,'all unrelated tables remain exact: '+name)
 const projection=await current.readMetadata('sid');assert.equal(projection.promptCompletionAdmission.acknowledged,true);assert.equal(projection.promptCompletionAdmission.native.outcome,'admitted')
 if(version===1){const oldAgain=new legacy.AgentMuxFileAgentSessionStore(path);assert.deepEqual(await oldAgain.readPromptAdmission('sid',key.expectedRun,key.submissionId),next,'the actual installed reader continues reading the complete original ACK');assert.equal((await oldAgain.readMetadata('sid')).promptCompletionAdmission.acknowledged,true)}
 const wrong=structuredClone(next);wrong.admission.intent.prompt='replacement';await assert.rejects(()=>current.settlePromptAdmission(next,wrong),'receipt settlement cannot replace its original claim')
 rows.push({version,fullOriginalACK:true,unrelatedSchemaAndTablesUnchanged:true,installedReader:version===1})
}
// The installed owner retires the exact v1 input before settlement. No Runtime or producer is constructed.
const retiredPath=join(root,'retired-pty.sqlite'),retiredOld=new legacy.AgentMuxFileAgentSessionStore(retiredPath)
const ptyPlan={kind:'render-then-submit',payload:text,renderedText:text,submit:'\r'}
const phase=(name,data,start)=>({operationId:terminalPromptPhaseOperationIdentity(session,key.submissionId,name,data),inputByteRange:{startByte:start,endByte:start+Buffer.byteLength(data)},acknowledged:true})
const payload=phase('payload',text,10),submit=phase('submit','\r',payload.inputByteRange.endByte)
const damaged={...structuredClone(session),promptCompletionAdmission:{operationId:payload.operationId,submissionId:key.submissionId,inputKey:key,startByte:10,endByte:submit.inputByteRange.endByte,acknowledged:true,intent:{run:key.expectedRun,ownerInstanceId:'original-producer',prompt:text,plan:ptyPlan,message:{userContent:text},execution:'immediate'}}}
await retiredOld.compareAndSwap(null,damaged)
const reservation={kind:'stop',agentSessionId:'sid',expectedRun:key.expectedRun,reservationId:'test-retirement',ownerId:'test-owner',ownerPid:process.pid,expiresAt:Date.now()+30000,operationId:'original-stop',stopOperation:{daemonInstance:'test-no-runtime',operationKey:'original-stop',runId:'run'}}
await retiredOld.reserveLifecycle(reservation);await retiredOld.commitLifecycle(reservation,null)
const retiredBefore=dump(retiredPath),retiredStore=new AgentMuxFileAgentSessionStore(retiredPath),originalRetirement=await retiredStore.readRetiredAgentSession('sid'),retiredRecord=await retiredStore.readPromptAdmission('sid',key.expectedRun,key.submissionId)
assert.equal(retiredBefore.version,1,'retirement fixture is created solely by installed v1 owner')
const restored=structuredClone(retiredRecord);restored.terminalPromptSubmission={run:key.expectedRun,submissionId:key.submissionId,promptDigest:createHash('sha256').update(text).digest('base64url'),outputCursorBytes:1,payload,submit}
await retiredStore.withPromptSubmission('sid',()=>retiredStore.settlePromptAdmission(retiredRecord,restored))
assert.deepEqual(await retiredStore.readPromptAdmission('sid',key.expectedRun,key.submissionId),restored,'retired original terminal ACK is complete')
assert.equal(await retiredStore.readMetadata('sid'),null,'settlement cannot reactivate retirement')
assert.deepEqual(await retiredStore.readRetiredAgentSession('sid'),originalRetirement,'retirement remains exact')
const retiredAfter=dump(retiredPath);assert.equal(retiredAfter.version,1);assert.deepEqual(retiredAfter.schema,retiredBefore.schema)
for(const [name,value]of Object.entries(retiredBefore.tables))if(name!=='prompt_admissions')assert.deepEqual(retiredAfter.tables[name],value,'retired settlement only updates its original independent row: '+name)
const child=spawnSync(process.execPath,['--input-type=module','-e',`import {readFileSync} from 'node:fs';const legacy=await import(process.env.AGENTMUX_INSTALLED_CORE_URL);const store=new legacy.AgentMuxFileAgentSessionStore(process.env.AMUX_SETTLEMENT_DB);console.log(JSON.stringify({record:await store.readPromptAdmission('sid',{runId:'run'},'original-input'),metadata:await store.readMetadata('sid'),retired:await store.readRetiredAgentSession('sid')}))`],{encoding:'utf8',env:{...process.env,AMUX_SETTLEMENT_DB:retiredPath}})
assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{record:restored,metadata:null,retired:originalRetirement},'independent installed process reads complete retired ACK without producer authority')
const ordinaryPath=join(root,'ordinary.sqlite'),old=new legacy.AgentMuxFileAgentSessionStore(ordinaryPath);await old.compareAndSwap(null,{...structuredClone(session),agentSessionId:'ordinary',run:{runId:'ordinary-run'},promptCompletionAdmission:undefined})
const store=new AgentMuxFileAgentSessionStore(ordinaryPath),before=await store.readMetadata('ordinary');await store.compareAndSwapMetadata(before,{...before,updatedAt:before.updatedAt+1})
assert.equal(dump(ordinaryPath).version,2,'ordinary writes must still initialize the original creation owner')
console.log('INPUT_SETTLEMENT_FORMAT_PASS:'+JSON.stringify({rows,retiredPtyOriginalOnly:true,installedIndependentProcess:true,acknowledgedV3GapDoesNotRebuild:true,ordinaryCreationUpgrade:true,nativeCalls:0,productionWrites:0}))
