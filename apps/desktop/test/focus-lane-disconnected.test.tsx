import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { chooseFocusFilter, focusFilterOptions } from './fixtures/focus-filter-menu'
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
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
const scratch = { id: SCRATCH_WORKSPACE_ID, hostId:'local', name:'Scratch project', path:_hygiene_fixturePath("scratch"), kind:'folder' as const }
const ordinary: ScratchTopicSnapshot = { id:'launcher:ordinary', title:'Fix scrolling', summary:'Keep input readable', directoryPath:_hygiene_fixturePath("scratch/topic--launcher--ordinary"), topicPath:_hygiene_fixturePath("scratch/topic--launcher--ordinary/topic.md"), collaborators:[] }
const mote: ScratchTopicSnapshot = { ...ordinary, id:'launcher:analyst', title:'Research Mote', directoryPath:_hygiene_fixturePath("scratch/topic--launcher--analyst"), topicPath:_hygiene_fixturePath("scratch/topic--launcher--analyst/topic.md"), soul:{ path:_hygiene_fixturePath("scratch/topic--launcher--analyst/SOUL.md"), content:'# Identity', version:'v1' } }
function agent(id:string,state:SessionSnapshot['status']['state'],processState:SessionSnapshot['processState']='running',workspacePath=_hygiene_fixturePath("repo")) {
 return {...base,id,workspacePath,processState,status:{...base.status,state},control:{...base.control,agentSessionId:id,run:{runId:'original-'+id}}}
}
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
 const config=await api.config.get(), snapshot=await api.sessions.snapshot()
 const found=snapshot.sessions.find((s):s is typeof base=>s.kind==='agent');expect(found).toBeDefined();base=found!
 vi.spyOn(api.workspaces,'listBranches').mockImplementation(async id=>({kind:'not-a-git-repository',hostId:'local',workspacePath:id==='repo'?_hygiene_fixturePath("repo"):_hygiene_fixturePath("old")}))
 vi.spyOn(api.workspaces,'appearance').mockResolvedValue({kind:'repository',icon:null})
 vi.spyOn(api.scratch,'listTopics').mockResolvedValue([ordinary,mote])
 useAppStore.setState({config:{...config,workspaces:[{id:'repo',name:'Product',hostId:'local',path:_hygiene_fixturePath("repo"),kind:'folder'},{id:'old',name:'Earlier project',hostId:'local',path:_hygiene_fixturePath("old"),kind:'folder'},scratch]},sessions:[agent('working','working'),agent('offline','disconnected','interrupted')],timelines:{},tabs:{},providerCatalog:[],agentNames:{working:'Repair',offline:'Earlier work'},spaceObjectIcons:{},workspaceFileRevisions:{},scratchTopicSnapshots:{},agentComposerDrafts:{working:'keep my draft'},agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}}})
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals()})
const mount=()=>act(async()=>root.render(createElement(GlobalFocusSurface)))
function lane(){const node=container.querySelector<HTMLElement>('[data-project-id="repo"]');expect(node).not.toBeNull();return node!}
function row(id:string){const node=container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`);expect(node).not.toBeNull();return node!}
async function seedTopic(){await act(async()=>useAppStore.setState({sessions:[agent('topic-agent','working','running',ordinary.directoryPath)],agentNames:{'topic-agent':'Scrolling'},scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(scratch),revision:0,topics:[ordinary,mote],error:null,reading:false}}}));await mount()}
it('does not compact a running Run when only its observation connection was lost',async()=>{
 await act(async()=>useAppStore.setState({sessions:[agent('still-live','disconnected')],agentNames:{'still-live':'Healthy running context'}}));await mount()
 expect(container.querySelectorAll('[aria-label="Disconnected projects"]')).toHaveLength(0)
 expect(row('still-live').closest('section[data-bucket="idle"]')).not.toBeNull();expect(row('still-live').classList.contains('focus-context--compact')).toBe(false)
 expect(useAppStore.getState().sessions.map(item=>[item.id,item.processState])).toEqual([['still-live','running']])
})
it('retains a concrete pending request in Attention even after process interruption',async()=>{
 const pending= {...agent('offline-request','disconnected','interrupted'),pendingInteraction:{id:'request',kind:'permission',title:'Allow editing src/scroll.ts?',operation:'edit'} as never}
 await act(async()=>useAppStore.setState({sessions:[pending]}));await mount()
 expect(row('offline-request').closest('section[data-bucket="attention"]')).not.toBeNull();expect(row('offline-request').textContent).toContain('Allow editing src/scroll.ts?')
 expect(container.querySelector('[aria-label="Disconnected projects"]')).toBeNull();expect(row('offline-request').classList.contains('focus-context--compact')).toBe(false)
})

it('renders a confirmed Topic alone with notebook glyph and no parent Project probe',async()=>{
 await seedTopic();const heading=container.querySelector('.focus-project-lanes__axis')!;expect([...heading.querySelectorAll('strong')].map(node=>node.textContent)).toEqual(['Fix scrolling'])
 expect(heading.querySelector('svg.lucide-notebook-text')).not.toBeNull();expect(heading.querySelector('[data-monogram]')).toBeNull();expect(api.workspaces.appearance).not.toHaveBeenCalled()
 expect(container.querySelector('.focus-project-lanes__summary')!.textContent).toBe('Keep input readable')
})
it('preserves a manual Topic icon from the sole object owner without adding reads',async()=>{
 const key=topicSpaceIconTarget(scratch,ordinary).key;await act(async()=>useAppStore.setState({spaceObjectIcons:{[key]:'flask'}}));await seedTopic()
 const heading=container.querySelector('.focus-project-lanes__axis')!;expect(heading.querySelector('[data-space-icon="flask"]')).not.toBeNull();expect(heading.querySelector('svg.lucide-notebook-text')).toBeNull();expect(api.workspaces.appearance).not.toHaveBeenCalled()
})
it('keeps Space/Rail automatic Topic monogram default outside the Focus seam',async()=>{
 await act(async()=>root.render(createElement(SpaceObjectIcon,{kind:'topic',name:'Fix scrolling',manualIcon:null})))
 expect(container.querySelector('[data-monogram]')).not.toBeNull();expect(container.querySelector('svg.lucide-notebook-text')).toBeNull()
})
it('keeps unknown Scratch identity visible without guessing Topic or Mote glyph',async()=>{
 vi.mocked(api.scratch.listTopics).mockResolvedValue([])
 await act(async()=>useAppStore.setState({sessions:[agent('unknown-topic','working','running',ordinary.directoryPath)]}));await mount()
 expect(row('unknown-topic').textContent).toContain('Mote identity is not confirmed');expect(container.querySelector('.focus-project-lanes__axis svg.lucide-notebook-text')).toBeNull()
 expect(container.querySelector('.focus-pmo-attention')).toBeNull()
})
it('retains actual Mote name and dedicated icon while keeping execution history isolated',async()=>{
 await act(async()=>useAppStore.setState({sessions:[agent('mote-agent','waiting','running',mote.directoryPath)],scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(scratch),revision:0,topics:[ordinary,mote],error:null,reading:false}}}));await mount()
 const button=container.querySelector('.focus-pmo-attention');expect(button).not.toBeNull();expect(button!.textContent).toContain('Research Mote');expect(button!.querySelector('[title="Mote"] svg')).not.toBeNull()
 expect(container.querySelectorAll('.focus-context')).toHaveLength(0);expect(useAppStore.getState().agentFocus.execution.history).toEqual([])
})
it('retains Mote manual identity and ordinary Project names through the same icon owner',async()=>{
 const key=topicSpaceIconTarget(scratch,mote).key
 await act(async()=>useAppStore.setState({sessions:[agent('mote-agent','waiting','running',mote.directoryPath),agent('working','working')],spaceObjectIcons:{[key]:'brain'},scratchTopicSnapshots:{[SCRATCH_WORKSPACE_ID]:{scope:scratchTopicsScope(scratch),revision:0,topics:[ordinary,mote],error:null,reading:false}}}));await mount()
 expect(container.querySelector('.focus-pmo-attention [data-space-icon="brain"]')).not.toBeNull();expect(lane().querySelector('.focus-project-lanes__axis strong')!.textContent).toBe('Product')
 expect(vi.mocked(api.workspaces.appearance).mock.calls.map(args=>args[0])).toEqual(['repo'])
})
it('does not amplify hierarchy/icon/history work for unrelated bytes and same-state observations',async()=>{
 await seedTopic();const reads={topics:vi.mocked(api.scratch.listTopics).mock.calls.length,branches:vi.mocked(api.workspaces.listBranches).mock.calls.length,appearance:vi.mocked(api.workspaces.appearance).mock.calls.length};const timeline=vi.spyOn(api.sessions,'timeline')
 const heading=container.querySelector('.focus-project-lanes__axis');expect(heading).not.toBeNull();expect(row('topic-agent')).not.toBeNull()
 await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(item=>({...item,latestOutputBytes:item.latestOutputBytes+99,status:{...item.status,observedAt:900}}))})))
 expect({topics:vi.mocked(api.scratch.listTopics).mock.calls.length,branches:vi.mocked(api.workspaces.listBranches).mock.calls.length,appearance:vi.mocked(api.workspaces.appearance).mock.calls.length}).toEqual(reads);expect(timeline).not.toHaveBeenCalled();expect(container.querySelector('.focus-project-lanes__axis')).toBe(heading)
})
it('binds Topic/Mote identity to trusted facts, keeping ownership ids and full path for navigation',async()=>{
 await seedTopic();const state=useAppStore.getState();const rows=createFocusProjectionSelector()(state).contexts
 expect(rows.map(item=>item.id)).toEqual(['topic-agent']);const lanes=deriveFocusProjectLanes(rows,state.config,{topics:{[SCRATCH_WORKSPACE_ID]:[ordinary,mote]},worktrees:[]})
 expect(lanes.map(item=>[item.projectId,item.workspaceId,item.objectKind,item.labels])).toEqual([[SCRATCH_WORKSPACE_ID,SCRATCH_WORKSPACE_ID,'topic',['Scratch project','Fix scrolling']]])
 await act(async()=>root.render(createElement(FocusProjectLanes,{lanes,selectedProjectKey:'all',onSelect:vi.fn(),renderLane:(_lane,heading)=>heading})))
 expect(container.querySelector('.focus-project-lanes__axis')!.getAttribute('title')).toContain(ordinary.directoryPath)
})
