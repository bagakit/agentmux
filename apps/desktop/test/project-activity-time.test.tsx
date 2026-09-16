// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSemanticState } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const NOW = 100_000_000
const initial = useAppStore.getState()
let root: Root | undefined, container: HTMLDivElement
let visibility: DocumentVisibilityState = 'visible'
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')

function agent(id: string, state: Exclude<AgentSemanticState, 'unknown'>, enteredAt: number | undefined = NOW - 240_000): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
    label: id, createdAt: 1, updatedAt: NOW, processState: 'running', latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    status: { state, source: 'native-hook', observedAt: NOW - 1_000 },
    semanticStatus: { state, source: 'native-hook', observedAt: NOW - 1_000, ...(enteredAt === undefined ? {} : { stateEnteredAt: enteredAt }) },
    ...(state === 'working' ? { turnUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, observedAt: NOW - 1_000,
      context: { usedTokens: 48, capacityTokens: 100 } } } : {}),
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
function Activity() {
  const sessions = useAppStore(state => state.sessions)
  return <><input aria-label="terminal input" /><div className="terminal-layout"><ProjectActivity sessions={sessions} /></div></>
}
async function mount(sessions: SessionSnapshot[]) {
  useAppStore.setState({ ...initial, sessions, config: null, providerCatalog: [], timelines: {}, agentNames: {}, loading: false }, true)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Activity />))
}
function menu() { return document.querySelector<HTMLElement>('.project-activity-menu') }
async function open() {
  const trigger = container.querySelector<HTMLButtonElement>('.project-activity')
  expect(trigger).not.toBeNull()
  await act(async () => trigger!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(menu()).not.toBeNull()
  const disclosure = menu()!.querySelector<HTMLElement>('[aria-label^="Show Agents"]')
  if (disclosure) await act(async () => disclosure.click())
  else expect(menu()!.querySelector('[aria-label^="Hide Agents"]')).not.toBeNull()
  expect(menu()!.querySelectorAll('.project-activity-menu__item').length).toBeGreaterThan(0)
}
function facts() {
  const rows = [...menu()!.querySelectorAll<HTMLElement>('.project-activity-menu__item')]
  expect(rows.length).toBeGreaterThan(0)
  return Object.fromEntries(rows.map(row => [row.querySelector('strong')!.textContent, row.querySelector('.project-activity-menu__meta')!.textContent]))
}
async function advance(ms: number) { await act(async () => vi.advanceTimersByTime(ms)) }
async function visible(value: DocumentVisibilityState) {
  visibility = value
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
}
async function close() {
  expect(menu()).not.toBeNull()
  await act(async () => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(menu()).toBeNull()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW)
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove()
  useAppStore.setState(initial, true)
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
  else Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it('actual menu displays Core entry ages and ctx; newer observations never restart the age', async () => {
  const unknown = agent('unknown', 'waiting'); delete unknown.semanticStatus!.stateEnteredAt
  await mount([agent('working', 'working'), agent('waiting', 'waiting'), agent('done', 'done'), agent('error', 'error'), unknown])
  const editor = container.querySelector<HTMLInputElement>('input')!; editor.focus()
  const layout = container.querySelector('.terminal-layout')!
  const beforeChildren = [...layout.children]
  await open()
  expect(document.activeElement).toBe(editor)
  expect([...layout.children]).toEqual(beforeChildren)
  expect(facts()).toEqual({ working: 'working 4m · ctx 48%', waiting: 'waiting 4m', done: '4m idle', error: 'error for 4m', unknown: 'start time unknown' })
  const before = useAppStore.getState().sessions.find(s => s.id === 'working')!
  const event: RuntimeEvent = { type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
    kind: 'agent', agentSessionId: before.id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
    run: before.control.run, retiredRuns: [],  createdAt: 1, updatedAt: NOW,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: NOW, stateEnteredAt: NOW - 240_000 },
    ...(before.kind === 'agent' ? { turnUsage: before.turnUsage } : {})
  } } }
  await act(async () => useAppStore.getState().applyEvent(event))
  expect(useAppStore.getState().sessions.find(s => s.id === 'working')?.status.observedAt).toBe(NOW)
  expect(facts().working).toBe('working 4m · ctx 48%')
  await advance(60_000)
  expect(facts()).toEqual({ working: 'working 5m · ctx 48%', waiting: 'waiting 5m', done: '5m idle', error: 'error for 5m', unknown: 'start time unknown' })
})

it('live observations between menu ticks keep the known state duration visible', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval')
  await mount([agent('working', 'working'), agent('waiting', 'waiting')])
  await open()
  expect(intervals).toHaveBeenCalledTimes(1)
  // Move the clock without running the interval, just as a Hook arrives between ticks.
  for (const offset of [250, 750]) {
    vi.setSystemTime(NOW + offset)
    const before = useAppStore.getState().sessions.find(s => s.id === 'working')!
    const event: RuntimeEvent = { type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
      kind: 'agent', agentSessionId: before.id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
      run: before.control.run, retiredRuns: [],  createdAt: 1, updatedAt: NOW + offset,
      semanticStatus: { state: 'working', source: 'native-hook', observedAt: NOW + offset, stateEnteredAt: NOW - 240_000 },
      ...(before.kind === 'agent' ? { turnUsage: before.turnUsage } : {})
    } } }
    await act(async () => useAppStore.getState().applyEvent(event))
    expect(useAppStore.getState().sessions.find(s => s.id === 'working')?.status.observedAt).toBe(NOW + offset)
    expect(facts()).toEqual({ working: 'working 4m · ctx 48%', waiting: 'waiting 4m' })
    expect(intervals).toHaveBeenCalledTimes(1)
  }
})

it('one visible menu clock advances silent rows without Store writes or Runtime calls and stops on close', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval'), clears = vi.spyOn(globalThis, 'clearInterval')
  const runtime = vi.spyOn(api.sessions, 'snapshot'), submit = vi.spyOn(api.sessions, 'submitPrompt')
  await mount([agent('one', 'waiting', NOW - 5_000), agent('two', 'done', NOW - 10_000)])
  expect(intervals).not.toHaveBeenCalled()
  await open()
  expect(intervals).toHaveBeenCalledTimes(1)
  expect(intervals.mock.calls[0]?.[1]).toBe(1000)
  const state = useAppStore.getState(), changed = vi.fn(), unsubscribe = useAppStore.subscribe(changed)
  try {
    await advance(2000)
    expect(facts()).toEqual({ one: 'waiting 7s', two: '12s idle' })
    expect(useAppStore.getState()).toBe(state)
    expect(changed).not.toHaveBeenCalled()
    expect(runtime).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
    await close()
    expect(clears).toHaveBeenCalledExactlyOnceWith(intervals.mock.results[0]!.value)
    await advance(3000)
    expect(intervals).toHaveBeenCalledTimes(1)
    await open()
    expect(intervals).toHaveBeenCalledTimes(2)
    expect(facts()).toEqual({ one: 'waiting 10s', two: '15s idle' })
  } finally { unsubscribe() }
})

it('hidden menus stop the clock; visibility resumption catches up, and unmount releases timer/listener', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval'), clears = vi.spyOn(globalThis, 'clearInterval')
  const listeners = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
  await mount([agent('one', 'waiting', NOW - 5_000), agent('two', 'done', NOW - 10_000)])
  await open(); expect(intervals).toHaveBeenCalledTimes(1)
  await visible('hidden')
  expect(clears).toHaveBeenCalledExactlyOnceWith(intervals.mock.results[0]!.value)
  await advance(3000)
  expect(facts()).toEqual({ one: 'waiting 5s', two: '10s idle' })
  await visible('visible')
  expect(intervals).toHaveBeenCalledTimes(2)
  expect(facts()).toEqual({ one: 'waiting 8s', two: '13s idle' })
  await advance(1000)
  expect(facts()).toEqual({ one: 'waiting 9s', two: '14s idle' })
  const visibilityCalls = listeners.mock.calls.filter(call => call[0] === 'visibilitychange')
  expect(visibilityCalls).toHaveLength(1)
  await act(async () => root!.unmount()); root = undefined
  expect(clears).toHaveBeenLastCalledWith(intervals.mock.results[1]!.value)
  expect(remove).toHaveBeenCalledWith('visibilitychange', visibilityCalls[0]![1])
  const count = intervals.mock.calls.length
  await visible('hidden'); await visible('visible'); await advance(1000)
  expect(intervals).toHaveBeenCalledTimes(count)
})

it('opening while hidden creates no clock, and stale observations remain last-active facts', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const stale = agent('stale', 'working'); stale.status = { state: 'running', source: 'native-hook', observedAt: 1 }
  await mount([stale, agent('unknown', 'waiting')])
  visibility = 'hidden'
  await open()
  expect(intervals).not.toHaveBeenCalled()
  expect(facts().stale).toMatch(/^last active \d+[smh]$/)
  expect(facts().stale).not.toContain('ctx')
  await visible('visible')
  expect(intervals).toHaveBeenCalledTimes(1)
})


it.each([
  ['working', false, 'working 4m · ctx 48%', 'working 5m · ctx 48%'],
  ['waiting', false, 'waiting 4m', 'waiting 5m'],
  ['error', false, 'error for 4m', 'error for 5m'],
  ['done', false, '4m idle', '5m idle'],
  ['done', true, 'start time unknown', 'start time unknown'],
  ['waiting', true, 'start time unknown', 'start time unknown']
] as const)('a solo %s Agent exposes its state time without a detail or pending request (unknown=%s)', async (state, unknown, current, next) => {
  const session = agent('solo', state)
  if (unknown) delete session.semanticStatus!.stateEnteredAt
  await mount([session])
  const trigger = container.querySelector<HTMLButtonElement>('.project-activity')!
  expect(trigger).not.toBeNull()
  if (state === 'done') {
    expect(trigger.getAttribute('aria-label')).toContain('1 Completed')
    expect(trigger.dataset.category).toBe('active')
    expect(trigger.querySelectorAll('.project-activity__metric--done')).toHaveLength(1)
    expect(trigger.querySelectorAll('.status__dot, .project-activity__metric--needs-you')).toHaveLength(0)
  }
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(menu()).not.toBeNull()
  expect(menu()!.querySelectorAll('.project-activity-group__summary')).toHaveLength(1)
  expect(menu()!.querySelector('[aria-label^="Show Agents"]')).toBeNull()
  expect(menu()!.textContent).toContain(current)
  await advance(60_000)
  expect(menu()!.textContent).toContain(next)
})
