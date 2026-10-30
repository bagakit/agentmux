import { registerMotePreferencesIpc } from '../../desktop/src/main/mote-preferences-ipc.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import * as core from '@agentmux/core'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { DEFAULT_MOTE_PRESENCE, effectiveMoteQuickSave, moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { createHostMotePresence } from '../src/mote-presence.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const loader = resolve(import.meta.dirname, 'mote-presence-node-loader.mjs')
async function cli(f: Awaited<ReturnType<typeof headlessFixture>>, method: string[], input: unknown) {
  return await new Promise<any>((yes, no) => {
    const child = spawn(process.execPath, ['--experimental-transform-types','--import',loader, resolve(import.meta.dirname,'../../../packages/core/src/agentmux.ts'),'--endpoint','unix:'+f.socketPath,...method,'--input','-'], { env: f.env, stdio:['pipe','pipe','pipe'] })
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
  process.kill(original.run.pid!, 'SIGKILL')
  let nativeObserved:any
  const recovered=await until(async()=>{nativeObserved=await client.statusAgent(sid);return nativeObserved},value=>value.run.state==='running'&&value.session.run.runId!==original.session.run.runId&&value.observation.readiness==='ready','same Session restored by standing maintenance',30000).catch(async error=>{throw new Error(String(error)+' '+JSON.stringify({run:nativeObserved?.run,continuity:nativeObserved?.session.continuity,observation:nativeObserved?.observation,maintenance:(await rpc.call('space.mote.preferences.read',{kind:'quick',target})).maintenance}))})
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
  expect(await readFile(join(topic.physicalDirectoryPath!,'MOTE.md'),'utf8')).toContain('Keep original user notes.')
  expect(await readFile(join(topic.physicalDirectoryPath!,'MOTE.md'),'utf8')).toContain('recovery: on-open')
})

async function managedFixture() {
  const f=await rpcOwnerFixture(['main'],core);cleanup.push(f.close)
  const configurationPath=join(f.root,'config.json');await writeFile(configurationPath,JSON.stringify({workspaces:[{id:SCRATCH_WORKSPACE_ID,hostId:'local',path:f.root}]}))
  const target={spaceId:'private-mote-space',zoneId:homeZoneId('private-mote-space'),expectedResource:{hostId:'local',workspaceId:SCRATCH_WORKSPACE_ID,workspacePath:f.root}}
  const spatial=new core.AgentMuxSpatialStateStore(join(f.root,'spatial.json'))
  await spatial.commit({expectedRevision:0,graph:{spaces:[{spaceId:target.spaceId,kind:'mote',name:'Original',hostId:'local',directoryPath:f.root,projectId:null,topicId:'original-mote'}],zones:[{zoneId:target.zoneId,workspaceId:SCRATCH_WORKSPACE_ID,kind:'home',hostId:'local',directoryPath:f.root,branch:null}],bindings:[{spaceId:target.spaceId,zoneId:target.zoneId}],tabs:[],regions:[],layouts:{},tabLayouts:{},resources:{}}})
  const current={hostId:'local',sessionId:'main',displayWorkspaceId:SCRATCH_WORKSPACE_ID,groupId:'g',tabId:'t',regionId:'r'}
  const resource={...target.expectedResource,zoneId:target.zoneId,zonePath:f.root,path:'MOTE.md'}
  const snapshot:any={target,identity:{hostId:'local',moteId:'original-mote'},status:'ready',resource,documentRevision:'original-file',roleRevision:'original-role',current,issue:null}
  const main={readCurrentMoteMain:async()=>structuredClone(snapshot),assertCurrent:async(original:any)=>{expect(original.roleRevision).toBe(snapshot.roleRevision)}}
  let enabled=true,available=true
  const files:any={read:async()=>{if(!available)throw new Error('Original private MOTE source unavailable');return {resource,result:{status:'read',document:{path:'MOTE.md',revision:'original-file',content:'---\nversion: 1\ndefaults:\n  presence:\n    enabled: '+enabled+'\n    intervalMs: 60000\n---\n'}}}}}
  let clock=100000,busy=false,outcome:'sent'|'unknown'='sent';const sent:any[]=[]
  const store=new ContinuousProgressLoopStore(join(f.root,'loops.json'))
  const make=()=>new ContinuousProgressLoopManager(store,async(loop,operationId)=>{sent.push({loop:structuredClone(loop),operationId});return outcome},()=>clock,async(loop,tickId)=>({session:{...f.client.agentSession('main'),semanticStatus:{state:busy?'working':'done',source:'native-hook',observedAt:clock,stateEnteredAt:clock},futurePromptIntents:{[loop.futureIntentId!]:await f.client.readAgentFuturePromptIntent('main',loop.futureIntentId!)}},observation:{process:'running',semantic:busy?'active':'idle',readiness:'ready',stale:false},inputByte:0,tickId,now:clock}) as any,{saveFutureIntent:async(loop,active)=>{await f.client.saveAgentFuturePromptIntent({agentSessionId:'main',expectedRun:f.client.agentSession('main').run,intentId:loop.futureIntentId!,operationId:loop.creationOperationId!,prompt:loop.prompt,active,continuitySource:loop.managedSource})}})
  let manager=make(),presence=createHostMotePresence({configurationPath,spatial,files,main,schedules:manager,clients:f.coreClients})
  cleanup.push(async()=>{presence.dispose();await manager.stop()})
  await manager.start();await manager.check(clock);await manager.check(clock)
  return {f,snapshot,sent,target,get presence(){return presence},get manager(){return manager},loop:()=>manager.list()[0]!,advance:()=>clock+=60000,filesAvailable:(value:boolean,notify=true)=>{available=value;if(notify)presence.invalidate(target)},enabled:(value:boolean)=>{enabled=value;presence.invalidate(target)},busy:(value:boolean)=>busy=value,outcome:(value:typeof outcome)=>outcome=value,async restart(){presence.dispose();await manager.stop();manager=make();presence=createHostMotePresence({configurationPath,spatial,files,main,schedules:manager,clients:f.coreClients});await manager.start();await manager.check(clock)}}
}
it('an unavailable original source is reobserved without a page open, file rewrite or new automatic operation',async()=>{
  const f=await managedFixture(), id=f.loop().loopId, operation=f.loop().creationOperationId
  f.filesAvailable(false);await f.manager.check(100001)
  expect(f.presence.read(f.target)).toMatchObject({status:'unconfirmed',schedule:{loopId:id}})
  f.filesAvailable(true,false);await f.manager.check(100002)
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
