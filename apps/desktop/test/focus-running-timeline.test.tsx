// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { HOUR_MS } from '../src/renderer/src/lib/focus-time-window'
import { useAppStore } from '../src/renderer/src/store'

const NOW = new Date('2026-10-02T12:00:00Z').getTime()
const baseline = useAppStore.getState()
type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const agent = (changes: Partial<Agent> = {}): Agent => ({
  id: 'live', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo', label: 'Working Agent',
  createdAt: NOW - 20 * HOUR_MS, updatedAt: NOW, agentSessionUpdatedAt: NOW, processState: 'running', latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
  status: { state: 'working', source: 'native-hook', observedAt: NOW },
  semanticStatus: { state: 'working', source: 'native-hook', observedAt: NOW, stateEnteredAt: NOW - HOUR_MS },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'live', run: { runId: 'current-run' } }, ...changes
})
let root: Root, element: HTMLDivElement
const select = createFocusProjectionSelector()
const onSelect = vi.fn()
async function render(sessions = [agent()], entries: Array<{ sessionId: string; focusedAt: number }> = []) {
  const contexts = select({ sessions, timelines: {}, config: null, agentNames: {}, scratchTopicSnapshots: useAppStore.getState().scratchTopicSnapshots }).contexts
  await act(async () => root.render(createElement(RecentFocusTimeline, { contexts, entries, currentSessionId: null, onSelect })))
  return contexts
}
const work = () => element.querySelector<HTMLButtonElement>('.recent-focus__working')
const live = () => element.querySelector<HTMLButtonElement>('.recent-focus__live')
const changeWindow = (label: string) => act(async () => element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); onSelect.mockReset()
  element = document.createElement('div'); document.body.append(element); root = createRoot(element); useAppStore.setState({ timelines: {} })
})
afterEach(async () => {
  await act(async () => root.unmount()); element.remove(); useAppStore.setState(baseline, true); vi.useRealTimers(); vi.unstubAllGlobals()
})

it('keeps a working Run at Now without any focus visit or captured message, with a proven work-state band', async () => {
  await render()
  expect(element.querySelectorAll('.recent-focus__track')).toHaveLength(1)
  expect(live()).not.toBeNull()
  expect(live()!.dataset).toMatchObject({ runId: 'current-run', runState: 'running' })
  expect(live()!.style.left).toBe('75%')
  expect(work()!.dataset).toMatchObject({ runId: 'current-run', workingEnteredAt: String(NOW - HOUR_MS), workingThrough: String(NOW) })
  expect([work()!.style.left, work()!.style.width]).toEqual(['50%', '25%'])
  expect(work()!.title).toContain('Work state, not Run duration')
  expect(element.querySelectorAll('.recent-focus__segment')).toHaveLength(0)
  work()!.focus(); expect(document.activeElement).toBe(work())
  await act(async () => work()!.click()); expect(onSelect).toHaveBeenCalledWith('live')
})

it('retains live facts when the last visit is older than the visible window without extending the visit', async () => {
  await render([agent()], [{ sessionId: 'live', focusedAt: NOW - 4 * HOUR_MS }])
  expect(element.querySelectorAll('.recent-focus__track')).toHaveLength(1)
  expect(live()).not.toBeNull(); expect(work()).not.toBeNull()
  expect(element.querySelectorAll('.recent-focus__segment')).toHaveLength(0)
})

it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, NOW + HOUR_MS])('does not replace missing/invalid/future working time %s with Session creation time', async enteredAt => {
  await render([agent({ semanticStatus: { state: 'working', source: 'native-hook', observedAt: NOW, ...(enteredAt === undefined ? {} : { stateEnteredAt: enteredAt }) } })])
  expect(live()).not.toBeNull()
  expect(live()!.title).toContain('Work start unknown'); expect(live()!.title).toContain('Run start unknown')
  expect(work()).toBeNull()
})

it.each(['done', 'waiting', 'running'] as const)('does not turn a live %s process into working', async state => {
  await render([agent({ status: { state, source: 'native-hook', observedAt: NOW }, semanticStatus: { state, source: 'native-hook', observedAt: NOW, stateEnteredAt: NOW - HOUR_MS } })])
  expect(live()!.dataset.runId).toBe('current-run'); expect(work()).toBeNull(); expect(live()!.classList.contains('is-working')).toBe(false)
})

it('requires authoritative matching semantic state and an alive Run before claiming a work band', async () => {
  const cases: Agent[] = [agent({ id: 'process-signal', semanticStatus: { state: 'working', source: 'run-process', observedAt: NOW, stateEnteredAt: NOW - HOUR_MS } }),
    agent({ id: 'mismatched-semantic', semanticStatus: { state: 'done', source: 'native-hook', observedAt: NOW, stateEnteredAt: NOW - HOUR_MS } }),
    agent({ id: 'ended', processState: 'interrupted' })]
  const contexts = await render(cases)
  expect(contexts.map(c => c.workingEnteredAt)).toEqual([null, null, null])
  expect([...element.querySelectorAll<HTMLElement>('.recent-focus__track')].map(n => n.dataset.focusTimelineId)).toEqual(['mismatched-semantic', 'process-signal'])
  expect(element.querySelectorAll('.recent-focus__working')).toHaveLength(0)
})

it('projects the current Run identity after replacement and preserves stable models on unrelated byte/heartbeat observations', async () => {
  const original = agent(), [first] = await render([original])
  const [next] = await render([agent({ control: { ...original.control, run: { runId: 'replacement-run' } } })])
  expect(live()!.dataset.runId).toBe('replacement-run'); expect(work()!.dataset.runId).toBe('replacement-run'); expect(next).not.toBe(first)
  const [stable] = await render([agent({ control: { ...original.control, run: { runId: 'replacement-run' } }, latestOutputBytes: 250, updatedAt: NOW + 1,
    status: { ...original.status, observedAt: NOW + 1 }, semanticStatus: { ...original.semanticStatus!, observedAt: NOW + 1 } })])
  expect(stable).toBe(next)
})

it('queries only the proven current work-state intersection in history and leaves future windows empty', async () => {
  await render([agent({ semanticStatus: { state: 'working', source: 'native-hook', observedAt: NOW, stateEnteredAt: NOW - 6 * HOUR_MS } })])
  await changeWindow('Previous focus window')
  expect(live()).toBeNull(); expect([work()!.style.left, work()!.style.width]).toEqual(['25%', '75%'])
  expect(work()!.dataset.workingThrough).toBe(String(NOW - 3 * HOUR_MS))
  await changeWindow('Next focus window'); await changeWindow('Next focus window')
  expect(element.querySelectorAll('.recent-focus__track')).toHaveLength(0); expect(work()).toBeNull(); expect(live()).toBeNull()
})

it('excludes a plain Shell while retaining the confirmed Agent live/work bands and read-only inspection', async () => {
  const shell: SessionSnapshot = { id: 'shell', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo', label: 'Shell',
    createdAt: NOW - 20 * HOUR_MS, updatedAt: NOW, processState: 'running', latestOutputBytes: 0, status: { state: 'running', source: 'run-process', observedAt: NOW },
    control: { kind: 'terminal', hostId: 'local', runId: 'shell-run', run: { runId: 'shell-run' } } }
  const contexts = select({ sessions: [shell, agent()], timelines: {}, config: null, agentNames: {}, scratchTopicSnapshots: useAppStore.getState().scratchTopicSnapshots }).contexts, before = useAppStore.getState().agentFocus
  expect(contexts.map(context => context.id)).toEqual(['live'])
  await act(async () => root.render(createElement(RecentFocusTimeline, { contexts, entries: [], currentSessionId: null, onSelect })))
  expect([...element.querySelectorAll<HTMLElement>('.recent-focus__track')].map(track => track.dataset.focusTimelineId)).toEqual(['live'])
  expect(live()).not.toBeNull(); expect(live()!.dataset.runId).toBe('current-run')
  expect(work()).not.toBeNull(); expect(work()!.dataset.runId).toBe('current-run')
  await changeWindow('Previous focus window'); await changeWindow('Return to current focus window')
  expect(onSelect).not.toHaveBeenCalled(); expect(useAppStore.getState().agentFocus).toBe(before)
  await act(async () => live()!.click()); expect(onSelect).toHaveBeenCalledWith('live')
})
