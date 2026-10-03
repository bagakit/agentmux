import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../../../packages/core/src/control-codec'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { useAppStore, agentSteerCanEdit, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SessionSnapshot } from '../src/shared/contracts'

const initial = useAppStore.getState()
const agent: Extract<SessionSnapshot, {kind:'agent'}> = {
 id:'pending-edit-session', promptSubmissionPredecessor:null, kind:'agent', providerId:'codex', executorId:'codex',hostId:'local',
 workspacePath:_hygiene_fixturePath("private-fixture"),label:'Pending edit',createdAt:1,updatedAt:1,agentSessionUpdatedAt:1,
 processState:'running',status:{state:'working',source:'native-hook',observedAt:1},latestOutputBytes:0,
 capabilities:{terminal:true,timeline:'complete-events',permission:'respond',providerResume:true,replyCorrelation:'none'},
 control:{kind:'agent',hostId:'local',agentSessionId:'pending-edit-session',run:{runId:'pending-edit-run'}}
}
function seed(): AgentSteerQueueEntry[] {
 useAppStore.setState({ sessions:[agent], agentSteerQueues:{}, agentSteerInFlight:{}, agentSteerInFlightPhase:{}, agentComposerDrafts:{[agent.id]:'keep bottom draft'} })
 for (const text of ['first unselected','second original','third unselected']) expect(useAppStore.getState().enqueueAgentSteer(agent.id,text,undefined,undefined,'manual','keep original note')).toBe(true)
 return useAppStore.getState().agentSteerQueues[agent.id]!
}
beforeEach(async () => {
 const close=await useAppStore.getState().initialize();close();useAppStore.setState(initial,true)
 vi.spyOn(api.sessions,'refresh').mockResolvedValue(agent)
})
afterEach(() => {useAppStore.setState(initial,true);vi.restoreAllMocks()})

describe('pending text is edited by its original queue owner',()=>{
 it('changes one body, preserving identity, target, order, facts and draft; saving never submits',async()=>{
  const before=seed();const target=before[1]!;const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  const next='edited second\nwith full contents'
  useAppStore.getState().editQueuedAgentSteer(agent.id,target.operationId,target.text,next)
  const queue=useAppStore.getState().agentSteerQueues[agent.id]!
  expect(queue).toEqual([before[0],{...target,text:next},before[2]])
  await new Promise(resolve=>setImmediate(resolve))
  expect(submit).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('keep bottom draft')
  await useAppStore.getState().sendQueuedAgentSteer(agent.id,target.operationId)
  expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.calls[0]!.slice(1,3)).toEqual([next,target.operationId])
  expect(useAppStore.getState().agentSteerQueues[agent.id]!.map(entry=>entry.operationId)).toEqual([before[0]!.operationId,before[2]!.operationId])
 })
 it('refuses stale text, unknown receipts and in-flight preparation without changing any message',()=>{
  const before=seed();const target=before[1]!
  expect(()=>useAppStore.getState().editQueuedAgentSteer(agent.id,target.operationId,'stale','new')).toThrow('changed while')
  for(const condition of [undefined,{expectedRun:agent.control.run,afterSubmissionId:null}]){
   const {promptCondition:_removed,...without}=target
   const entry=condition===undefined?without:{...target,promptCondition:condition}
   useAppStore.setState({agentSteerQueues:{[agent.id]:[before[0]!,entry,before[2]!]}})
   expect(agentSteerCanEdit(entry)).toBe(false)
   expect(()=>useAppStore.getState().editQueuedAgentSteer(agent.id,target.operationId,target.text,'new')).toThrow('original delivery is unknown')
   expect(useAppStore.getState().agentSteerQueues[agent.id]![1]).toEqual(entry)
  }
  useAppStore.setState({agentSteerQueues:{[agent.id]:before},agentSteerInFlight:{[agent.id]:target.operationId},agentSteerInFlightPhase:{[agent.id]:'preparing'}})
  expect(()=>useAppStore.getState().editQueuedAgentSteer(agent.id,target.operationId,target.text,'new')).toThrow('preparing')
  expect(useAppStore.getState().agentSteerQueues[agent.id]).toEqual(before)
 })
 it('keeps the original retired Run binding editable before admission, and rejects bad bodies or wrong identities',()=>{
  const before=seed();const target={...before[1]!,runId:'old-original-run'}
  useAppStore.setState({agentSteerQueues:{[agent.id]:[target]}})
  useAppStore.getState().editQueuedAgentSteer(agent.id,target.operationId,target.text,'changed for original target')
  expect(useAppStore.getState().agentSteerQueues[agent.id]![0]).toEqual({...target,text:'changed for original target'})
  for(const text of ['  ','null\0body','x'.repeat(17*1024*1024)]) expect(()=>useAppStore.getState().editQueuedAgentSteer(agent.id,target.operationId,'changed for original target',text)).toThrow()
  expect(()=>useAppStore.getState().editQueuedAgentSteer('other-session',target.operationId,target.text,'new')).toThrow('no longer available')
 })
 it('cannot change the message after the drain starts preparing during a pending async refresh',async()=>{
  const before=seed();const target=before[1]!;let release!:(value:typeof agent)=>void
  const refresh=vi.spyOn(api.sessions,'refresh').mockImplementation(()=>new Promise(resolve=>{release=resolve}))
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  const attempt=useAppStore.getState().sendQueuedAgentSteer(agent.id,target.operationId)
  await vi.waitFor(()=>expect(refresh).toHaveBeenCalled())
  expect(()=>useAppStore.getState().editQueuedAgentSteer(agent.id,target.operationId,target.text,'race')).toThrow('preparing')
  release(agent);await attempt;expect(submit.mock.calls[0]![1]).toBe(target.text)
 })
 it('strict public parameters and result identities cannot smuggle target, author or editable receipts',()=>{
  const base={schemaVersion:5,requestId:'edit-request',operation:'message.pending.edit',agentSessionId:agent.id,pendingId:'pending',expectedText:'before',text:'after'}
  expect(parseAgentMuxControlRequest(base)).toEqual(base)
  for(const extra of [{authorHuman:true},{runId:'another-run'},{caller:{agentSessionId:'forged'}}]) expect(()=>parseAgentMuxControlRequest({...base,...extra})).toThrow()
  expect(()=>parseAgentMuxControlReceipt({schemaVersion:5,requestId:'r',ok:true,operation:'message.pending.ls',result:{agentSessionId:agent.id,messages:[{pendingId:'x',text:'x',runId:agent.control.run.runId,enqueuedAt:1,status:'queued',phase:'submitting',editable:true,delivery:'unconfirmed'}]}})).toThrow()
 })
 it('requires transport-approved human mutation and refuses absent or Agent principals',async()=>{
  const before=seed(), target=before[1]!
  const service=new AgentMuxRpcService({execute:request=>useAppStore.getState().executeControl(request)})
  const params={agentSessionId:agent.id,pendingId:target.operationId,expectedText:target.text,text:'revised by user'}
  for(const context of [{},{principal:{kind:'agent',id:'claim'}},{principal:{kind:'user',id:''}},
   {principal:{kind:'user',id:'  '}},{principal:{kind:'device',id:'bad\0id'}},{principal:{kind:'device',id:1}},
   {principal:{kind:'user',id:'user'},caller:{agentSessionId:'claim',capability:'claim'}},
   {principal:{kind:'device',id:'device'},caller:{} }]) {
   await expect(service.call('message.pending.edit',params,context as any)).rejects.toMatchObject({code:'AGENT_CAPABILITY_INVALID'})
   expect(useAppStore.getState().agentSteerQueues[agent.id]).toEqual(before)
  }
  const result=await service.call('message.pending.edit',params,{principal:{kind:'device',id:'trusted-device'}})
  expect(result.message.text).toBe(params.text)
  await service.dispose()
 })
 it('does not claim submission when a failed message is subsequently removed from the local projection',async()=>{
  const before=seed(), target=before[1]!
  vi.spyOn(api.sessions,'submitPrompt').mockRejectedValue(new Error('delivery unknown'))
  const dispose=useAppStore.subscribe((state,previous)=>{
   if(previous.agentSteerInFlight[agent.id]===target.operationId && !state.agentSteerInFlight[agent.id]) useAppStore.setState(state => ({agentSteerQueues:{...state.agentSteerQueues,[agent.id]:(state.agentSteerQueues[agent.id] ?? []).filter(entry=>entry.operationId!==target.operationId)}}))
  })
  try {
   const result=await useAppStore.getState().executeControl({schemaVersion:5,requestId:'send-race',operation:'message.pending.send',agentSessionId:agent.id,pendingId:target.operationId})
   expect(result).toMatchObject({disposition:'unconfirmed',message:null})
  } finally {dispose()}
 })
 it('actual compiled CLI and typed RPC list/edit/send the same live Store, including a non-first message',async()=>{
  const before=seed(),target=before[1]!;const root=await mkdtemp(join(tmpdir(),'am-pending-'))
  const server=new AgentMuxControlServer({socketPath:join(root,'control.sock'),execute:request=>useAppStore.getState().executeControl(request)})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
  await server.start()
  const client=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  const run=async(args:string[])=>{
   const result=await runCompiledObjectCli(['--endpoint',`unix://${server.path}`,'message','pending',...args],objectCliEnvironment(root))
   expect(result.stderr).toBe('');expect(result.code).toBe(0);return JSON.parse(result.stdout).result
  }
  try{
   const listed=await run(['ls','--session',agent.id]);expect(listed.messages.map((item:{pendingId:string})=>item.pendingId)).toEqual(before.map(item=>item.operationId))
   const text='CLI revised second\nfull contents'
   const edited=await run(['edit','--session',agent.id,'--pending-id',target.operationId,'--expected-text',target.text,'--text',text])
   expect(edited.changed).toBe(true);expect(edited.message.text).toBe(text);expect(submit).not.toHaveBeenCalled()
   const observed=await client.call('message.pending.ls',{agentSessionId:agent.id})
   expect(observed.messages[1]!.text).toBe(text);expect(observed.messages[1]!.runId).toBe(target.runId)
   const sent=await run(['send','--session',agent.id,'--pending-id',target.operationId])
   expect(sent).toMatchObject({pendingId:target.operationId,disposition:'submitted',message:null})
   expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.calls[0]!.slice(1,3)).toEqual([text,target.operationId])
   expect(useAppStore.getState().agentSteerQueues[agent.id]!.map(item=>item.text)).toEqual([before[0]!.text,before[2]!.text])
  }finally{await client.dispose();await server.stop();await rm(root,{recursive:true})}
 },20000)
})
