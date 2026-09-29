// @vitest-environment happy-dom
import { act, createElement, memo, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { addTabPlacement, createWorkspaceLayout, regionIds } from '@agentmux/layout'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { tabForFocusedSession } from '../src/renderer/src/lib/focus-tab-projection'

const work = vi.hoisted(() => ({ members: [] as string[], numbers: [] as string[][], commits: {} as Record<string, number> }))
const owning = vi.hoisted(() => ({ depth: 0, indexes: 0, reads: {} as Record<string, string[]> }))
// Count this selector's dependency work; durable-store persistence has its own unrelated calls.
vi.mock('../src/renderer/src/lib/focus-context', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/focus-context')>()
  return { ...actual, createFocusProjectionSelector: () => {
    const select = actual.createFocusProjectionSelector()
    return (input: Parameters<typeof select>[0]) => { owning.depth++; try { return select(input) } finally { owning.depth-- } }
  } }
})
vi.mock('../src/renderer/src/lib/workbench-tabs', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/workbench-tabs')>()
  return { ...actual, workbenchSurfaces: (tab: WorkbenchTab) => { if (owning.depth) work.members.push(tab.id); return actual.workbenchSurfaces(tab) } }
})
vi.mock('../src/renderer/src/lib/session-presentation', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/session-presentation')>()
  return { ...actual, sessionPresentationById: (sessions: readonly SessionSnapshot[]) => { if (owning.depth) owning.indexes++; return actual.sessionPresentationById(sessions) } }
})
vi.mock('../src/renderer/src/lib/region-display-name', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/region-display-name')>()
  return { ...actual, regionDisplayNames: (regions: Parameters<typeof actual.regionDisplayNames>[0]) => { work.numbers.push(regions.map(region => region.regionId)); return actual.regionDisplayNames(regions) } }
})
vi.mock('../src/renderer/src/components/FocusContextRow', async original => {
  const actual = await original<typeof import('../src/renderer/src/components/FocusContextRow')>()
  return { FocusContextRow: memo((props: Parameters<typeof actual.FocusContextRow>[0]) => createElement(Profiler, { id: props.context.id, onRender: id => { work.commits[id] = (work.commits[id] ?? 0) + 1 } }, createElement(actual.FocusContextRow, props))) }
})
// Heavy leaves and unrelated hierarchy I/O are outside this display-owner proof.
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span', { 'data-avatar-leaf': true }) }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusNavigationPreview } from '../src/renderer/src/components/FocusNavigationPreview'
import { FocusNavigationButton } from '../src/renderer/src/components/FocusNavigationButton'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, workspaceId: string
function terminal(id: string, workspacePath: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath, label: 'Terminal · Same project', createdAt: 1, updatedAt: 1, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0, control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }
}
function pair(tabId: string, left: string, right: string): WorkbenchTab {
  return addWorkbenchRegion(createWorkbenchTab(tabId, { kind: 'terminal', phase: 'attached', regionId: `${tabId}-left`, sessionId: left, workspaceId }), `${tabId}-left`, 'right', { kind: 'terminal', phase: 'attached', regionId: `${tabId}-right`, sessionId: right, workspaceId })
}
function row(id: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`)
  expect(button).not.toBeNull()
  return button!
}
function title(id: string) { return row(id).querySelector('strong')!.textContent }
function resetWork() { work.members = []; work.numbers = []; work.commits = {}; owning.reads = {}; owning.indexes = 0 }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get(), { sessions: examples } = await api.sessions.snapshot(), workspace = config.workspaces[0]!
  workspaceId = workspace.id
  const base = examples.find((session): session is Extract<SessionSnapshot,{kind:'agent'}> => session.kind === 'agent'); expect(base).toBeDefined()
  const agent = { ...base!, id: 'agent', hostId: 'local', workspacePath: workspace.path, label: 'Codex · Same project', status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }
  const tabs = { original: pair('original', 'first', 'second'), neighbour: pair('neighbour', 'third', 'fourth'), agent: createWorkbenchTab('agent', { kind: 'agent', phase: 'attached', regionId: 'agent-region', sessionId: 'agent', workspaceId }) }
  for (const [id, tab] of Object.entries(tabs)) tabs[id as keyof typeof tabs] = new Proxy(tab, { get(target, key, receiver) {
    if (owning.depth && ['name', 'regions', 'layout'].includes(String(key))) (owning.reads[id] ??= []).push(String(key))
    return Reflect.get(target, key, receiver)
  } })
  let layout = createWorkspaceLayout('owner-group')
  for (const tabId of Object.keys(tabs)) layout = addTabPlacement(layout, 'owner-group', tabId)!
  const timeline: AgentTimelineSnapshot = { agentSessionId: 'agent', revision: 1, items: [{ id: 'prompt', agentSessionId: 'agent', kind: 'user_message', status: 'complete', source: 'native-hook', title: 'User message', content: 'Inspect the parser', createdAt: 1, updatedAt: 1 }] }
  useAppStore.setState({ config, sessions: ['first', 'second', 'third', 'fourth'].map<SessionSnapshot>(id => terminal(id, workspace.path)).concat(agent), tabs, layouts: { [workspaceId]: layout }, activeWorkspaceId: workspaceId, providerCatalog: [], timelines: { agent: timeline }, agentNames: {}, closingWorkbenchViews: {}, mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  resetWork()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Plain Terminal rows were explicitly removed from Focus. Original ownership,
// navigation, process facts and durable surfaces remain meaningful regressions.
it('shows only the Agent semantic name without inventing a Terminal task',async()=>{await act(async()=>root.render(createElement(GlobalFocusSurface)));expect([...container.querySelectorAll<HTMLElement>('.focus-context')].map(node=>node.dataset.sessionId)).toEqual(['agent']);expect(title('agent')).toBe('Inspect the parser')})
it('keeps the same first original owner when a Terminal has multiple projections',async()=>{
 const duplicate=createWorkbenchTab('duplicate',{kind:'terminal',phase:'attached',regionId:'duplicate-region',sessionId:'first',workspaceId},'Another projection')
 useAppStore.setState(state=>({tabs:{...state.tabs,duplicate}}));await act(async()=>useAppStore.getState().focusExecutionSession('first'));await act(async()=>root.render(createElement(GlobalFocusSurface)))
 expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original','neighbour','agent','duplicate']);expect(tabForFocusedSession(useAppStore.getState().tabs,'first')?.id).toBe('original');expect(container.querySelector('#focus-workspace-slot')?.getAttribute('data-focus-tab-id')).toBe('original')
})
it('uses existing rename/reorder/return actions and preserves original identity and Run refs',async()=>{
 const runs=useAppStore.getState().sessions.map(session=>session.control.run)
 await act(async()=>useAppStore.getState().renameTab('original','Release shells'));await act(async()=>useAppStore.getState().swapRegions(workspaceId,'original','original-left','original-right'));await act(async()=>useAppStore.getState().focusRegion(workspaceId,'original','original-left','keyboard'));await act(async()=>useAppStore.getState().focusExecutionSession('first'));await act(async()=>root.render(createElement(GlobalFocusSurface)))
 expect(container.querySelector('#focus-workspace-slot')?.getAttribute('data-focus-tab-id')).toBe('original');expect(regionIds(useAppStore.getState().tabs.original!.layout.root)).toEqual(['original-right','original-left'])
 await act(async()=>useAppStore.getState().setMainSurface('workbench'));const state=useAppStore.getState();expect(state.mainSurface).toBe('workbench');expect(state.tabs.original?.name).toBe('Release shells');expect(state.layouts[workspaceId]?.groups[0]?.activeTabId).toBe('original');expect(state.tabs.original?.layout.activeRegionId).toBe('original-left');expect(Object.keys(state.tabs.original!.regions)).toEqual(['original-left','original-right']);state.sessions.forEach((session,index)=>expect(session.control.run).toBe(runs[index]))
})
it('does no Terminal owner/number work or Agent redraw for irrelevant facts, rename and reorder',async()=>{
 await act(async()=>root.render(createElement(GlobalFocusSurface)));expect(Object.keys(work.commits)).toEqual(['agent']);expect(work.numbers).toEqual([]);resetWork()
 await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>({...session,latestOutputBytes:session.latestOutputBytes+10,status:{...session.status,observedAt:2}}))})));await act(async()=>useAppStore.getState().setAgentComposerDraft('unrelated','Draft fact'));await act(async()=>useAppStore.getState().renameTab('original','Changed shells'));await act(async()=>useAppStore.getState().swapRegions(workspaceId,'original','original-left','original-right'))
 expect(work).toEqual({members:[],numbers:[],commits:{}});expect(owning.indexes).toBe(0);expect(owning.reads).toEqual({})
})
it('keeps permanent counts layout-independent and Preview on the same Agent set',async()=>{
 const commits=vi.fn();await act(async()=>root.render(createElement(Profiler,{id:'counter',onRender:commits},createElement(FocusNavigationButton,{'aria-label':'Focus'},'Focus'))));expect(commits.mock.calls.length).toBeGreaterThan(0);const committed=commits.mock.calls.length
 await act(async()=>useAppStore.getState().renameTab('original','Preview shells'));expect(commits.mock.calls.length).toBe(committed);expect(work.numbers).toEqual([]);await act(async()=>root.render(createElement(FocusNavigationPreview)));expect([...container.querySelectorAll<HTMLElement>('[data-preview-session]')].map(node=>node.dataset.previewSession)).toEqual(['agent']);expect(container.querySelector('.focus-navigation-preview__header small')?.textContent).toBe('1 context')
})
it('does not invent a Tab for an unowned Terminal or erase its control',async()=>{
 useAppStore.setState(state=>({sessions:[...state.sessions,terminal('unowned',state.config!.workspaces[0]!.path)]}));const before=useAppStore.getState();await act(async()=>root.render(createElement(GlobalFocusSurface)));expect(createFocusProjectionSelector()(before).contexts.map(context=>context.id)).toEqual(['agent']);expect(tabForFocusedSession(before.tabs,'unowned')).toBeNull();expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original','neighbour','agent']);expect(useAppStore.getState().sessions).toBe(before.sessions)
})
it('keeps failed owned and ended unowned Runtime facts without putting them in Agent cards',async()=>{
 const path=useAppStore.getState().config!.workspaces[0]!.path,failed={...terminal('old-failed',path),processState:'exited' as const,status:{state:'error' as const,source:'run-process' as const,observedAt:1,detail:'signal Killed: 9',exitCode:1,exitReason:'crashed' as const}}
 const stopped={...failed,id:'old-stopped',status:{...failed.status,state:'exited' as const,exitReason:'user-stopped' as const}},interrupted={...failed,id:'old-interrupted',processState:'interrupted' as const,status:{state:'disconnected' as const,source:'run-process' as const,observedAt:1,detail:'The Runtime restarted and interrupted this Run.'}}
 useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='first' && session.kind==='terminal'?{...failed,id:'first',control:session.control}:session).concat(failed,stopped,interrupted,terminal('live-unowned',path))}));await act(async()=>useAppStore.getState().focusExecutionSession('first'));const before=useAppStore.getState();await act(async()=>root.render(createElement(GlobalFocusSurface)));expect(createFocusProjectionSelector()(before).contexts.map(context=>context.id)).toEqual(['agent']);expect(container.querySelector('#focus-workspace-slot')?.getAttribute('data-focus-tab-id')).toBe('original');await act(async()=>root.render(createElement(FocusNavigationPreview)));expect(container.querySelector('[data-preview-count="attention"] b')?.textContent).toBe('0');expect(useAppStore.getState().sessions).toBe(before.sessions);expect(useAppStore.getState().tabs).toBe(before.tabs)
})
it('retains the selected Terminal as liveness changes without mistaking it for Agent work',async()=>{
 const live={...terminal('disconnected-live',useAppStore.getState().config!.workspaces[0]!.path),status:{state:'disconnected' as const,source:'run-process' as const,observedAt:1}}
 useAppStore.setState(state=>({sessions:[...state.sessions,live],agentFocus:{...state.agentFocus,execution:{sessionId:live.id,history:[]}}}));const select=createFocusProjectionSelector();await act(async()=>root.render(createElement(GlobalFocusSurface)))
 for(const processState of ['running','interrupted','running'] as const){await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id===live.id?{...session,processState}:session)})));expect(select(useAppStore.getState()).contexts.map(context=>context.id)).toEqual(['agent']);expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(live.id);expect(useAppStore.getState().sessions.find(session=>session.id===live.id)?.control).toBe(live.control)}
})
it('keeps a held launching owner and restores its durable references without new Agent membership',async()=>{
 useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='first'?{...session,processState:'exited',status:{...session.status,state:'error',exitCode:1}}:session),tabs:{...state.tabs,original:{...state.tabs.original!,regions:{...state.tabs.original!.regions,'original-left':{...state.tabs.original!.regions['original-left']!,phase:'launching'}}}}}));const originalTabs=useAppStore.getState().tabs;await act(async()=>root.render(createElement(GlobalFocusSurface)));expect(createFocusProjectionSelector()(useAppStore.getState()).contexts.map(context=>context.id)).toEqual(['agent'])
 await act(async()=>useAppStore.setState(state=>({tabs:Object.fromEntries(Object.entries(state.tabs).filter(([id])=>id!=='original'))})));expect(tabForFocusedSession(useAppStore.getState().tabs,'first')).toBeNull();const snapshot=structuredClone(useAppStore.getState().sessions);await act(async()=>useAppStore.setState({sessions:snapshot,tabs:originalTabs}));expect(tabForFocusedSession(useAppStore.getState().tabs,'first')?.id).toBe('original');const held=useAppStore.getState().tabs.original!.regions['original-left']!;expect(held.kind).toBe('terminal');if(held.kind==='terminal')expect(held.phase).toBe('launching');expect(useAppStore.getState().sessions).toBe(snapshot)
})
it('preserves exact exit facts and old activity without making them Agent results',async()=>{
 useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='first'?{...session,processState:'exited',status:{...session.status,state:'error',detail:'signal Killed: 9',exitCode:1,exitReason:'crashed'}}:session.id==='second'?{...session,processState:'exited',status:{...session.status,state:'exited',detail:'signal SIGTERM',exitCode:143,exitReason:'user-stopped'}}:session.id==='third'?{...session,processState:'exited',status:{...session.status,state:'exited',exitCode:0,exitReason:'unknown'}}:session),timelines:{...state.timelines,first:{agentSessionId:'first',revision:1,items:[{id:'old-tool',agentSessionId:'first',kind:'tool_call',status:'complete',source:'native-hook',title:'Old activity',createdAt:1,updatedAt:1}]}}}));const before=useAppStore.getState();await act(async()=>root.render(createElement(GlobalFocusSurface)));expect(createFocusProjectionSelector()(before).contexts.map(context=>context.id)).toEqual(['agent']);expect(useAppStore.getState().sessions).toBe(before.sessions);expect(useAppStore.getState().timelines).toBe(before.timelines);expect(before.sessions.slice(0,3).map(session=>[session.status.exitCode,session.status.exitReason])).toEqual([[1,'crashed'],[143,'user-stopped'],[0,'unknown']]);expect(title('agent')).toBe('Inspect the parser')
})
it('exit fact changes never redraw unrelated Agent rows',async()=>{
 await act(async()=>root.render(createElement(GlobalFocusSurface)));resetWork();await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='first'?{...session,processState:'exited',status:{...session.status,state:'exited',detail:'signal SIGTERM',exitCode:143,exitReason:'user-stopped'}}:session)})));expect(work).toEqual({members:[],numbers:[],commits:{}});expect(owning.reads).toEqual({});expect(useAppStore.getState().sessions[0]!.status.exitCode).toBe(143)
})
it('mixed Tab changes preserve one Agent row without rebuilding Terminal labels',async()=>{
 const tab=addWorkbenchRegion(createWorkbenchTab('original',{kind:'terminal',phase:'attached',regionId:'original-left',sessionId:'first',workspaceId}),'original-left','right',{kind:'agent',phase:'attached',regionId:'mixed-agent',sessionId:'agent',workspaceId});useAppStore.setState(state=>({tabs:{...state.tabs,original:tab}}));await act(async()=>root.render(createElement(GlobalFocusSurface)));expect(title('agent')).toBe('Inspect the parser');expect(container.querySelectorAll('.focus-context')).toHaveLength(1);expect(work.numbers).toEqual([]);resetWork();await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='agent'?{...session,label:'Terminal'}:session)})));expect(title('agent')).toBe('Inspect the parser');expect(work).toEqual({members:[],numbers:[],commits:{}});expect(owning.indexes).toBe(0)
})
