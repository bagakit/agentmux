// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest'
import {useAppStore,retainGoalFiniteStartIntent,clearGoalFiniteStartIntent} from '../src/renderer/src/store'
import {readGoalFiniteStartIntent} from '../src/renderer/src/lib/goal-finite-start'
import {goalNextStepFact,goalHasOriginalWork} from '../src/renderer/src/lib/goal-presentation'
import {createGoalRetainedStartsSelector} from '../src/renderer/src/lib/goal-navigation'
import {groupGoals} from '../src/renderer/src/lib/goal-groups'
import {GoalWorkArea} from '../src/renderer/src/components/GoalWorkArea'
import {api} from '../src/renderer/src/lib/api'
import type {DemandProjection} from '../src/renderer/src/lib/global-demand-board'
import type {DemandSpaceMemberReference} from '@agentmux/demand/relations'
import {composerDOM,composerSession} from './helpers/composer-dom-fixture'
const dom=composerDOM(),reference:DemandSpaceMemberReference={kind:'space-member',source:{runtimeId:'B',spaceId:'Space',regionId:'Region',admission:{kind:'association',operationId:'original-L'}},execution:{runtimeId:'independent-A',agentSessionId:'same-SID'}}
const goal:DemandProjection={id:'private-Goal',title:'Retained task',description:'Goal body',status:'todo',priority:'normal',projectId:null,projectName:null,sessionIds:[reference],assigneeSessionIds:[reference],supervisorSessionId:null,createdAt:1,updatedAt:2,source:'default-topic',sessions:[],workspacePath:null}
const retained=()=>({goalId:goal.id,operationId:'original-OP',agentReference:reference,access:{source:{hostId:'original-B'},coordinator:{hostId:'original-A'}},expectedUpdatedAt:2,phase:'may-have-dispatched' as const})
it('original partialize → JSON → merge preserves supported legacy/qualified and opaque entries without hydration normalization',()=>{
 const legacy={goalId:'legacy',operationId:'legacy-OP',sessionId:'raw-SID',expectedUpdatedAt:1},entries={legacy,[goal.id]:retained(),future:{kind:'future',version:9,request:{operationId:'future-OP',draft:'Keep opaque input'}},nothing:null}
 const options=useAppStore.persist.getOptions(),original={...useAppStore.getState(),goalFiniteStartIntents:entries},serialized=JSON.stringify(options.partialize!(original))
 const restored=options.merge!(JSON.parse(serialized),useAppStore.getState())
 expect(restored.goalFiniteStartIntents).toEqual(entries)
 expect(restored.goalFiniteStartIntents.legacy).not.toHaveProperty('phase')
 expect(readGoalFiniteStartIntent(restored.goalFiniteStartIntents[goal.id],goal.id)?.agentReference).toEqual(reference)
})
it('private CAS rejects a stale producer and cannot clear newer same-OP input or overwrite an opaque original',async()=>{
 const original=retained(),newer={...original,accessDraft:{coordinator:{hostId:'current-independent-A'}}}
 useAppStore.setState({goalFiniteStartIntents:{[goal.id]:newer}})
 let refusal:unknown
 await retainGoalFiniteStartIntent({...original,phase:'not-attempted'},original).catch(error=>{refusal=error})
 expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toBe(newer)
 expect(refusal).toBeInstanceOf(Error);expect((refusal as Error).message).toContain('newer private input')
 await clearGoalFiniteStartIntent(goal.id,original.operationId,original)
 expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toBe(newer)
 const opaque={kind:'future',operationId:original.operationId,request:{draft:'Keep this original opaque input'}}
 useAppStore.setState({goalFiniteStartIntents:{[goal.id]:opaque}})
 await expect(retainGoalFiniteStartIntent(original,opaque)).rejects.toThrow('cannot be replaced')
 expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toBe(opaque)
})
it('the actual original Work area and list/group projection keep an opaque input visible and qualified intent never becomes a raw same-SID source',async()=>{
 const opaque={kind:'future',operationId:'opaque-OP',input:{draft:'Original future user input'}},execute=vi.spyOn(api.goals,'execute')
 useAppStore.setState({goalFiniteStartIntents:{[goal.id]:opaque},demands:{[goal.id]:goal},sessions:[composerSession('same-SID')]})
 const sessions=useAppStore.getState().sessions,drafts=useAppStore.getState().agentComposerDrafts,select=createGoalRetainedStartsSelector([goal]),selected=select(useAppStore.getState())
 expect(selected[goal.id]).toBe(opaque);expect(select(useAppStore.getState())).toBe(selected)
 expect(groupGoals([goal],()=>false,id=>selected[id])[0]?.stage).toBe('unknown')
 expect(goalHasOriginalWork(goal,opaque)).toBe(true)
 expect(goalNextStepFact(goal,retained()).source).toEqual({kind:'start',operationId:'original-OP',agentReference:reference})
 await dom.render(<GoalWorkArea demand={goal} active={false}/>)
 const service=[...dom.container.querySelectorAll('[role="status"]')].find(node=>node.textContent?.includes('Original Start input is retained but cannot be read'))
 expect(service).toBeDefined();expect(service!.closest('details:not([open])')).toBeNull()
 expect(execute).not.toHaveBeenCalled();expect(useAppStore.getState().goalFiniteStartIntents[goal.id]).toBe(opaque)
 expect(useAppStore.getState().sessions).toBe(sessions);expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
})
