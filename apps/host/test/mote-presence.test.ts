import { registerMotePreferencesIpc } from '../../desktop/src/main/mote-preferences-ipc.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, mkdir, mkdtemp, rm, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import * as core from '@agentmux/core'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { DEFAULT_MOTE_PRESENCE, effectiveMoteQuickSave, moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { ContinuousProgressLoopManager, MAINTENANCE_RETRY_MS } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { createHostMotePresence, motePresenceSourceId } from '../src/mote-presence.js'
import { createHostContent } from '../src/content-owner.js'
import { createHostMoteMainReader, createHostMoteDialogue } from '../src/mote-dialogue.js'
import { HostMoteQuickPreferences } from '../src/mote-quick-preferences.js'
import { MoteConnectionPreferences } from '../src/mote-connection-preferences.js'
import { MoteDialogueStore } from '@agentmux/core/mote-dialogue-store'
import { MOTE_SUPERVISION_GUIDANCE } from '@agentmux/core/mote-dialogue'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const loader = resolve(import.meta.dirname, 'mote-presence-node-loader.mjs')
async function cli(f: Awaited<ReturnType<typeof headlessFixture>>, method: string[], input: unknown) {
  return await new Promise<any>((yes, no) => {
    const child = spawn(process.execPath, ['--experimental-transform-types','--import',loader, resolve(import.meta.dirname,'../../../packages/core/src/agentmux.ts'),'--endpoint','unix:'+f.socketPath,...method,method[0]==='schedule'?'--data':'--input','-'], { env: f.env, stdio:['pipe','pipe','pipe'] })
    let out='',err='';child.stdout.on('data',value=>out+=value);child.stderr.on('data',value=>err+=value);child.once('error',no);child.once('close',code=>code===0 ? yes(JSON.parse(out).result) : no(new Error(err)));child.stdin.end(JSON.stringify(input))
  })
}
it('CAS role generation changes only with the complete original binding, including A→B→A', () => {
  const reference = {hostId:'local',sessionId:'a',displayWorkspaceId:'w',groupId:'g',tabId:'t',regionId:'r'}
  const base = {kind:'quick',target:{spaceId:'original-mote'},operationId:'interval-save',baseline:{defaults:{conversation:reference,conversationRevision:'original-role'},document:{revision:'original-file'}},values:{conversation:reference,presence:{enabled:true,intervalMs:3600000}}} as any
  expect(effectiveMoteQuickSave(base).conversationRevision).toBe('original-role')
  const b=effectiveMoteQuickSave({...base,operationId:'to-b',values:{conversation:{...reference,sessionId:'b'}}})
  expect(b.conversationRevision).not.toBe('original-role')
  expect(effectiveMoteQuickSave({...base,operationId:'back-to-a',baseline:{...base.baseline,defaults:b}}).conversationRevision).not.toBe(b.conversationRevision)
  expect(DEFAULT_MOTE_PRESENCE).toEqual({enabled:true,intervalMs:1800000})
})
it('standing maintenance admits the original source beyond the ordinary activity window, while revocation rejects only this recovery', async () => {
  const f=await rpcOwnerFixture(['original'],core,()=>({nativeHandle:{kind:'provider',providerId:'codex',sessionId:'native-original'}}));cleanup.push(f.close)
  const store=f.store, old=Date.now()-2*86400000, original=(await store.load())[0]!
  await store.compareAndSwap(original,{...original,createdAt:old-1000,updatedAt:Date.now(),semanticStatus:{state:'done',source:'native-hook',observedAt:old,stateEnteredAt:old},recoveryActivity:{state:'idle',sourceId:'original-native-source',nativeTurnId:'turn-old',sequence:1,hookReceiptId:'original-hook',observedAt:old,run:original.run,nativeSessionId:'native-original'}} as any)
  const inner=f.client as any; inner.kernel.status=vi.fn(async()=>({...f.run(original.run.runId),state:{type:'exited',code:1,signal:null}}))
  const witness=vi.fn(async()=>{throw new core.AgentMuxError('Exact original standing admission reached native lifecycle','STANDING_ADMITTED')})
  inner.recovery.ports.hooks.requireHookIngressOwner=witness
  // Use a real, private executable observation; no user Provider is probed or launched.
  inner.recovery.ports.providers.probeAgent=async()=>({providerId:'codex',executable:process.execPath,installed:true,capabilities:inner.providers.get('codex').catalog.capabilities})
  const source={sourceId:'private-standing-source',revision:'role-1'}
  await f.client.saveAgentFuturePromptIntent({agentSessionId:'original',intentId:'original-intent',operationId:'original-standing',expectedRun:original.run,prompt:'Internal original check.',active:true,continuitySource:source})
  await expect(f.client.ensureAgentContinuity({agentSessionId:'original',expectedRun:original.run,operationId:'omitted-trigger',standingIntent:{...source,intentId:'original-intent',operationId:'original-standing'}})).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
  const automatic=await f.client.ensureAgentContinuity({agentSessionId:'original',expectedRun:original.run,operationId:'ordinary-original',trigger:'startup'})
  expect(automatic).toMatchObject({kind:'pending',reason:'idle-window-expired'})
  await expect(f.client.ensureAgentContinuity({agentSessionId:'original',expectedRun:original.run,operationId:'standing-original',trigger:'standing-maintenance',standingIntent:{...source,intentId:'original-intent',operationId:'original-standing'},policy:{continuationEnabled:false}})).rejects.toMatchObject({code:'STANDING_ADMITTED'})
  expect(witness).toHaveBeenCalledTimes(1)
  await f.client.saveAgentFuturePromptIntent({agentSessionId:'original',intentId:'original-intent',operationId:'original-standing',expectedRun:original.run,prompt:'Internal original check.',active:false})
  await expect(f.client.ensureAgentContinuity({agentSessionId:'original',expectedRun:original.run,operationId:'revoked-original',trigger:'standing-maintenance',standingIntent:{...source,intentId:'original-intent',operationId:'original-standing'}})).rejects.toMatchObject({code:'AGENT_STANDING_INTENT_CHANGED'})
  await expect(f.client.saveAgentFuturePromptIntent({agentSessionId:'original',intentId:'original-intent',operationId:'original-standing',expectedRun:original.run,prompt:'Internal original check.',active:true,caller:f.credentials})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  expect(witness).toHaveBeenCalledTimes(1);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('actual headless Host and CLI save original preferences, share one schedule, preserve pause and native identity across owner restart', async () => {
  const prior=process.env.AGENTMUX_TEST_OWNER_ENTRY;process.env.MOTE_PRESENCE_DROP_ACK='1';process.env.AGENTMUX_TEST_OWNER_ENTRY=resolve(import.meta.dirname,'fixtures/mobile-web-host.mjs')
  let f:Awaited<ReturnType<typeof headlessFixture>>
  try {f=await headlessFixture({ownerNodeArgs:['--experimental-transform-types','--import',loader]})} finally {delete process.env.MOTE_PRESENCE_DROP_ACK;if(prior===undefined)delete process.env.AGENTMUX_TEST_OWNER_ENTRY;else process.env.AGENTMUX_TEST_OWNER_ENTRY=prior}
  cleanup.push(async()=>{try{const c=await f.client();for(const s of await c.readAgentSessions())if((await c.statusAgent(s.agentSessionId)).run.state==='running')await c.stopAgent(s.agentSessionId,s.run)}finally{await f.cleanup()}})
  process.stderr.write('[presence-stage] private Host ready\n')
  const workspace={id:SCRATCH_WORKSPACE_ID,hostId:'local',name:'Private Mote',path:join(f.root,'scratch'),kind:'folder'};await mkdir(workspace.path)
  const topics=new ScratchTopics(),topic=await topics.ensureMote(workspace,'view:presence-original')
  const configurationPath=join(f.env.AGENTMUX_STATE_DIRECTORY!,'original-configuration.json')
  const configuration={workspaces:[workspace],executors:{codex:{providerId:'codex',label:'Private original',command:resolve(import.meta.dirname,'../../../packages/core/test/fixtures/fake-codex-cli.mjs'),args:[],env:{CODEX_HOME:join(f.root,'home'),AGENTMUX_FAKE_READY_MODE:'before',AGENTMUX_FAKE_NATIVE_RECORD:'1',AGENTMUX_FAKE_NATIVE_PRESERVE:'1',AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY:join(f.root,'native'),AGENTMUX_FAKE_NATIVE_CONTEXT:'Original private main decisions'},injectAgentMuxGuide:false}},appearance:{}}
  await writeFile(configurationPath,JSON.stringify(configuration));await writeFile(join(topic.physicalDirectoryPath!,'MOTE.md'),'---\nversion: 1\ndefaults:\n  executorId: codex\n  recovery: on-open\n---\nKeep original user notes.\n')
  const spaceId=directoryIdentity('local',topic.identityDirectoryPath!),zoneId=homeZoneId(spaceId),tabId='original-tab',regionId='original-region',groupId='original-group'
  const target={spaceId,zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:workspace.path}}
  const spatial=new core.AgentMuxSpatialStateStore(join(f.env.AGENTMUX_STATE_DIRECTORY!,'spatial-state.json'))
  const current=await spatial.read()
  await spatial.commit({expectedRevision:current?.revision??0,graph:{spaces:[{spaceId,kind:'mote',name:'Original Mote',hostId:'local',directoryPath:topic.physicalDirectoryPath!,projectId:null,topicId:topic.id}],zones:[{zoneId,workspaceId:workspace.id,kind:'home',hostId:'local',directoryPath:topic.physicalDirectoryPath!,branch:null}],bindings:[{spaceId,zoneId}],tabs:[{tabId,zoneId,workspaceId:workspace.id,name:'Main',regionIds:[regionId]}],regions:[{tabId,regionId,kind:'launcher',agentSessionId:null,runId:null,execution:null}],layouts:{[workspace.id]:createWorkspaceLayout(groupId,[tabId])},tabLayouts:{[tabId]:createWorkbenchViewLayout(regionId)},resources:{}}})
  process.stderr.write('[presence-stage] original sources ready\n')
  const rpc=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:f.socketPath}});cleanup.push(()=>rpc.dispose())
  const opened=await rpc.call('agent.open',{operationId:'original-main-create',content:{kind:'new-agent',executorId:'codex'},destination:{spaceId,zoneId,tabId,regionId},focus:false})
  const sid=opened.agent!.agentSessionId;let client=await f.client()
  const original=await until(()=>client.statusAgent(sid),value=>Boolean(value.session.nativeHandle)&&value.observation.semantic==='idle','original private main ready')
  process.stderr.write('[presence-stage] original native ready\n')
  const read=await cli(f,['space','mote','preferences','read'],{kind:'quick',target})
  expect(read.status).toBe('ready');const baseline=moteQuickBaseline(read)!
  const conversation={hostId:'local',sessionId:sid,displayWorkspaceId:workspace.id,groupId,tabId,regionId}
  const saved=await cli(f,['space','mote','preferences','save'],{kind:'quick',target,baseline,values:{...read.defaults,conversation},destination:{kind:'occurrence',displayWorkspaceId:workspace.id,groupId,tabId,regionId},operationId:'establish-original-main'})
  expect(saved.status).toBe('saved');expect(saved.source.defaults.conversationRevision).toBeTypeOf('string')
  let last:any
  process.stderr.write('[presence-stage] main binding saved\n')
  const observed=await until(async()=>{ last=await rpc.call('space.mote.preferences.read',{kind:'quick',target});return last },value=>value.maintenance?.status==='active','Host arranged default heartbeat').catch(async error=>{throw new Error(String(error)+' '+JSON.stringify({maintenance:last?.maintenance,schedules:await rpc.call('schedule.list',{})}))})
  const schedule=observed.maintenance!.schedule!;expect(schedule.everyMs).toBe(1800000)
  process.stderr.write('[presence-stage] default schedule active\n')
  const second=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:f.socketPath}});cleanup.push(()=>second.dispose())
  expect((await second.call('schedule.list',{})).schedules.filter(v=>v.managedSource?.sourceId===schedule.managedSource!.sourceId)).toHaveLength(1)
  const handlers=new Map<string,Function>(), wrongOwner=vi.fn(async()=>{throw new Error('A quick preference cannot be sent through a connector or Renderer writer')})
  registerMotePreferencesIpc({socketPath:join(f.root,'absent-desktop-business.sock'),handleWithEvent:(channel,handler)=>{handlers.set(channel,handler)},assertTrusted:()=>{},runtime:{callOriginalCore:async(hostId:string,method:any,params:any)=>{expect(hostId).toBe('local');return await second.call(method,params)},connectionHostingTarget:wrongOwner,callConnectionHost:wrongOwner} as any})
  expect(await handlers.get('motePreferences:read')!({}, {kind:'quick',target})).toMatchObject({status:'ready',maintenance:{schedule:{loopId:schedule.loopId}}})
  const interval=await handlers.get('motePreferences:save')!({},{kind:'quick',target,baseline:moteQuickBaseline(observed),values:{...observed.defaults,presence:{enabled:true,intervalMs:3600000}},destination:{kind:'occurrence',displayWorkspaceId:workspace.id,groupId,tabId,regionId},operationId:'change-original-interval'})
  expect(wrongOwner).not.toHaveBeenCalled()
  expect(interval.status).toBe('saved');expect(interval.source.defaults.conversationRevision).toBe(saved.source.defaults.conversationRevision)
  process.stderr.write('[presence-stage] interval File saved\n')
  const changed=await until(()=>rpc.call('schedule.inspect',{scheduleId:schedule.loopId}),value=>value.schedule?.everyMs===3600000,'same schedule interval updated')
  expect(changed.schedule!.loopId).toBe(schedule.loopId)
  const retainedLegacy=await cli(f,['space','mote','preferences','read'],{kind:'quick',target})
  expect(retainedLegacy.defaults.recovery).toBe('on-open')
  const refusedLegacy=await cli(f,['space','mote','preferences','save'],{kind:'quick',target,baseline:moteQuickBaseline(retainedLegacy),values:{...retainedLegacy.defaults,recovery:'startup'},destination:{kind:'occurrence',displayWorkspaceId:workspace.id,groupId,tabId,regionId},operationId:'no-legacy-recovery-writer'})
  expect(refusedLegacy.status).toBe('refused-before-write')
  process.stderr.write('[presence-stage] same schedule updated\n')
  // Exercise the actual Host cadence and its unchanged delivery port, not an onTick stub.
  const dueMessage = 'Private exact due heartbeat consumer witness'
  const scheduled = await cli(f,['schedule','create'],{target:{hostId:'local',agentSessionId:sid,providerId:original.session.providerId,workspacePath:original.session.workspacePath},afterMs:50,prompt:dueMessage,operationId:'private-due-consumer'})
  // This private terminal executable has no native queue. Only the original Core claim owner
  // can confirm that its preparation failed before claiming input; the Host keeps it due.
  const attempted = await until(()=>rpc.call('schedule.inspect',{scheduleId:scheduled.schedule.loopId}),value=>value.schedule?.lastOutcome==='skipped','actual Host due input reached original Core preparation',10000)
  expect(attempted.schedule).toMatchObject({status:'active',nextCheckAt:scheduled.schedule.nextCheckAt,lastDecision:expect.stringContaining('native queue source is unconfirmed')})
  expect(attempted.schedule!.pendingCompletion).toBeUndefined()
  expect((await client.statusAgent(sid)).run.acceptedInputBytes).toBe(original.run.acceptedInputBytes)
  expect((await cli(f,['schedule','list'],{})).schedules.find((value:any)=>value.loopId===scheduled.schedule.loopId)).toMatchObject({status:'active',lastOutcome:'skipped'})
  await rpc.call('schedule.cancel',{scheduleId:scheduled.schedule.loopId,expectedRevision:attempted.schedule!.revision!,operationId:'close-private-due-probe'})
  process.kill(original.run.pid!, 'SIGKILL')
  let nativeObserved:any=original
  const recovered=await until(async()=>{try{nativeObserved=await client.statusAgent(sid)}catch(error){if(!(error instanceof core.AgentMuxError)||error.code!=='STALE_AGENT_SESSION')throw error}return nativeObserved},value=>value.run.state==='running'&&value.session.run.runId!==original.session.run.runId&&value.observation.readiness==='ready','same Session restored by standing maintenance',30000).catch(async error=>{throw new Error(String(error)+' '+JSON.stringify({run:nativeObserved?.run,continuity:nativeObserved?.session.continuity,observation:nativeObserved?.observation,maintenance:(await rpc.call('space.mote.preferences.read',{kind:'quick',target})).maintenance}))})
  expect(recovered.session.nativeHandle).toEqual(original.session.nativeHandle)
  expect(recovered.session.continuity).toMatchObject({kind:'resumed',reason:'standing-intent',standingIntent:{revision:saved.source.defaults.conversationRevision}})
  const replay=await until(async()=>(await client.readRunReplay(recovered.session.run)).replay.map(value=>value.data).join(''),value=>value.includes('codex-restored-context:'),'original native context replay',10000)
  expect(replay).toContain('Original private main decisions')
  process.stderr.write('[presence-stage] native original restored\n')
  const refused=await cli(f,['space','mote','preferences','save'],{kind:'quick',target,baseline,values:{conversation},destination:{kind:'occurrence',displayWorkspaceId:workspace.id,groupId,tabId,regionId},operationId:'stale-original-save'})
  expect(refused.status).toBe('refused-before-write')
  await rpc.call('schedule.pause',{scheduleId:schedule.loopId,expectedRevision:changed.schedule!.revision!,operationId:'pause-original-heartbeat'})
  process.stderr.write('[presence-stage] manual schedule paused\n')
  const beforeUnknown=await rpc.call('space.mote.preferences.read',{kind:'quick',target})
  const unknown=await cli(f,['space','mote','preferences','save'],{kind:'quick',target,baseline:moteQuickBaseline(beforeUnknown),values:{...beforeUnknown.defaults,presence:{enabled:true,intervalMs:120000}},destination:{kind:'occurrence',displayWorkspaceId:workspace.id,groupId,tabId,regionId},operationId:'original-lost-file-ack'})
  expect(unknown).toMatchObject({status:'unconfirmed',operationId:'original-lost-file-ack',source:null})
  expect(await readFile(join(topic.physicalDirectoryPath!,'MOTE.md'),'utf8')).toContain('intervalMs: 120000')
  process.stderr.write('[presence-stage] unknown File ACK retained\n')
  await f.restart();client=await f.client()
  const after=await until(()=>client.statusAgent(sid),value=>value.run.state==='running','same native remains live after owner restart')
  expect(after.session.run).toEqual(recovered.session.run);expect(after.session.nativeHandle).toEqual(original.session.nativeHandle)
  const fresh=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:f.socketPath}});cleanup.push(()=>fresh.dispose())
  process.stderr.write('[presence-stage] Host restarted same Run\n')
  const retained=await until(()=>fresh.call('space.mote.preferences.read',{kind:'quick',target}),value=>value.maintenance?.status==='paused','manual pause retained')
  expect(retained.maintenance!.schedule!.loopId).toBe(schedule.loopId)
  expect((await fresh.call('schedule.inspect',{scheduleId:scheduled.schedule.loopId})).schedule).toMatchObject({status:'stopped',lastMutation:{operationId:'close-private-due-probe',action:'cancel'}})
  expect(await readFile(join(topic.physicalDirectoryPath!,'MOTE.md'),'utf8')).toContain('Keep original user notes.')
  expect(await readFile(join(topic.physicalDirectoryPath!,'MOTE.md'),'utf8')).toContain('recovery: on-open')
}, 120_000)

async function managedFixture(initialSaveBusy=false, retainedPrompt?: string, retainedNote?: string) {
  const f=await rpcOwnerFixture(['main','other'],core);cleanup.push(f.close)
  const configurationPath=join(f.root,'config.json');await writeFile(configurationPath,JSON.stringify({workspaces:[{id:SCRATCH_WORKSPACE_ID,hostId:'local',path:f.root}]}))
  const target={spaceId:'private-mote-space',zoneId:homeZoneId('private-mote-space'),expectedResource:{hostId:'local',workspaceId:SCRATCH_WORKSPACE_ID,workspacePath:f.root}}
  const spatial=new core.AgentMuxSpatialStateStore(join(f.root,'spatial.json'))
  await spatial.commit({expectedRevision:0,graph:{spaces:[{spaceId:target.spaceId,kind:'mote',name:'Original',hostId:'local',directoryPath:f.root,projectId:null,topicId:'original-mote'}],zones:[{zoneId:target.zoneId,workspaceId:SCRATCH_WORKSPACE_ID,kind:'home',hostId:'local',directoryPath:f.root,branch:null}],bindings:[{spaceId:target.spaceId,zoneId:target.zoneId}],tabs:[],regions:[],layouts:{},tabLayouts:{},resources:{}}})
  const current={hostId:'local',sessionId:'main',displayWorkspaceId:SCRATCH_WORKSPACE_ID,groupId:'g',tabId:'t',regionId:'r'}
  const resource={...target.expectedResource,zoneId:target.zoneId,zonePath:f.root,path:'MOTE.md'}
  const snapshot:any={target,identity:{hostId:'local',moteId:'original-mote'},status:'ready',resource,documentRevision:'original-file',roleRevision:'original-role',current,issue:null}
  const main={readCurrentMoteMain:async()=>structuredClone(snapshot),assertCurrent:async(original:any)=>{expect(original.roleRevision).toBe(snapshot.roleRevision)}}
  let enabled=true,available=true
  const files:any={read:async()=>{if(!available)throw new Error('Original private MOTE source unavailable');return {resource,result:{status:'read',document:{path:'MOTE.md',revision:'sha256:'+'0'.repeat(64),content:'---\nversion: 1\ndefaults:\n  presence:\n    enabled: '+enabled+'\n    intervalMs: 60000\n---\n'}}}}}
  let clock=100000,busy=false,outcome:'sent'|'unknown'='sent';const sent:any[]=[]
  const store=new ContinuousProgressLoopStore(join(f.root,'loops.json'))
  const make=()=>new ContinuousProgressLoopManager(store,async(loop,operationId)=>{sent.push({loop:structuredClone(loop),operationId});return outcome},()=>clock,async(loop,tickId)=>({session:{...f.client.agentSession(loop.agentSessionId),semanticStatus:{state:busy?'working':'done',source:'native-hook',observedAt:clock,stateEnteredAt:clock},futurePromptIntents:{[loop.futureIntentId!]:await f.client.readAgentFuturePromptIntent(loop.agentSessionId,loop.futureIntentId!)}},observation:{process:'running',semantic:busy?'active':'idle',readiness:'ready',stale:false},inputByte:0,tickId,now:clock}) as any,{saveFutureIntent:async(loop,active)=>{if(initialSaveBusy&&active)throw new core.AgentMuxError('The original Future Intent owner is busy with a person input.','AGENT_PROMPT_SUBMISSION_BUSY');await f.client.saveAgentFuturePromptIntent({agentSessionId:loop.agentSessionId,expectedRun:f.client.agentSession(loop.agentSessionId).run,intentId:loop.futureIntentId!,operationId:loop.creationOperationId!,prompt:loop.prompt,...(retainedNote?{agentMuxNote:retainedNote}:{}),active,continuitySource:loop.managedSource})}})
  let manager=make()
  await manager.start()
  if(retainedPrompt) await manager.call('schedule.create',{target:{hostId:'local',agentSessionId:'main',providerId:f.client.agentSession('main').providerId,workspacePath:f.root},everyMs:60000,prompt:retainedPrompt,managedSource:{sourceId:motePresenceSourceId(snapshot.identity),revision:snapshot.roleRevision},operationId:'retained-original-maintenance'})
  let presence=createHostMotePresence({configurationPath,spatial,files,main,schedules:manager,clients:f.coreClients})
  cleanup.push(async()=>{presence.dispose();await manager.stop()})
  await manager.check(clock);await manager.check(clock)
  return {f,snapshot,files,sent,target,main,saveBusy:(value:boolean)=>initialSaveBusy=value,get presence(){return presence},get manager(){return manager},loop:()=>manager.list()[0]!,advance:()=>clock+=60000,at:(value:number)=>clock=value,filesAvailable:(value:boolean,notify=true)=>{available=value;if(notify)presence.invalidate(target)},enabled:(value:boolean)=>{enabled=value;presence.invalidate(target)},busy:(value:boolean)=>busy=value,outcome:(value:typeof outcome)=>outcome=value,async restart(){presence.dispose();await manager.stop();manager=make();presence=createHostMotePresence({configurationPath,spatial,files,main,schedules:manager,clients:f.coreClients});await manager.start();await manager.check(clock)}}
}
it('a supervision heartbeat freezes the exact original Mote input and shares the Main duties at the actual future-intent owner',async()=>{
  const f=await managedFixture(), loop=f.loop()
  expect(loop.prompt).toContain(MOTE_SUPERVISION_GUIDANCE)
  expect(loop.prompt).toContain('space mote dialogue heartbeat report')
  expect(loop.prompt).toContain('lastInputRef')
  expect(loop.prompt).toContain('later Agent statement, not proof')
  expect(JSON.parse(loop.prompt.slice(loop.prompt.lastIndexOf('\n')+1))).toEqual({target:f.target})
  const original=await f.f.client.readAgentFuturePromptIntent('main',loop.futureIntentId!)
  expect(original).toMatchObject({operationId:loop.creationOperationId,prompt:loop.prompt,continuitySource:loop.managedSource})
  await f.manager.check(f.advance())
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0].loop).toMatchObject({agentSessionId:'main',prompt:loop.prompt,managedSource:loop.managedSource})
})
it('a retained supervision heartbeat body and an unknown claim survive owner restart without adopting new guidance',async()=>{
  const retained='Original previously arranged maintenance body.', retainedNote='Original previously arranged platform context.', f=await managedFixture(false,retained,retainedNote)
  f.outcome('unknown');await f.manager.check(f.advance())
  const frozen=structuredClone(f.loop()), intent=await f.f.client.readAgentFuturePromptIntent('main',frozen.futureIntentId!)
  expect(frozen).toMatchObject({prompt:retained,status:'paused',lastOutcome:'unknown'})
  expect(frozen.pendingCompletion?.operationId).toBe(f.sent[0].operationId)
  expect(intent?.message.systemContext).toContain(retainedNote);expect(intent?.message.systemContext).not.toContain(MOTE_SUPERVISION_GUIDANCE)
  expect(frozen.pendingCompletion?.agentMuxNote).toBe(intent!.message.systemContext)
  await f.restart()
  expect(f.loop()).toMatchObject({loopId:frozen.loopId,prompt:retained,pendingCompletion:frozen.pendingCompletion})
  expect(await f.f.client.readAgentFuturePromptIntent('main',frozen.futureIntentId!)).toEqual(intent)
  expect(f.sent).toHaveLength(1)
})
it('an unavailable original source is reobserved without a page open, file rewrite or new automatic operation',async()=>{
  const f=await managedFixture(), id=f.loop().loopId, operation=f.loop().creationOperationId
  f.filesAvailable(false);await f.manager.check(100001)
  expect(f.presence.read(f.target)).toMatchObject({status:'unconfirmed',schedule:{loopId:id}})
  // No change event: the owner reads the source again after its first retry wait.
  f.filesAvailable(true,false);await f.manager.check(100001+MAINTENANCE_RETRY_MS)
  expect(f.presence.read(f.target)).toMatchObject({status:'active',schedule:{loopId:id,creationOperationId:operation}})
  expect(f.sent).toHaveLength(0)
})
it('an active original main without an output Attachment is observed by the existing scheduler before its next heartbeat',async()=>{
  const f=await managedFixture(), original=await f.f.client.statusAgent('main')
  vi.spyOn(f.f.client,'statusAgent').mockResolvedValue({...original,run:{...original.run,state:'exited',exitCode:1}})
  const recover=vi.spyOn(f.f.client,'ensureAgentContinuity').mockResolvedValue({kind:'reattachable'} as any)
  await f.manager.check(100001)
  expect(recover).toHaveBeenCalledOnce()
  expect(recover).toHaveBeenCalledWith(expect.objectContaining({agentSessionId:'main',expectedRun:original.session.run,trigger:'standing-maintenance',standingIntent:expect.objectContaining({revision:'original-role',intentId:f.loop().futureIntentId})}))
  expect(f.sent).toHaveLength(0)
})
it('disabling the original main pauses its same arrangement and explicit reenable never silently resumes it',async()=>{
  const f=await managedFixture(), id=f.loop().loopId
  f.enabled(false);await f.manager.check(100001)
  expect(f.presence.read(f.target)).toMatchObject({status:'disabled',schedule:{loopId:id,status:'paused'}})
  f.enabled(true);await f.manager.check(100002)
  expect(f.presence.read(f.target)).toMatchObject({status:'paused',schedule:{loopId:id,status:'paused'}})
  await f.manager.call('schedule.resume',{scheduleId:id,expectedRevision:f.loop().revision!,operationId:'explicit-original-resume'})
  await f.manager.check(100003)
  expect(f.loop()).toMatchObject({loopId:id,status:'active'})
  expect(f.presence.read(f.target)).toMatchObject({status:'active',schedule:{loopId:id,status:'active'}})
  expect(f.sent).toHaveLength(0)
})
it('the original scheduler defers busy input, preserves claimed unknown across restart, and never resets it on interval edits',async()=>{
  const f=await managedFixture();expect(f.loop().everyMs).toBe(60000)
  f.busy(true);await f.manager.check(f.advance());expect(f.sent).toHaveLength(0);expect(f.loop().pendingCompletion).toBeUndefined()
  f.busy(false);f.outcome('unknown');await f.manager.check(f.advance());expect(f.sent,JSON.stringify(f.loop())).toHaveLength(1)
  const claimed=structuredClone(f.loop().pendingCompletion);expect(claimed?.operationId).toBe(f.sent[0].operationId);expect(f.loop().status).toBe('paused')
  await f.manager.call('schedule.update',{scheduleId:f.loop().loopId,expectedRevision:f.loop().revision!,operationId:'paused-period-edit',everyMs:120000})
  expect(f.loop().pendingCompletion).toEqual(claimed);expect(f.loop().status).toBe('paused');expect(f.loop().everyMs).toBe(120000)
  await f.restart();expect(f.loop().pendingCompletion).toEqual(claimed);expect(f.sent).toHaveLength(1);expect(f.loop().status).toBe('paused')
})
it('a source gap at a due occurrence keeps the heartbeat active and the next occurrence runs',async()=>{
  const f=await managedFixture(), id=f.loop().loopId, due=f.loop().nextCheckAt
  f.filesAvailable(false,false);await f.manager.check(f.at(due))
  // The gap is a service note on an active arrangement, not a pause the user has to undo.
  expect(f.loop()).toMatchObject({loopId:id,status:'active',nextCheckAt:due,lastDecision:expect.stringContaining('unconfirmed')})
  expect(f.sent).toHaveLength(0)
  f.filesAvailable(true,false);await f.manager.check(f.at(due+60000))
  expect(f.loop()).toMatchObject({loopId:id,status:'active'});expect(f.sent).toHaveLength(1)
})
it('an unconfirmed source is read again after growing waits, not on every tick',async()=>{
  const f=await managedFixture(), due=f.loop().nextCheckAt
  const reads=vi.spyOn(f.files,'read')
  f.filesAvailable(false,false)
  for(let at=due;at<due+30000;at+=1000)await f.manager.check(f.at(at))
  // Thirty one-second ticks: the due occurrence and the presence owner each retry at 1, 2, 4, 8 and 16 seconds.
  expect(reads.mock.calls.length).toBeLessThanOrEqual(12)
  expect(f.loop().status).toBe('active');expect(f.sent).toHaveLength(0)
})
it('a held maintenance read does not prevent the next scheduler tick',async()=>{
  const f=await managedFixture(), due=f.loop().nextCheckAt
  const original=await f.f.client.statusAgent('main'), held:Array<()=>void>=[]
  const status=vi.spyOn(f.f.client,'statusAgent').mockImplementation(()=>new Promise(resolve=>{held.push(()=>resolve(original))}))
  const checking=f.manager.check(f.at(due))
  let second:Promise<void>|undefined
  try {
    await vi.waitFor(()=>expect(f.sent).toHaveLength(1))
    expect(held.length).toBeGreaterThan(0)
    const originalSession=f.f.client.agentSession('main')
    const added=await f.manager.call('schedule.create',{target:{hostId:'local',agentSessionId:'main',providerId:originalSession.providerId,workspacePath:originalSession.workspacePath},everyMs:60000,prompt:'Another original arrangement',operationId:'other-maintenance-independent'})
    second=f.manager.check(f.at(added.schedule.nextCheckAt))
    await vi.waitFor(()=>expect(f.sent.some(value=>value.loop.loopId===added.schedule.loopId)).toBe(true),{timeout:1000,interval:10})
    expect(status).toHaveBeenCalledOnce()
  } finally {
    status.mockResolvedValue(original);for(const release of held)release();await checking;await second
  }
})
it('a maintenance rejection reaches its caller after due work and does not pause the arrangement',async()=>{
  const f=await managedFixture(), due=f.loop().nextCheckAt
  f.presence.dispose()
  const failure=new Error('Original maintenance observation failed')
  const release=f.manager.setMaintenanceOwner({qualify:async()=>({action:'continue'}),maintain:async()=>{throw failure}})
  try {
    await expect(f.manager.check(f.at(due))).rejects.toBe(failure)
    expect(f.sent).toHaveLength(1);expect(f.loop().status).toBe('active')
  } finally { release() }
  const recovered=f.manager.setMaintenanceOwner({qualify:async()=>({action:'continue'}),maintain:async()=>{}})
  try { await expect(f.manager.check(f.at(due+60000))).resolves.toBeUndefined() }
  finally { recovered() }
})
it('a changed role generation cannot receive a due occurrence even when its Host and SID are the same',async()=>{
  const f=await managedFixture();f.snapshot.roleRevision='new-generation-same-sid'
  await f.manager.check(f.advance());expect(f.sent).toHaveLength(0);expect(f.loop().status).toBe('paused')
})
it('maintenance observation failure is a service window while the original healthy manual input remains usable',async()=>{
  const f=await rpcOwnerFixture(['main'],core);cleanup.push(f.close)
  const spatial=new core.AgentMuxSpatialStateStore(join(f.root,'spatial.json'))
  const manager=new ContinuousProgressLoopManager({load:async()=>{throw new Error('original private schedule storage unavailable')},save:async()=>{}} as any,async()=>{throw new Error('No automatic delivery was authorized')},Date.now,async()=>{throw new Error('No observation was admitted')})
  const presence=createHostMotePresence({configurationPath:join(f.root,'config.json'),spatial,files:{read:async()=>{throw new Error('No File read was admitted')}} as any,main:{readCurrentMoteMain:async()=>{throw new Error('No role was admitted')},assertCurrent:async()=>{}},schedules:manager,clients:f.coreClients})
  cleanup.push(async()=>{presence.dispose();await manager.stop()})
  await expect(presence.start()).resolves.toBeUndefined()
  const target={spaceId:'original',zoneId:'original-home',expectedResource:{hostId:'local',workspaceId:SCRATCH_WORKSPACE_ID,workspacePath:f.root}}
  expect(presence.read(target)).toMatchObject({status:'unconfirmed',issue:expect.stringContaining('original private schedule storage unavailable')})
  await f.client.writeAgent({agentSessionId:'main',expectedRun:f.client.agentSession('main').run,data:'healthy manual input',source:'user'})
  expect(f.rawInput).toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it.each([1,1000])('source observation copies only original managed prompts with %i unrelated arrangements',count=>{
  const scheduler=new core.ContinuousProgressScheduler()
  const loop=(id:string,sourceId:string)=>({loopId:id,hostId:'local',agentSessionId:id,providerId:'generic',workspacePath:'/private-fixture',prompt:'original prompt',intervalMs:60000,nextCheckAt:60000,status:'active',managedSource:{sourceId,revision:'original'}})
  scheduler.restore([loop('original','selected'),...Array.from({length:count},(_,i)=>loop('unrelated-'+i,'another-'+i)),loop('other-original','selected')] as any)
  const copies=vi.spyOn(globalThis,'structuredClone')
  expect(scheduler.listManaged('selected').map(value=>value.loopId)).toEqual(['original','other-original'])
  expect(copies).toHaveBeenCalledTimes(2);copies.mockClear()
  expect(scheduler.listManaged('absent')).toEqual([]);expect(copies).not.toHaveBeenCalled()
})
it('a new Mote without MOTE.md is a ready empty role for every Host reader, and an unreadable MOTE.md stays unconfirmed',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'mote-without-file-')));cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const workspace={id:SCRATCH_WORKSPACE_ID,hostId:'local',name:'New Mote',path:join(root,'scratch'),kind:'folder'};await mkdir(workspace.path)
  const topic=await new ScratchTopics().ensureMote(workspace,'view:presence-without-file'),file=join(topic.physicalDirectoryPath!,'MOTE.md')
  await expect(access(file)).rejects.toMatchObject({code:'ENOENT'})
  const configurationPath=join(root,'configuration.json');await writeFile(configurationPath,JSON.stringify({workspaces:[workspace]}))
  const spaceId=directoryIdentity('local',topic.identityDirectoryPath!),zoneId=homeZoneId(spaceId)
  const target={spaceId,zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:workspace.path}}
  const spatial=new core.AgentMuxSpatialStateStore(join(root,'spatial.json'))
  await spatial.commit({expectedRevision:0,graph:{spaces:[{spaceId,kind:'mote',name:'New Mote',hostId:'local',directoryPath:topic.physicalDirectoryPath!,projectId:null,topicId:topic.id}],zones:[{zoneId,workspaceId:workspace.id,kind:'home',hostId:'local',directoryPath:topic.physicalDirectoryPath!,branch:null}],bindings:[{spaceId,zoneId}],tabs:[],regions:[],layouts:{},tabLayouts:{},resources:{}}})
  const files=createHostContent({configurationPath,spatial}).files!,main=createHostMoteMainReader({configurationPath,spatial,files})
  const catalog=async()=>core.spatialCatalog((await spatial.read())!.graph)
  const dialogue=createHostMoteDialogue({main,spatial,store:new MoteDialogueStore(join(root,'dialogue.sqlite')),clientForHost:()=>{throw new Error('No message owner was admitted')}})
  const manager=new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(root,'loops.json')),async()=>{throw new Error('No automatic delivery was authorized')},()=>100000,async()=>{throw new Error('No observation was admitted')})
  const presence=createHostMotePresence({configurationPath,spatial,files,main,schedules:manager,clients:()=>[]})
  cleanup.push(async()=>{presence.dispose();await manager.stop()})
  const quick=new HostMoteQuickPreferences({files,main,catalog,executors:async()=>[{id:'saved',name:'Saved',providerId:'codex'}],maintenance:value=>presence.read(value)})
  const connection=new MoteConnectionPreferences({files,catalog,connections:async()=>{throw new Error('No connection list was admitted')}})
  await manager.start();await manager.check(100000)
  const empty=await main.readCurrentMoteMain(target)
  expect(empty).toMatchObject({status:'ready',identity:{hostId:'local',moteId:topic.id},resource:{hostId:'local',workspaceId:SCRATCH_WORKSPACE_ID},documentRevision:null,roleRevision:expect.any(String),current:null,issue:null})
  expect(empty.resource!.path.endsWith('MOTE.md')).toBe(true)
  expect((await dialogue.read({target,kind:'main'})).main).toMatchObject({status:'ready',current:null,roleRevision:empty.roleRevision})
  const read=await quick.read({kind:'quick',target})
  expect(read).toMatchObject({status:'ready',issue:null,maintenance:{status:'unbound',issue:null}});expect(read.defaults).toEqual({})
  expect(await connection.read({kind:'connection',target})).toMatchObject({status:'ready',values:{connection:null},issue:null})
  // The first unrelated save keeps the role generation reported for the absent file.
  const saved=await quick.save({kind:'quick',target,operationId:'first-executor',baseline:moteQuickBaseline(read)!,values:{executorId:'saved'},destination:{kind:'empty',displayWorkspaceId:workspace.id,groupId:'original-group'}})
  expect(saved).toMatchObject({status:'saved',source:{defaults:{executorId:'saved'}}})
  expect(await main.readCurrentMoteMain(target)).toMatchObject({status:'ready',current:null,roleRevision:empty.roleRevision})
  // A MOTE.md that exists but cannot be read as text is not an absence.
  await rm(file);await mkdir(file);presence.invalidate(target);await manager.check(100001)
  expect(await main.readCurrentMoteMain(target)).toMatchObject({status:'unconfirmed',current:null,issue:expect.stringContaining('MOTE.md could not be read')})
  expect(presence.read(target)).toMatchObject({status:'unconfirmed',issue:expect.stringContaining('MOTE.md could not be read')})
  expect(await quick.read({kind:'quick',target})).toMatchObject({status:'unconfirmed',defaults:null})
  expect(await connection.read({kind:'connection',target})).toMatchObject({status:'unconfirmed',values:null})
})

it('a held main observation cannot hold another Mote on the current or later maintenance cadence',async()=>{
  const f=await managedFixture(),second={...f.target,spaceId:'private-second-mote',zoneId:'private-second-home'}
  const snapshot={...structuredClone(f.snapshot),target:second,identity:{hostId:'local',moteId:'second-mote'},resource:{...f.snapshot.resource,zoneId:second.zoneId},current:{...f.snapshot.current,sessionId:'other'}}
  vi.spyOn(f.main,'readCurrentMoteMain').mockImplementation(async target=>structuredClone(target.spaceId===second.spaceId?snapshot:f.snapshot))
  vi.spyOn(f.main,'assertCurrent').mockResolvedValue(undefined)
  const readFile=f.files.read.bind(f.files)
  vi.spyOn(f.files,'read').mockImplementation(async(input:any)=>{const value=await readFile(input);return {...value,resource:{...value.resource,zoneId:input.zoneId}}})
  const original=await f.f.client.statusAgent('main'),read=f.f.client.statusAgent.bind(f.f.client)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  const status=vi.spyOn(f.f.client,'statusAgent').mockImplementation(async sid=>{if(sid==='main'){entered.resolve();await release.promise;return original}return read(sid)})
  f.presence.invalidate(second)
  const checking=f.manager.check(100001);await entered.promise
  try {
    await vi.waitFor(()=>expect(f.presence.read(second),JSON.stringify(f.presence.read(second))).toMatchObject({status:'active',schedule:{agentSessionId:'other'}}))
    const previous=status.mock.calls.filter(([sid])=>sid==='other').length
    await f.manager.check(100002)
    expect(status.mock.calls.filter(([sid])=>sid==='other').length).toBeGreaterThan(previous)
    expect(status.mock.calls.filter(([sid])=>sid==='main')).toHaveLength(1)
  } finally {release.resolve();await checking}
})

it.each([false,true])('an unconfirmed standing configuration converges its original creation without resuming a user pause (paused=%s)',async paused=>{
  const f=await managedFixture(true),original=structuredClone(f.loop())
  expect(original).toMatchObject({status:'paused',lastOutcome:'unknown'})
  expect(original.pendingCompletion).toBeUndefined();expect(original.lastTickId).toBeUndefined()
  if(paused)await f.manager.call('schedule.pause',{scheduleId:original.loopId,expectedRevision:original.revision!,operationId:'explicit-pause-original-creation'})
  f.saveBusy(false);await f.manager.check(f.at(101000))
  expect(f.loop()).toMatchObject({loopId:original.loopId,creationOperationId:original.creationOperationId,status:paused?'paused':'active'})
  expect(f.manager.listManaged(original.managedSource!.sourceId)).toHaveLength(1)
  expect(f.sent).toHaveLength(0);expect(f.f.rawInput).not.toHaveBeenCalled();expect(f.f.inner.kernel.input).not.toHaveBeenCalled()
  if(!paused){
    expect(f.loop().lastOutcome).toBeUndefined()
    expect(await f.f.client.readAgentFuturePromptIntent(original.agentSessionId,original.futureIntentId!)).toMatchObject({operationId:original.creationOperationId,active:true})
  }
})
