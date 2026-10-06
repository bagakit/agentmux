// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, now: number
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  now = Date.now()
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const base = snapshot.sessions.find(session => session.kind === 'agent')!
  const { semanticStatus: _semantic, ...sessionBase } = base
  const workspaces = ['older', 'newer', 'unknown'].map(id => ({ id, name: id, hostId: 'local', path: fixturePath(id), kind: 'folder' as const }))
  const sessions = workspaces.map((workspace, index) => ({ ...sessionBase, id: workspace.id, hostId: 'local', workspacePath: workspace.path,
    processState: 'running' as const, status: { state: 'running' as const, source: 'run-process' as const, observedAt: now },
    ...(index === 2 ? {} : { semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - (index === 0 ? 10000 : 1000) } }),
    control: { ...base.control, agentSessionId: workspace.id } }))
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: fixturePath('older') })
  useAppStore.setState({ config: { ...config, workspaces }, sessions, timelines: {}, tabs: {}, agentNames: {}, scratchTopicSnapshots: {},
    mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { older: 'Original unsent draft' } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const order = () => [...document.querySelectorAll<HTMLElement>('.focus-project-board__live .focus-project-lanes__row')].map(row => row.dataset.projectId)
async function task(id: string, at: number) {
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [id]: { agentSessionId: id, revision: at, items: [{
    id: 'original-task', agentSessionId: id, kind: 'user_message', source: 'native-hook', status: 'complete', title: 'Prompt', content: 'Continue the task', createdAt: at, updatedAt: at
  }] } } })))
}

it('aggregates activity across every checkout of the original Host/Project before filtering', () => {
  const state = useAppStore.getState(), config = state.config!
  const checkout = { ...config.workspaces[0]!, id: 'checkout', path: fixturePath('checkout'), repoPath: config.workspaces[0]!.path, branch: 'feature' }
  const session = { ...state.sessions[0]!, id: 'checkout-agent', workspacePath: checkout.path,
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, stateEnteredAt: now, observedAt: now } }
  const input = { ...state, config: { ...config, workspaces: [...config.workspaces, checkout] }, sessions: [...state.sessions, session] }
  const contexts = createFocusProjectionSelector()(input).laneContexts
  const lanes = deriveFocusProjectLanes(contexts, input.config, undefined, {}, now)
  const project = lanes.filter(lane => lane.projectId === 'older')
  expect(project).toHaveLength(2)
  expect(project.map(lane => lane.lastActivityAt)).toEqual([now, now])
  expect(lanes.map(lane => lane.projectId)).toEqual(['older', 'older', 'newer', 'unknown'])
})

it('shows current activity immediately but coalesces changing project order in a bounded window', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  expect(order()).toEqual(['newer', 'older', 'unknown'])
  const original = container.querySelector('[data-session-id="older"]'), controls = useAppStore.getState().sessions.map(session => session.control)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const page = vi.spyOn(api.sessions, 'historyPage')
  await task('older', now)
  expect(order()).toEqual(['newer', 'older', 'unknown'])
  expect(container.querySelector('[data-project-id="older"] time')?.getAttribute('dateTime')).toBe(new Date(now).toISOString())
  await act(async () => vi.advanceTimersByTime(2000))
  await task('newer', now + 1)
  await task('older', now + 2)
  await act(async () => vi.advanceTimersByTime(1000))
  expect(order()).toEqual(['older', 'newer', 'unknown'])
  expect(container.querySelector('[data-session-id="older"]')).toBe(original)
  expect(useAppStore.getState().sessions.map(session => session.control)).toEqual(controls)
  expect(useAppStore.getState().agentComposerDrafts.older).toBe('Original unsent draft')
  expect(page).not.toHaveBeenCalled()
})

it('does not turn bytes, heartbeat, focus visits or hidden updates into task activity', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const before = container.querySelector('[data-project-id="older"] time')?.getAttribute('dateTime')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, updatedAt: now, latestOutputBytes: 1000, status: { ...session.status, observedAt: now } })),
    agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution, history: [{ sessionId: 'older', focusedAt: now }] } } })))
  expect(order()).toEqual(['newer', 'older', 'unknown'])
  expect(container.querySelector('[data-project-id="older"] time')?.getAttribute('dateTime')).toBe(before)
  expect(container.querySelector('[data-project-id="unknown"] .focus-project-lanes__activity')?.textContent).toBe('Activity unknown')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await task('older', now)
  await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
  await act(async () => vi.advanceTimersByTime(4000))
  expect(order()).toEqual(['newer', 'older', 'unknown'])
  await act(async () => useAppStore.setState({ mainSurface: 'agents' }))
  expect(order()).toEqual(['older', 'newer', 'unknown'])
})

it('holds the original keyboard and pointer target until the operation finishes', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const card = container.querySelector<HTMLButtonElement>('[data-session-id="older"]')!
  await act(async () => card.focus())
  await task('older', now)
  await act(async () => vi.advanceTimersByTime(3000))
  expect(order()).toEqual(['newer', 'older', 'unknown'])
  expect(document.activeElement).toBe(card)
  await act(async () => { card.blur(); card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })) })
  await act(async () => vi.advanceTimersByTime(3000))
  expect(order()).toEqual(['newer', 'older', 'unknown'])
  await act(async () => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  const outside = document.createElement('input'); document.body.append(outside)
  await act(async () => outside.focus())
  await act(async () => vi.advanceTimersByTime(3000))
  expect(order()).toEqual(['older', 'newer', 'unknown'])
  expect(container.querySelector('[data-session-id="older"]')).toBe(card)
  outside.remove()
})

it('counts proven child activity without moving the original state-entry clock', async () => {
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const original = useAppStore.getState().sessions[0]!
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'older' && session.kind === 'agent'
    ? { ...session, semanticStatus: { ...session.semanticStatus!, aggregateActivityAt: now } } : session) })))
  expect(container.querySelector('[data-project-id="older"] time')?.getAttribute('dateTime')).toBe(new Date(now).toISOString())
  await act(async () => vi.advanceTimersByTime(3000))
  expect(order()).toEqual(['older', 'newer', 'unknown'])
  const updated = useAppStore.getState().sessions[0]!
  expect(updated.kind === 'agent' && updated.semanticStatus?.stateEnteredAt).toBe(original.kind === 'agent' && original.semanticStatus?.stateEnteredAt)
  expect(useAppStore.getState().timelines).toEqual({})
})

it('uses the saved recent window to distinguish newly sorted work from stable older projects', () => {
  const state = useAppStore.getState(), select = createFocusProjectionSelector()
  const sessions = state.sessions.map((session, index) => session.kind === 'agent' && index < 2 ? { ...session,
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - (index === 0 ? 30 : 20) * 3_600_000 } } : session)
  const rows = select({ ...state, sessions }).laneContexts
  expect(deriveFocusProjectLanes(rows, { ...state.config!, focus: { recentActivityHours: 12 } }, undefined, {}, now).map(lane => lane.projectId)).toEqual(['older', 'newer', 'unknown'])
  expect(deriveFocusProjectLanes(rows, { ...state.config!, focus: { recentActivityHours: 48 } }, undefined, {}, now).map(lane => lane.projectId)).toEqual(['newer', 'older', 'unknown'])
})
