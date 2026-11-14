// @vitest-environment happy-dom
import {act} from 'react'
import {beforeEach,expect,it,vi} from 'vitest'
import {demandAgentReferenceKey,type DemandSpaceMemberReference} from '@agentmux/demand/relations'
import {GoalAgentPicker} from '../src/renderer/src/components/GoalAgentPicker'
import {GoalFiniteStartControl} from '../src/renderer/src/components/GoalFiniteStartControl'
import {GoalExecution} from '../src/renderer/src/components/GoalExecution'
import {WorkbenchPresentationContext} from '../src/renderer/src/lib/workbench-presentation'
import {retainGoalAgentSelectionDraft,useAppStore} from '../src/renderer/src/store'
import {api} from '../src/renderer/src/lib/api'
import type {DemandProjection} from '../src/renderer/src/lib/global-demand-board'
import {composerConfig,composerDOM} from './helpers/composer-dom-fixture'
import {providerCatalogReader,historySourcesReader} from './helpers/startup-observation-api-fixture'
import {readGoalAgentSelectionDraft} from '../src/renderer/src/lib/goal-agent-selection'
import type {GoalRelationSave} from '../src/renderer/src/components/GoalAgentPicker'
const dom=composerDOM(),key='agentmux-workbench-v1'
const reference:DemandSpaceMemberReference={kind:'space-member',source:{runtimeId:'B',spaceId:'S',regionId:'R',admission:{kind:'creation',operationId:'C'}},execution:{runtimeId:'D',agentSessionId:'SID'}}
const goal:DemandProjection={id:'draft-goal',title:'Original Goal',description:'',status:'todo',priority:'normal',projectId:null,projectName:null,sessionIds:[reference],assigneeSessionIds:[reference],supervisorSessionId:null,createdAt:1,updatedAt:1,source:'default-topic',sessions:[],workspacePath:null}
beforeEach(()=>{localStorage.clear();useAppStore.setState({config:composerConfig,sessions:[],goalAgentSelectionDrafts:{},goalAgentCreationDrafts:{},goalFiniteStartIntents:{},agentComposerDrafts:{original:'Keep original input'}});vi.spyOn(api.sessions,'onEvent').mockImplementation(()=>()=>{});vi.spyOn(useAppStore.getState(),'executeControl').mockResolvedValue({operation:'demand.show',demand:null} as never)})
async function initialize(){
 vi.spyOn(api.config,'get').mockResolvedValue(composerConfig)
 vi.spyOn(api.providers,'list').mockImplementation(providerCatalogReader())
 vi.spyOn(api.sessions,'historySources').mockImplementation(historySourcesReader())
 vi.spyOn(api.sessions,'snapshot').mockResolvedValue({sessions:[],timelines:{},recoveryCandidates:[]})
 vi.spyOn(api.demands,'list').mockResolvedValue([])
 return await useAppStore.getState().initialize()
}

it('actual Store hydration and an unrelated checkpoint retain an opaque original selection and its neighbors',async()=>{
 const draftKey=JSON.stringify([goal.id,'assignees']),future={goalId:goal.id,role:'assignees',selected:[{...reference,futureAdmission:{original:'unreadable here'}}],expectedUpdatedAt:1,originalUnsentNote:'Keep this original choice'},neighbor={arbitrary:'opaque neighbor',originalOperation:'OP'}
 const raw={[draftKey]:future,'future-neighbor':neighbor}
 localStorage.setItem(key,JSON.stringify({state:{goalAgentSelectionDrafts:raw},version:1}))
 await useAppStore.persist.rehydrate()
 const dispose=await initialize()
 try {
 const checkpoint=await retainGoalAgentSelectionDraft({goalId:'unrelated-goal',role:'related',selected:['legacy-other'],expectedUpdatedAt:1})
 expect(checkpoint.clientStateWritten,checkpoint.reason??'Checkpoint unavailable').toBe(true)
 const saved=JSON.parse(localStorage.getItem(key)!).state.goalAgentSelectionDrafts
 expect(saved[JSON.stringify(['unrelated-goal','related'])]).toMatchObject({selected:['legacy-other']})
 expect(saved[draftKey]).toEqual(future);expect(saved['future-neighbor']).toEqual(neighbor)
 const onSave=vi.fn(async()=>true)
 await dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={onSave} onClose={()=>{}}/>)
 expect(document.body.textContent).toContain('original selection')
 expect(document.querySelector('.goal-agent-picker button[type="submit"]')).toBeNull()
 expect(onSave).not.toHaveBeenCalled();expect(useAppStore.getState().executeControl).not.toHaveBeenCalled()
 expect(JSON.parse(localStorage.getItem(key)!).state.goalAgentSelectionDrafts[draftKey]).toEqual(future)
 } finally {dispose()}
})

it('real Picker and finite Start distinguish a raw reference equal to a qualified semantic key',async()=>{
 const dispose=await initialize()
 try {
 const raw=demandAgentReferenceKey(reference),original={...goal,sessionIds:[raw,reference],assigneeSessionIds:[raw,reference]}
 await dom.render(<WorkbenchPresentationContext.Provider value={{active:false,retainedRegionId:null}}><GoalExecution demand={original} onUpdate={async()=>false}/></WorkbenchPresentationContext.Provider>)
 expect(dom.container.querySelectorAll('[data-goal-team-reference]')).toHaveLength(2)
 await dom.render(<GoalAgentPicker demand={original} role="assignees" onSave={async()=>false} onClose={()=>{}}/>)
 expect(document.querySelectorAll('.goal-agent-picker__row[data-goal-agent-key]')).toHaveLength(2)
 expect([...document.querySelectorAll<HTMLInputElement>('.goal-agent-picker__row input')].filter(input=>input.checked)).toHaveLength(2)
 await dom.render(<GoalFiniteStartControl demand={original}/>)
 const rows=[...dom.container.querySelectorAll<HTMLLabelElement>('.goal-finite-start__recipients label')]
 expect(rows).toHaveLength(2)
 const qualified=rows.find(row=>row.textContent?.includes('Saved Source member'))??rows.find(row=>!row.textContent?.includes(raw))!
 await act(async()=>qualified.querySelector<HTMLInputElement>('input')!.click())
 let start=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.startsWith('Start with'))!
 await act(async()=>start.click())
 expect(useAppStore.getState().executeControl).not.toHaveBeenCalled();expect(useAppStore.getState().goalFiniteStartIntents).toEqual({})
 const legacy=rows.find(row=>row.textContent?.includes(raw))!
 await act(async()=>legacy.querySelector<HTMLInputElement>('input')!.click())
 start=[...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.startsWith('Start with'))!
 vi.spyOn(api.demands,'inspectDispatch').mockResolvedValue(null)
 await act(async()=>start.click())
 const calls=vi.mocked(useAppStore.getState().executeControl).mock.calls.filter(([input])=>input.operation==='demand.start')
 expect(calls).toHaveLength(1);expect(calls[0]![0]).toMatchObject({sessionId:raw});expect(calls[0]![0]).not.toMatchObject({sessionId:JSON.stringify(['legacy',raw])})
 } finally {dispose()}
})

it('a late relationship ACK cannot clear a newer opaque selection in the original private leaf',async()=>{
 const dispose=await initialize()
 try {
 let resolve!:(saved:boolean)=>void
 const onSave=vi.fn<GoalRelationSave>(()=>new Promise<boolean>(done=>{resolve=done}))
 await dom.render(<GoalAgentPicker demand={goal} role="assignees" onSave={onSave} onClose={()=>{}}/>)
 await act(async()=>document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type="submit"]')!.click())
 expect(onSave).toHaveBeenCalledTimes(1)
 const draftKey=JSON.stringify([goal.id,'assignees']),opaque={goalId:goal.id,role:'assignees',selected:[{kind:'future-member',original:'later private choice'}],expectedUpdatedAt:1}
 await act(async()=>useAppStore.setState(state=>({goalAgentSelectionDrafts:{...state.goalAgentSelectionDrafts,[draftKey]:opaque}})))
 expect(document.body.textContent).toContain('original selection')
 await act(async()=>resolve(true))
 const checkpoint=await retainGoalAgentSelectionDraft({goalId:'another-goal',role:'related',selected:['retained-other'],expectedUpdatedAt:1})
 expect(checkpoint.clientStateWritten).toBe(true)
 expect(JSON.parse(localStorage.getItem(key)!).state.goalAgentSelectionDrafts[draftKey]).toEqual(opaque)
 expect(useAppStore.getState().executeControl).not.toHaveBeenCalled()
 } finally {dispose()}
})

it('the original private selection leaf restores exact current access and retains a newer saved prefix across a late Save ACK',async()=>{
 const dispose=await initialize()
 try {
 const draftKey=JSON.stringify([goal.id,'supervisor'])
 const original={goalId:goal.id,role:'supervisor' as const,selected:[reference],expectedUpdatedAt:1,
  relationAccess:[{reference,access:{source:{hostId:'configured-B'}}}]}
 await retainGoalAgentSelectionDraft(original)
 let resolve!:(saved:boolean)=>void
 const onSave=vi.fn<GoalRelationSave>(()=>new Promise<boolean>(done=>{resolve=done}))
 await dom.render(<GoalAgentPicker demand={goal} role="supervisor" onSave={onSave} onClose={()=>{}}/>)
 const submit=document.querySelector<HTMLButtonElement>('.goal-agent-picker button[type="submit"]')
 expect(submit).toBeTruthy()
 await act(async()=>submit!.click())
 expect(onSave.mock.calls[0]?.[2]).toEqual(original.relationAccess)
 const pin=(runtimeId:string)=>({runtimeId,publicKey:'original-key-'+runtimeId,fingerprint:'original-fingerprint-'+runtimeId})
 const adoptedRoute={source:pin('A'),hops:[{edgeId:'B-in-A',target:pin('B')}]}
 const newer={...original,relationAccess:[{reference,access:{source:{hostId:'configured-A',via:{routeId:'original-prefix',adoptedRoute}}}}]}
 await act(async()=>useAppStore.setState(state=>({goalAgentSelectionDrafts:{...state.goalAgentSelectionDrafts,[draftKey]:newer}})))
 await act(async()=>resolve(true))
 const checkpoint=await retainGoalAgentSelectionDraft({goalId:'unrelated',role:'related',selected:['original-other'],expectedUpdatedAt:1})
 expect(checkpoint.clientStateWritten).toBe(true)
 expect(JSON.parse(localStorage.getItem(key)!).state.goalAgentSelectionDrafts[draftKey]).toEqual(newer)
 expect(readGoalAgentSelectionDraft(newer,goal.id,'supervisor')).toEqual(newer)
 await useAppStore.persist.rehydrate()
 expect(useAppStore.getState().goalAgentSelectionDrafts[draftKey]).toEqual(newer)
 expect(useAppStore.getState().executeControl).not.toHaveBeenCalled()
 } finally {dispose()}
})
