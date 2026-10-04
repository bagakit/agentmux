import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryDescriptor, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'
import { chooseFocusFilter } from './fixtures/focus-filter-menu'
import * as ProjectRows from '../src/renderer/src/components/FocusProjectLanes'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ sessionId }: { sessionId: string }) => createElement('output', { 'data-private-pty': sessionId }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const initial = useAppStore.getState(), NOW = Date.parse(_hygiene_fixtureIso(24235200000, "second")), HOUR = 3_600_000
let root: Root, container: HTMLDivElement, base: Extract<SessionSnapshot, { kind: 'agent' }>
const key = (project: string, host = 'local') => JSON.stringify([host, project])
function visit(id: string, project = id, hours = 36, hostId = 'local'): AgentFocusHistoryEntry {
  return { sessionId: id, focusedAt: NOW - hours * HOUR, identity: { kind: 'agent', providerId: 'generic', name: `Observed ${id}`,
    hostId, workspacePath: (_hygiene_fixturePath("observed/") + (project) + ""), project: { id: project, name: `Project ${project}` }, branch: 'observed-branch', topicId: 'observed-topic' } }
}
const source = (id: string, state: 'active' | 'retired' = 'active', hostId = 'local'): AgentSessionHistoryDescriptor => ({ agentSessionId: id, hostId, state, ...(state === 'retired' ? { retiredAt: NOW - HOUR } : {}) })
function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { ...base, id, label: id, hostId: 'local', workspacePath: _hygiene_fixturePath("current"), processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: NOW - 168 * HOUR },
    control: { ...base.control, hostId: 'local', agentSessionId: id, run: { runId: `new-current-${id}` } } }
}
function recent(): HTMLButtonElement[] { return [...container.querySelectorAll<HTMLButtonElement>('[data-recent-project]')] }
function past(): HTMLButtonElement[] { return [...container.querySelectorAll<HTMLButtonElement>('[data-retained-project]')] }
async function mount(entries: AgentFocusHistoryEntry[], options: { sessions?: SessionSnapshot[]; visible?: boolean; timelines?: Record<string, AgentTimelineSnapshot> } = {}) {
  useAppStore.setState({ agentFocus: { execution: { sessionId: null, history: entries }, pmo: { sessionId: null } },
    sessions: options.sessions ?? [], timelines: options.timelines ?? {} })
  await act(async () => root.render(<GlobalFocusSurface visible={options.visible ?? true} />))
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 25)))
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const found = snapshot.sessions.find((session): session is typeof base => session.kind === 'agent')
  expect(found).toBeDefined(); base = found!
  useAppStore.setState({ ...initial, loading: false, config: { ...config, focus: { recentActivityHours: 24 }, workspaces: [{ id: 'current', name: 'Current project', path: _hygiene_fixturePath("current"), hostId: 'local', kind: 'folder' }] },
    sessions: [], tabs: {}, layouts: {}, timelines: {}, scratchTopicSnapshots: {}, providerCatalog: [], recoveryCandidates: [], spaceObjectIcons: {}, agentNames: {}, demands: {},
    mainSurface: 'agents', error: null, activeWorkspaceId: null, agentComposerDrafts: { healthy: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, focusTimelineRuler: { ...initial.focusTimelineRuler, timeZone: 'UTC' } }, true)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'generic', nativeSessionId: `native-${control.agentSessionId}` }, items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'generic', nativeSessionId: `native-${control.agentSessionId}` }, dispose: vi.fn() }))
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, revision: 0, items: [] }))
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("current") })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  for (const method of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const) vi.spyOn(api.sessions, method)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('keeps 36h and exactly 48h observations in the original board despite a saved 24h sort, while closed/49h observations remain Past and old healthy Context stays', async () => {
  vi.mocked(api.sessions.historySources).mockResolvedValue([source('recent'), source('edge'), source('closed', 'retired'), source('old')])
  const healthy = agent('healthy')
  await mount([visit('recent'), visit('edge', 'edge', 48), visit('old', 'old', 49), visit('closed', 'closed', 1)], { sessions: [healthy] })
  expect(recent().map(row => row.dataset.recentProject).sort()).toEqual([key('edge'), key('recent')])
  expect(past().map(row => row.dataset.retainedProject).sort()).toEqual([key('closed'), key('old')])
  expect(container.querySelectorAll('.focus-project-board__live .focus-project-lanes__row')).toHaveLength(3)
  expect(container.querySelectorAll('.focus-context')).toHaveLength(1)
  expect(container.querySelector('.focus-context')?.getAttribute('data-session-id')).toBe('healthy')
  expect(recent()[0]!.title).toContain('observed-branch'); expect(recent()[0]!.title).toContain('observed-topic')
  expect(useAppStore.getState().config?.focus?.recentActivityHours).toBe(24)
  expect(useAppStore.getState().sessions).toEqual([healthy]); expect(useAppStore.getState().agentComposerDrafts.healthy).toBe('Original unsent draft')
  for (const method of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const) expect(api.sessions[method]).not.toHaveBeenCalled()
})

it('keeps recent unknown during catalogue wait and missing/error facts, and a late retired catalogue cannot erase a newer current Run', async () => {
  let resolve!: (sources: AgentSessionHistoryDescriptor[]) => void
  vi.mocked(api.sessions.historySources).mockImplementation(() => new Promise(done => { resolve = done }))
  await mount([visit('newborn'), visit('missing')])
  expect(recent()).toHaveLength(2); expect(recent().every(row => row.textContent?.includes('Current status unknown'))).toBe(true)
  const current = agent('newborn')
  await act(async () => useAppStore.setState({ sessions: [current] }))
  await act(async () => resolve([source('newborn', 'retired')]))
  expect(container.querySelector('.focus-context[data-session-id="newborn"]')).not.toBeNull()
  expect(recent().map(row => row.dataset.recentProject)).toEqual([key('missing')])
  expect(recent()[0]!.textContent).toContain('Current status unknown')
  expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('new-current-newborn')
})

it('uses held real task timestamps as well as visits, without promoting future visits or same-state lifecycle observation times', async () => {
  const task = (id: string, stateOnly: boolean): AgentTimelineSnapshot => ({ agentSessionId: id, revision: 1, items: [{ id: `${id}-event`, agentSessionId: id,
    kind: stateOnly ? 'lifecycle' : 'tool_call', title: 'Held task event', status: 'complete', source: 'native-hook', createdAt: NOW - 49 * HOUR, updatedAt: stateOnly ? NOW : NOW - 36 * HOUR,
    ...(stateOnly ? { activityState: { run: { runId: `old-${id}` }, state: 'done', stateEnteredAt: NOW - 49 * HOUR } } : {}) }] })
  await mount([visit('task', 'task', 168), visit('heartbeat', 'heartbeat', 168), visit('future', 'future', -1)], { timelines: { task: task('task', false), heartbeat: task('heartbeat', true) } })
  expect(recent().map(row => row.dataset.recentProject)).toEqual([key('task')])
  expect(recent()[0]!.textContent).toContain('Last active')
  expect(recent()[0]!.querySelector('time')?.dateTime).toBe(new Date(NOW - 36 * HOUR).toISOString())
  expect(past().map(row => row.dataset.retainedProject).sort()).toEqual([key('future'), key('heartbeat')])
})

it('requires every recorded Host/SID source to be retired, isolates equal project IDs across Hosts, and filters the same lightweight board rows', async () => {
  vi.mocked(api.sessions.historySources).mockResolvedValue([source('old-local', 'retired'), source('active-local'), source('closed-remote', 'retired', 'remote')])
  await mount([visit('old-local', 'shared'), visit('active-local', 'shared'), visit('closed-remote', 'shared', 1, 'remote')])
  expect(recent().map(row => row.dataset.recentProject)).toEqual([key('shared')])
  expect(past().map(row => row.dataset.retainedProject)).toEqual([key('shared', 'remote')])
  await chooseFocusFilter(container, 'project', key('shared', 'remote'))
  expect(recent()).toHaveLength(0); expect(past()).toHaveLength(1)
  await chooseFocusFilter(container, 'project', key('shared'))
  expect(recent()).toHaveLength(1); expect(past()).toHaveLength(0)
  const before = useAppStore.getState(), row = recent()[0]!
  await act(async () => { row.focus(); row.click() })
  expect(container.querySelector('.recent-focus')?.getAttribute('data-window-start')).not.toBeNull()
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus); expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it('shares exactly one actual catalogue read with Timeline, keeps errors visible on recent unknown, and hidden/bytes add no catalogue or body reads', async () => {
  vi.mocked(api.sessions.historySources).mockRejectedValue(new Error('Catalogue service unavailable'))
  await mount([visit('missing')], { visible: false })
  expect(api.sessions.historySources).not.toHaveBeenCalled()
  await act(async () => root.render(<GlobalFocusSurface visible />))
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 25)))
  expect(api.sessions.historySources).toHaveBeenCalledTimes(1)
  expect(recent()).toHaveLength(1); expect(recent()[0]!.textContent).toContain('Current status unknown')
  expect(container.querySelector('[role="status"][title="Catalogue service unavailable"]')).not.toBeNull()
  const node = recent()[0], reads = [api.sessions.historySources, api.sessions.historyPage, api.sessions.observeHistory, api.sessions.timeline].map(fn => vi.mocked(fn).mock.calls.length)
  for (let i = 0; i < 12; i++) await act(async () => useAppStore.setState({ sessions: [agent('healthy')] }))
  expect(recent()[0]).toBe(node)
  await act(async () => root.render(<GlobalFocusSurface visible={false} />))
  expect([api.sessions.historySources, api.sessions.historyPage, api.sessions.observeHistory, api.sessions.timeline].map(fn => vi.mocked(fn).mock.calls.length)).toEqual(reads)
})

it('unrelated loaded timeline changes do not rerender the real lane consumer or reread project sources', async () => {
  const render = vi.spyOn(ProjectRows, 'FocusProjectLanes')
  await mount([visit('recent')])
  expect(render.mock.calls.length).toBeGreaterThan(0)
  const baseline = render.mock.calls.length, original = recent()[0]!
  const calls = vi.mocked(api.sessions.historySources).mock.calls.length
  for (let index = 0; index < 15; index++) await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines,
    unrelated: { agentSessionId: 'unrelated', revision: index + 1, items: [{ id: 'unrelated-tool', agentSessionId: 'unrelated', kind: 'tool_call', title: 'Unrelated output', status: 'streaming', source: 'native-hook', createdAt: NOW, updatedAt: NOW }] }
  } })))
  expect(render.mock.calls.length).toBe(baseline); expect(recent()[0]).toBe(original)
  expect(api.sessions.historySources).toHaveBeenCalledTimes(calls)
})
