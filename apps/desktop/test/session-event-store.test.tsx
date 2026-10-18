// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../src/shared/contracts'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { useAppStore } from '../src/renderer/src/store'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { parseRendererPerformanceSnapshot } from '@agentmux/core/control'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const original = useAppStore.getState()
let root: Root, container: HTMLDivElement, commits = 0
const session = () => ({ ...composerSession('event-owner'),
  agentSessionUpdatedAt: 1000, updatedAt: 1000,
  status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1000 } })
const statusEvent = (observedAt: number, state: 'waiting' | 'working' = 'working'): RuntimeEvent => ({
  type: 'core', hostId: session().control.hostId, event: { type: 'agent-status', agentSessionId: session().control.agentSessionId,
    state, evidence: { source: 'native-hook', observedAt, run: session().control.run } }
})
const sessionEvent = (): RuntimeEvent => ({ type: 'core', hostId: session().hostId, event: { type: 'agent-session', session: {
  kind: 'agent', agentSessionId: session().control.agentSessionId, providerId: session().providerId, executorId: session().executorId,
  hostId: session().hostId, workspacePath: session().workspacePath, createdAt: 1, updatedAt: 1000,
  run: session().control.run, retiredRuns: [], semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1000 },
  turnUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, observedAt: 2000 }
} } })
function Activity() {
  const sessions = useAppStore(state => state.sessions)
  return <Profiler id="event-activity" onRender={() => commits++}><ProjectActivity sessions={sessions} /></Profiler>
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...original, config: composerConfig, loading: false, sessions: [session(), composerSession('unrelated-owner')],
    agentSteerQueues: {}, pendingAgentLaunches: {}, timelines: {}, tabs: {}, layouts: {} }, true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<Activity />)); commits = 0
  expect(container.querySelector('.project-activity')).not.toBeNull()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('attributes real Store events by protocol type while retaining noop, useful update and early-return behavior', async () => {
  const before = rendererPerformance.snapshot().sessionEvents, state = useAppStore.getState()
  await act(async () => useAppStore.getState().applyEvent(statusEvent(999)))
  expect(useAppStore.getState()).toBe(state); expect(commits).toBe(0)
  await act(async () => useAppStore.getState().applyEvent(sessionEvent()))
  const changed = useAppStore.getState()
  expect(changed.sessions[0]?.kind === 'agent' && changed.sessions[0].turnUsage?.totalTokens).toBe(18)
  expect(changed.sessions[1]).toBe(state.sessions[1]); expect(commits).toBeGreaterThan(0)
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session().hostId,
    event: { type: 'control-endpoint-state', state: 'available', evidence: { source: 'run-process', observedAt: 2000 } } }))
  expect(useAppStore.getState()).toBe(changed)
  const after = rendererPerformance.snapshot().sessionEvents
  expect(after.count - before.count).toBe(3)
  for (const kind of ['agent-status', 'agent-session', 'control-endpoint-state'] as const) expect(after.byType[kind].count - before.byType[kind].count).toBe(1)
  expect(after.byType.unknown.count).toBe(before.byType.unknown.count)
})

it('includes original synchronous subscribers, preserves the exact thrown error and excludes later microtasks', async () => {
  let mono = performance.now(), later = false
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  const before = rendererPerformance.snapshot().sessionEvents
  const off = useAppStore.subscribe(() => { mono += 11; queueMicrotask(() => { later = true; mono += 100 }) })
  try {
    await act(async () => useAppStore.getState().applyEvent(statusEvent(2000, 'waiting')))
    expect(later).toBe(true)
    expect(rendererPerformance.snapshot().sessionEvents.byType['agent-status'].totalMs - before.byType['agent-status'].totalMs).toBe(11)
    expect(useAppStore.getState().sessions[0]?.status.state).toBe('waiting')
  } finally { off() }
  const beforeThrow = rendererPerformance.snapshot().sessionEvents, error = new Error('synthetic synchronous subscriber failure')
  const offThrow = useAppStore.subscribe(() => { mono += 17; throw error })
  try {
    await act(async () => {
      let caught: unknown
      try { useAppStore.getState().applyEvent(sessionEvent()) } catch (failure) { caught = failure }
      expect(caught).toBe(error)
    })
    const after = rendererPerformance.snapshot().sessionEvents
    expect(after.byType['agent-session'].count - beforeThrow.byType['agent-session'].count).toBe(1)
    expect(after.byType['agent-session'].totalMs - beforeThrow.byType['agent-session'].totalMs).toBe(17)
    expect(after.totalMs - beforeThrow.totalMs).toBe(17)
    const changed = useAppStore.getState().sessions[0]
    expect(changed?.kind === 'agent' && changed.turnUsage?.totalTokens).toBe(18)
  } finally { offThrow() }
})

it('keeps a slow real Store event on its original source after focus, Run and payload changes', async () => {
  let mono = performance.now()
  vi.spyOn(performance, 'now').mockImplementation(() => mono)
  const incoming = statusEvent(2000, 'waiting'), original = session()
  const off = useAppStore.subscribe(() => { mono += 80 })
  try { await act(async () => useAppStore.getState().applyEvent(incoming)) } finally { off() }
  const before = parseRendererPerformanceSnapshot(rendererPerformance.snapshot()).slowEvents.at(-1)!
  expect(before).toMatchObject({ kind: 'session-event', detail: 'agent-status', source: {
    hostId: original.control.hostId, sessionId: original.control.agentSessionId, runId: original.control.run.runId,
    regionId: null, instanceId: null
  } })
  if (incoming.event.type === 'agent-status') incoming.event.evidence.run = { runId: 'changed-input-run' }
  await act(async () => useAppStore.setState({ mainSurface: 'agents', sessions: [composerSession('replacement-owner')] }))
  const after = parseRendererPerformanceSnapshot(rendererPerformance.snapshot()).slowEvents.find(row => row.id === before.id)!
  expect(after.source).toEqual(before.source)
  expect(after.source!.runId).toBe(original.control.run.runId)
})
