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
  return { ...actual, createTerminalFocusProjectionSelector: () => {
    const select = actual.createTerminalFocusProjectionSelector()
    return (input: Parameters<typeof select>[0]) => { owning.depth++; try { return select(input) } finally { owning.depth-- } }
  } }
})
vi.mock('../src/renderer/src/lib/workbench-tabs', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/workbench-tabs')>()
  return { ...actual, workbenchSurfaces: (tab: WorkbenchTab) => { if (owning.depth) work.members.push(tab.id); return actual.workbenchSurfaces(tab) } }
})
vi.mock('../src/renderer/src/lib/session-presentation', async original => {
  const actual = await original<typeof import('../src/renderer/src/lib/session-presentation')>()
  return { sessionPresentationById: (sessions: readonly SessionSnapshot[]) => { if (owning.depth) owning.indexes++; return actual.sessionPresentationById(sessions) } }
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
import { createTerminalFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'

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
  const agent = { ...examples[0]!, id: 'agent', hostId: 'local', workspacePath: workspace.path, label: 'Codex · Same project', status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }
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

it('shows distinct actual Global rows without task invention and keeps the Agent semantic name', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(container.querySelectorAll('.focus-context')).toHaveLength(5)
  expect([title('first'), title('second')]).toEqual(['Terminal 1', 'Terminal 2'])
  expect(row('first').textContent).toContain('No task signal')
  expect(row('second').textContent).toContain('No task signal')
  expect(title('agent')).toBe('Inspect the parser')
  expect(row('first').title).toContain('Tab original\nRegion original-left')
  expect(row('first').getAttribute('aria-description')).toContain('Region original-left')
  expect(row('first').textContent).not.toContain('Same project')
})

it('uses the same first owner as actual Focus navigation when a Session has multiple projections', async () => {
  const duplicate = createWorkbenchTab('duplicate', { kind: 'terminal', phase: 'attached', regionId: 'duplicate-region', sessionId: 'first', workspaceId }, 'Another projection')
  useAppStore.setState(state => ({ tabs: { ...state.tabs, duplicate } }))
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original', 'neighbour', 'agent', 'duplicate'])
  expect(tabForFocusedSession(useAppStore.getState().tabs, 'first')?.id).toBe('original')
  expect(row('first').title).toContain('Tab original\nRegion original-left')
  expect(title('first')).toBe('Terminal 1')
  await act(async () => row('first').click())
  expect(container.querySelector('#focus-workspace-slot')?.getAttribute('data-focus-tab-id')).toBe('original')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('first')
})

it('uses existing rename/reorder/return actions and preserves original identity and healthy Run refs', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const runs = useAppStore.getState().sessions.map(session => session.control.run)
  await act(async () => useAppStore.getState().renameTab('original', 'Release shells'))
  expect([title('first'), title('second')]).toEqual(['Release shells · Terminal 1', 'Release shells · Terminal 2'])
  await act(async () => useAppStore.getState().swapRegions(workspaceId, 'original', 'original-left', 'original-right'))
  expect(regionIds(useAppStore.getState().tabs.original!.layout.root)).toEqual(['original-right', 'original-left'])
  expect([title('first'), title('second')]).toEqual(['Release shells · Terminal 2', 'Release shells · Terminal 1'])
  expect(row('first').title).toContain('Region original-left')
  await act(async () => row('first').click())
  expect(container.querySelector('#focus-workspace-slot')?.getAttribute('data-focus-tab-id')).toBe('original')
  await act(async () => useAppStore.getState().setMainSurface('workbench'))
  const state = useAppStore.getState()
  expect(state.mainSurface).toBe('workbench')
  expect(tabForFocusedSession(state.tabs, 'first')?.id).toBe('original')
  expect(state.layouts[workspaceId]?.groups[0]?.activeTabId).toBe('original')
  expect(state.tabs.original?.layout.activeRegionId).toBe('original-left')
  expect(Object.keys(state.tabs.original!.regions)).toEqual(['original-left', 'original-right'])
  expect(state.sessions.map(session => session.control.run)).toEqual(runs)
  state.sessions.forEach((session, index) => expect(session.control.run).toBe(runs[index]))
})

it('does no owner/number work for irrelevant facts and limits rename/reorder derivation to the related Tab', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(Object.keys(work.commits).sort()).toEqual(['agent', 'first', 'fourth', 'second', 'third'])
  expect(work.numbers).toEqual([['original-left', 'original-right'], ['neighbour-left', 'neighbour-right']])
  resetWork()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 10, status: { ...session.status, observedAt: 2 } })) })))
  await act(async () => useAppStore.getState().setAgentComposerDraft('unrelated', 'Draft fact'))
  expect(work).toEqual({ members: [], numbers: [], commits: {} })
  expect(owning.reads).toEqual({})
  await act(async () => useAppStore.getState().renameTab('original', 'Changed shells'))
  expect(work).toEqual({ members: [], numbers: [], commits: { first: 1, second: 1 } })
  expect(title('first')).toBe('Changed shells · Terminal 1')
  expect(owning.reads.neighbour).toBeUndefined()
  expect(owning.reads.agent).toBeUndefined()
  resetWork()
  await act(async () => useAppStore.getState().swapRegions(workspaceId, 'original', 'original-left', 'original-right'))
  expect(work.numbers).toEqual([['original-right', 'original-left']])
  expect(work.commits).toEqual({ first: 1, second: 1 })
  expect(work.members).toEqual([])
  expect(owning.reads.neighbour).toBeUndefined()
  expect(owning.reads.agent).toBeUndefined()
})

it('feeds the same names to an open Preview while the permanent counter does not read layouts', async () => {
  const navigationCommits = vi.fn()
  await act(async () => root.render(createElement(Profiler, { id: 'counter', onRender: navigationCommits }, createElement(FocusNavigationButton, { 'aria-label': 'Focus' }, 'Focus'))))
  expect(navigationCommits.mock.calls.length).toBeGreaterThan(0)
  expect(work.numbers).toEqual([])
  const committed = navigationCommits.mock.calls.length
  await act(async () => useAppStore.getState().renameTab('original', 'Preview shells'))
  expect(navigationCommits.mock.calls.length).toBe(committed)
  expect(work.numbers).toEqual([])
  await act(async () => root.render(createElement(FocusNavigationPreview)))
  const preview = container.querySelector('[data-preview-session="first"]')
  expect(preview?.textContent).toContain('Preview shells · Terminal 1')
  expect(preview?.getAttribute('title')).toContain('Tab original\nRegion original-left')
  expect(container.querySelector('[data-preview-session="second"]')?.textContent).toContain('Preview shells · Terminal 2')
  resetWork()
  await act(async () => root.render(createElement(FocusNavigationButton, {}, 'Focus')))
  resetWork()
  await act(async () => useAppStore.getState().renameTab('original', 'Closed preview'))
  expect(work).toEqual({ members: [], numbers: [], commits: {} })
})

it('keeps the known fallback when there is no original owner instead of inventing a replacement', async () => {
  useAppStore.setState(state => ({ sessions: [...state.sessions, terminal('unowned', state.config!.workspaces[0]!.path)] }))
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(container.querySelectorAll('.focus-context')).toHaveLength(6)
  expect(title('unowned')).toBe('Terminal · Same project')
  expect(row('unowned').title).not.toContain('Region ')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(['original', 'neighbour', 'agent'])
})

it('keeps failed original terminals while excluding ended unowned history from both lanes and Preview', async () => {
  const path = useAppStore.getState().config!.workspaces[0]!.path
  const failed = { ...terminal('old-failed', path), processState: 'exited' as const, status: { state: 'error' as const, source: 'run-process' as const, observedAt: 1, detail: 'signal Killed: 9', exitCode: 1, exitReason: 'crashed' as const } }
  const stopped = { ...failed, id: 'old-stopped', status: { ...failed.status, state: 'exited' as const, exitReason: 'user-stopped' as const } }
  const interrupted = { ...failed, id: 'old-interrupted', processState: 'interrupted' as const, status: { state: 'disconnected' as const, source: 'run-process' as const, observedAt: 1, detail: 'The Runtime restarted and interrupted this Run.' } }
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'first' && session.kind === 'terminal' ? { ...failed, id: 'first', control: session.control } : session).concat(failed, stopped, interrupted, terminal('live-unowned', path)) }))
  const before = useAppStore.getState(), select = createTerminalFocusProjectionSelector(), projected = select(before)
  expect(projected.contexts.map(context => context.id)).toEqual(['first', 'second', 'third', 'fourth', 'agent', 'live-unowned'])
  expect(projected.laneContexts.map(context => context.id)).toEqual(projected.contexts.map(context => context.id))
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(container.querySelectorAll('.focus-context')).toHaveLength(6)
  expect(row('first').dataset.bucket).toBe('attention')
  expect(row('first').textContent).toContain('signal Killed: 9 · Exit code 1')
  expect(title('live-unowned')).toBe('Terminal · Same project')
  await act(async () => row('first').click())
  expect(container.querySelector('#focus-workspace-slot')?.getAttribute('data-focus-tab-id')).toBe('original')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('first')
  await act(async () => root.render(createElement(FocusNavigationPreview)))
  expect(container.querySelector('[data-preview-count="attention"] b')?.textContent).toBe('1')
  expect(container.querySelector('[data-preview-session="first"]')?.textContent).toContain('signal Killed: 9 · Exit code 1')
  expect(container.querySelector('.focus-navigation-preview__header small')?.textContent).toBe('6 contexts')
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(Object.keys(before.tabs))
  expect(useAppStore.getState().tabs.original!.regions).toBe(before.tabs.original!.regions)
  expect(useAppStore.getState().tabs.original!.layout.root).toBe(before.tabs.original!.layout.root)
  expect(useAppStore.getState().tabs.neighbour).toBe(before.tabs.neighbour)
  expect(useAppStore.getState().sessions.map(session => session.control.run)).toEqual(before.sessions.map(session => session.control.run))
})

it('uses process liveness rather than a disconnected display label for unowned membership', async () => {
  const path = useAppStore.getState().config!.workspaces[0]!.path
  const live = { ...terminal('disconnected-live', path), status: { state: 'disconnected' as const, source: 'run-process' as const, observedAt: 1 } }
  useAppStore.setState(state => ({ sessions: [...state.sessions, live], agentFocus: { ...state.agentFocus, execution: { sessionId: live.id, history: [] } } }))
  const select = createTerminalFocusProjectionSelector()
  expect(select(useAppStore.getState()).contexts.map(context => context.id)).toEqual(['first', 'second', 'third', 'fourth', 'agent', 'disconnected-live'])
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(row(live.id).textContent).toContain('Run is alive · Connection status unknown')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === live.id ? { ...session, processState: 'interrupted' } : session) })))
  expect(container.querySelector(`.focus-context[data-session-id="${live.id}"]`)).toBeNull()
  expect(select(useAppStore.getState()).laneContexts.map(context => context.id)).toEqual(['first', 'second', 'third', 'fourth', 'agent'])
  await act(async () => root.render(createElement(FocusNavigationPreview)))
  expect(container.querySelector('.focus-navigation-preview__header small')?.textContent).toBe('5 contexts')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === live.id ? { ...session, processState: 'running' } : session) })))
  expect(container.querySelector('.focus-navigation-preview__header small')?.textContent).toBe('6 contexts')
  expect(select(useAppStore.getState()).contexts.map(context => context.id)).toEqual(['first', 'second', 'third', 'fourth', 'agent', 'disconnected-live'])
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(live.id)
})

it('keeps a held launching owner and restores ended membership from original durable references', async () => {
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'first' ? { ...session, processState: 'exited', status: { ...session.status, state: 'error', exitCode: 1 } } : session),
    tabs: { ...state.tabs, original: { ...state.tabs.original!, regions: { ...state.tabs.original!.regions, 'original-left': { ...state.tabs.original!.regions['original-left']!, phase: 'launching' } } } } }))
  const select = createTerminalFocusProjectionSelector(), originalTabs = useAppStore.getState().tabs
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(row('first').textContent).toContain('Exit code 1')
  expect(select(useAppStore.getState()).laneContexts.map(context => context.id)).toEqual(['first', 'second', 'third', 'fourth', 'agent'])
  await act(async () => useAppStore.setState(state => ({ tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== 'original')) })))
  expect(container.querySelector('[data-session-id="first"]')).toBeNull()
  expect(row('second').textContent).toContain('Shell open')
  const snapshot = structuredClone(useAppStore.getState().sessions)
  await act(async () => useAppStore.setState({ sessions: snapshot }))
  expect(container.querySelector('[data-session-id="first"]')).toBeNull()
  await act(async () => useAppStore.setState({ tabs: originalTabs }))
  expect(row('first').title).toContain('Region original-left')
  expect(select(useAppStore.getState()).contexts.map(context => context.id)).toEqual(['first', 'second', 'third', 'fourth', 'agent'])
  expect(useAppStore.getState().sessions).toBe(snapshot)
})

it('explains exit facts instead of old activity without guessing success or the signal sender', async () => {
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'first' ? { ...session, processState: 'exited', status: { ...session.status, state: 'error', detail: 'signal Killed: 9', exitCode: 1, exitReason: 'crashed' } }
    : session.id === 'second' ? { ...session, processState: 'exited', status: { ...session.status, state: 'exited', detail: 'signal SIGTERM', exitCode: 143, exitReason: 'user-stopped' } }
      : session.id === 'third' ? { ...session, processState: 'exited', status: { ...session.status, state: 'exited', exitCode: 0, exitReason: 'unknown' } }
        : session.id === 'fourth' ? { ...session, processState: 'exited', status: { ...session.status, state: 'exited', exitReason: 'unknown' } } : session),
    timelines: { ...state.timelines, first: { agentSessionId: 'first', revision: 1, items: [{ id: 'old-tool', agentSessionId: 'first', kind: 'tool_call', status: 'complete', source: 'native-hook', title: 'Old activity', createdAt: 1, updatedAt: 1 }] } } }))
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(row('first').textContent).toContain('signal Killed: 9 · Exit code 1')
  expect(row('first').textContent).not.toContain('Old activity')
  expect(row('second').dataset.bucket).toBe('idle')
  expect(row('second').textContent).toContain('Stopped by you · signal SIGTERM · Exit code 143')
  expect(row('third').querySelector('small')?.textContent).toBe('Exited')
  expect(row('third').textContent).toContain('Exit code 0')
  expect(row('fourth').textContent).toContain('Process exited · Cause unknown')
  expect(title('agent')).toBe('Inspect the parser')
})

it('updates only the affected row when exit facts change without a state transition', async () => {
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'first' ? { ...session, processState: 'exited', status: { ...session.status, state: 'exited', exitCode: 0, exitReason: 'unknown' } } : session) }))
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(row('first').textContent).toContain('Exit code 0')
  resetWork()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'first' ? { ...session, status: { ...session.status, detail: 'signal SIGTERM', exitCode: 143, exitReason: 'user-stopped' } } : session) })))
  expect(row('first').textContent).toContain('Stopped by you · signal SIGTERM · Exit code 143')
  expect(work).toEqual({ members: [], numbers: [], commits: { first: 1 } })
  expect(owning.reads).toEqual({ original: ['name'] })
  resetWork()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 10, status: { ...session.status, observedAt: 2 } })) })))
  expect(work).toEqual({ members: [], numbers: [], commits: {} })
  expect(owning.reads).toEqual({})
})

it('reuses the base Session cache for mixed-Tab labels without indexing unrelated bytes', async () => {
  const tab = addWorkbenchRegion(createWorkbenchTab('original', { kind: 'terminal', phase: 'attached', regionId: 'original-left', sessionId: 'first', workspaceId }), 'original-left', 'right', { kind: 'agent', phase: 'attached', regionId: 'mixed-agent', sessionId: 'agent', workspaceId })
  useAppStore.setState(state => ({ tabs: { ...state.tabs, original: tab } }))
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(container.querySelectorAll('.focus-context')).toHaveLength(5)
  expect([title('first'), title('agent')]).toEqual(['Terminal', 'Inspect the parser'])
  expect(work.numbers).toEqual([['original-left', 'mixed-agent'], ['neighbour-left', 'neighbour-right']])
  resetWork()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 10, status: { ...session.status, observedAt: 2 } })) })))
  expect(work).toEqual({ members: [], numbers: [], commits: {} })
  expect(owning.indexes).toBe(0)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'agent' ? { ...session, label: 'Terminal' } : session) })))
  expect([title('first'), title('agent')]).toEqual(['Terminal 1', 'Inspect the parser'])
  expect(work.numbers).toEqual([['original-left', 'mixed-agent']])
  expect(work.commits).toEqual({ first: 1 })
  expect(owning.indexes).toBe(0)
})
