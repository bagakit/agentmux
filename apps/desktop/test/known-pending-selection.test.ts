import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {useAppStore,type AgentSteerQueueEntry} from '../src/renderer/src/store'
import {api} from '../src/renderer/src/lib/api'
import {AgentMuxControlServer} from '../../../packages/core/src/public-rpc-server'
import {connectAgentMuxRpc} from '../../../packages/core/src/public-rpc-client'
import {objectCliEnvironment,runCompiledObjectCli} from '../../../packages/core/test/helpers/object-cli-rpc'
import type {SessionSnapshot} from '../src/shared/contracts'
const initial=useAppStore.getState(),sid='selected-session',runId='selected-run'
const base:Extract<SessionSnapshot,{kind:'agent'}>={id:sid,kind:'agent',providerId:'codex',executorId:'codex',hostId:'local',
 workspacePath:_hygiene_fixturePath("private"),label:'Original',createdAt:1,updatedAt:1,agentSessionUpdatedAt:1,promptSubmissionPredecessor:null,
 processState:'running',status:{state:'working',source:'native-hook',observedAt:1},latestOutputBytes:0,
 capabilities:{terminal:true,timeline:'complete-events',permission:'respond',providerResume:true,replyCorrelation:'none',promptExecution:{immediate:'native-steer'}},
 control:{kind:'agent',hostId:'local',agentSessionId:sid,run:{runId}}}
const pending=(kind:'permission'|'question'='permission'):typeof base=>({...base,pendingInteraction:{kind,id:'current-request',agentSessionId:sid,
 ...(kind==='permission'?{title:'Current permission',options:[{id:'allow',label:'Allow',kind:'allow-once' as const}]}:{questions:[{id:'question',prompt:'Current question',options:[{id:'yes',label:'Yes'}]}]}),
 evidence:{source:'native-hook',observedAt:2,run:{runId},hookReceiptId:'current-request'}}} as typeof base)
const entry=(id:string):AgentSteerQueueEntry=>({operationId:id,runId,text:'Full original '+id,agentMuxNote:'Original note',sourceChannel:'message-tool',enqueuedAt:100,promptCondition:null,status:'queued',origin:'manual'})
const queue=()=>useAppStore.getState().agentSteerQueues[sid]??[]
const send=(id='chosen')=>useAppStore.getState().executeControl({schemaVersion:5,requestId:'select-'+id,operation:'message.pending.send',agentSessionId:sid,pendingId:id})
function clearInteraction(){
 useAppStore.getState().applyEvent({type:'core',hostId:'local',event:{type:'agent-session',session:{kind:'agent',agentSessionId:sid,
 providerId:base.providerId,executorId:base.executorId,hostId:'local',workspacePath:base.workspacePath,run:{runId},retiredRuns:[],
 createdAt:1,updatedAt:Date.now(),semanticStatus:{state:'working',source:'native-hook',observedAt:Date.now()}}}})
}
beforeEach(async()=>{
 const dispose=await useAppStore.getState().initialize();dispose();useAppStore.setState(initial,true)
 useAppStore.setState({config:{version:9,hosts:[{id:'local',kind:'local',label:'Local'}],executors:{},workspaces:[{id:'w',name:'Private',hostId:'local',path:_hygiene_fixturePath("private"),kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}},
 sessions:[pending()],agentSteerQueues:{[sid]:[entry('first'),entry('chosen'),entry('tail')]},agentSteerInFlight:{},agentSteerInFlightPhase:{},
 agentComposerDrafts:{[sid]:'Keep current draft'},timelines:{}})
 vi.spyOn(api.sessions,'refresh').mockResolvedValue(base)
 vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue()
})
afterEach(async()=>{await useAppStore.getState().flushAgentSteerQueue(sid);useAppStore.setState(initial,true);vi.restoreAllMocks()})
it.each(['permission','question'] as const)('normally waits on current %s and keeps the exact nonhead selected tuple',async kind=>{
 useAppStore.setState({sessions:[pending(kind)]});const before=structuredClone(queue())
 expect(await send()).toMatchObject({operation:'message.pending.send',pendingId:'chosen',disposition:'unconfirmed',message:{delivery:'not-submitted',editable:true}})
 expect(queue()).toEqual([before[0],{...before[1],execution:'immediate'},before[2]])
 expect(api.sessions.refresh).not.toHaveBeenCalled();expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
 expect(api.ui.requestStorageFlush).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep current draft')
 expect(useAppStore.getState().agentSteerInFlight[sid]).toBeUndefined()
})
it('normally waits when the same-binding public refresh first reveals the pending interaction',async()=>{
 useAppStore.setState({sessions:[base]});vi.mocked(api.sessions.refresh).mockResolvedValue(pending())
 const before=structuredClone(queue());expect(await send()).toMatchObject({disposition:'unconfirmed',message:{delivery:'not-submitted'}})
 expect(queue()).toEqual([before[0],{...before[1],execution:'immediate'},before[2]])
 expect(api.sessions.refresh).toHaveBeenCalledTimes(1);expect(api.sessions.submitPrompt).not.toHaveBeenCalled();expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
})
it('the original interaction-clear event wakes only the exact chosen intent, retaining draft and all other records',async()=>{
 const tail=entry('tail'),unknown={...entry('unknown'),promptCondition:{expectedRun:{runId},afterSubmissionId:'old-claim'},execution:'immediate' as const,awaitingExplicitSend:true as const},
  paused={...entry('paused'),execution:'immediate' as const,awaitingExplicitSend:true as const}
 useAppStore.setState({agentSteerQueues:{[sid]:[entry('chosen'),tail,unknown,paused]}})
 await send();expect(api.sessions.submitPrompt).not.toHaveBeenCalled();clearInteraction()
 await useAppStore.getState().flushAgentSteerQueue(sid)
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
 expect(vi.mocked(api.sessions.submitPrompt).mock.calls[0]!.slice(1,3)).toEqual([entry('chosen').text,'chosen'])
 expect(vi.mocked(api.sessions.submitPrompt).mock.calls[0]![4]).toEqual({allowUncertainTurn:true,execution:'immediate'});expect(vi.mocked(api.sessions.submitPrompt).mock.calls[0]![6]).toBe(entry('chosen').agentMuxNote)
 expect(queue()).toEqual([tail,unknown,paused]);expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep current draft')
})
it('retains both exact concurrently selected waiting operations without lending permission to the tail',async()=>{
 const results=await Promise.all([send('first'),send('chosen')])
 expect(results).toEqual([expect.objectContaining({disposition:'unconfirmed'}),expect.objectContaining({disposition:'unconfirmed'})])
 expect(queue().map(x=>[x.operationId,x.execution,x.promptCondition])).toEqual([['first','immediate',null],['chosen','immediate',null],['tail',undefined,null]])
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})
it('consumes a real interaction-clear wake that arrives before an older pending refresh settles',async()=>{
 useAppStore.setState({sessions:[base]})
 let release!:(value:typeof base)=>void
 vi.mocked(api.sessions.refresh).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve})).mockResolvedValue(base)
 const chosen=send()
 await vi.waitFor(()=>expect(api.sessions.refresh).toHaveBeenCalledTimes(1))
 useAppStore.setState({sessions:[pending()]});clearInteraction();release(pending())
 expect(await chosen).toMatchObject({disposition:'submitted',message:null})
 expect(api.sessions.refresh).toHaveBeenCalledTimes(2);expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
 expect(queue().map(x=>x.operationId)).toEqual(['first','tail'])
})
it('does not convert a nonnull unknown operation into known-unsubmitted waiting',async()=>{
 const chosen={...entry('chosen'),promptCondition:{expectedRun:{runId},afterSubmissionId:'original-admission'},execution:'immediate' as const,awaitingExplicitSend:true as const}
 useAppStore.setState({agentSteerQueues:{[sid]:[chosen]}})
 vi.mocked(api.sessions.submitPrompt).mockRejectedValue(Object.assign(new Error('Exact pending race'),{code:'AGENT_INTERACTION_PENDING'}))
 await expect(send()).rejects.toMatchObject({code:'AGENT_INTERACTION_PENDING',logId:expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{12}$/)})
 expect(queue()[0]!.promptCondition).toEqual(chosen.promptCondition);expect(queue()[0]!.awaitingExplicitSend).toBe(true)
 clearInteraction();await useAppStore.getState().flushAgentSteerQueue(sid)
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1);expect(queue()[0]!.operationId).toBe('chosen')
})
it('checks the refreshed exact Run before treating a request as normal waiting',async()=>{
 useAppStore.setState({sessions:[base]})
 vi.mocked(api.sessions.refresh).mockResolvedValue({...pending(),control:{...base.control,run:{runId:'different-run'}}})
 await expect(send()).rejects.toThrow('Session binding changed')
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled();expect(queue()[1]!.promptCondition).toBeNull()
 expect(queue()[1]!.awaitingExplicitSend).toBe(true)
})
it('the actual compiled CLI and typed public RPC return the same original waiting record without Core input',async()=>{
 const root=await mkdtemp(join(tmpdir(),'amx-known-wait-'))
 const server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),execute:request=>useAppStore.getState().executeControl(request)})
 let rpc:Awaited<ReturnType<typeof connectAgentMuxRpc>>|undefined
 try{
  await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  const cli=await runCompiledObjectCli(['--endpoint','unix://'+server.path,'message','pending','send','--session',sid,'--pending-id','chosen'],objectCliEnvironment(root))
  expect(cli.code,cli.stderr).toBe(0);expect(cli.stderr).toBe('')
  const result=JSON.parse(cli.stdout).result
  expect(result).toMatchObject({pendingId:'chosen',disposition:'unconfirmed',message:{text:entry('chosen').text,delivery:'not-submitted',runId}})
  const read=await rpc.call('message.pending.ls',{agentSessionId:sid})
  expect(read.messages.find(x=>x.pendingId==='chosen')).toEqual(result.message)
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled();expect(queue()[1]!.promptCondition).toBeNull()
 }finally{await rpc?.dispose();await server.stop();await rm(root,{recursive:true})}
},20000)

it('the actual compiled CLI sends a never-dispatched original after its durable Session replaces the Run',async()=>{
 const stale={...entry('chosen'),runId:'retired-run',awaitingExplicitSend:true as const,status:'deferred' as const}
 const neighbors=[entry('first'),entry('tail')]
 useAppStore.setState({sessions:[base],agentSteerQueues:{[sid]:[neighbors[0]!,stale,neighbors[1]!]}})
 const root=await mkdtemp(join(tmpdir(),'amx-explicit-rebind-'))
 const server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),execute:request=>useAppStore.getState().executeControl(request)})
 let rpc:Awaited<ReturnType<typeof connectAgentMuxRpc>>|undefined
 try{
  await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  const before=await rpc.call('message.pending.ls',{agentSessionId:sid})
  expect(before.messages.find(x=>x.pendingId==='chosen')).toMatchObject({runId:'retired-run',editable:true,delivery:'not-submitted'})
  const cli=await runCompiledObjectCli(['--endpoint','unix://'+server.path,'message','pending','send','--session',sid,'--pending-id','chosen'],objectCliEnvironment(root))
  expect(cli.code,cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toMatchObject({pendingId:'chosen',disposition:'submitted',message:null})
  expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls[0]!.slice(0,4)).toEqual([base.control,stale.text,'chosen',{expectedRun:base.control.run,afterSubmissionId:null}])
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls[0]![6]).toBe(stale.agentMuxNote)
  expect(queue()).toEqual(neighbors)
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Keep current draft')
  expect((await rpc.call('message.pending.ls',{agentSessionId:sid})).messages.map(x=>x.pendingId)).toEqual(['first','tail'])
 }finally{await rpc?.dispose();await server.stop();await rm(root,{recursive:true})}
},20000)

it('keeps a freshly selected old-Run intent waiting on the current interaction without losing its execution choice',async()=>{
 const stale={...entry('chosen'),runId:'retired-run',awaitingExplicitSend:true as const}
 useAppStore.setState({agentSteerQueues:{[sid]:[stale]}})
 expect(await send()).toMatchObject({disposition:'unconfirmed',message:{runId,delivery:'not-submitted'}})
 expect(queue()).toEqual([{...stale,runId,awaitingExplicitSend:undefined,execution:'immediate'}])
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
 clearInteraction();await useAppStore.getState().flushAgentSteerQueue(sid)
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
 expect(vi.mocked(api.sessions.submitPrompt).mock.calls[0]![4]).toEqual({allowUncertainTurn:true,execution:'immediate'})
 expect(queue()).toEqual([])
})

it('retains a never-dispatched message through another Run change during refresh and accepts a later explicit retry',async()=>{
 const stale={...entry('chosen'),runId:'retired-run',awaitingExplicitSend:true as const}
 const next={...base,control:{...base.control,run:{runId:'next-run'}}}
 useAppStore.setState({sessions:[base],agentSteerQueues:{[sid]:[stale]}})
 vi.mocked(api.sessions.refresh).mockImplementationOnce(async()=>{useAppStore.setState({sessions:[next]});return next})
 await expect(send()).rejects.toThrow('Session binding changed')
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
 expect(queue()[0]).toMatchObject({operationId:'chosen',text:stale.text,promptCondition:null,awaitingExplicitSend:true})
 vi.mocked(api.sessions.refresh).mockResolvedValue(next)
 expect(await send()).toMatchObject({disposition:'submitted'})
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
 expect(vi.mocked(api.sessions.submitPrompt).mock.calls[0]![3]).toEqual({expectedRun:next.control.run,afterSubmissionId:null})
})
