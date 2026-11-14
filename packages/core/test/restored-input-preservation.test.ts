import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, link, readFile, rename } from 'node:fs/promises'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { retiredReopenFixture } from './fixtures/retired-reopen.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { agentPromptCondition, validateAgentPromptAdmissionIntent, validateAgentPromptInputBinding } from '../src/agent-prompt-condition.js'
import { withAgentInputClaimLease, bindAgentInputClaimStore } from '../src/agent-input-claim-lease.js'
import * as sessionDatabaseOwner from '../src/agent-session-database.js'
import { readCurrentSessionDatabase } from '../src/agent-session-database.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { inspectPromptInSecondProcess } from './helpers/prompt-receipt-process.js'
it('Memory lifecycle commits retain the original cut through resume, retirement and reopen', async () => {
 const store=new AgentMuxMemoryAgentSessionStore(),run={runId:'old-run'}
 const seed={kind:'agent' as const,agentSessionId:'memory-original',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:'/synthetic',run,retiredRuns:[],hookBindingId:'hook',hookToken:'synthetic',createdAt:1,updatedAt:1,inputEpoch:'synthetic-restored-cut',inputRestoration:{operationId:'original-restore',sourceSHA256:'a'.repeat(64),reason:'restored-snapshot' as const}}
 await store.compareAndSwap(null,seed)
 const claim={reservationId:'resume-reservation',ownerId:'synthetic-owner',ownerPid:process.pid,expiresAt:Date.now()+10000}
 const resume={...claim,kind:'resume' as const,agentSessionId:seed.agentSessionId,operationId:'resume',expectedRun:run}
 await store.reserveLifecycle(resume)
 const {inputEpoch:_epoch,inputRestoration:_source,...withoutEpoch}=seed
 const next={...withoutEpoch,run:{runId:'new-run'},retiredRuns:[run]}
 await store.commitLifecycle(resume,next)
 expect((await store.readMetadata(seed.agentSessionId))?.inputEpoch).toBe(seed.inputEpoch)
 const stop={...claim,reservationId:'stop-reservation',kind:'stop' as const,agentSessionId:seed.agentSessionId,operationId:'stop',expectedRun:next.run,stopOperation:{daemonInstance:'synthetic',operationKey:'stop',runId:next.run.runId}}
 await store.reserveLifecycle(stop);await store.commitLifecycle(stop,null)
 const retired=(await store.readRetiredAgentSession(seed.agentSessionId))!
 expect(retired.history?.inputEpoch).toBe(seed.inputEpoch)
 const reopen={...claim,reservationId:'reopen-reservation',kind:'reopen' as const,agentSessionId:seed.agentSessionId,operationId:'reopen',expectedRetirement:retired}
 await store.reserveLifecycle(reopen)
 await store.commitLifecycle(reopen,{...withoutEpoch,run:{runId:'reopened-run'},retiredRuns:[next.run],reopenedFrom:{run:next.run,source:'user',observedAt:retired.observedAt}})
 expect((await store.readMetadata(seed.agentSessionId))?.inputEpoch).toBe(seed.inputEpoch)
})

it('reads a restored namespace even with no active SID, through the real public reader and source CLI', async () => {
 const h=await rpcOwnerFixture(['recipient'])
 const server=new AgentMuxControlServer({socketPath:join(h.root,'epoch.sock'),coreClients:h.coreClients})
 try {
  expect(await h.client.readAgentInputEpoch()).toBeUndefined()
  const current=(await h.store.readMetadata('recipient'))!
  const stop={kind:'stop' as const,agentSessionId:'recipient',expectedRun:current.run,reservationId:'epoch-retire',ownerId:'synthetic',ownerPid:process.pid,expiresAt:Date.now()+10000,operationId:'epoch-retire',stopOperation:{daemonInstance:'synthetic',operationKey:'epoch-retire',runId:current.run.runId}}
  await h.store.reserveLifecycle(stop);await h.store.commitLifecycle(stop,null)
  const snapshot=join(h.root,'retired-cut.sqlite'),incarnation=await cut(h.store.path,snapshot)
  const prepared=await h.store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(h.root,'stage'),operationId:'restore-empty-active',expectedIncarnation:incarnation})
  if(prepared.state!=='prepared')throw new Error('Expected candidate')
  await rename(prepared.file,h.store.path)
  expect(await h.store.loadMetadata()).toEqual([])
  await expect(h.store.readInputEpoch()).resolves.toBe(prepared.inputEpoch)
  await server.start()
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  try {expect(await rpc.call('agent.input.epoch',{hostId:'local'})).toEqual({hostId:'local',inputEpoch:prepared.inputEpoch})} finally {await rpc.dispose()}
  const loader=fileURLToPath(new URL('./helpers/prompt-receipt-source-loader.mjs',import.meta.url)),cli=fileURLToPath(new URL('../src/agentmux.ts',import.meta.url))
  const output=await promisify(execFile)(process.execPath,['--no-warnings','--experimental-loader',loader,cli,'--endpoint','unix://'+server.path,'agent','input','epoch','--host','local'],{env:process.env})
  expect(JSON.parse(output.stdout)).toMatchObject({ok:true,result:{hostId:'local',inputEpoch:prepared.inputEpoch}})
  const db=new DatabaseSync(h.store.path);db.exec('DROP TABLE input_namespace; ALTER TABLE identity DROP COLUMN input_restore_schema');db.close()
  await expect(h.store.readInputEpoch()).rejects.toMatchObject({code:'INVALID_AGENT_SESSION_STORE'})
 } finally {await server.stop();await h.close()}
})

it('the actual retired reopen and stop consumers retain the original namespace epoch across Runs', async () => {
 const f=await retiredReopenFixture('codex')
 try {
  const snapshot=join(f.root,'retired-cut.sqlite'),incarnation=await cut(f.storePath,snapshot)
  const prepared=await f.store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(f.root,'stage'),operationId:'restore-lifecycle',expectedIncarnation:incarnation})
  if(prepared.state!=='prepared')throw new Error('Expected candidate')
  await rename(prepared.file,f.storePath)
  const opened=await f.client.reopenAgent(f.input)
  expect(opened.inputEpoch).toBe(prepared.inputEpoch)
  expect(f.client.agentSession(opened.agentSessionId).inputEpoch).toBe(prepared.inputEpoch)
  f.inner.kernel.status.mockImplementation(async (id:string)=>({...f.run(id,false),lifecycleOperationId:f.starts[0]?.operationKey ?? null}))
  await f.client.stopAgent(opened.agentSessionId,opened.run)
  const retired=(await f.store.readRetiredAgentSession(opened.agentSessionId))!
  expect(retired.history?.inputEpoch).toBe(prepared.inputEpoch)
  expect(retired.history?.inputRestoration?.operationId).toBe('restore-lifecycle')
  const again=await f.client.reopenAgent({agentSessionId:opened.agentSessionId,expectedRetiredAt:retired.observedAt,operationId:'explicit-reopen-again'})
  expect(again.inputEpoch).toBe(prepared.inputEpoch)
  expect(f.starts).toHaveLength(2);expect(f.inner.kernel.input).not.toHaveBeenCalled()
 } finally {await f.close()}
})

it('freezes a new future activation while an old activation stays unknown and cancellation remains available', async () => {
 const h=await rpcOwnerFixture(['recipient'])
 try {
  const snapshot=join(h.root,'cut.sqlite'),incarnation=await cut(h.store.path,snapshot)
  const prepared=await h.store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(h.root,'stage'),operationId:'restore-future',expectedIncarnation:incarnation})
  if(prepared.state!=='prepared')throw new Error('Expected candidate')
  await rename(prepared.file,h.store.path)
  await Reflect.get(h.client,'registry').refresh('recipient',{runId:'run-recipient'})
  const intent={agentSessionId:'recipient',intentId:'future',operationId:'future-original',prompt:'synthetic-future',active:true}
  await expect(h.client.saveAgentFuturePromptIntent(intent)).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  await h.client.saveAgentFuturePromptIntent({...intent,inputEpoch:prepared.inputEpoch})
  expect(await h.client.readAgentFuturePromptIntent('recipient','future')).toMatchObject({inputEpoch:prepared.inputEpoch,active:true})
  await h.client.saveAgentFuturePromptIntent({...intent,active:false})
  expect(await h.client.readAgentFuturePromptIntent('recipient','future')).toMatchObject({inputEpoch:prepared.inputEpoch,active:false})
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
 } finally {await h.close()}
})

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}) })
async function root() { const value=await mkdtemp(join(tmpdir(),'amux-restored-input-')); roots.push(value); return value }
async function cut(path: string, target: string) { const db=(await readCurrentSessionDatabase(path,{readOnly:true}))!; try { await backup(db,target); return String(db.prepare('SELECT incarnation FROM identity').get()!.incarnation) } finally { db.close() } }

it('preserves old absence and freezes epoch in exact and all directed bindings', () => {
  const run={runId:'run'}
  expect(agentPromptCondition({run})).toEqual({expectedRun:run,afterSubmissionId:null})
  expect(agentPromptCondition({run,inputEpoch:'restored'})).toEqual({expectedRun:run,afterSubmissionId:null,inputEpoch:'restored'})
  for(const kind of ['manual-actor','session-conversation','native-conversation'] as const) {
    const admissionIntent=kind==='native-conversation'?{kind,source:{providerId:'codex',nativeSessionId:'native'}}:{kind}
    expect(validateAgentPromptInputBinding({expectedRun:run,inputEpoch:'restored',admissionIntent})).toEqual({expectedRun:run,inputEpoch:'restored',admissionIntent})
    expect(validateAgentPromptAdmissionIntent({...admissionIntent,expectedRun:run,inputEpoch:'restored'})).toEqual({...admissionIntent,expectedRun:run,inputEpoch:'restored'})
  }
})

it('stages the full original SQLite cut without changing live/source claims or private tables', async () => {
 const r=await root(), store=new AgentMuxFileAgentSessionStore(join(r,'live.sqlite'))
 const original={kind:'agent' as const,agentSessionId:'original',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:r,run:{runId:'same-run'},retiredRuns:[],hookBindingId:'hook',hookToken:'synthetic',createdAt:1,updatedAt:1}
 await store.compareAndSwap(null,original)
 const db=new DatabaseSync(store.path);db.exec("CREATE TABLE private_original(body TEXT); INSERT INTO private_original VALUES ('synthetic-private')");db.close()
 const snapshot=join(r,'cut.sqlite'), incarnation=await cut(store.path,snapshot)
 const before=await readFile(snapshot), liveBefore=await store.readMetadata(original.agentSessionId)
 const prepared=await store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(r,'stage'),operationId:'restore-original',expectedIncarnation:incarnation})
 expect(prepared.state).toBe('prepared'); if(prepared.state!=='prepared')throw new Error('Expected held candidate')
 expect(await readFile(snapshot)).toEqual(before);expect(await store.readMetadata(original.agentSessionId)).toEqual(liveBefore)
 const staged=new AgentMuxFileAgentSessionStore(prepared.file), current=(await staged.readMetadata(original.agentSessionId))!
 expect(current.inputEpoch).toBe(prepared.inputEpoch);expect(current.inputRestoration).toEqual({operationId:'restore-original',sourceSHA256:prepared.sourceSHA256,reason:'restored-snapshot'})
 const privateDb=new DatabaseSync(prepared.file,{readOnly:true});try{expect(privateDb.prepare('PRAGMA user_version').get()?.user_version).toBe(3);expect(privateDb.prepare('SELECT body FROM private_original').get()?.body).toBe('synthetic-private')}finally{privateDb.close()}
 const {inputEpoch:_epoch,inputRestoration:_source,...dropped}=current
 await staged.compareAndSwapMetadata(current,dropped);expect((await staged.readMetadata(original.agentSessionId))?.inputEpoch).toBe(prepared.inputEpoch)
 await expect(staged.compareAndSwapMetadata((await staged.readMetadata(original.agentSessionId))!,{...current,inputEpoch:'another'})).rejects.toMatchObject({code:'INVALID_AGENT_SESSION_STORE'})
 const damaged=new DatabaseSync(prepared.file);damaged.exec("UPDATE input_namespace_cuts SET operation_id='different-original-operation'");damaged.close()
 await expect(staged.readInputEpoch()).rejects.toMatchObject({code:'INVALID_AGENT_SESSION_STORE'});expect((await staged.readMetadata(original.agentSessionId))?.agentSessionId).toBe(original.agentSessionId)
})

it('rejects a cut-external old Client input while fresh independent input and old inspect stay available', async () => {
 const h=await rpcOwnerFixture(['recipient'])
 let restored: Awaited<ReturnType<typeof rpcOwnerFixture<AgentMuxClient, AgentMuxFileAgentSessionStore>>> | undefined
 try {
  const original=(await h.store.readMetadata('recipient'))!, stale={agentSessionId:'recipient',operationId:'after-cut',prompt:'synthetic-old',...agentPromptCondition(original),execution:'immediate' as const}
  const snapshot=join(h.root,'cut.sqlite'), incarnation=await cut(h.store.path,snapshot)
  await h.client.submitAgentPrompt(stale)
  expect(await h.store.readPromptAdmission('recipient',original.run,'after-cut')).not.toBeNull()
  const target=join(h.root,'restored.sqlite'), owner=new AgentMuxFileAgentSessionStore(target)
  const prepared=await owner.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(h.root,'stage'),operationId:'restore-incident',expectedIncarnation:incarnation})
  if(prepared.state!=='prepared')throw new Error('Expected safe source')
  await link(prepared.file,target)
  class RestoredStore extends AgentMuxFileAgentSessionStore { constructor(_path:string){super(target)} }
  restored=await rpcOwnerFixture([], {AgentMuxClient,AgentMuxFileAgentSessionStore:RestoredStore})
  const observed=restored
  restored.inner.kernel.status=vi.fn(async (id:string)=>({...observed.run(id),workspacePath:original.workspacePath}))
  await expect(restored.client.submitAgentPrompt(stale)).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED',detail:'unknown'})
  await expect(restored.client.submitAgentPrompt({agentSessionId:'recipient',operationId:'old-directed',prompt:'old',expectedRun:original.run,admissionIntent:{kind:'manual-actor'},execution:'immediate'})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  expect(restored.inner.kernel.input).not.toHaveBeenCalled()
  expect(await restored.client.inspectAgentPromptSubmission({kind:'prompt',agentSessionId:'recipient',expectedRun:original.run,submissionId:'after-cut'})).toBeNull()
  const current=(await restored.store.readMetadata('recipient'))!
  expect(restored.client.agentSession('recipient').inputEpoch).toBe(prepared.inputEpoch)
  await restored.client.submitAgentPrompt({agentSessionId:'recipient',operationId:'fresh-independent',prompt:'synthetic-new',...agentPromptCondition(current),execution:'immediate'})
  expect(restored.inner.kernel.input).toHaveBeenCalled()
  const key={kind:'prompt' as const,agentSessionId:'recipient',expectedRun:original.run,submissionId:'fresh-independent'}
  const record=await restored.store.readPromptAdmission('recipient',original.run,key.submissionId)
  expect(record?.admission?.acknowledged).toBe(true)
  const cold=await inspectPromptInSecondProcess(h.root,key,target)
  expect(cold.readback.record).toEqual(record);expect(cold.readback.active.inputEpoch).toBe(prepared.inputEpoch);expect(cold.cli).toMatchObject({ok:true,result:{record}})
  await restored.client.submitAgentPrompt({agentSessionId:'recipient',operationId:'fresh-directed',prompt:'synthetic-directed',expectedRun:original.run,inputEpoch:prepared.inputEpoch,admissionIntent:{kind:'manual-actor'},execution:'immediate'})
  for(const value of Reflect.get(restored.client,'inputWaitingRecipients').values()) await value.pending
  expect((await restored.store.readPromptAdmission('recipient',original.run,'fresh-directed'))?.admission?.acknowledged).toBe(true)
 } finally {await restored?.close();await h.close()}
})

it('holds original journal waiting/continue and notifications, preserving new independent work', async () => {
 const r=await root(), queue=new DurableAgentMuxMessageQueue(join(r,'live.sqlite')), run={runId:'run-recipient'}
 const intent=(id:string)=>({key:{kind:'prompt' as const,agentSessionId:'recipient',expectedRun:run,submissionId:id},admissionIntent:{kind:'manual-actor' as const,expectedRun:run},execution:'immediate' as const,environment:{providerId:'codex',executorId:'codex'},source:{kind:'prompt' as const,prompt:'synthetic-'+id,authorHuman:true,recoveryAuthorization:'local-human' as const}})
 const old=(await queue.savePromptInput(intent('old-input')))!
 const claimStore=new AgentMuxMemoryAgentSessionStore();bindAgentInputClaimStore(queue,claimStore)
 const gated=(await queue.savePromptInput(intent('old-gate')))!
 const carrier={kind:'pty' as const,plan:{kind:'single-phase' as const,data:'synthetic-old-gate\r'}}
 await withAgentInputClaimLease(claimStore,queue.queueId,gated.intent.key,lease=>queue.authorizeInputDispatch(gated.control.ref,undefined,undefined,{lease,carrier}))
 const originalGate=(await queue.inspectInput({key:gated.intent.key}))!
 const peer=await queue.append({operationId:'old-peer',messageId:'old-mid',createdAt:1,sender:{kind:'agent-session',agentSessionId:'sender'},recipient:{kind:'agent-session',agentSessionId:'recipient'},threadId:'thread',correlationId:'correlation',replyTo:null,workspaceId:'workspace',senderSessionId:'sender',senderRunId:'sender-run',recipientSessionId:'recipient',recipientRunId:run.runId,body:'synthetic-peer'},{deliveryMode:'reference'})
 const sources=await queue.storageRecoverySource().capture(join(r,'cut'))
 const journal=sources.members.find(x=>x.id==='journal')!, mutex=sources.members.find(x=>x.id==='mutex')!
 const owner=new DurableAgentMuxMessageQueue(join(r,'missing.sqlite'))
 const prepared=await owner.prepareRecoveryRestore({sourcePath:journal.file,sourceMutexPath:mutex.file,stagingPath:join(r,'stage'),operationId:'restore-queue',expectedIncarnation:JSON.parse(sources.revision)[0]})
 const restored=new DurableAgentMuxMessageQueue(prepared.file)
 bindAgentInputClaimStore(restored,claimStore)
 await withAgentInputClaimLease(claimStore,restored.queueId,gated.intent.key,lease=>expect(restored.authorizeInputDispatch(originalGate.control.ref,undefined,undefined,{lease,carrier,continueOriginalGate:true})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'}))
 expect(await restored.inspectInput({key:gated.intent.key})).toEqual(originalGate)
 expect(await restored.inspectInput({key:old.intent.key})).toEqual(old)
 expect(await restored.readRestorablePromptInputs()).toEqual([])
 await expect(restored.authorizeInputDispatch(old.control.ref)).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED',detail:'unknown'})
 expect(await restored.pendingNotificationRecipients()).toEqual([])
 expect(await restored.prepareNotification({notificationId:'would-replay',agentSessionId:'recipient',condition:{expectedRun:run,afterSubmissionId:null},sourceRuns:[run.runId]})).toBeNull()
 const fresh=(await restored.savePromptInput(intent('fresh-input')))!
 expect((await restored.readRestorablePromptInputs()).map(x=>x.intent.key)).toEqual([fresh.intent.key])
 expect(await restored.authorizeInputDispatch(fresh.control.ref)).not.toBeNull()
 await expect(restored.prepareNotification({notificationId:'old-explicit',agentSessionId:'recipient',messageIds:[peer.messageId],condition:{expectedRun:run,afterSubmissionId:null}})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
 const after=new DurableAgentMuxMessageQueue(prepared.file)
 expect(await after.readRestorablePromptInputs()).toEqual([])
 expect(await after.inspectInput({key:old.intent.key})).toEqual(old)
 const freshPeer=await restored.append({operationId:'fresh-peer',messageId:'fresh-mid',createdAt:2,sender:{kind:'agent-session',agentSessionId:'sender'},recipient:{kind:'agent-session',agentSessionId:'recipient'},threadId:'thread',correlationId:'fresh-correlation',replyTo:null,workspaceId:'workspace',senderSessionId:'sender',senderRunId:'sender-run',recipientSessionId:'recipient',recipientRunId:run.runId,body:'synthetic-new-peer'},{deliveryMode:'reference'})
 expect(await restored.pendingNotificationRecipients()).toEqual(['recipient'])
 const newNotice=await restored.prepareNotification({notificationId:'new-notice',agentSessionId:'recipient',condition:{expectedRun:run,afterSubmissionId:null},sourceRuns:[run.runId]})
 expect(newNotice?.messageIds).toEqual([freshPeer.messageId])
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(AGENTMUX_|CTXMUX_)/u.test(key)))
 const loader=fileURLToPath(new URL('./helpers/prompt-receipt-source-loader.mjs',import.meta.url))
 const code=`import {DurableAgentMuxMessageQueue} from ${JSON.stringify(new URL('../src/agent-global-message-queue.ts',import.meta.url).href)}; const q=new DurableAgentMuxMessageQueue(process.argv[1]);console.log(JSON.stringify({pid:process.pid,old:await q.inspectInput({key:JSON.parse(process.argv[2])}),restorable:await q.readRestorablePromptInputs()}))`
 const cold=JSON.parse((await promisify(execFile)(process.execPath,['--no-warnings','--experimental-loader',loader,'--input-type=module','-e',code,prepared.file,JSON.stringify(old.intent.key)],{env})).stdout)
 expect(cold.pid).not.toBe(process.pid);expect(cold.old).toEqual(old);expect(cold.restorable).toEqual([])

})

it('preserves old initial/future recipes while holding them with an explicit original source', async () => {
 const r=await root(), store=new AgentMuxFileAgentSessionStore(join(r,'live.sqlite')), run={runId:'same-run'}
 const initialInput={input:{submissionId:'initial',prompt:'synthetic-initial'},prompt:'synthetic-initial',message:{userContent:'synthetic-initial'},digest:createHash('sha256').update('synthetic-initial').digest('base64url'),delivery:'post-launch' as const,lifecycleOperationId:'original-create',state:'prepared' as const,key:{kind:'prompt' as const,agentSessionId:'original',expectedRun:run,submissionId:'initial'}}
 const original={kind:'agent' as const,agentSessionId:'original',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:r,run,retiredRuns:[],hookBindingId:'hook',hookToken:'synthetic',createdAt:1,updatedAt:1,initialInput,creation:{createOperationId:'original-create',createdRun:run,initialPrompt:'unknown' as const,initialInputKey:initialInput.key},
  futurePromptIntents:{later:{operationId:'original-future',prompt:'synthetic-future',message:{userContent:'synthetic-future'},active:true}}}
 await store.compareAndSwap(null,original)
 const snapshot=join(r,'cut.sqlite'), incarnation=await cut(store.path,snapshot)
 const prepared=await store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(r,'stage'),operationId:'restore-hold',expectedIncarnation:incarnation})
 if(prepared.state!=='prepared')throw new Error('Expected safe post-launch hold')
 expect(prepared).toMatchObject({heldInitialInputs:1,heldFutureIntents:1})
 const staged=new AgentMuxFileAgentSessionStore(prepared.file), current=(await staged.load())[0] as typeof original
 expect(current.initialInput).toEqual({...initialInput,state:'unknown'})
 expect(current.futurePromptIntents?.later).toEqual({...original.futurePromptIntents.later,active:false})
 expect((await store.load())[0]).toEqual(original)
 expect(await staged.readPromptAdmission('original',run,'initial')).toBeNull()
})

it('reports an unsupported prepared lifecycle selector without publishing or inventing a terminal result', async () => {
 const r=await root(), store=new AgentMuxFileAgentSessionStore(join(r,'live.sqlite')),run={runId:'run'}
 const original={kind:'agent' as const,agentSessionId:'original',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:r,run,retiredRuns:[],hookBindingId:'hook',hookToken:'synthetic',createdAt:1,updatedAt:1}
 await store.compareAndSwap(null,original)
 const reservation={kind:'stop' as const,reservationId:'reservation',ownerId:'synthetic-owner',ownerPid:process.pid,agentSessionId:'original',operationId:'original-stop',expiresAt:Date.now()+10000,expectedRun:run,stopOperation:{daemonInstance:'synthetic',operationKey:'original-stop',runId:run.runId}}
 await store.reserveLifecycle(reservation)
 const baselineReservation=await store.readLifecycleReservation('original')
 const snapshot=join(r,'cut.sqlite'),incarnation=await cut(store.path,snapshot)
 const result=await store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(r,'stage'),operationId:'restore',expectedIncarnation:incarnation})
 expect(result).toEqual({state:'unavailable',selectors:[{agentSessionId:'original',operationId:'original-stop',reason:'prepared-lifecycle-hold-unavailable'}]})
 expect(await store.readLifecycleReservation('original')).toEqual(baselineReservation)
})

it('refuses foreign source incarnation and never overwrites an existing candidate', async () => {
 const r=await root(),store=new AgentMuxFileAgentSessionStore(join(r,'live.sqlite'))
 await store.compareAndSwap(null,{kind:'agent',agentSessionId:'original',providerId:'codex',executorId:'codex',hostId:'local',workspacePath:r,run:{runId:'run'},retiredRuns:[],hookBindingId:'hook',hookToken:'synthetic',createdAt:1,updatedAt:1})
 const snapshot=join(r,'cut.sqlite'),incarnation=await cut(store.path,snapshot)
 await expect(store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(r,'foreign'),operationId:'restore',expectedIncarnation:'foreign'})).rejects.toMatchObject({code:'STORAGE_RECOVERY_INVALID'})
 const params={sourcePath:snapshot,stagingPath:join(r,'stage'),operationId:'restore',expectedIncarnation:incarnation}
 const first=await store.prepareRecoveryRestore(params);expect(first.state).toBe('prepared')
 if(first.state!=='prepared')throw new Error('Expected candidate')
 const before=await readFile(first.file)
 await expect(store.prepareRecoveryRestore(params)).rejects.toMatchObject({code:'EEXIST'})
 expect(await readFile(first.file)).toEqual(before)
})

it('the actual Client cold waiting and same-gate continuation consumers cannot wake held journal work', async () => {
 const h=await rpcOwnerFixture(['recipient'])
 try {
  const queue=Reflect.get(h.client,'messageQueue') as DurableAgentMuxMessageQueue,run={runId:'run-recipient'}
  const saved=(id:string)=>queue.savePromptInput({key:{kind:'prompt',agentSessionId:'recipient',expectedRun:run,submissionId:id},admissionIntent:{kind:'manual-actor',expectedRun:run},execution:'immediate',environment:{providerId:'codex',executorId:'codex'},source:{kind:'prompt',prompt:'synthetic-original',authorHuman:true,recoveryAuthorization:'local-human'}})
  const waiting=(await saved('old-waiting'))!,gate=(await saved('old-gate'))!,carrier={kind:'pty' as const,plan:{kind:'single-phase' as const,data:'synthetic-original\r'}}
  await withAgentInputClaimLease(h.store,queue.queueId,gate.intent.key,lease=>queue.authorizeInputDispatch(gate.control.ref,undefined,undefined,{lease,carrier}))
  const before=(await queue.inspectInput({key:gate.intent.key}))!
  const source=await queue.storageRecoverySource().capture(join(h.root,'queue-cut'))
  const prepared=await queue.prepareRecoveryRestore({sourcePath:source.members.find(x=>x.id==='journal')!.file,sourceMutexPath:source.members.find(x=>x.id==='mutex')!.file,stagingPath:join(h.root,'queue-stage'),operationId:'restore-queue-consumers',expectedIncarnation:JSON.parse(source.revision)[0]})
  const restored=new DurableAgentMuxMessageQueue(prepared.file);bindAgentInputClaimStore(restored,h.store)
  Reflect.set(h.client,'messageQueue',restored)
  const coordinator=Reflect.get(h.client,'promptSubmission'),deps=Reflect.get(coordinator,'deps')
  Reflect.set(coordinator,'deps',{...deps,inputJournalId:restored.queueId})
  await Reflect.get(h.client,'restoreInputWaiting').call(h.client)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(await restored.inspectInput({key:waiting.intent.key})).toEqual(waiting)
  await h.client.rejoinAgentInputWaiting({ref:before.control.ref})
  for(const value of Reflect.get(h.client,'inputWaitingRecipients').values()) await value.pending
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(await restored.inspectInput({key:gate.intent.key})).toEqual(before)
  await h.client.submitAgentPrompt({agentSessionId:'recipient',expectedRun:run,operationId:'fresh-independent-queue',prompt:'synthetic-new',authorHuman:true,admissionIntent:{kind:'manual-actor'},execution:'immediate'})
  for(const value of Reflect.get(h.client,'inputWaitingRecipients').values()) await value.pending
  expect(h.inner.kernel.input).toHaveBeenCalled()
  expect((await h.store.readPromptAdmission('recipient',run,'fresh-independent-queue'))?.admission?.acknowledged).toBe(true)
 } finally {await h.close()}
})

it('admits a Queue-only cut on the original live Store, preserves claims and makes old operation retries monotonic', async()=>{
 const h=await rpcOwnerFixture(['recipient'])
 try{
  const before=(await h.store.readMetadata('recipient'))!,stale={agentSessionId:'recipient',operationId:'outside-queue-cut',prompt:'original-body',...agentPromptCondition(before),execution:'immediate' as const}
  await h.client.submitAgentPrompt(stale)
  const record=await h.store.readPromptAdmission('recipient',before.run,stale.operationId)
  const cut=await h.store.admitRecoveryInputCut({operationId:'queue-only-original',sourceSHA256:'a'.repeat(64)})
  expect(cut.state).toBe('admitted');if(cut.state!=='admitted')throw new Error('Expected original live cut')
  expect(await h.store.readInputEpoch()).toBe(cut.inputEpoch)
  expect(await h.store.readPromptAdmission('recipient',before.run,stale.operationId)).toEqual(record)
  expect((await h.store.readMetadata('recipient'))?.run).toEqual(before.run)
  await expect(h.client.submitAgentPrompt({...stale,operationId:'cut-external-old-key'})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  const future={agentSessionId:'recipient',intentId:'fresh-future',operationId:'fresh-future',prompt:'new-body',active:true,inputEpoch:cut.inputEpoch}
  await h.client.saveAgentFuturePromptIntent(future)
  const retry=await h.store.admitRecoveryInputCut({operationId:'queue-only-original',sourceSHA256:'a'.repeat(64)})
  expect(retry).toMatchObject({state:'admitted',inputEpoch:cut.inputEpoch,heldFutureIntents:0})
  expect(await h.client.readAgentFuturePromptIntent('recipient',future.intentId)).toMatchObject({active:true,inputEpoch:cut.inputEpoch})
  const next=await h.store.admitRecoveryInputCut({operationId:'queue-only-next',sourceSHA256:'b'.repeat(64)})
  expect(next.state).toBe('admitted');if(next.state!=='admitted')throw new Error('Expected later cut')
  expect(next.inputEpoch).not.toBe(cut.inputEpoch)
  await expect(h.store.admitRecoveryInputCut({operationId:'queue-only-original',sourceSHA256:'a'.repeat(64)})).rejects.toMatchObject({code:'STORAGE_RECOVERY_INPUT_CUT_SUPERSEDED'})
  expect(await h.store.readInputEpoch()).toBe(next.inputEpoch)
  expect(await h.store.readPromptAdmission('recipient',before.run,stale.operationId)).toEqual(record)
  const db=new DatabaseSync(h.store.path,{readOnly:true});try{expect(db.prepare('SELECT count(*) AS n FROM input_namespace_cuts').get()?.n).toBe(2)}finally{db.close()}
 }finally{await h.close()}
})

it('refuses the live cut while the original prompt owner is delivering, then admits the same operation', async()=>{
 const h=await rpcOwnerFixture(['recipient'])
 try{
  let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{entered=resolve})
  const pending=h.store.withPromptSubmission('recipient',async()=>{entered();await blocked})
  await ready
  const input={operationId:'held-owner',sourceSHA256:'c'.repeat(64)}
  await expect(h.store.admitRecoveryInputCut(input)).rejects.toMatchObject({code:'AGENT_PROMPT_SUBMISSION_BUSY'})
  expect(await h.store.readInputEpoch()).toBeUndefined()
  release();await pending;expect(await h.store.admitRecoveryInputCut(input)).toMatchObject({state:'admitted'})
 }finally{await h.close()}
})


it('confirms the original durability ACK on every retry of the same visible input cut',async()=>{
 const h=await rpcOwnerFixture(['recipient'])
 try{
  const original=sessionDatabaseOwner.syncSessionDatabase
  const fault=vi.spyOn(sessionDatabaseOwner,'syncSessionDatabase').mockImplementation(async()=>{throw Object.assign(new Error('controlled after-COMMIT directory EIO'),{code:'EIO'})})
  const input={operationId:'lost-cut-ack',sourceSHA256:'d'.repeat(64)}
  await expect(h.store.admitRecoveryInputCut(input)).rejects.toMatchObject({code:'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED'})
  const visible=await h.store.readInputEpoch();expect(visible).toMatch(/^restore:/)
  await expect(h.store.admitRecoveryInputCut(input)).rejects.toMatchObject({code:'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED'})
  expect(fault).toHaveBeenCalledTimes(2)
  fault.mockImplementation(original)
  expect(await h.store.admitRecoveryInputCut(input)).toMatchObject({state:'admitted',inputEpoch:visible})
 }finally{await h.close()}
})

it.each(['missing','malformed'] as const)('a %s v3 input namespace keeps original metadata and no-prompt lifecycle while new input remains unknown',async mode=>{
 const f=await retiredReopenFixture('codex')
 try{
  // This fixture already owns deterministic Runtime leaves; keep the real prepared-resume consumer and exact frozen request intact.
  const runtime={runtimeId:'synthetic-runtime',instanceId:'private-daemon',buildIdentity:'private-b061',protocolVersion:21},originalStart=f.inner.kernel.start
  f.inner.kernel.creationRuntimeIdentity=()=>runtime
  const originalBinding=f.inner.hookServer.createBinding
  f.inner.hookServer.createBinding=vi.fn((...args:any[])=>({...originalBinding(...args),bindingId:args[2]}))
  f.inner.kernel.startPrepared=vi.fn(async(request:any,operationKey:string,expected:any)=>{expect(expected).toEqual(runtime);expect(request.env.AGENTMUX_LIFECYCLE_OPERATION_ID).toBe(operationKey);return originalStart({...request,cwd:request.cwd,operationKey})})

  const snapshot=join(f.root,'lifecycle-cut.sqlite'),incarnation=await cut(f.storePath,snapshot)
  const prepared=await f.store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(f.root,'stage'),operationId:'restore-lifecycle-gap',expectedIncarnation:incarnation})
  if(prepared.state!=='prepared')throw new Error('Expected held cut')
  await rename(prepared.file,f.storePath)
  const first=await f.client.reopenAgent(f.input)
  const db=new DatabaseSync(f.storePath);db.exec(mode==='missing'?'DROP TABLE input_namespace':"UPDATE input_namespace SET restoration='{}'");db.close()
  await expect(f.store.readInputEpoch()).rejects.toThrow()
  const metadata=(await f.store.readMetadata(first.agentSessionId))!
  await expect(f.store.compareAndSwapMetadata(metadata,{...metadata,updatedAt:metadata.updatedAt+1})).resolves.toBeUndefined()
  expect((await f.store.readMetadata(first.agentSessionId))?.inputEpoch).toBe(prepared.inputEpoch)
  const ended=new Set([first.run.runId])
  f.inner.kernel.status=vi.fn(async(id:string)=>({...f.run(id,!ended.has(id)),lifecycleOperationId:f.starts.find((_,index)=>id===`new-run-${index+1}`)?.operationKey??null}))
  const continuation=await f.client.ensureAgentContinuity({agentSessionId:first.agentSessionId,expectedRun:first.run,operationId:'original-no-prompt-resume',trigger:'manual',policy:{continuationEnabled:false,reminderMode:'off'}})
  expect(continuation.kind).toBe('resumed');if(continuation.kind!=='resumed')throw new Error('Expected the original native resume')
  const resumed=continuation.session
  expect(resumed.agentSessionId).toBe(first.agentSessionId);expect(resumed.run).not.toEqual(first.run);expect(resumed.inputEpoch).toBe(prepared.inputEpoch)
  expect(resumed.nativeHandle).toEqual(first.nativeHandle)
  await expect(f.client.submitAgentPrompt({agentSessionId:resumed.agentSessionId,operationId:'old-request-without-cut',prompt:'Old retained body',expectedRun:resumed.run,afterSubmissionId:null,execution:'immediate'})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  const current=(await f.store.readMetadata(resumed.agentSessionId))!
  await expect(f.client.submitAgentPrompt({agentSessionId:resumed.agentSessionId,operationId:'fresh-body-unknown-namespace',prompt:'Fresh body',...agentPromptCondition(current),execution:'immediate'})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  await expect(f.client.saveAgentFuturePromptIntent({agentSessionId:resumed.agentSessionId,intentId:'fresh-future',operationId:'fresh-future',prompt:'Future body',active:true,inputEpoch:prepared.inputEpoch})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  ended.add(resumed.run.runId)
  await f.client.stopAgent(resumed.agentSessionId,resumed.run)
  const retired=(await f.store.readRetiredAgentSession(resumed.agentSessionId))!
  expect(retired.history?.inputEpoch).toBe(prepared.inputEpoch)
  const reopened=await f.client.reopenAgent({agentSessionId:resumed.agentSessionId,expectedRetiredAt:retired.observedAt,operationId:'original-no-prompt-reopen'})
  expect(reopened.agentSessionId).toBe(first.agentSessionId);expect(reopened.inputEpoch).toBe(prepared.inputEpoch)
  expect(f.starts).toHaveLength(3);expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await readFile(f.path)).toEqual(f.nativeBefore)
 }finally{await f.close()}
})


it('a no-prompt reopen adopts the current confirmed cut while retaining the original retirement epoch',async()=>{
 const f=await retiredReopenFixture('codex')
 try{
  const snapshot=join(f.root,'first-cut.sqlite'),incarnation=await cut(f.storePath,snapshot)
  const prepared=await f.store.prepareRecoveryRestore({sourcePath:snapshot,stagingPath:join(f.root,'first-stage'),operationId:'first-restore',expectedIncarnation:incarnation})
  if(prepared.state!=='prepared')throw new Error('Expected held cut')
  await rename(prepared.file,f.storePath)
  const first=await f.client.reopenAgent(f.input)
  f.inner.kernel.status=vi.fn(async(id:string)=>({...f.run(id,false),lifecycleOperationId:f.starts.find((_,index)=>id===`new-run-${index+1}`)?.operationKey??null}))
  await f.client.stopAgent(first.agentSessionId,first.run)
  const retired=(await f.store.readRetiredAgentSession(first.agentSessionId))!
  expect(retired.history?.inputEpoch).toBe(prepared.inputEpoch)
  const next=await f.store.admitRecoveryInputCut({operationId:'later-queue-only-cut',sourceSHA256:'b'.repeat(64)})
  if(next.state!=='admitted')throw new Error('Expected later cut')
  expect(next.inputEpoch).not.toBe(prepared.inputEpoch)
  expect((await f.store.readRetiredAgentSession(first.agentSessionId))?.history?.inputEpoch).toBe(prepared.inputEpoch)
  await expect(f.client.reopenAgent({agentSessionId:first.agentSessionId,expectedRetiredAt:retired.observedAt,operationId:'reopen-after-later-cut'})).resolves.toMatchObject({agentSessionId:first.agentSessionId,inputEpoch:next.inputEpoch,nativeHandle:first.nativeHandle})
  expect(f.starts).toHaveLength(2);expect(f.inner.kernel.input).not.toHaveBeenCalled()
 }finally{await f.close()}
})
