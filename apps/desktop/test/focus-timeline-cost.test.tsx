// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FocusTimelineTrack } from '../src/renderer/src/lib/focus-history-timeline'
import { groupFocusTimeline, type FocusInputTrack } from '../src/renderer/src/lib/focus-history-timeline'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { fixtureTime } from '../scripts/lib/fixture-values.mjs'

const initial = useAppStore.getState()
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>, renders: Record<string, number>, commits: number
let tracks: Map<string, FocusTimelineTrack>, renderedTracks: string[]
const selected = vi.fn(), reset = () => { renders = {}; commits = 0; renderedTracks = [] }
const observer = () => { commits++ }
async function render(visible = true, onSelect = selected) { await act(async () => root.render(<Profiler id="actual-focus-subtree" onRender={observer}><GlobalFocusSurface visible={visible} workspaceOpen={false} onSelectContext={onSelect}/></Profiler>)) }
async function scene(size: number) {
  const now = Date.now(), workspace = composerConfig.workspaces[0]!
  const sessions = Array.from({ length: size }, (_, i) => ({ ...composerSession('focus-' + i), label: 'Focus task ' + i,
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: now },
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - 1000 } }))
  const tabs = Object.fromEntries(sessions.map((session,i) => { const tab = createWorkbenchTab('focus-tab-'+i, { kind:'agent', phase:'attached', regionId:'focus-region-'+i, workspaceId:workspace.id, sessionId:session.id }); return [tab.id, tab] }))
  const browser = await api.browser.create('focus-cost-browser','https://example.test',workspace.id)
  tabs.noise = createWorkbenchTab('noise', {...browser, kind:'browser', browserId:browser.id, regionId:'noise-region',workspaceId:workspace.id})
  useAppStore.setState({ ...initial, loading:false, config:composerConfig, mainSurface:'agents', focusView:'list', activeWorkspaceId:workspace.id,
    sessions, tabs, layouts:{[workspace.id]:createWorkspaceLayout('focus-group',Object.keys(tabs))},
    timelines:Object.fromEntries(sessions.map(session=>[session.id,{agentSessionId:session.id,revision:1,items:[]}])),
    agentNames:{},agentFocus:{execution:{sessionId:null,history:sessions.map((session,i)=>({sessionId:session.id,focusedAt:now-10_000-i*1000,identity:{name:session.label,kind:'agent' as const,providerId:'codex',hostId:'local',workspacePath:workspace.path,project:{id:workspace.id,name:workspace.name}}}))},pmo:{sessionId:null}},
    workbenchSpaceSelection:null,agentComposerDrafts:{'focus-0':'Original unsent draft'},scratchTopicSnapshots:{}},true)
  vi.spyOn(api.spatial,'read').mockResolvedValue({schemaVersion:1,revision:1,graph:desktopSpatialGraph(useAppStore.getState(),[])})
  await initializeSpatialControlFixture()
  await render()
  expect(host.querySelectorAll('[data-focus-card-key]')).toHaveLength(size)
  expect(host.querySelectorAll('[data-focus-timeline-id]')).toHaveLength(size)
  expect([...tracks.values()].filter(track=>!!track.current)).toHaveLength(size)
}
async function updates(update:(index:number)=>void,count=10,check?:(index:number)=>void) { reset();for(let i=0;i<count;i++) {await act(async()=>update(i));check?.(i)} }
beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']});vi.setSystemTime(fixtureTime())
  tracks=new Map();reset();selected.mockClear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('__agentmuxFocusTimelineCostRender',(name:string,props:{track?:FocusTimelineTrack}={})=>{
    renders[name]=(renders[name]??0)+1
    if(props.track) {tracks.set(props.track.key,props.track);renderedTracks.push(props.track.sessionId)}
  })
  host=document.createElement('div');document.body.append(host);root=createClientUiRoot(host)
  vi.spyOn(api.workspaces,'appearance').mockResolvedValue({kind:'repository',icon:null})
  vi.spyOn(api.workspaces,'listBranches').mockResolvedValue({kind:'not-a-git-repository',hostId:'local',workspacePath:composerConfig.workspaces[0]!.path})
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();useAppStore.setState(initial,true);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals()})

it('keeps a changed original input route fresh while sharing the unchanged retained track',()=>{
  const input:FocusInputTrack={key:'original-input-track',sessionId:'original-agent',identity:{name:'Original Agent',kind:'agent',providerId:'codex',hostId:'original-host',workspacePath:composerConfig.workspaces[0]!.path,project:{id:'original-project',name:'Original project'}},reference:{hostId:'first-route',agentSessionId:'original-agent'}}
  const first=groupFocusTimeline([],[],new Map(),[input])
  const unchanged=groupFocusTimeline([],[],new Map(),[input],first)
  expect(unchanged[0]!.tracks[0]).toBe(first[0]!.tracks[0])
  const current=groupFocusTimeline([],[],new Map(),[{...input,reference:{hostId:'current-route',agentSessionId:'original-agent'}}],unchanged)
  expect(current[0]!.tracks[0]!.key).toBe(first[0]!.tracks[0]!.key)
  expect(current[0]!.tracks[0]).not.toBe(first[0]!.tracks[0])
  expect(current[0]!.tracks[0]!.inputReference).toEqual({hostId:'current-route',agentSessionId:'original-agent'})
})

it.each([4,40])('isolates actual Focus timeline consumers with %i confirmed current tracks',async size=>{
  await scene(size)
  const draft=useAppStore.getState().agentComposerDrafts
  const browserSurface=useAppStore.getState().tabs.noise!.regions['noise-region']!
  for(const visible of [true,false]) {
    await render(visible)
    for(const noise of ['file','browser'] as const) {
      await updates(index=>useAppStore.setState(state=>({tabs:{...state.tabs,noise:noise==='file'
        ?createWorkbenchTab('noise',{kind:'file',regionId:'noise-region',workspaceId:composerConfig.workspaces[0]!.id,path:'unrelated-'+index+'.txt'})
        :{...state.tabs.noise!,regions:{'noise-region':{...browserSurface,url:'https://example.test/'+index,title:'Other page '+index}}}}})))
      expect(renderedTracks,`${visible}/${noise}`).toEqual([])
      expect(renders.RecentFocusTimeline??0,`${visible}/${noise}`).toBe(0)
    }
  }
  await render()
  await updates(index=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='focus-0'?{...session,status:{state:index%2?'working':'waiting',source:'native-hook',observedAt:Date.now()+index},semanticStatus:{state:index%2?'working':'waiting',source:'native-hook',observedAt:Date.now()+index,stateEnteredAt:Date.now()+index}}:session)})),10,index=>expect(host.querySelector('[data-focus-timeline-id="focus-0"] .recent-focus__live')?.classList.contains('is-working')).toBe(Boolean(index%2)))
  expect(renderedTracks).toEqual(Array(10).fill('focus-0'))
  expect(renders.FocusContextCardBody).toBe(10)
  await updates(index=>useAppStore.setState(state=>({timelines:{...state.timelines,'focus-0':{agentSessionId:'focus-0',revision:index+2,items:[{id:'message-'+index,agentSessionId:'focus-0',kind:'user_message',source:'user',status:'complete',createdAt:Date.now()-1000,updatedAt:Date.now(),title:'Prompt',content:'Original prompt '+index}]}}})))
  expect(renderedTracks).toEqual(Array(10).fill('focus-0'))
  expect(renders.FocusContextCardBody).toBe(10)
  const timeline=host.querySelector('.recent-focus')!
  await updates(()=>vi.advanceTimersByTime(1000),5);expect(commits).toBe(0)
  await updates(()=>vi.advanceTimersByTime(30_000),2);expect(renderedTracks).toHaveLength(size*2)
  await render(false);await updates(()=>vi.advanceTimersByTime(30_000),2);expect(commits).toBe(0)
  await render();expect(host.querySelector('.recent-focus')).toBe(timeline)
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft)
})

it.each([4, 40])('keeps unrelated timeline and name publications out of %i mounted Focus projections', async size => {
  await scene(size)
  expect(renders.FocusProjectionSubject).toBeGreaterThan(0)
  expect(renders.FocusCardRankComparison).toBeGreaterThan(0)
  expect(renders.deriveFocusProjectLanes).toBeGreaterThan(0)
  expect(renders.groupFocusTimeline).toBeGreaterThan(0)
  expect(renders.focusTimelineOrderCandidates).toBeGreaterThan(0)
  const original = useAppStore.getState()
  const cards = () => [...host.querySelectorAll<HTMLElement>('[data-focus-card-key]')]
  const cardOrder = () => cards().map(card => JSON.parse(card.dataset.focusCardKey!)[1])
  const originalOrder = cardOrder()
  const tracks = [...host.querySelectorAll('[data-focus-timeline-id]')]
  for (const count of [1, 40]) {
    await updates(revision => useAppStore.setState(state => {
      const timelines = { ...state.timelines }, agentNames = { ...state.agentNames }
      for (let index = 0; index < count; index++) {
        const id = 'background-only-' + index
        timelines[id] = { agentSessionId: id, revision, items: [] }
        agentNames[id] = 'Background task ' + revision
      }
      return { timelines, agentNames }
    }))
    expect(renders.FocusProjectionSubject ?? 0, `${count} unrelated subjects`).toBe(0)
    expect(renders.FocusCardRankComparison ?? 0).toBe(0)
    expect(renders.deriveFocusProjectLanes ?? 0).toBe(0)
    expect(renders.groupFocusTimeline ?? 0).toBe(0)
    expect(renders.focusTimelineOrderCandidates ?? 0).toBe(0)
    expect(renderedTracks).toEqual([])
    expect(cardOrder()).toEqual(originalOrder)
    expect([...host.querySelectorAll('[data-focus-timeline-id]')]).toEqual(tracks)
  }

  const id = originalOrder.at(-1) as string
  const card = host.querySelector<HTMLButtonElement>(`[data-session-id="${id}"].focus-context`)!
  expect(card).not.toBeNull()
  await updates(() => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, [id]: 'Renamed original task' } })), 1)
  expect(renders.FocusProjectionSubject).toBeGreaterThan(0)
  expect(renders.FocusCardRankComparison ?? 0).toBe(0)
  expect(cardOrder()).toEqual(originalOrder)
  expect(card.textContent).toContain('Renamed original task')
  expect(renderedTracks).toEqual([id])
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(useAppStore.getState().sessions).toBe(original.sessions)
  expect(useAppStore.getState().tabs).toBe(original.tabs)

  await updates(index => useAppStore.setState(state => {
    const nextState = index === 0 ? 'waiting' as const : 'working' as const
    const observedAt = Date.now() + index
    const status = { state: nextState, source: 'native-hook' as const, observedAt }
    return { sessions: state.sessions.map(session => session.id === id
      ? { ...session, status, semanticStatus: { ...status, stateEnteredAt: observedAt } } : session) }
  }), 2)
  expect(renders.FocusCardRankComparison).toBeGreaterThan(0)
  expect(cardOrder()).toEqual([id, ...originalOrder.slice(0, -1)])
  expect(useAppStore.getState().sessions.find(session => session.id === id)?.control).toBe(original.sessions.find(session => session.id === id)?.control)
  expect(useAppStore.getState().agentFocus).toBe(original.agentFocus)
})

