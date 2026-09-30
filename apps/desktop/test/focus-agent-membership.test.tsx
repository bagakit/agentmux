import { focusFilterOptions } from './fixtures/focus-filter-menu'
import { resolve } from 'node:path'
// @vitest-environment happy-dom
import { act, createElement, memo, Profiler, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { addTabPlacement, createWorkspaceLayout, regionIds } from '@agentmux/layout'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executionFocusPresentation, tabForFocusedSession } from '../src/renderer/src/lib/focus-tab-projection'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'

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
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
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
  const inputConfig = await api.config.get(), snapshot = await api.sessions.snapshot()
  // The public spatial catalog requires absolute durable directories, unlike old list-only fixtures.
  const config = { ...inputConfig, workspaces: inputConfig.workspaces.map(item => ({ ...item, path: resolve(item.path), ...(item.repoPath ? { repoPath: resolve(item.repoPath) } : {}) })) }
  const examples = snapshot.sessions.map(item => ({ ...item, workspacePath: resolve(item.workspacePath) })), workspace = config.workspaces[0]!
  workspaceId = workspace.id
  const base = examples.find((session): session is Extract<SessionSnapshot,{kind:'agent'}> => session.kind === 'agent'); expect(base).toBeDefined()
  const agent = { ...base!, id: 'agent', hostId: 'local', workspacePath: workspace.path, label: 'Inspect the parser', status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }
  const agents = [agent, ...(['attention', 'results', 'idle', 'disconnected', 'healthy-lost'] as const).map(id => ({ ...agent, id, label: id, processState: id === 'disconnected' ? 'interrupted' as const : 'running' as const, status: { state: id === 'attention' ? 'error' as const : id === 'results' ? 'done' as const : id === 'disconnected' || id === 'healthy-lost' ? 'disconnected' as const : 'running' as const, source: 'native-hook' as const, observedAt: 1 }, control: { ...agent.control, run: {runId:id+'-run'} } }))]
  const tabs = { original: pair('original', 'first', 'second'), neighbour: pair('neighbour', 'third', 'fourth'), agent: createWorkbenchTab('agent', { kind: 'agent', phase: 'attached', regionId: 'agent-region', sessionId: 'agent', workspaceId }) }
  for (const [id, tab] of Object.entries(tabs)) tabs[id as keyof typeof tabs] = new Proxy(tab, { get(target, key, receiver) {
    if (owning.depth && ['name', 'regions', 'layout'].includes(String(key))) (owning.reads[id] ??= []).push(String(key))
    return Reflect.get(target, key, receiver)
  } })
  let layout = createWorkspaceLayout('owner-group')
  for (const tabId of Object.keys(tabs)) layout = addTabPlacement(layout, 'owner-group', tabId)!
  const timeline: AgentTimelineSnapshot = { agentSessionId: 'agent', revision: 1, items: [{ id: 'prompt', agentSessionId: 'agent', kind: 'user_message', status: 'complete', source: 'native-hook', title: 'User message', content: 'Inspect the parser', createdAt: 1, updatedAt: 1 }] }
  useAppStore.setState({ config, sessions: ['first', 'second', 'third', 'fourth'].map<SessionSnapshot>(id => terminal(id, workspace.path)).concat(agents), tabs, layouts: { [workspaceId]: layout }, activeWorkspaceId: workspaceId, providerCatalog: [], timelines: { agent: timeline, results: { agentSessionId: 'results', revision: 1, items: [{id:'answer',agentSessionId:'results',kind:'assistant_message',status:'complete',source:'native-hook',title:'Answer',content:'Reviewed and complete',createdAt:1,updatedAt:1}] } }, agentNames: {}, closingWorkbenchViews: {}, agentComposerDrafts: {first:'Unsent shell draft'}, mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  resetWork()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const agentIds = ['agent', 'attention', 'disconnected', 'healthy-lost', 'idle', 'results']
async function expandDisconnected() { const toggle=container.querySelector<HTMLButtonElement>('[data-bucket="disconnected"] .focus-recovery-toggle');expect(toggle).not.toBeNull();await act(async()=>toggle!.click()) }
// Agent-only membership is the left lane collection, not the separately retained right work surface.
function renderedIds() { return [...container.querySelectorAll<HTMLElement>('.global-focus-main [data-session-id]')].map(node=>node.dataset.sessionId).sort() }
function focusSurface() {
  const state = useAppStore.getState()
  const presentation = executionFocusPresentation(state.agentFocus.execution, state.tabs, state.agentFocus.execution.sessionId ? spatialCatalog(state, []) : null, reference => state.selectExecutionFocusReference(reference, state.agentFocus.execution))
  return createElement(GlobalFocusSurface, { presentation })
}

it('mounted lanes exclude ordinary running, failed and disconnected Terminals and retain every confirmed Agent state',async()=>{
  useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='second'?{...session,processState:'exited',status:{state:'error',source:'run-process',observedAt:1,exitCode:1}}:session.id==='third'?{...session,processState:'interrupted',status:{state:'disconnected',source:'run-process',observedAt:1}}:session)}))
  await act(async()=>root.render(focusSurface()));await expandDisconnected()
  expect(renderedIds()).toEqual(agentIds)
  expect(row('agent').dataset.bucket).toBe('working');expect(row('attention').dataset.bucket).toBe('attention');expect(row('results').dataset.bucket).toBe('results');expect(row('idle').dataset.bucket).toBe('idle')
  expect(row('healthy-lost').closest('[data-bucket="idle"]')).not.toBeNull();expect(row('disconnected').closest('[data-bucket="disconnected"]')).not.toBeNull()
  const options=(await focusFilterOptions(container,'state')).map(option=>option.text)
  expect(options).toEqual(['All states','Attention · 1','Working · 1','Results · 1','Idle / Recovery · 2','Disconnected · 1'])
  const axes=[...container.querySelectorAll<HTMLButtonElement>('.focus-project-lanes__axis')];expect(axes).toHaveLength(1);expect(axes[0]!.title).toContain('· 5 live ·')
})
it('actual hover totals and permanent counts consume the same Agent-only set',async()=>{
  await act(async()=>root.render(createElement(Fragment,null,createElement(FocusNavigationButton,{'aria-label':'Focus'},'Focus'),createElement(FocusNavigationPreview))))
  expect(container.querySelector('[data-focus-count="working"]')?.textContent).toBe('1');expect(container.querySelector('[data-focus-count="attention"]')?.textContent).toBe('1')
  expect(container.querySelector('.focus-navigation-preview__header')?.textContent).toBe('Focus6 contexts')
  expect([...container.querySelectorAll<HTMLElement>('[data-preview-session]')].map(node=>node.dataset.previewSession)).toEqual(['attention','agent','results'])
  expect([...container.querySelectorAll('[data-preview-count] b')].map(node=>node.textContent)).toEqual(['1','1','1','1'])
  expect(container.querySelector('.focus-navigation-preview__recovery')?.textContent).toContain('2 disconnected')
})
it('exclusion keeps the actual selected Terminal workspace, owner, Region, Run, draft, visits and layout',async()=>{
  await act(async()=>useAppStore.getState().focusRegion(workspaceId,'original','original-left','keyboard'))
  await act(async()=>useAppStore.getState().focusExecutionSession('first'))
  const before=useAppStore.getState(), runs=before.sessions.map(session=>session.control.run)
  await act(async()=>root.render(focusSurface()))
  expect(renderedIds()).not.toContain('first');expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe('original')
  expect(container.querySelector('.focus-toolbar__identity strong')?.textContent).toBe('Terminal');expect(container.querySelector('.focus-toolbar__identity')?.getAttribute('title')).not.toContain('Recovery unknown')
  const after=useAppStore.getState();expect(after.agentFocus).toBe(before.agentFocus);expect(after.tabs).toBe(before.tabs);expect(after.layouts).toBe(before.layouts);expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.activeWorkspaceId).toBe(workspaceId);expect(after.tabs.original?.layout.activeRegionId).toBe('original-left');expect(tabForFocusedSession(after.tabs,'first')?.id).toBe('original')
  after.sessions.forEach((session,index)=>expect(session.control.run).toBe(runs[index]));expect(after.agentFocus.execution.history.length).toBeGreaterThan(0)
  expect(container.querySelector('[data-focus-timeline-id="first"] .recent-focus__segment')).not.toBeNull()
})
it('original Terminal rename, reorder and return remain precise without adding cards or changing Run refs',async()=>{
  const runs=useAppStore.getState().sessions.map(session=>session.control.run)
  await act(async()=>useAppStore.getState().renameTab('original','Release shells'))
  await act(async()=>useAppStore.getState().swapRegions(workspaceId,'original','original-left','original-right'))
  await act(async()=>useAppStore.getState().focusRegion(workspaceId,'original','original-left','keyboard'))
  await act(async()=>useAppStore.getState().focusExecutionSession('first'))
  await act(async()=>root.render(focusSurface()))
  expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe('original')
  expect(container.querySelector('.focus-toolbar__identity strong')?.textContent).toBe('Release shells');expect(useAppStore.getState().tabs.original?.name).toBe('Release shells');expect(regionIds(useAppStore.getState().tabs.original!.layout.root)).toEqual(['original-right','original-left'])
  await act(async()=>useAppStore.getState().setMainSurface('workbench'))
  const state=useAppStore.getState();expect(state.mainSurface).toBe('workbench');expect(state.layouts[workspaceId]?.groups[0]?.activeTabId).toBe('original');expect(state.tabs.original?.layout.activeRegionId).toBe('original-left')
  state.sessions.forEach((session,index)=>expect(session.control.run).toBe(runs[index]));expect(renderedIds()).not.toContain('first')
})
it('irrelevant Terminal bytes, heartbeats, drafts and rename never derive owners or redraw Agent cards',async()=>{
  await act(async()=>root.render(focusSurface()));expect(Object.keys(work.commits).sort()).toEqual(['agent','attention','healthy-lost','idle','results'])
  resetWork()
  await act(async()=>useAppStore.setState(state=>({sessions:state.sessions.map(session=>({...session,latestOutputBytes:session.latestOutputBytes+10,status:{...session.status,observedAt:2}}))})))
  await act(async()=>useAppStore.getState().setAgentComposerDraft('first','Another shell draft'))
  await act(async()=>useAppStore.getState().renameTab('original','Shells renamed'))
  expect(work).toEqual({members:[],numbers:[],commits:{}});expect(owning.indexes).toBe(0)
})
it('the shared projection retains exact Agent row arrays for irrelevant Terminal changes and removes changed eligibility',()=>{
  const select=createFocusProjectionSelector(),before=useAppStore.getState(), initial=select(before)
  expect(initial.contexts.map(row=>row.id).sort()).toEqual(agentIds)
  const ignored=select({...before,sessions:before.sessions.map(session=>session.kind==='terminal'?{...session,label:'Provider-like title',latestOutputBytes:99}:session)})
  expect(ignored.contexts).toBe(initial.contexts);expect(ignored.laneContexts).toBe(initial.laneContexts)
  const changed=select({...before,sessions:before.sessions.map(session=>session.id==='agent'?terminal('agent',session.workspacePath):session)})
  expect(changed.contexts.map(row=>row.id).sort()).toEqual(agentIds.filter(id=>id!=='agent'))
})
it('Terminal-only input has an honest empty board while its selected original workspace remains',async()=>{
  await act(async()=>useAppStore.getState().focusRegion(workspaceId,'original','original-left','keyboard'))
  await act(async()=>useAppStore.getState().focusExecutionSession('first'))
  useAppStore.setState(state=>({sessions:state.sessions.filter(session=>session.kind==='terminal'),timelines:{}}))
  await act(async()=>root.render(focusSurface()))
  expect(renderedIds()).toEqual([]);expect(container.querySelector('.global-agents-empty')?.textContent).toContain('Open an Agent from a Workspace')
  expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe('original');expect(useAppStore.getState().sessions).toHaveLength(4)
})
