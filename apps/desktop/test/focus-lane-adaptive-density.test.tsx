import { mkdir, writeFile } from 'node:fs/promises'
import { chooseFocusFilter, focusFilterOptions } from '../test/fixtures/focus-filter-menu'
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot, ScratchTopicSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
// Actual Global/Store/hierarchy/row/disclosure/identity; PTY paint and the separate
// Timeline query owner are outside this lane test and do not read private Runtime.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, base: Extract<SessionSnapshot,{kind:'agent'}>
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId:'local', name:'Scratch project', path:'/scratch', kind:'folder' as const }
const ordinary: ScratchTopicSnapshot = { id:'launcher:ordinary', title:'Fix scrolling', summary:'Keep input readable', directoryPath:'/scratch/topic--launcher--ordinary', topicPath:'/scratch/topic--launcher--ordinary/topic.md', collaborators:[] }
const mote: ScratchTopicSnapshot = { ...ordinary, id:'launcher:analyst', title:'Research Mote', directoryPath:'/scratch/topic--launcher--analyst', topicPath:'/scratch/topic--launcher--analyst/topic.md', soul:{ path:'/scratch/topic--launcher--analyst/SOUL.md', content:'# Identity', version:'v1' } }
function agent(id:string,state:SessionSnapshot['status']['state'],processState:SessionSnapshot['processState']='running',workspacePath='/repo') {
 return {...base,id,workspacePath,processState,status:{...base.status,state},control:{...base.control,agentSessionId:id,run:{runId:'original-'+id}}}
}
beforeEach(async () => {
 await mkdir('.tmp/focus-lane-adaptive-implementation-20261004',{recursive:true})
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
 Object.defineProperty(Element.prototype,'scrollIntoView',{value:vi.fn(),configurable:true})
 const config=await api.config.get(), snapshot=await api.sessions.snapshot()
 const found=snapshot.sessions.find((s):s is typeof base=>s.kind==='agent');expect(found).toBeDefined();base=found!
 vi.spyOn(api.workspaces,'listBranches').mockImplementation(async id=>({kind:'not-a-git-repository',hostId:'local',workspacePath:id==='repo'?'/repo':'/old'}))
 vi.spyOn(api.workspaces,'appearance').mockResolvedValue({kind:'repository',icon:null})
 vi.spyOn(api.scratch,'listTopics').mockResolvedValue([ordinary,mote])
 useAppStore.setState({config:{...config,workspaces:[{id:'repo',name:'Product',hostId:'local',path:'/repo',kind:'folder'},{id:'old',name:'Earlier project',hostId:'local',path:'/old',kind:'folder'},scratch]},sessions:[agent('working','working'),agent('offline','disconnected','interrupted')],timelines:{},tabs:{},providerCatalog:[],agentNames:{working:'Repair',offline:'Earlier work'},spaceObjectIcons:{},workspaceFileRevisions:{},scratchTopicSnapshots:{},agentComposerDrafts:{working:'keep my draft'},agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}}})
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals()})
const mount=()=>act(async()=>root.render(createElement(GlobalFocusSurface)))
function lane(){const node=container.querySelector<HTMLElement>('.focus-project-board > .focus-project-lanes [data-project-id="repo"]');expect(node).not.toBeNull();return node!}
function offlineColumn(){const node=lane().querySelector<HTMLElement>('section[data-bucket="disconnected"]');expect(node).not.toBeNull();return node!}
function row(id:string){const node=container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`);expect(node).not.toBeNull();return node!}
async function expand(){const node=offlineColumn().querySelector<HTMLButtonElement>('.focus-recovery-toggle');expect(node).not.toBeNull();await act(async()=>node!.click())}
async function filter(value:string){await chooseFocusFilter(container,'state',value)}
async function search(value:string){const node=container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]');expect(node).not.toBeNull();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,value);node!.dispatchEvent(new Event('input',{bubbles:true}))})}
async function seedTopic(){await act(async()=>useAppStore.setState({sessions:[agent('topic-agent','working','running',ordinary.directoryPath)],agentNames:{'topic-agent':'Scrolling'},scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(scratch),revision:0,topics:[ordinary,mote],error:null,reading:false}}}));await mount()}

it('compact Disconnected entry opens the one retained view rather than flowing offline cards back into a mixed lane',async()=>{
 const offlineFacts=Array.from({length:5},(_,i)=>agent('offline-'+i,'disconnected','interrupted'))
 const offlineNames=Object.fromEntries(offlineFacts.map((item,i)=>[item.id,'Offline task '+i]))
 await act(async()=>useAppStore.setState({sessions:[agent('working','working'),...offlineFacts],agentNames:{working:'Repair',...offlineNames}}))
 await mount()
 const state=useAppStore.getState(), controls=state.sessions.map(item=>item.control), draft=state.agentComposerDrafts, focus=state.agentFocus
 const column=offlineColumn(), groups=lane().querySelector<HTMLElement>('.focus-project-lanes__groups')!
 expect(groups).not.toBeNull();expect(column.querySelectorAll('.focus-context')).toHaveLength(0)
 const button=column.querySelector<HTMLButtonElement>('button')!;expect(button).not.toBeNull()
 await act(async()=>button.click())
 const local=[...column.querySelectorAll('.focus-context')].map(node=>node.getAttribute('data-session-id'))
 const drawer=container.querySelector<HTMLElement>('[aria-label="Disconnected projects"]')
 const actual={schema:'agentmux.focus-lane-adaptive-click-counter.v1',laneId:lane().dataset.laneId,confirmedOffline:5,columnTemplate:groups.style.getPropertyValue('--focus-state-columns'),localAfterClick:local,sharedViewPresent:drawer!==null,sharedViewRows:drawer?.querySelectorAll('.focus-context').length??0,originalControlsEqual:JSON.stringify(useAppStore.getState().sessions.map(item=>item.control))===JSON.stringify(controls),draftReferenceSame:useAppStore.getState().agentComposerDrafts===draft,focusReferenceSame:useAppStore.getState().agentFocus===focus}
 await writeFile('.tmp/focus-lane-adaptive-implementation-20261004/click-actual.json',JSON.stringify(actual,null,2)+'\n')
 expect(local,'Disconnected count entry must never inflate the mixed lane; existing retained view is the only detailed view').toEqual([])
 expect(drawer).not.toBeNull()
})
it('searching confirmed offline Contexts does not automatically grow full mixed-lane offline rows',async()=>{
 const offlineFacts=Array.from({length:5},(_,i)=>agent('offline-'+i,'disconnected','interrupted'))
 const offlineNames=Object.fromEntries(offlineFacts.map((item,i)=>[item.id,'Offline task '+i]))
 await act(async()=>useAppStore.setState({sessions:[agent('working','working'),...offlineFacts],agentNames:{working:'Repair',...offlineNames}}))
 await mount();await search('Offline task')
 const column=offlineColumn(), local=[...column.querySelectorAll('.focus-context')].map(node=>node.getAttribute('data-session-id'))
 const button=column.querySelector<HTMLButtonElement>('button')!;expect(button).not.toBeNull();expect(button.getAttribute('aria-label')).toBe('View disconnected contexts · 5')
 await writeFile('.tmp/focus-lane-adaptive-implementation-20261004/search-actual.json',JSON.stringify({schema:'agentmux.focus-lane-adaptive-search-counter.v1',laneId:lane().dataset.laneId,matchingOffline:5,localRows:local,expanded:button.getAttribute('aria-expanded'),disabled:button.disabled,sharedViewPresent:container.querySelector('[aria-label="Disconnected projects"]')!==null},null,2)+'\n')
 expect(local,'search keeps a compact count entry; only an explicit entry opens the retained disconnected view').toEqual([])
})

it('one selected offline Context still has only the compact entry until explicit reveal',async()=>{
 await act(async()=>useAppStore.setState({agentFocus:{execution:{sessionId:'offline',history:[]},pmo:{sessionId:null}}}));await mount()
 const column=offlineColumn(),trigger=column.querySelector<HTMLButtonElement>('.focus-disconnected-entry')!
 expect(trigger).not.toBeNull();expect(trigger.textContent).toBe('1')
 expect(column.querySelectorAll('.focus-context')).toHaveLength(0);expect(drawer().querySelectorAll('.focus-context')).toHaveLength(0)
 await act(async()=>trigger.click())
 expect([...drawer().querySelectorAll('.focus-context')].map(node=>node.getAttribute('data-session-id'))).toEqual(['offline'])
 expect(row('offline').classList.contains('is-selected')).toBe(true);expect(column.querySelectorAll('.focus-context')).toHaveLength(0)
})

const drawer=()=>container.querySelector<HTMLElement>('[aria-label="Disconnected projects"]')!
const mainIds=()=>[...container.querySelectorAll('.focus-project-board > .focus-project-lanes .focus-context')].map(n=>n.getAttribute('data-session-id'))
it('healthy observation loss and pending Attention stay outside confirmed offline',async()=>{
 await act(async()=>useAppStore.setState({sessions:[agent('healthy','disconnected'),agent('offline','disconnected','interrupted'),{...agent('permission','disconnected','interrupted'),pendingInteraction:{id:'p',kind:'permission',title:'Allow editing?',operation:'edit'} as never}]}));await mount()
 expect(row('healthy').closest('[data-bucket="idle"]')).not.toBeNull();expect(row('permission').closest('[data-bucket="attention"]')).not.toBeNull()
 await act(async()=>offlineColumn().querySelector<HTMLButtonElement>('.focus-disconnected-entry')!.click())
 expect([...drawer().querySelectorAll('.focus-context')].map(n=>n.getAttribute('data-session-id'))).toEqual(['offline'])
})
it('hover has three actual summaries and no history/control changes',async()=>{
 const facts=Array.from({length:8},(_,i)=>agent('offline-'+i,'disconnected','interrupted'))
 await act(async()=>useAppStore.setState({sessions:[agent('working','working'),...facts],agentNames:Object.fromEntries(facts.map((s,i)=>[s.id,'Offline task '+i]))}));await mount()
 const state=useAppStore.getState(),page=vi.spyOn(api.sessions,'historyPage'),catalog=vi.spyOn(api.sessions,'historySources'),timeline=vi.spyOn(api.sessions,'timeline')
 const button=offlineColumn().querySelector<HTMLButtonElement>('.focus-disconnected-entry')!;await act(async()=>button.focus())
 const popup=document.querySelector('.focus-disconnected-summary');expect(popup).not.toBeNull()
 expect([...popup!.querySelectorAll('[data-disconnected-summary]')].map(n=>n.getAttribute('data-disconnected-summary'))).toEqual(['offline-0','offline-1','offline-2']);expect(popup!.textContent).toContain('5 more')
 expect(page).not.toHaveBeenCalled();expect(catalog).not.toHaveBeenCalled();expect(timeline).not.toHaveBeenCalled()
 await act(async()=>button.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(document.querySelector('.focus-disconnected-summary')).toBeNull()
 expect(useAppStore.getState().sessions).toBe(state.sessions);expect(useAppStore.getState().agentFocus).toBe(state.agentFocus);expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
 // Repeat the same actual caller with two registered Branches of one project.
 await act(async()=>useAppStore.setState(current=>({config:{...current.config!,workspaces:[...current.config!.workspaces,{id:'checkout-a',name:'Checkout A',hostId:'local',kind:'worktree',path:'/checkout-a',repoPath:'/repo',branch:'feature/a'},{id:'checkout-b',name:'Checkout B',hostId:'local',kind:'worktree',path:'/checkout-b',repoPath:'/repo',branch:'feature/b'}]},sessions:[agent('branch-live-a','working','running','/checkout-a'),agent('branch-off-a','disconnected','interrupted','/checkout-a'),agent('branch-live-b','working','running','/checkout-b'),agent('branch-off-b','disconnected','interrupted','/checkout-b')]})))
 const branches=[...container.querySelectorAll<HTMLElement>('.focus-project-board > .focus-project-lanes [data-project-id="repo"]')]
 expect(branches).toHaveLength(2);expect(new Set(branches.map(node=>node.dataset.laneId)).size).toBe(2)
 const branch=branches.find(node=>node.querySelector('.focus-project-lanes__axis')?.textContent?.includes('feature/b'))!;expect(branch).toBeDefined()
 const branchEntry=branch.querySelector<HTMLButtonElement>('.focus-disconnected-entry')!;expect(branchEntry).not.toBeNull()
 await act(async()=>{branchEntry.focus();branchEntry.click()})
 expect(document.activeElement).toBe(row('branch-off-b'));expect(row('branch-off-b').closest<HTMLElement>('[data-lane-id]')!.dataset.laneId).toBe(branch.dataset.laneId)
 expect([...drawer().querySelectorAll('.focus-context')].map(node=>node.getAttribute('data-session-id'))).toEqual(['branch-off-a','branch-off-b'])
})
it('mixed and pure offline belong to one shared view and filters keep the same qualification',async()=>{
 await act(async()=>useAppStore.setState(s=>({sessions:[...s.sessions,agent('old','disconnected','interrupted','/old')]})));await mount()
 expect((await focusFilterOptions(container,'state')).map(o=>o.text)).toEqual(['All states','Attention · 0','Working · 1','Results · 0','Idle / Recovery · 0','Disconnected · 2'])
 expect(drawer().querySelectorAll('.focus-context')).toHaveLength(0);await filter('disconnected');expect(mainIds()).toEqual([])
 await act(async()=>offlineColumn().querySelector<HTMLButtonElement>('.focus-disconnected-entry')!.click())
 expect([...drawer().querySelectorAll('.focus-context')].map(n=>n.getAttribute('data-session-id'))).toEqual(['offline','old'])
})
it('same project Topics reveal by exact lane and Return keeps draft/focus',async()=>{
 const other={...ordinary,id:'launcher:other',title:'Another topic',directoryPath:'/scratch/topic--launcher--other',topicPath:'/scratch/topic--launcher--other/topic.md'}
 await act(async()=>useAppStore.setState({sessions:[agent('live','working','running',ordinary.directoryPath),agent('off-a','disconnected','interrupted',ordinary.directoryPath),agent('off-b','disconnected','interrupted',other.directoryPath)],scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(scratch),revision:0,topics:[ordinary,other],error:null,reading:false}}}));await mount()
 const lanes=[...container.querySelectorAll<HTMLElement>('.focus-project-board > .focus-project-lanes [data-lane-id]')];expect(lanes).toHaveLength(2)
 expect(new Set(lanes.map(n=>n.dataset.laneId)).size).toBe(2)
 const desired=lanes.find(n=>n.textContent?.includes('Another topic'))!;expect(desired).toBeDefined()
 const trigger=desired.querySelector<HTMLButtonElement>('.focus-disconnected-entry')!;const state=useAppStore.getState()
 await act(async()=>{trigger.focus();trigger.click()})
 const current=[...drawer().querySelectorAll<HTMLElement>('[data-lane-id]')].find(n=>n.dataset.laneId===desired.dataset.laneId)!;expect(current).toBeDefined()
 expect(document.activeElement).toBe(current.querySelector('.focus-context'))
 await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
 expect(document.activeElement).toBe(trigger);expect(drawer().querySelectorAll('.focus-context')).toHaveLength(0)
 expect(useAppStore.getState().sessions).toBe(state.sessions);expect(useAppStore.getState().agentFocus).toBe(state.agentFocus);expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
})
it('Return preserves a later deliberate input and only explicit context click navigates',async()=>{
 await mount();const trigger=offlineColumn().querySelector<HTMLButtonElement>('.focus-disconnected-entry')!
 await act(async()=>{trigger.focus();trigger.click()});expect(row('offline').closest('[aria-label="Disconnected projects"]')).toBe(drawer())
 const input=container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
 await act(async()=>{input.focus();drawer().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})
 expect(document.activeElement).toBe(input);expect(drawer().querySelectorAll('.focus-context')).toHaveLength(0)
 await act(async()=>trigger.click());await act(async()=>row('offline').click());expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('offline')
})

it('returns to the valid collection header when the originating entry became disabled',async()=>{
 await act(async()=>useAppStore.setState(s=>({sessions:[...s.sessions,agent('old-off','disconnected','interrupted','/old')]})));await mount()
 const trigger=offlineColumn().querySelector<HTMLButtonElement>('.focus-disconnected-entry')!
 await act(async()=>{trigger.focus();trigger.click()})
 expect(drawer().querySelectorAll('.focus-context')).toHaveLength(2)
 await act(async()=>useAppStore.setState(s=>({sessions:s.sessions.map(item=>item.id==='offline'?{...item,processState:'running',status:{...item.status,state:'working'}}:item)})))
 expect(trigger.isConnected).toBe(true);expect(trigger.disabled).toBe(true)
 const returnButton=drawer().querySelector<HTMLButtonElement>('.focus-disconnected-projects__return')!,header=drawer().querySelector<HTMLButtonElement>('.focus-recovery-toggle')!
 expect(returnButton).not.toBeNull()
 await act(async()=>{returnButton.focus();returnButton.click()})
 expect(document.activeElement,'disabled original entry must not drop Return to BODY').toBe(header)
 expect(drawer().querySelectorAll('.focus-context')).toHaveLength(0)
})
