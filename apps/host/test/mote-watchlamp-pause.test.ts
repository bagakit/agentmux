import { afterEach, expect, it, vi } from 'vitest'
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import * as core from '@agentmux/core'
import type { ContinuousProgressLoop, ContinuousProgressObservation } from '@agentmux/core'
import { parseScheduleRecord, parseScheduleRpcParams } from '@agentmux/core'
import { moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const standing = (id = 'original', patch: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ loopId:id,hostId:'local',agentSessionId:id,providerId:'generic',workspacePath:'/private/'+id,prompt:'Original internal check',intervalMs:1000,everyMs:60000,nextCheckAt:1000,status:'active',creationOperationId:'create-'+id,futureIntentId:'future-'+id,managedSource:{sourceId:'source-'+id,revision:'original-role'},revision:1,...patch })
function idle(loop: ContinuousProgressLoop, tickId: string): ContinuousProgressObservation {
  return {session:{...loop,run:{runId:'original-run'},semanticStatus:{state:'done',source:'native-hook',observedAt:100},futurePromptIntents:{[loop.futureIntentId!]:{active:true,operationId:loop.creationOperationId!,message:{userContent:loop.prompt,systemContext:'Original context'}}}},observation:{process:'running',semantic:'idle',readiness:'ready',stale:false},inputByte:0,tickId,now:1000} as ContinuousProgressObservation
}
async function fixture(records = [standing()]) {
  let clock = 1000
  const root = await mkdtemp(join(tmpdir(),'mote-pause-'));closes.push(()=>rm(root,{recursive:true,force:true}))
  const store = new ContinuousProgressLoopStore(join(root,'loops.json'));await store.save(records)
  const onTick = vi.fn(async ():Promise<'sent'|'unknown'> => 'unknown'), saveFutureIntent = vi.fn(async()=>{})
  const manager = new ContinuousProgressLoopManager(store,onTick,()=>clock,async(loop,tickId)=>idle(loop,tickId),{saveFutureIntent})
  manager.setMaintenanceOwner({maintain:async()=>{},qualify:async()=>({action:'continue'})})
  await manager.start();closes.push(()=>manager.stop())
  return {manager,onTick,store,saveFutureIntent,at:(value:number)=>clock=value}
}
it('manual pause owns one onset across retries and interval changes; resume starts a later episode',async()=>{
  const f=await fixture(),request={scheduleId:'original',expectedRevision:1,operationId:'opaque-pause'}
  const first=(await f.manager.call('schedule.pause',request)).schedule!
  expect(first.pause).toEqual({reason:'manual',episodeId:expect.any(String),pausedAt:1000})
  f.at(9000);expect((await f.manager.call('schedule.pause',request)).schedule!.pause).toEqual(first.pause)
  const updated=(await f.manager.call('schedule.update',{scheduleId:first.loopId,expectedRevision:first.revision!,operationId:'change-interval',everyMs:120000})).schedule!
  expect(updated.pause).toEqual(first.pause)
  const resumed=(await f.manager.call('schedule.resume',{scheduleId:first.loopId,expectedRevision:updated.revision!,operationId:'explicit-resume'})).schedule!
  expect(resumed.pause).toBeUndefined()
  const second=(await f.manager.call('schedule.pause',{scheduleId:first.loopId,expectedRevision:resumed.revision!,operationId:'later-pause'})).schedule!
  expect(second.pause).toEqual({reason:'manual',episodeId:expect.any(String),pausedAt:9000});expect(second.pause!.episodeId).not.toBe(first.pause!.episodeId)
  expect(f.onTick).not.toHaveBeenCalled()
})
it('cold pending recovery records its actual owner transition once and retains the exact input',async()=>{
  const pending={id:'original-completion',operationId:'original-input',condition:{expectedRun:{runId:'original-run'},afterSubmissionId:null},prompt:'Frozen body'}
  const f=await fixture([standing('original',{pendingCompletion:pending,lastTickAt:3,lastTickId:'original-tick'})]),first=f.manager.inspectLoop('original')!
  expect(first).toMatchObject({status:'paused',lastOutcome:'unknown',pendingCompletion:pending,pause:{reason:'input-unconfirmed',pausedAt:1000,episodeId:expect.any(String)}})
  await f.manager.check(999999);expect(f.manager.inspectLoop('original')!.pause).toEqual(first.pause);expect(f.onTick).not.toHaveBeenCalled()
  const restored=new ContinuousProgressLoopManager(f.store,async()=>{throw Error('No replay')},()=>9000,async()=>{throw Error('No read')})
  await f.manager.stop();await restored.start();closes.push(()=>restored.stop())
  expect(restored.inspectLoop('original')).toEqual(first)
})
it('legacy paused text and tick time never fabricate reason or onset, even on explicit reconfirmation',async()=>{
  const f=await fixture([standing('original',{status:'paused',lastDecision:'Paused by you; input unconfirmed',lastTickAt:1,lastOutcome:'unknown'})])
  expect(f.manager.inspectLoop('original')!.pause).toBeUndefined()
  await f.manager.check(100000);expect(f.manager.inspectLoop('original')!.pause).toBeUndefined()
  const explicit=(await f.manager.call('schedule.pause',{scheduleId:'original',expectedRevision:1,operationId:'opaque'})).schedule!
  expect(explicit.pause).toEqual({reason:'manual'});expect(explicit.lastTickAt).toBe(1)
})
it('a late unknown receipt preserves a newer explicit pause and the original pending input',async()=>{
  const f=await fixture(),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>()
  f.onTick.mockImplementation(async()=>{entered.resolve();await gate.promise;return 'unknown'})
  const checking=f.manager.check(1000);await entered.promise
  const pending=structuredClone(f.manager.inspectLoop('original')!.pendingCompletion)
  f.at(2000);const paused=await f.manager.pause('original')
  gate.resolve();await checking
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'paused',pause:paused.pause,pendingCompletion:pending,lastOutcome:'unknown'})
  expect(f.manager.inspectLoop('original')!.pause!.reason).toBe('manual')
  await f.manager.check(999999);expect(f.onTick).toHaveBeenCalledOnce()
})
it('new input uncertainty gets its own source facts, without claiming native completion',async()=>{
  const f=await fixture();await f.manager.check(1000)
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'paused',lastOutcome:'unknown',pause:{reason:'input-unconfirmed',episodeId:expect.any(String),pausedAt:1000},pendingCompletion:{operationId:expect.any(String)}})
  const first=f.manager.inspectLoop('original')!;await f.manager.check(999999);expect(f.manager.inspectLoop('original')).toEqual(first);expect(f.onTick).toHaveBeenCalledOnce()
})
it('startup preparation is distinct and confirmed source cancellation keeps its stopped semantics',async()=>{
  const f=await fixture([]);f.saveFutureIntent.mockRejectedValue(new Error('Original owner busy before any input'))
  await expect(f.manager.call('schedule.create',{target:{hostId:'local',agentSessionId:'main',providerId:'generic',workspacePath:'/private/main'},everyMs:60000,prompt:'Original message',operationId:'original-create'})).rejects.toThrow('Original owner busy')
  const prepared=f.manager.list()[0]!;expect(prepared).toMatchObject({status:'paused',pause:{reason:'preparation'}});expect(prepared.pendingCompletion).toBeUndefined()
  f.saveFutureIntent.mockResolvedValue(undefined)
  const cancelled=(await f.manager.call('schedule.cancel',{scheduleId:prepared.loopId,expectedRevision:prepared.revision!,operationId:'cancel-original'})).schedule!
  expect(cancelled.status).toBe('stopped');expect(cancelled.pause).toEqual(prepared.pause);expect(f.onTick).not.toHaveBeenCalled()
})
it('an internal pause uses an explicit owner reason while public callers cannot assert one',async()=>{
  const f=await fixture()
  const internal=(await f.manager.call('schedule.pause',{scheduleId:'original',expectedRevision:1,operationId:'opaque-internal'},undefined,'execution-ended')).schedule!
  expect(internal.pause!.reason).toBe('execution-ended');expect(internal.lastMutation!.action).toBe('pause')
  expect(()=>parseScheduleRpcParams('schedule.pause',{scheduleId:'original',expectedRevision:1,operationId:'opaque',pauseReason:'manual'})).toThrow()
})
it('only the original persistence-induced pause gets its reason; a healthy managed due remains active',async()=>{
  for(const managed of [false,true]) {
    const f=await fixture([standing('original',managed?{}:{managedSource:undefined})])
    vi.spyOn(f.store,'save').mockRejectedValueOnce(new Error('Original claim directory unavailable'))
    await expect(f.manager.check(1000)).rejects.toThrow('Original claim directory unavailable')
    expect(f.manager.inspectLoop('original')!.status).toBe(managed?'active':'paused')
    expect(f.manager.inspectLoop('original')!.pause).toEqual(managed?undefined:{reason:'persistence-unconfirmed',episodeId:expect.any(String),pausedAt:1000})
    expect(f.onTick).not.toHaveBeenCalled()
  }
})
it('a real repeating-clock overflow owns a pause without fabricating another occurrence',async()=>{
  const at=Number.MAX_SAFE_INTEGER-1,f=await fixture([standing('original',{nextCheckAt:at})]);f.at(at);f.onTick.mockResolvedValue('sent')
  await f.manager.check(at)
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'paused',pause:{reason:'timing-unrepresentable',episodeId:expect.any(String),pausedAt:at},lastOutcome:'sent'})
  await f.manager.check(at);expect(f.onTick).toHaveBeenCalledOnce()
})
it.each([
  {reason:'display-guessed'}, {reason:'manual',episodeId:'orphan'}, {reason:'manual',pausedAt:1},
  {reason:'manual',episodeId:'original',pausedAt:1.5}, {reason:'manual',episodeId:'original',pausedAt:-1},
  {reason:'manual',episodeId:'original',pausedAt:1,guessed:true}, {reason:'manual',episodeId:'bad\nidentity',pausedAt:1}
])('strict original schedule codec rejects malformed pause %j',pause=>{expect(()=>parseScheduleRecord(standing('original',{pause:pause as never}))).toThrow()})
it('strict codec retains legacy absence and a valid typed episode exactly',()=>{
  const legacy=standing();expect(parseScheduleRecord(legacy)).toEqual(legacy)
  const original=standing('original',{status:'paused',pause:{reason:'input-unconfirmed',episodeId:'exact-episode',pausedAt:123}})
  expect(parseScheduleRecord(original)).toEqual(original)
})
const loader=resolve(import.meta.dirname,'mote-watchlamp-pause-node-loader.mjs')
async function cli(f:Awaited<ReturnType<typeof headlessFixture>>,method:string[],input:unknown) {
  return await new Promise<any>((yes,no)=>{
    const child=spawn(process.execPath,['--experimental-transform-types','--import',loader,resolve(import.meta.dirname,'../../../packages/core/src/agentmux.ts'),'--endpoint','unix:'+f.socketPath,...method,method[0]==='schedule'?'--data':'--input','-'],{env:{...f.env,MOTE_WATCHLAMP_LOADS:process.env.MOTE_WATCHLAMP_LOADS},stdio:['pipe','pipe','pipe']})
    let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.once('error',no);child.once('close',code=>code===0?yes(JSON.parse(out).result):no(Error(err)));child.stdin.end(JSON.stringify(input))
  })
}
it('actual Host, SDK and source CLI share typed facts and retain original Run/episodes through a real owner restart',async()=>{
  const prior=process.env.AGENTMUX_TEST_OWNER_ENTRY;process.env.AGENTMUX_TEST_OWNER_ENTRY=resolve(import.meta.dirname,'fixtures/mote-watchlamp-host.mjs')
  let f:Awaited<ReturnType<typeof headlessFixture>>
  try { f=await headlessFixture({ownerNodeArgs:['--experimental-transform-types','--import',loader]}) } finally {if(prior===undefined)delete process.env.AGENTMUX_TEST_OWNER_ENTRY;else process.env.AGENTMUX_TEST_OWNER_ENTRY=prior}
  const ownedPids=new Set<number>([f.owner.processId])
  let wroteReceipt=false
  closes.push(async()=>{
    try{const c=await f.client();for(const s of await c.readAgentSessions())if((await c.statusAgent(s.agentSessionId)).run.state==='running')await c.stopAgent(s.agentSessionId,s.run)}finally{await f.cleanup()}
    const rootRemoved=await access(f.root).then(()=>false,error=>{if(error.code==='ENOENT')return true;throw error})
    const processStates=[...ownedPids].map(pid=>{try{process.kill(pid,0);return {pid,alive:true}}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return {pid,alive:false};throw error}})
    expect(rootRemoved).toBe(true);expect(processStates.every(value=>!value.alive)).toBe(true)
    if(process.env.MOTE_WATCHLAMP_RECEIPT&&wroteReceipt) { const path=process.env.MOTE_WATCHLAMP_RECEIPT,receipt=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...receipt,cleanup:{rootRemoved,processStates}},null,2)) }
  })
  const firstOwner=f.owner,initial=await cli(f,['schedule','list'],{})
  const legacy=initial.schedules.find((s:any)=>s.loopId==='legacy-paused'),pending=initial.schedules.find((s:any)=>s.loopId==='pending-recovered')
  expect(legacy.pause).toBeUndefined();expect(pending.pause).toMatchObject({reason:'input-unconfirmed',episodeId:expect.any(String),pausedAt:expect.any(Number)});expect(pending.pause.pausedAt).toBeGreaterThan(pending.lastTickAt)
  const workspace={id:SCRATCH_WORKSPACE_ID,hostId:'local',name:'Private Mote',path:join(f.root,'scratch'),kind:'folder'};await mkdir(workspace.path)
  const topic=await new ScratchTopics().ensureMote(workspace,'view:watchlamp-original'),state=f.env.AGENTMUX_STATE_DIRECTORY!
  await writeFile(join(state,'original-configuration.json'),JSON.stringify({workspaces:[workspace],executors:{codex:{providerId:'codex',label:'Private original',command:resolve(import.meta.dirname,'../../../packages/core/test/fixtures/fake-codex-cli.mjs'),args:[],env:{CODEX_HOME:join(f.root,'home'),AGENTMUX_FAKE_READY_MODE:'before',AGENTMUX_FAKE_NATIVE_RECORD:'1',AGENTMUX_FAKE_NATIVE_PRESERVE:'1',AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY:join(f.root,'native')},injectAgentMuxGuide:false}},appearance:{}}))
  await writeFile(join(topic.physicalDirectoryPath!,'MOTE.md'),'---\nversion: 1\ndefaults:\n  executorId: codex\n---\nOriginal user notes.\n')
  const spaceId=directoryIdentity('local',topic.identityDirectoryPath!),zoneId=homeZoneId(spaceId),tabId='original-tab',regionId='original-region',groupId='original-group',target={spaceId,zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:workspace.path}}
  const spatial=new core.AgentMuxSpatialStateStore(join(state,'spatial-state.json')),current=await spatial.read()
  await spatial.commit({expectedRevision:current?.revision??0,graph:{spaces:[{spaceId,kind:'mote',name:'Original Mote',hostId:'local',directoryPath:topic.physicalDirectoryPath!,projectId:null,topicId:topic.id}],zones:[{zoneId,workspaceId:workspace.id,kind:'home',hostId:'local',directoryPath:topic.physicalDirectoryPath!,branch:null}],bindings:[{spaceId,zoneId}],tabs:[{tabId,zoneId,workspaceId:workspace.id,name:'Main',regionIds:[regionId]}],regions:[{tabId,regionId,kind:'launcher',agentSessionId:null,runId:null,execution:null}],layouts:{[workspace.id]:createWorkspaceLayout(groupId,[tabId])},tabLayouts:{[tabId]:createWorkbenchViewLayout(regionId)},resources:{}}})
  let rpc=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:f.socketPath}});closes.push(()=>rpc.dispose())
  const opened=await rpc.call('agent.open',{operationId:'watchlamp-original-main',content:{kind:'new-agent',executorId:'codex'},destination:{spaceId,zoneId,tabId,regionId},focus:false}),sid=opened.agent!.agentSessionId
  let client=await f.client();const original=await until(()=>client.statusAgent(sid),v=>Boolean(v.session.nativeHandle)&&v.observation.semantic==='idle','private fixture original ready')
  ownedPids.add(original.run.pid!)
  const read=await cli(f,['space','mote','preferences','read'],{kind:'quick',target})
  const conversation={hostId:'local',sessionId:sid,displayWorkspaceId:workspace.id,groupId,tabId,regionId},destination={kind:'occurrence',displayWorkspaceId:workspace.id,groupId,tabId,regionId}
  expect((await cli(f,['space','mote','preferences','save'],{kind:'quick',target,baseline:moteQuickBaseline(read),values:{...read.defaults,conversation},destination,operationId:'watchlamp-bind-main'})).status).toBe('saved')
  const bound=await until(()=>rpc.call('space.mote.preferences.read',{kind:'quick',target}),v=>v.maintenance?.status==='active','original heartbeat active'),managed=bound.maintenance!.schedule!
  const standalone=(await cli(f,['schedule','create'],{target:{hostId:'local',agentSessionId:sid,providerId:'codex',workspacePath:original.session.workspacePath},everyMs:3600000,prompt:'Separate explicit private arrangement',operationId:'watchlamp-create-manual'})).schedule
  const manual=(await cli(f,['schedule','pause'],{scheduleId:standalone.loopId,expectedRevision:standalone.revision,operationId:'opaque-agent-or-person'})).schedule
  expect(manual.pause).toMatchObject({reason:'manual',episodeId:expect.any(String),pausedAt:expect.any(Number)})
  const beforeOff=await rpc.call('space.mote.preferences.read',{kind:'quick',target})
  expect((await cli(f,['space','mote','preferences','save'],{kind:'quick',target,baseline:moteQuickBaseline(beforeOff),values:{...beforeOff.defaults,presence:{enabled:false,intervalMs:1800000}},destination,operationId:'watchlamp-disable-source'})).status).toBe('saved')
  const disabled=await until(()=>rpc.call('schedule.inspect',{scheduleId:managed.loopId}),v=>v.schedule?.status==='paused','internal disabled pause')
  expect(disabled.schedule!.pause).toMatchObject({reason:'source-disabled',episodeId:expect.any(String),pausedAt:expect.any(Number)})
  const preferences=await cli(f,['space','mote','preferences','read'],{kind:'quick',target});expect(preferences.maintenance.schedule.pause).toEqual(disabled.schedule!.pause)
  const persisted=JSON.parse(await readFile(join(state,'continuous-progress-loops.json'),'utf8')),before=await cli(f,['schedule','list'],{})
  await rpc.dispose();const secondOwner=(await f.restart()).owner;expect(secondOwner.ownerInstanceId).not.toBe(firstOwner.ownerInstanceId)
  ownedPids.add(secondOwner.processId);expect(secondOwner.processId).not.toBe(firstOwner.processId)
  rpc=await core.connectAgentMuxRpc({endpoint:{transport:'unix',path:f.socketPath}});client=await f.client()
  const after=await cli(f,['schedule','list'],{}),restored=await client.statusAgent(sid)
  expect(after.schedules).toEqual(before.schedules);expect(after.schedules.find((s:any)=>s.loopId==='legacy-paused').pause).toBeUndefined()
  expect(restored.run.runId).toBe(original.run.runId);expect(restored.run.state).toBe('running');expect(restored.session.nativeHandle).toEqual(original.session.nativeHandle)
  expect(restored.run.pid).toBe(original.run.pid);expect(restored.run.acceptedInputBytes).toBe(original.run.acceptedInputBytes)
  expect((await rpc.call('schedule.inspect',{scheduleId:managed.loopId})).schedule!.pause).toEqual(disabled.schedule!.pause)
  expect((await cli(f,['space','mote','preferences','read'],{kind:'quick',target})).maintenance.schedule.pause).toEqual(disabled.schedule!.pause)
  const durable=JSON.parse(await readFile(join(state,'continuous-progress-loops.json'),'utf8'));expect(durable).toEqual(persisted)
  if(process.env.MOTE_WATCHLAMP_RECEIPT){await writeFile(process.env.MOTE_WATCHLAMP_RECEIPT,JSON.stringify({schema:'agentmux.mote-watchlamp.host-proof.v1',scope:'private actual Host + official ctxmux + fake-codex fixture; no vendor model',firstOwner,secondOwner,original,restored,pending,legacy,manual,disabled:disabled.schedule,preferences,before,after,persisted,durable,root:f.root},null,2));wroteReceipt=true}
},120000)
