// @vitest-environment happy-dom
import {act} from 'react'
import {beforeEach,expect,it,vi} from 'vitest'
import type {DemandSpaceMemberReference} from '@agentmux/demand/relations'
import type {Demand} from '@agentmux/demand'
import type {AgentMuxDemand} from '@agentmux/core/control'
import type {DemandProjection} from '../src/renderer/src/lib/global-demand-board'
import {GoalFiniteStartControl} from '../src/renderer/src/components/GoalFiniteStartControl'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {composerConfig,composerDOM,composerSession} from './helpers/composer-dom-fixture'
import {goalFiniteStartAccess,goalFiniteStartInspection,goalFiniteStartSubmission,readGoalFiniteStartIntent} from '../src/renderer/src/lib/goal-finite-start'

const dom=composerDOM()
const reference:DemandSpaceMemberReference={kind:'space-member',source:{runtimeId:'original-B',spaceId:'original-Space',regionId:'original-Region',admission:{kind:'creation',operationId:'original-C'}},execution:{runtimeId:'original-D',agentSessionId:'same-SID'}}
const goal=():DemandProjection & Demand & AgentMuxDemand=>({id:'qualified-finite-goal',title:'Original one-time Goal',description:'Frozen Goal body',status:'todo',priority:'normal',projectId:null,projectName:null,sessionIds:[reference],assigneeSessionIds:[reference],supervisorSessionId:null,createdAt:1,updatedAt:2,source:'default-topic',sessions:[],workspacePath:null,executorId:null,participations:[],tags:[],plannedStartAt:null,targetAt:null,parentDemandId:null,decisions:[],activities:[]})
beforeEach(()=>{
 useAppStore.setState({config:composerConfig,sessions:[composerSession('same-SID')],agentNames:{},timelines:{},goalAgentCreationDrafts:{},goalAgentSelectionDrafts:{},goalFiniteStartIntents:{},agentComposerDrafts:{'same-SID':'Original local unsent input'},demands:{}})
 vi.spyOn(api.demands,'onChanged').mockImplementation(()=>()=>{})
 vi.spyOn(api.sessions,'onEvent').mockImplementation(()=>()=>{})
})

it('the actual finite component checks a retained qualified operation through public Goal control with exact access, never the legacy same-SID path or Start',async()=>{
 const originalGoal=goal(),access={source:{hostId:'original-B-carrier'}},retained={goalId:originalGoal.id,operationId:'original-Start',agentReference:reference,access,expectedUpdatedAt:originalGoal.updatedAt,phase:'may-have-dispatched' as const}
 const dispatch={operationId:retained.operationId,target:reference,runId:'original-D-Run',execution:'finite' as const,prompt:'Frozen Goal body',agentMuxNote:'Original independent note',preparedAt:3,stage:'unknown' as const}
 const observed={...originalGoal,dispatches:[dispatch]},execute=vi.spyOn(api.goals,'execute').mockResolvedValue({operation:'demand.show',demand:observed,goalContinuations:[]})
 const inspectLegacy=vi.spyOn(api.demands,'inspectDispatch').mockResolvedValue(dispatch),reconcileLegacy=vi.spyOn(api.demands,'reconcileDispatch').mockResolvedValue({demand:observed})
 vi.spyOn(useAppStore.getState(),'refreshDemand').mockResolvedValue()
 // Native user-document ingress is untyped. This fixture exercises the new
 // private shape on the real existing component before its typed reader exists.
 useAppStore.setState({demands:{[originalGoal.id]:originalGoal},goalFiniteStartIntents:{[originalGoal.id]:retained as never}})
 const drafts=useAppStore.getState().agentComposerDrafts
 await dom.render(<GoalFiniteStartControl demand={observed} primary/>)
 await vi.waitFor(()=>expect(execute).toHaveBeenCalledWith(expect.objectContaining({operation:'demand.show',demandId:originalGoal.id,dispatchOperationId:retained.operationId,access})))
 const check=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Inspect original Start')!
 await act(async()=>check.click())
 expect(execute.mock.calls.every(([request])=>request.operation==='demand.show')).toBe(true)
 expect(inspectLegacy).not.toHaveBeenCalled();expect(reconcileLegacy).not.toHaveBeenCalled()
 expect(useAppStore.getState().goalFiniteStartIntents[originalGoal.id]).toEqual(retained)
 expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})

it('the original qualified request keeps its semantic member and operation while an explicit current carrier changes, without reconstructing Core input facts',()=>{
 const value={goalId:'original-goal',operationId:'original-OP',agentReference:reference,access:{source:{hostId:'original-B'}},accessDraft:{source:{hostId:'current-B'},coordinator:{hostId:'independent-original-D'}},expectedUpdatedAt:8,phase:'may-have-dispatched' as const}
 const saved=readGoalFiniteStartIntent(value,value.goalId)!
 expect(saved).toEqual(value);expect(value.access).toEqual({source:{hostId:'original-B'}})
 expect('agentReference' in saved&&saved.agentReference).toEqual(reference)
 const access=goalFiniteStartAccess(saved as Extract<typeof saved,{agentReference:unknown}>)
 expect(goalFiniteStartInspection(value.goalId,value.operationId,access)).toMatchObject({operation:'demand.show',dispatchOperationId:'original-OP',access:value.accessDraft})
 const resumed=goalFiniteStartSubmission(saved,access,true)
 expect(resumed).toEqual({schemaVersion:5,requestId:'original-OP',operation:'demand.start',demandId:'original-goal',agentReference:reference,access:value.accessDraft,resumeOriginal:true})
 for(const key of ['sessionId','continuation','prompt','agentMuxNote','runId','expectedRun','expectedUpdatedAt'])expect(resumed).not.toHaveProperty(key)
})

it('the typed private view does not interpret future fields, another Goal, raw/qualified collisions or an unreadable access as dispatch authority',()=>{
 const value={goalId:'original-goal',operationId:'original-OP',agentReference:reference,access:{source:{hostId:'B'}},expectedUpdatedAt:8,phase:'may-have-dispatched' as const}
 for(const raw of [{...value,future:{phase:9}},{...value,sessionId:'same-SID'},{...value,agentReference:'same-SID'},{...value,access:{source:{hostId:'B'},credentials:'not-an-access'}},{...value,phase:'future-phase'}]){
  const bytes=JSON.stringify(raw);expect(readGoalFiniteStartIntent(raw,value.goalId)).toBeUndefined();expect(JSON.stringify(raw)).toBe(bytes)
 }
 expect(readGoalFiniteStartIntent(value,'another-goal')).toBeUndefined()
})

it('the legacy request remains its original raw Session operation with its exact Goal version',()=>{
 const legacy={goalId:'legacy-goal',operationId:'legacy-OP',sessionId:'original-raw-SID',expectedUpdatedAt:4,phase:'not-attempted' as const}
 expect(readGoalFiniteStartIntent(legacy,legacy.goalId)).toEqual(legacy)
 expect(goalFiniteStartSubmission(legacy)).toEqual({schemaVersion:5,requestId:'legacy-OP',operation:'demand.start',demandId:'legacy-goal',sessionId:'original-raw-SID',expectedUpdatedAt:4})
 const withoutPhase={goalId:'legacy-goal',operationId:'legacy-OP',sessionId:'original-raw-SID',expectedUpdatedAt:4}
 expect(readGoalFiniteStartIntent(withoutPhase,withoutPhase.goalId)?.phase).toBe('may-have-dispatched')
 expect(withoutPhase).not.toHaveProperty('phase')
})

it('a current independent Coordinator can check the same private operation without fabricating Source, while explicit Resume still requires original Source access',()=>{
 const value={goalId:'original-goal',operationId:'original-OP',agentReference:reference,access:{source:{hostId:'original-B'}},accessDraft:{coordinator:{hostId:'original-D-current'}},expectedUpdatedAt:8,phase:'may-have-dispatched' as const}
 const bytes=JSON.stringify(value),saved=readGoalFiniteStartIntent(value,value.goalId)!
 expect(saved).toEqual(value)
 expect(saved.agentReference).toBeDefined()
 const access=goalFiniteStartAccess(saved as Extract<typeof saved,{agentReference:unknown}>)
 expect(goalFiniteStartInspection(saved.goalId,saved.operationId,access)).toMatchObject({operation:'demand.show',dispatchOperationId:'original-OP',access:{coordinator:{hostId:'original-D-current'}}})
 expect(()=>goalFiniteStartSubmission(saved,undefined,true)).toThrow()
 expect(JSON.stringify(value)).toBe(bytes)
})
