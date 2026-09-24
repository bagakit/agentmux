// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS, restoreAgentFocus, sanitizeAgentFocus } from '../src/renderer/src/lib/agent-focus'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { localDateTime } from '../src/renderer/src/lib/focus-time-window'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
// The work terminal is the only controlled leaf; Store, board, grouping, tracks and dialog are real.
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => createElement('output', { 'data-private-terminal': '' }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const NOW = Date.parse('2026-10-03T12:00:00Z'), HOUR = 3_600_000
const baseline = useAppStore.getState()
let root: Root, element: HTMLDivElement
function terminal(id: string, path: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: path, label: `Terminal ${id}`, createdAt: 1, updatedAt: 1,
    processState: 'running', latestOutputBytes: 0, status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }
}
function agent(id: string, path: string): SessionSnapshot {
  return { ...terminal(id, path), kind: 'agent', providerId: 'claude', executorId: 'claude', agentSessionUpdatedAt: 1,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: id } } }
}
function config(): AppConfig {
  return { version: 9, hosts: [{ id: 'local', label: 'Private', kind: 'local' }], executors: {},
    workspaces: [{ id: 'alpha', hostId: 'local', name: 'Alpha project', path: '/alpha', kind: 'folder' }, { id: 'beta', hostId: 'local', name: 'Beta project', path: '/beta', kind: 'folder' },
      { id: 'checkout', hostId: 'local', name: 'Feature checkout', path: '/feature', kind: 'worktree', repoPath: '/alpha', branch: 'feature/history' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
}
function record(id: string, at: number) { vi.spyOn(Date, 'now').mockReturnValue(at); useAppStore.getState().focusExecutionSession(id) }
async function render(entries = useAppStore.getState().agentFocus.execution.history, sessions = useAppStore.getState().sessions, cfg = useAppStore.getState().config) {
  const contexts = createFocusProjectionSelector()({ ...useAppStore.getState(), sessions, config: cfg, timelines: useAppStore.getState().timelines, agentNames: {} }).contexts
  await act(async () => root.render(createElement(RecentFocusTimeline, { entries, contexts, lanes: deriveFocusProjectLanes(contexts, cfg), currentSessionId: null, onSelect: useAppStore.getState().focusExecutionSession })))
}
function visibleProjects() { return [...element.querySelectorAll<HTMLElement>('[data-timeline-project]')].filter(node => !node.hidden) }
async function date(at: number) {
  await act(async () => { const input = element.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, localDateTime(at)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/alpha' })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  useAppStore.setState({ config: config(), sessions: [agent('a', '/feature'), terminal('b', '/beta')], timelines: {}, tabs: {}, layouts: {}, agentNames: { a: 'Observed worker' }, agentFocus: EMPTY_AGENT_FOCUS, mainSurface: 'agents', recoveryCandidates: [], error: null })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => { await act(async () => root.unmount()); element.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('records actual Store focus identity, closes keepSession display, and retains grouped archive through durable restore', async () => {
  const stop = vi.spyOn(api.sessions, 'stop'), recover = vi.spyOn(api.sessions, 'recover'), create = vi.spyOn(api.sessions, 'launchAgent')
  const tab = createWorkbenchTab('agent-tab', { regionId: 'agent-region', kind: 'agent', phase: 'attached', workspaceId: 'checkout', sessionId: 'a' })
  useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { checkout: createWorkspaceLayout('group', [tab.id]) } })
  record('a', NOW - 2 * HOUR); record('b', NOW - HOUR); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState()).agentFocus
  expect(restoreAgentFocus(saved).execution.history.map(item => [item.sessionId, item.identity?.project?.name, item.identity?.kind])).toEqual([['b', 'Beta project', 'terminal'], ['a', 'Alpha project', 'agent']])
  expect(await useAppStore.getState().closeTab('checkout', 'group', tab.id, { keepAgentSessions: true })).toBe(true)
  expect(useAppStore.getState().tabs).toEqual({}); expect(useAppStore.getState().sessions.map(item => item.id)).toEqual(['a', 'b'])
  const retained = sanitizeAgentFocus(restoreAgentFocus(saved), [], () => 'execution')
  expect(retained.execution.sessionId).toBeNull(); expect(retained.execution.history).toEqual(restoreAgentFocus(saved).execution.history)
  useAppStore.setState({ sessions: [], agentFocus: retained, config: { ...config(), workspaces: [] } })
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(visibleProjects().map(node => node.querySelector('strong')!.textContent)).toEqual(['Alpha project', 'Beta project'])
  expect(api.workspaces.appearance).not.toHaveBeenCalled()
  expect([...element.querySelectorAll('[data-history-only="true"]')].map(node => node.getAttribute('data-focus-timeline-id'))).toEqual(['a', 'b'])
  const button = element.querySelector<HTMLButtonElement>('[data-focus-timeline-id="a"] .recent-focus__segment')!
  await act(async () => button.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Observed worker'); expect(dialog.textContent).toContain('feature/history'); expect(dialog.textContent).toContain('Alpha project')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  expect(stop.mock.calls).toEqual([]); expect(recover.mock.calls).toEqual([]); expect(create.mock.calls).toEqual([])
})

it('does not substitute current ownership or renames for past observations, including unknown legacy events', async () => {
  record('a', NOW - 2 * HOUR); record('b', NOW - HOUR)
  const entries = [...useAppStore.getState().agentFocus.execution.history, { sessionId: 'a', focusedAt: NOW - 2.5 * HOUR }]
  const moved = agent('a', '/beta'); useAppStore.setState({ sessions: [moved], agentNames: { a: 'Renamed now' } }); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  await render(entries, [moved], config())
  const groups = visibleProjects()
  expect(groups.map(node => node.querySelector('strong')!.textContent)).toEqual(['Project not recorded', 'Alpha project', 'Beta project'])
  expect(groups[1]!.querySelector('.recent-focus__track .recent-focus__gutter > span')!.textContent).toContain('Observed worker')
  expect(groups[0]!.querySelector('.recent-focus__segment')!.getAttribute('title')).toContain('Historical name not recorded · Project not recorded')
  expect(groups[1]!.querySelector('[data-history-only="true"]')).not.toBeNull()
})

it('collapses a compact project heading while preserving actual per-Context fragments as an inert summary', async () => {
  record('a', NOW - 2 * HOUR); record('b', NOW - HOUR); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  await render(); const group = visibleProjects()[0]!, button = group.querySelector<HTMLButtonElement>('.recent-focus__project-heading')!
  expect(button.textContent).toContain('1'); expect(group.querySelector('img[alt="Project icon"]')).not.toBeNull()
  const segments = [...group.querySelectorAll('.recent-focus__segment')]
  await act(async () => button.click())
  const summary = group.querySelector<HTMLElement>('.recent-focus__project-tracks')!
  expect(button.getAttribute('aria-expanded')).toBe('false'); expect(summary.inert).toBe(true); expect(summary.getAttribute('aria-hidden')).toBe('true')
  expect([...summary.querySelectorAll('.recent-focus__segment')]).toEqual(segments)
  await act(async () => button.click()); expect(summary.inert).toBe(false); expect(button.getAttribute('aria-expanded')).toBe('true')
})

it('shows retained Terminal focus only inside a containing window without inventing a live Run or execution duration', async () => {
  record('b', NOW - 7 * 24 * HOUR); const entries = useAppStore.getState().agentFocus.execution.history
  vi.spyOn(Date, 'now').mockReturnValue(NOW); await render(entries, [])
  expect(visibleProjects()).toEqual([]); expect(element.querySelectorAll('[data-focus-timeline-id]')).toHaveLength(0)
  await date(NOW - 7 * 24 * HOUR)
  expect(visibleProjects().map(node => node.querySelector('strong')!.textContent)).toEqual(['Beta project'])
  expect(element.querySelector('[data-focus-timeline-id="b"] .recent-focus__segment')!.getAttribute('data-known-end')).toBeNull()
  expect(element.querySelectorAll('[data-run-state], [data-run-id], .recent-focus__working')).toHaveLength(0)
})

it('preserves immutable observations and the 2000-event limit through actual Store persist shape', () => {
  record('a', NOW - HOUR)
  const observation = useAppStore.getState().agentFocus.execution.history[0]!
  expect(observation.identity?.name).toBe('Observed worker')
  useAppStore.getState().renameAgent('a', 'Later name')
  expect(useAppStore.getState().agentFocus.execution.history[0]).toBe(observation)
  useAppStore.setState({ sessions: ['c', 'd'].map(id => ({ ...terminal(id, '/'), hostId: 'h', label: id, control: { kind: 'terminal' as const, hostId: 'h', runId: id, run: { runId: id } } })) })
  for (let i = 0; i < 2005; i++) record(i % 2 ? 'c' : 'd', 5000 + i)
  const focus = useAppStore.getState().agentFocus
  expect(focus.execution.history).toHaveLength(2000)
  expect(focus.execution.history.at(-1)!.focusedAt).toBe(5005)
  expect(restoreAgentFocus(JSON.parse(JSON.stringify(focus)))).toEqual(focus)
})

it('does not read native history for archive grouping and preserves tracks through unrelated output', async () => {
  record('a', NOW - 2 * HOUR); record('b', NOW - HOUR); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  useAppStore.setState({ sessions: [], agentFocus: sanitizeAgentFocus(useAppStore.getState().agentFocus, [], () => 'execution') })
  const history = vi.spyOn(api.sessions, 'historyPage')
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const tracks = [...element.querySelectorAll('[data-focus-timeline-id]')]; expect(tracks).toHaveLength(2)
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [{ id: 'out', agentSessionId: 'unrelated', kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: NOW, updatedAt: NOW, title: 'Unrelated output', content: 'Nothing related' }] } } })))
  expect([...element.querySelectorAll('[data-focus-timeline-id]')]).toEqual(tracks); expect(history.mock.calls).toEqual([])
})

it('keeps project-presence work linear in actual retained tracks on initial mount', async () => {
  const size = 200
  useAppStore.setState({ sessions: Array.from({ length: size }, (_, index) => terminal(`presence-scale-${index}`, '/alpha')) })
  for (let index = 0; index < size; index++) record(`presence-scale-${index}`, NOW - size + index)
  const entries = useAppStore.getState().agentFocus.execution.history
  expect(entries).toHaveLength(size)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  let additions = 0, copied = 0
  const NativeSet = globalThis.Set
  class CountedSet<T> extends NativeSet<T> {
    constructor(values?: Iterable<T> | null) {
      const items = values ? Array.from(values) : undefined
      super(items)
      if (items?.length && typeof items[0] === 'string' && items[0].includes('presence-scale-')) copied += items.length
    }
    add(value: T): this {
      if (typeof value === 'string' && value.includes('presence-scale-')) additions++
      return super.add(value)
    }
  }
  vi.stubGlobal('Set', CountedSet)
  await render(entries, [])
  expect(element.querySelectorAll('[data-focus-timeline-id]')).toHaveLength(size)
  expect(visibleProjects()).toHaveLength(1)
  expect(visibleProjects()[0]!.querySelector('.recent-focus__project-heading small')!.textContent).toBe(String(size))
  expect(additions).toBeGreaterThanOrEqual(size)
  expect(copied).toBeLessThanOrEqual(size * 2)
  expect(additions).toBeLessThanOrEqual(size * 3)
})
