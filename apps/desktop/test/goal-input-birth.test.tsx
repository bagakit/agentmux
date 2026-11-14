// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { GoalFiniteStartControl } from '../src/renderer/src/components/GoalFiniteStartControl'
import { api } from '../src/renderer/src/lib/api'
import { retainGoalFiniteStartIntent, useAppStore } from '../src/renderer/src/store'
import { goalFiniteStartSubmission, readGoalFiniteStartIntent } from '../src/renderer/src/lib/goal-finite-start'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { chooseField } from './helpers/selection-field'
const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
afterEach(async () => { await dom.render(<></>); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const reference: DemandSpaceMemberReference = { kind:'space-member', source:{ runtimeId:'original-source',spaceId:'original-space',regionId:'original-region',admission:{kind:'association',operationId:'original-association'} },execution:{runtimeId:'original-executor',agentSessionId:'original-SID'} }
function goal(): DemandProjection { return {id:'qualified-birth',title:'One task',description:'Original user task',status:'todo',priority:'normal',projectId:null,projectName:null,sessionIds:[reference],assigneeSessionIds:[reference],supervisorSessionId:null,createdAt:1,updatedAt:2,source:'default-topic',sessions:[],workspacePath:null,executorId:null,participations:[],tags:[],plannedStartAt:null,targetAt:null,parentDemandId:null,decisions:[],activities:[]} }
function Finite({id}:{id:string}) { const current=useAppStore(s=>s.demands[id]); return current?<GoalFiniteStartControl demand={current}/>:null }
async function setup() {
 const root = await mkdtemp('/tmp/amux-goal-birth-'); cleanup.push(()=>rm(root,{recursive:true,force:true}))
 const reader = vi.fn(async () => ({runtimeId:reference.execution.runtimeId,inputEpoch:'original-qualified-cut'}))
 const server = new AgentMuxControlServer({socketPath:join(root,'owner.sock'),goalInputEpoch:reader,goalControl:async()=>({operation:'demand.show',demand:null,goalContinuations:[]})}); await server.start(); cleanup.push(()=>server.stop())
 // registerIpc and preload are original. Only this Unix owner's namespace leaf
 // is controlled; no provider/Run creation is part of the association UI proof.
 bridge.publicCoreEndpointPath=server.path
 const f = await owningBridge(undefined, {publicCoreEndpointPath:server.path}); cleanup.push(f.dispose)
 return {reader,server,f}
}
function renderState(current=goal(), saved?:unknown) {
 useAppStore.setState({config:{...composerConfig,hosts:[...composerConfig.hosts,{id:'independent',kind:'local',label:'Independent Agent'}]},demands:{[current.id]:current},sessions:[],agentNames:{},timelines:{},goalFiniteStartIntents:saved===undefined?{}:{[current.id]:saved}})
 vi.spyOn(api.ui,'requestStorageFlush').mockResolvedValue(undefined)
 vi.spyOn(api.demands,'onChanged').mockImplementation(()=>()=>{}); vi.spyOn(api.sessions,'onEvent').mockImplementation(()=>()=>{})
 vi.spyOn(useAppStore.getState(),'refreshDemand').mockResolvedValue()
 return current
}
async function select(label:string,hostId:string) { const field=dom.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; expect(field).not.toBeNull(); await chooseField(field,JSON.stringify({hostId})) }

it('two association connection choices stay a form until the exact Main Unix namespace read, then freeze one new operation',async()=>{
 const {reader,f}=await setup()
 const current=renderState(); vi.spyOn(api.demands,'inputEpoch').mockImplementation(bridge.api!.demands.inputEpoch)
 await dom.render(<Finite id={current.id}/>);
 await select('Project connection for original-space','local')
 expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toMatchObject({phase:'selecting-access',accessDraft:{source:{hostId:'local'}}})
 expect(useAppStore.getState().goalFiniteStartIntents[current.id]).not.toHaveProperty('operationId'); expect(reader).not.toHaveBeenCalled()
 await select('Coordinator connection for original-executor','independent')
 await vi.waitFor(()=>expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toMatchObject({phase:'not-attempted',inputEpoch:'original-qualified-cut'}))
 const saved=readGoalFiniteStartIntent(useAppStore.getState().goalFiniteStartIntents[current.id],current.id)!
 expect(reader).toHaveBeenCalledExactlyOnceWith({agentReference:reference,access:{source:{hostId:'local'},coordinator:{hostId:'independent'}}},expect.anything())
 expect(goalFiniteStartSubmission(saved)).toMatchObject({operation:'demand.start',requestId:saved.operationId,inputEpoch:'original-qualified-cut',agentReference:reference})
 expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.client.submitAgentPrompt).not.toHaveBeenCalled()
})

it('editing an old operation never renews its missing input cut; Store rejects a fresh-cut upgrade',async()=>{
 const old={goalId:goal().id,operationId:'original-old-OP',agentReference:reference,access:{source:{hostId:'local'},coordinator:{hostId:'independent'}},expectedUpdatedAt:2,phase:'not-attempted' as const}
 const current=renderState(goal(),old),reader=vi.spyOn(api.demands,'inputEpoch').mockResolvedValue({runtimeId:reference.execution.runtimeId,inputEpoch:'wrong-later-cut'})
 await dom.render(<Finite id={current.id}/>); await select('Project connection for original-space','independent')
 const saved=useAppStore.getState().goalFiniteStartIntents[current.id]
 expect(saved).toMatchObject({operationId:old.operationId,accessDraft:{source:{hostId:'independent'}}}); expect(saved).not.toHaveProperty('inputEpoch'); expect(reader).not.toHaveBeenCalled()
 await expect(retainGoalFiniteStartIntent({...old,inputEpoch:'wrong-later-cut'},saved)).rejects.toThrow('cannot be replaced')
 expect(goalFiniteStartSubmission(readGoalFiniteStartIntent(saved,current.id)!)).not.toHaveProperty('inputEpoch')
})

it('a wrong Runtime namespace reply retains the no-operation form and never prepares a task',async()=>{
 const current=renderState(),reader=vi.spyOn(api.demands,'inputEpoch').mockResolvedValue({runtimeId:'another-runtime',inputEpoch:'another-cut'})
 await dom.render(<Finite id={current.id}/>); await select('Project connection for original-space','local'); await select('Coordinator connection for original-executor','independent')
 expect(reader).toHaveBeenCalledTimes(1); expect(useAppStore.getState().goalFiniteStartIntents[current.id]).toMatchObject({phase:'selecting-access'})
 expect(useAppStore.getState().goalFiniteStartIntents[current.id]).not.toHaveProperty('operationId'); expect(dom.container.textContent).toContain('another original Agent Runtime')
})

it('connection drafts have no submit authority and opaque/private input is preserved by the original reader',()=>{
 const draft={goalId:'g',agentReference:reference,expectedUpdatedAt:2,phase:'selecting-access' as const,accessDraft:{source:{hostId:'local'}}}
 expect(readGoalFiniteStartIntent(draft,'g')).toEqual(draft); expect(()=>goalFiniteStartSubmission(draft)).toThrow('connections')
 for(const raw of [{...draft,operationId:'invented'},{...draft,inputEpoch:'invented'},{...draft,future:true}]) expect(readGoalFiniteStartIntent(raw,'g')).toBeUndefined()
})

it('Main forwards the original Goal dispatch cut rather than the latest condition cut, including original absence',async()=>{
 const {f}=await setup(), forwarded=vi.fn(async()=>{throw Error('Controlled public Goal intake')})
 vi.spyOn(f.runtime,'inspectGoalAttention').mockResolvedValue(null as never)
 vi.spyOn(f.runtime,'callOriginalCore').mockImplementation(async(_host,method,params)=>{ if(method==='goal.start')return await forwarded(params); throw Error('Unrelated fixture Goal observation') })
 for(const inputEpoch of ['original-demand-cut',undefined]){
  await bridge.api!.sessions.submitPrompt(control,'Original Goal input','same-Goal-OP',{expectedRun:control.run,afterSubmissionId:null,inputEpoch:'later-condition-cut'},undefined,false,undefined,'api',undefined,undefined,{goalId:'original-goal',operationId:'same-Goal-OP',...(inputEpoch===undefined?{}:{inputEpoch})})
  expect(forwarded).toHaveBeenCalled()
  if(inputEpoch===undefined)expect(forwarded.mock.calls.at(-1)![0]).not.toHaveProperty('inputEpoch')
  else expect(forwarded.mock.calls.at(-1)![0]).toMatchObject({inputEpoch,operationId:'same-Goal-OP'})
 }
 expect(f.client.submitAgentPrompt).not.toHaveBeenCalled()
})
