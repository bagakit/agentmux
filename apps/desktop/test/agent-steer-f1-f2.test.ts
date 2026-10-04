import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore,type AgentSteerQueueEntry} from '../src/renderer/src/store'
import type {SessionSnapshot} from '../src/shared/contracts'

type Agent = Extract<SessionSnapshot,{kind:'agent'}>
type Immediate = 'native-steer'|'interrupt-before-input'|undefined
const initial=useAppStore.getState(),sid='f1-f2-original-session',oldRun='f1-f2-ended-run',newRun='f1-f2-restored-run'
const originalBody='Full original body\n第二行',originalNote='Preserve the original note',draft='Keep this distinct current draft'
const agent=(runId:string,immediate:Immediate,running=true):Agent=>({
 id:sid,kind:'agent',providerId:'synthetic-f1-f2',executorId:'synthetic-f1-f2',hostId:'local',
 workspacePath:_hygiene_fixturePath("private-f1-f2"),label:'Original workface',createdAt:1,updatedAt:1,agentSessionUpdatedAt:1,
 promptSubmissionPredecessor:runId===newRun?'restored-predecessor':null,
 processState:running?'running':'exited',status:{state:running?'working':'done',source:'native-hook',observedAt:1},latestOutputBytes:0,
 capabilities:{terminal:true,timeline:'complete-events',permission:'respond',providerResume:true,replyCorrelation:'none',
  ...(immediate?{promptExecution:{immediate}}:{})},control:{kind:'agent',hostId:'local',agentSessionId:sid,run:{runId}}
})
const entry=(operationId:string):AgentSteerQueueEntry=>({operationId,text:originalBody,agentMuxNote:originalNote,
 sourceChannel:'message-tool',origin:'manual',enqueuedAt:1234,promptCondition:null,status:'queued'})
const selected=()=>useAppStore.getState().agentSteerQueues[sid]!.find(item=>item.operationId==='selected')!
const queue=()=>useAppStore.getState().agentSteerQueues[sid]??[]
const tracked:Array<Promise<unknown>>=[]
const release:Array<()=>void>=[]
const send=()=>{const promise=useAppStore.getState().sendQueuedAgentSteer(sid,'selected');tracked.push(promise);return promise}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
function seed(immediate:Immediate){
 const stopped=agent(oldRun,immediate,false)
 const head={...entry('queue-only-head'),runId:oldRun,text:'Unselected older head'},
  tail={...entry('paused-tail'),runId:oldRun,text:'Boot-paused tail',awaitingExplicitSend:true as const}
 useAppStore.setState({sessions:[stopped],agentSteerQueues:{[sid]:[head,entry('selected'),tail]},
  agentComposerDrafts:{[sid]:draft},agentSteerInFlight:{},agentSteerInFlightPhase:{},timelines:{}})
 // The actual recovery owner requires the existing attached original workface.
 useAppStore.getState().selectSession(sid)
 return {head,tail,tabs:structuredClone(useAppStore.getState().tabs),layout:structuredClone(useAppStore.getState().layouts)}
}
function expectRetained(original:ReturnType<typeof seed>){
 expect(queue().filter(item=>item.operationId!=='selected')).toEqual([original.head,original.tail])
 expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(draft)
 expect(useAppStore.getState().tabs).toEqual(original.tabs)
 expect(useAppStore.getState().layouts).toEqual(original.layout)
 expect(useAppStore.getState().agentSteerInFlight[sid]).toBeUndefined()
 expect(useAppStore.getState().agentSteerInFlightPhase[sid]).toBeUndefined()
}
beforeEach(async()=>{
 const dispose=await useAppStore.getState().initialize();dispose();useAppStore.setState(initial,true)
 useAppStore.setState({config:{version:9,hosts:[{id:'local',kind:'local',label:'Local'}],executors:{},
  workspaces:[{id:'f1-f2-workspace',name:'Original',hostId:'local',path:_hygiene_fixturePath("private-f1-f2"),kind:'folder'}],
  appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}})
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue()
 vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue()
})
afterEach(async()=>{
 for(const done of release)done()
 await Promise.allSettled(tracked);tracked.length=0;release.length=0
 useAppStore.setState(initial,true);vi.restoreAllMocks()
})

it.each([
 {mode:'default' as const,original:undefined,fresh:'native-steer' as const},
 {mode:'immediate' as const,original:'native-steer' as const,fresh:'interrupt-before-input' as const}
])('F1 freezes original $mode before recovery and keeps it across fresh capability changes',async({mode,original,fresh})=>{
 const before=seed(original),recovered=agent(newRun,fresh),recovery=deferred<Awaited<ReturnType<typeof api.sessions.recover>>>()
 const recover=vi.spyOn(api.sessions,'recover').mockReturnValue(recovery.promise)
 vi.spyOn(api.sessions,'refresh').mockResolvedValue(recovered)
 release.push(()=>recovery.resolve({kind:'resumed',session:recovered}))
 const result=send()
 // This assertion is synchronous: the selected execution must precede every recovery await.
 expect(selected()).toEqual({...entry('selected'),execution:mode})
 await vi.waitFor(()=>expect(recover).toHaveBeenCalledTimes(1))
 expect(recover.mock.calls[0]).toEqual([agent(oldRun,original,false).control,_hygiene_fixturePath("private-f1-f2"),'selected'])
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
 recovery.resolve({kind:'resumed',session:recovered})
 expect(await result).toBe('submitted')
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
 const call=vi.mocked(api.sessions.submitPrompt).mock.calls[0]!
 expect(call.slice(0,4)).toEqual([recovered.control,originalBody,'selected',
  {expectedRun:recovered.control.run,afterSubmissionId:'restored-predecessor'}])
 expect(call[4]).toEqual(mode==='immediate'?{allowUncertainTurn:true,execution:'immediate'}:{allowUncertainTurn:true})
 expect(call.slice(5,8)).toEqual([true,originalNote,'message-tool'])
 expect(queue()).toEqual([before.head,before.tail]);expectRetained(before)
 // A later background wake grants neither the old head nor the boot-paused tail permission.
 await useAppStore.getState().flushAgentSteerQueue(sid)
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
})

it('F1 refuses an unsupported fresh immediate capability while preserving null original intent and the restored Run',async()=>{
 const before=seed('native-steer'),recovered=agent(newRun,'native-steer'),fresh=agent(newRun,undefined)
 vi.spyOn(api.sessions,'recover').mockResolvedValue({kind:'resumed',session:recovered})
 vi.spyOn(api.sessions,'refresh').mockResolvedValue(fresh)
 await expect(send()).rejects.toThrow('original immediate-send capability is unconfirmed')
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
 expect(selected()).toMatchObject({...entry('selected'),runId:newRun,execution:'immediate',promptCondition:null,status:'deferred',awaitingExplicitSend:true})
 expect(selected().logId).toMatch(/^delivery-/)
 expect(useAppStore.getState().sessions.find(item=>item.id===sid)?.control.run.runId).toBe(newRun)
 expectRetained(before)
 await useAppStore.getState().flushAgentSteerQueue(sid)
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('F2 restores known null only when fresh condition was saved locally and storage failed before the submit call',async()=>{
 const before=seed('native-steer'),recovered=agent(newRun,'native-steer')
 vi.spyOn(api.sessions,'recover').mockResolvedValue({kind:'resumed',session:recovered})
 vi.spyOn(api.sessions,'refresh').mockResolvedValue(recovered)
 const freshCondition={expectedRun:recovered.control.run,afterSubmissionId:'restored-predecessor'}
 const flush=vi.mocked(api.ui.requestStorageFlush).mockResolvedValueOnce().mockImplementationOnce(async()=>{
  expect(selected()).toMatchObject({promptCondition:freshCondition,execution:'immediate',runId:newRun})
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  throw new Error('Exact local save failed after fresh binding')
 })
 await expect(send()).rejects.toThrow('Exact local save failed after fresh binding')
 expect(flush).toHaveBeenCalledTimes(2)
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
 expect(selected()).toMatchObject({...entry('selected'),runId:newRun,execution:'immediate',promptCondition:null,
  status:'deferred',awaitingExplicitSend:true,error:expect.stringContaining('Exact local save failed')})
 expect(selected().logId).toMatch(/^delivery-/);expectRetained(before)
 await useAppStore.getState().flushAgentSteerQueue(sid)
 expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('F2 preserves the original nonnull condition and operation once submit starts and its reply is lost',async()=>{
 const before=seed('native-steer'),recovered=agent(newRun,'native-steer')
 vi.spyOn(api.sessions,'recover').mockResolvedValue({kind:'resumed',session:recovered})
 vi.spyOn(api.sessions,'refresh').mockResolvedValue(recovered)
 const freshCondition={expectedRun:recovered.control.run,afterSubmissionId:'restored-predecessor'}
 vi.mocked(api.sessions.submitPrompt).mockImplementation(async(control,text,operationId,condition,options)=>{
  expect([control,text,operationId,condition,options]).toEqual([recovered.control,originalBody,'selected',freshCondition,
   {allowUncertainTurn:true,execution:'immediate'}])
  expect(selected().promptCondition).toEqual(freshCondition)
  throw new Error('Original submit reply was lost after the call began')
 })
 await expect(send()).rejects.toThrow('Original submit reply was lost after the call began')
 expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(2)
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
 expect(selected()).toMatchObject({...entry('selected'),runId:newRun,execution:'immediate',promptCondition:freshCondition,
  status:'deferred',awaitingExplicitSend:true,error:expect.stringContaining('Original submit reply was lost')})
 expect(selected().logId).toMatch(/^delivery-/);expectRetained(before)
 await useAppStore.getState().flushAgentSteerQueue(sid)
 expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
 expect(selected().promptCondition).toEqual(freshCondition)
})
