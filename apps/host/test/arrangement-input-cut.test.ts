import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { observeAgent, type ContinuousProgressLoop } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { parseAgentProgressParams, parseAgentProgressResult } from '../../../packages/core/src/agent-progress.js'
import { parseScheduleRpcParams, validateScheduleRpcResult } from '../../../packages/core/src/public-rpc-schedules.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { inspectPromptInSecondProcess } from '../../../packages/core/test/helpers/prompt-receipt-process.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { createGoalRuntime } from '../src/goal-runtime.js'
const cleanup: Array<()=>Promise<void>>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(){
 const h=await rpcOwnerFixture(['recipient']);cleanup.push(h.close)
 if(process.env.ARRANGEMENT_TEST_SOURCE_LOADS)process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS=process.env.ARRANGEMENT_TEST_SOURCE_LOADS
 const target={hostId:'local',agentSessionId:'recipient',providerId:'codex',workspacePath:h.root}
 const runtime=createGoalRuntime({clients:h.coreClients,checkIn:async()=>{throw Error('No check-in in fixture')}})
 const store=new ContinuousProgressLoopStore(join(h.root,'loops.json'));let now=100
 const observed=async(loop:ContinuousProgressLoop,tickId:string)=>{
  const session=h.client.agentSession('recipient'),status={state:'done' as const,source:'native-hook' as const,observedAt:1}
  const intent=loop.futureIntentId?await h.client.readAgentFuturePromptIntent('recipient',loop.futureIntentId):null
  return {session:{...session,semanticStatus:status,...(intent?{futurePromptIntents:{[loop.futureIntentId!]:intent}}:{})},
   observation:observeAgent({process:'running',status,timelineCapability:'complete-events',awaitingRequest:false,terminalCapabilityUnverified:false},now),tickId,now,inputByte:0,inputOccupied:false}
 }
 const sent:ContinuousProgressLoop[]=[]
 const manager=new ContinuousProgressLoopManager(store,async(loop)=>{sent.push(structuredClone(loop));return 'sent'},()=>now,observed,runtime)
 cleanup.push(()=>manager.stop());await manager.start()
 const cut=async(operationId:string)=>{const r=await h.store.admitRecoveryInputCut({operationId,sourceSHA256:'a'.repeat(64)});if(r.state!=='admitted')throw Error('Expected qualified cut');await Reflect.get(h.client,'registry').refresh('recipient',{runId:'run-recipient'});return r.inputEpoch}
 return {...h,sessionStore:h.store,target,runtime,store,manager,sent,cut,now:(v:number)=>{now=v}}
}
it('real Host future admission keeps old activation unknown and new exact public CLI creation works through Core Store',async()=>{
 const f=await fixture(),epoch=await f.cut('first-recovery')
 const server=new AgentMuxControlServer({socketPath:join(f.root,'arrangements.sock'),coreClients:f.coreClients,schedules:f.manager,progress:{call:(m,p,c)=>f.manager.callProgress(m,p,c)}})
 cleanup.push(()=>server.stop());await server.start()
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanup.push(()=>rpc.dispose())
 const stale={target:f.target,everyMs:60_000,prompt:'original retained body',operationId:'old-before-cut'}
 await expect(rpc.call('schedule.create',stale)).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
 expect(f.inner.kernel.input).not.toHaveBeenCalled()
 const request={target:f.target,everyMs:60_000,prompt:'new independent body',operationId:'new-after-cut',inputEpoch:epoch}
 const loader=fileURLToPath(new URL('../../../packages/core/test/helpers/prompt-receipt-source-loader.mjs',import.meta.url)),cli=fileURLToPath(new URL('../../../packages/core/src/agentmux.ts',import.meta.url))
 async function run(args:string[],input:unknown){return new Promise<{code:number|null,stdout:string,stderr:string}>((resolve,reject)=>{const cp=import('node:child_process').then(({spawn})=>{const child=spawn(process.execPath,['--no-warnings','--experimental-loader',loader,cli,'--endpoint','unix://'+server.path,...args],{env:process.env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(JSON.stringify(input));});void cp})}
 const result=await run(['schedule','create','--data','-'],request)
 expect(result.code,result.stderr).toBe(0)
 const record=JSON.parse(result.stdout).result.schedule as ContinuousProgressLoop
 expect(record.inputEpoch).toBe(epoch)
 expect(await f.client.readAgentFuturePromptIntent('recipient',record.futureIntentId!)).toMatchObject({active:true,inputEpoch:epoch,operationId:request.operationId})
 await expect(rpc.call('schedule.create',{...request,inputEpoch:'another-cut'})).rejects.toMatchObject({code:'SCHEDULE_OPERATION_CONFLICT'})
 const progress=await run(['agent','progress','create','--data','-'],{target:f.target,intervalMs:60_000,prompt:'independent progress',operationId:'progress-new',inputEpoch:epoch})
 expect(progress.code,progress.stderr).toBe(0);expect(JSON.parse(progress.stdout).result.loop.inputEpoch).toBe(epoch)
 const coldCode="import{readFile}from'node:fs/promises';process.stdout.write(await readFile(process.argv[1],'utf8'))"
 const cold=await promisify(execFile)(process.execPath,['--input-type=module','-e',coldCode,join(f.root,'loops.json')])
 expect(JSON.parse(cold.stdout).loops??JSON.parse(cold.stdout)).toEqual(await f.store.load())
 // Real Host submit facade -> Client -> Provider -> original Store, only Native leaf controlled.
 await expect(f.runtime.submitPrompt({kind:'agent',...f.target,run:{runId:'run-recipient'}},'new manual body','fresh-native-proof',{expectedRun:{runId:'run-recipient'},inputEpoch:epoch,admissionIntent:{kind:'manual-actor'}},undefined,{execution:'immediate'})).resolves.toBeDefined()
 for(const value of Reflect.get(f.client,'inputWaitingRecipients').values())await value.pending
 const key={kind:'prompt' as const,agentSessionId:'recipient',expectedRun:{runId:'run-recipient'},submissionId:'fresh-native-proof'}
 const admission=await f.sessionStore.readPromptAdmission('recipient',key.expectedRun,key.submissionId)
 expect(admission?.admission?.acknowledged).toBe(true);expect(f.inner.kernel.input).toHaveBeenCalled()
 const proof=await inspectPromptInSecondProcess(f.root,key)
 expect(proof.readback.record).toEqual(admission)
})
it.each([undefined,'earlier-cut'])('old automatic progress (%s) never captures fresh epoch, while a new explicit arrangement can run',async old=>{
 const f=await fixture(),epoch=await f.cut('restore-auto')
 const oldRecord={...f.target,loopId:'retained-loop',intervalMs:60_000,prompt:'original body',status:'active' as const,nextCheckAt:100,...(old===undefined?{}:{inputEpoch:old})}
 await f.manager.stop();await f.store.save([oldRecord])
 const manager=new ContinuousProgressLoopManager(f.store,async loop=>{f.sent.push(loop);return 'sent'},()=>100,async(loop,tickId)=>{
  const session=f.client.agentSession('recipient'),status={state:'done' as const,source:'native-hook' as const,observedAt:1}
  return{session:{...session,semanticStatus:status},observation:observeAgent({process:'running',status,timelineCapability:'complete-events',awaitingRequest:false,terminalCapabilityUnverified:false},100),now:100,tickId,inputByte:0,inputOccupied:false}
 })
 cleanup.push(()=>manager.stop());await manager.start();await manager.check(100)
 expect(f.sent).toEqual([]);expect(manager.list()[0]).toMatchObject({loopId:'retained-loop',prompt:oldRecord.prompt,status:'paused',lastOutcome:'unknown'})
 expect(manager.list()[0]?.inputEpoch).toBe(old)
 await manager.resume('retained-loop');await manager.check(100)
 expect(f.sent).toEqual([]);expect(manager.list()[0]?.lastOutcome).toBe('unknown')
 await manager.stopLoop('retained-loop')
 const created=await manager.callProgress('agent.progress.create',{target:f.target,intervalMs:60_000,prompt:'fresh explicit',operationId:'fresh-loop',inputEpoch:epoch},{principal:{kind:'user',id:'human'}})
 await manager.checkNow(created.loop.loopId)
 expect(f.sent).toHaveLength(1);expect(f.sent[0]!.pendingCompletion?.condition?.inputEpoch).toBe(epoch)
 expect((await f.store.load()).find(x=>x.loopId==='retained-loop')?.inputEpoch).toBe(old)
})
it('current-cut pause/resume keeps the original progress epoch and operation; ordinary never-restored absence stays usable',async()=>{
 const f=await fixture()
 for(const restored of [false,true]){
  const inputEpoch=restored?await f.cut('same-cut'):undefined
  const result=await f.manager.callProgress('agent.progress.create',{target:f.target,intervalMs:60_000,prompt:'same cut',operationId:'create-'+String(inputEpoch),...(inputEpoch===undefined?{}:{inputEpoch})},{principal:{kind:'user',id:'human'}})
  await f.manager.pause(result.loop.loopId);await f.manager.resume(result.loop.loopId);await f.manager.checkNow(result.loop.loopId)
  expect(f.sent.at(-1)?.pendingCompletion?.condition?.inputEpoch).toBe(inputEpoch)
  await f.manager.stopLoop(result.loop.loopId)
 }
 expect(f.sent).toHaveLength(2)
})
it('public request and result codecs keep the original epoch and reject rewritten receipts',async()=>{
 const f=await fixture(),inputEpoch=await f.cut('codecs')
 const request={target:f.target,afterMs:60_000,prompt:'body',operationId:'codec-schedule',inputEpoch}
 expect(parseScheduleRpcParams('schedule.create',request)).toEqual(request)
 const receipt=await f.manager.call('schedule.create',request)
 expect(validateScheduleRpcResult('schedule.create',receipt,request)).toEqual(receipt)
 expect(()=>validateScheduleRpcResult('schedule.create',{...receipt,schedule:{...receipt.schedule,inputEpoch:'wrong'}},request)).toThrow()
 const p={target:f.target,intervalMs:60_000,prompt:'progress',operationId:'codec-progress',inputEpoch}
 expect(parseAgentProgressParams('agent.progress.create',p)).toEqual(p)
 const result=await f.manager.callProgress('agent.progress.create',p,{principal:{kind:'user',id:'human'}})
 expect(parseAgentProgressResult('agent.progress.create',result,p)).toEqual(result)
 expect(()=>parseAgentProgressResult('agent.progress.create',{...result,loop:{...result.loop,inputEpoch:'wrong'}},p)).toThrow()
})
it.each([undefined,'earlier-cut'])('Goal preparation copies the original savedStart epoch (%s) rather than its later observation',async inputEpoch=>{
 const f=await fixture();await f.cut('later-goal-cut');await f.manager.stop()
 const goal={id:'original-goal',title:'Original goal',description:'Original work',status:'active' as const,sessionIds:['recipient'],assigneeSessionIds:['recipient'],supervisorSessionId:'recipient',alignment:{revision:1,confirmedAt:1,criteria:[{id:'proof',text:'real result'}]}}
 const manager=new ContinuousProgressLoopManager(f.store,async()=>{throw Error('No initial dispatch')},()=>100,async(_loop,tickId)=>({session:f.client.agentSession('recipient'),observation:{process:'running',semantic:'idle',readiness:'ready',stale:false},now:100,tickId,inputByte:0,inputOccupied:false}) as never,undefined,{read:async()=>goal,inspectInitial:async()=> 'unconfirmed'})
 cleanup.push(()=>manager.stop())
 const request={...f.target,goalId:goal.id,alignmentRevision:1,intervalMs:60_000,operationId:'goal-birth',prompt:goal.description,...(inputEpoch===undefined?{}:{inputEpoch})}
 const prepared=await manager.prepareGoal(request)
 expect(prepared.inputEpoch).toBe(inputEpoch);expect(prepared.initialDelivery?.condition?.inputEpoch).toBe(inputEpoch)
 expect(prepared.initialDelivery?.condition?.expectedRun.runId).toBe('run-recipient')
 expect(await manager.prepareGoal(request)).toEqual(prepared)
 await expect(manager.prepareGoal({...request,inputEpoch:(await f.client.readAgentInputEpoch())!})).rejects.toMatchObject({code:'CONTROL_REQUEST_CONFLICT'})
 expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it.each([undefined,'original-birth-cut'])('Mote maintenance copies original creation birth (%s), and a later observation cannot renew its failed create',async inputEpoch=>{
 const f=await fixture(),currentEpoch=await f.cut('mote-later-cut')
 const {writeFile}=await import('node:fs/promises'),{AgentMuxSpatialStateStore}=await import('@agentmux/core')
 const {createHostMotePresence}=await import('../src/mote-presence.js'),{homeZoneId}=await import('../src/mote-model.js'),{SCRATCH_WORKSPACE_ID}=await import('../src/mote-topic-model.js')
 const configurationPath=join(f.root,'config.json');await writeFile(configurationPath,JSON.stringify({workspaces:[{id:SCRATCH_WORKSPACE_ID,hostId:'local',path:f.root}]}))
 const target={spaceId:'fixture-mote',zoneId:homeZoneId('fixture-mote'),expectedResource:{hostId:'local',workspaceId:SCRATCH_WORKSPACE_ID,workspacePath:f.root}}
 const spatial=new AgentMuxSpatialStateStore(join(f.root,'spatial.json'))
 await spatial.commit({expectedRevision:0,graph:{spaces:[{spaceId:target.spaceId,kind:'mote',name:'Fixture',hostId:'local',directoryPath:f.root,projectId:null,topicId:'fixture-mote'}],zones:[{zoneId:target.zoneId,workspaceId:SCRATCH_WORKSPACE_ID,kind:'home',hostId:'local',directoryPath:f.root,branch:null}],bindings:[{spaceId:target.spaceId,zoneId:target.zoneId}],tabs:[],regions:[],layouts:{},tabLayouts:{},resources:{}}})
 const resource={...target.expectedResource,zoneId:target.zoneId,zonePath:f.root,path:'MOTE.md'}
 const snapshot={target,identity:{hostId:'local',moteId:'fixture-mote'},status:'ready',resource,documentRevision:'original-file',roleRevision:'original-role',current:{hostId:'local',sessionId:'recipient',displayWorkspaceId:SCRATCH_WORKSPACE_ID,groupId:'g',tabId:'t',regionId:'r'},issue:null}
 const source=vi.spyOn(f.client,'inspectAgentCreation').mockResolvedValue({...f.client.agentSession('recipient'),creation:{inputEpoch}} as never)
 const files={read:async()=>({resource,result:{status:'read',document:{path:'MOTE.md',revision:'sha256:'+'0'.repeat(64),content:'---\nversion: 1\ndefaults:\n  presence:\n    enabled: true\n    intervalMs: 60000\n---\n'}}})}
 const calls=vi.spyOn(f.manager,'call')
 const presence=createHostMotePresence({configurationPath,spatial,files:files as never,main:{readCurrentMoteMain:async()=>structuredClone(snapshot),assertCurrent:async()=>{}} as never,schedules:f.manager,clients:f.coreClients});cleanup.push(async()=>presence.dispose())
 await f.manager.check(100);await f.manager.check(100)
 expect(source).toHaveBeenCalled();expect(f.manager.list()).toHaveLength(1)
 const original=f.manager.list()[0]!
 expect(original.inputEpoch).toBe(inputEpoch);expect(original.status).toBe('paused');expect(original.lastOutcome).toBe('unknown')
 source.mockResolvedValue({...f.client.agentSession('recipient'),creation:{inputEpoch:currentEpoch}} as never)
 f.now(10_000);presence.invalidate(target);await f.manager.check(10_000);await f.manager.check(10_000)
 const retained=f.manager.list()[0]!
 expect(retained.loopId).toBe(original.loopId);expect(retained.inputEpoch).toBe(inputEpoch);expect(retained.creationOperationId).toBe(original.creationOperationId)
 const attempts=calls.mock.calls.filter(([method])=>method==='schedule.create').map(([,p])=>(p as {inputEpoch?:string}).inputEpoch)
 expect(attempts.length).toBeGreaterThanOrEqual(2);expect(attempts.every(value=>value===inputEpoch)).toBe(true)
 expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
