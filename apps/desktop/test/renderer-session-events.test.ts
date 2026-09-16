// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxDesktopApi, AgentMuxPreloadApi, AppConfig, RuntimeEvent, SessionControl, SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
type Listener = (event: RuntimeEvent) => void
let api: AgentMuxDesktopApi
let listeners: Set<Listener>
let subscribe: ReturnType<typeof vi.fn>
let releases: Array<ReturnType<typeof vi.fn>>
let disposers: Array<() => void>

function control(runId = 'target-run', hostId = 'target-host'): SessionControl {
  return { kind: 'terminal', hostId, runId, run: { runId } }
}
function output(startByte = 0, runId = 'target-run', hostId = 'target-host'): RuntimeEvent {
  const dataBytes = new TextEncoder().encode(`bytes-${startByte}`)
  return { type: 'core', hostId, event: { type: 'terminal-output', run: { runId }, data: `bytes-${startByte}`, dataBytes,
    evidence: { source: 'terminal-output', observedAt: 1, run: { runId },
      outputByteRange: { startByte, endByte: startByte + dataBytes.length } } } }
}
function resized(): RuntimeEvent {
  return { type: 'core', hostId: 'target-host', event: { type: 'terminal-resized', run: { runId: 'target-run' }, cols: 90, rows: 30 } }
}
function semantic(): RuntimeEvent {
  return { type: 'core', hostId: 'target-host', event: { type: 'process-state', run: { runId: 'target-run' }, state: 'running', pid: 123,
    evidence: { source: 'run-process', observedAt: 1, run: { runId: 'target-run' } } } }
}
function emit(event: RuntimeEvent): void { for (const listener of [...listeners]) listener(event) }
function onEvent(listener: Listener, scope?: SessionControl): () => void {
  const dispose = api.sessions.onEvent(listener, scope)
  disposers.push(dispose)
  return dispose
}

beforeEach(async () => {
  vi.resetModules()
  listeners = new Set(); releases = []; disposers = []
  subscribe = vi.fn((listener: Listener) => {
    listeners.add(listener)
    const release = vi.fn(() => { listeners.delete(listener) })
    releases.push(release)
    return release
  })
  const preload = { sessions: { onEvent: subscribe }, control: {} } as unknown as AgentMuxPreloadApi
  window.agentmux = preload
  api = (await import('../src/renderer/src/lib/api')).api
})
afterEach(() => {
  disposers.forEach(dispose => dispose())
  delete window.agentmux
  vi.restoreAllMocks()
})

it('actual Desktop API has one raw subscription and delivers original bytes only to its exact host and Run', () => {
  const received: Array<{ consumer: number; event: RuntimeEvent }> = []
  const scopes = [control(), control('target-run', 'other-host'), control('old-run'),
    ...Array.from({ length: 5 }, (_, i) => control(`other-run-${i}`))]
  scopes.forEach((scope, consumer) => onEvent(event => received.push({ consumer, event }), scope))
  const globals: RuntimeEvent[] = []
  onEvent(event => globals.push(event))
  expect(subscribe).toHaveBeenCalledTimes(1)
  expect(listeners.size).toBe(1)
  const event = output()
  emit(event)
  expect(received).toEqual([{ consumer: 0, event }])
  expect(received[0]!.event).toBe(event)
  expect((received[0]!.event.event as Extract<RuntimeEvent['event'], { type: 'terminal-output' }>).dataBytes)
    .toBe((event.event as Extract<RuntimeEvent['event'], { type: 'terminal-output' }>).dataBytes)
  expect(globals).toEqual([])
  const member = semantic()
  emit(member)
  expect(globals).toEqual([member])
  expect(received).toEqual([{ consumer: 0, event }])
})

it('keeps resize and byte event order for every matching view without extra bridge registrations', () => {
  const first: RuntimeEvent[] = [], second: RuntimeEvent[] = []
  onEvent(event => first.push(event), control())
  onEvent(event => second.push(event), control())
  const events = [output(0), resized(), output(90)]
  events.forEach(emit)
  expect(first).toEqual(events)
  expect(second).toEqual(events)
  expect(first[0]).toBe(second[0])
  expect(subscribe).toHaveBeenCalledTimes(1)
})

it('owns duplicate function registrations independently and releases the native owner only after the last one', () => {
  const receive = vi.fn()
  const first = onEvent(receive, control()), second = onEvent(receive, control())
  emit(output())
  expect(receive).toHaveBeenCalledTimes(2)
  first(); first()
  expect(releases[0]).not.toHaveBeenCalled()
  emit(output(1))
  expect(receive).toHaveBeenCalledTimes(3)
  second()
  expect(releases[0]).toHaveBeenCalledTimes(1)
  expect(listeners.size).toBe(0)
  emit(output(2))
  expect(receive).toHaveBeenCalledTimes(3)
  onEvent(receive, control())
  expect(subscribe).toHaveBeenCalledTimes(2)
  expect(listeners.size).toBe(1)
  emit(output(3))
  expect(receive).toHaveBeenCalledTimes(4)
})

it('takes a current dispatch snapshot when callbacks dispose and subscribe synchronously', () => {
  const calls: string[] = []
  let second = () => {}
  onEvent(() => {
    calls.push('first'); second()
    onEvent(() => calls.push('late'), control())
  }, control())
  second = onEvent(() => calls.push('second'), control())
  emit(output())
  expect(calls).toEqual(['first', 'second'])
  emit(output(1))
  expect(calls).toEqual(['first', 'second', 'first', 'late'])
  expect(subscribe).toHaveBeenCalledTimes(1)
})

it('allows last-unsubscribe reentry to establish a fresh native owner without retaining stale handlers', () => {
  const calls: string[] = []
  let first = () => {}
  first = onEvent(() => { calls.push('old'); first(); onEvent(() => calls.push('new'), control()) }, control())
  emit(output())
  expect(calls).toEqual(['old'])
  expect(releases[0]).toHaveBeenCalledTimes(1)
  expect(subscribe).toHaveBeenCalledTimes(2)
  expect(listeners.size).toBe(1)
  emit(output(1))
  expect(calls).toEqual(['old', 'new'])
})

it('delivers remaining relevant consumers before exposing a callback failure on the original error channel', () => {
  const failure = new Error('Private consumer failure')
  const receive = vi.fn()
  const globals = vi.fn()
  onEvent(() => { throw failure }, control())
  onEvent(receive, control())
  onEvent(globals)
  const event = output()
  expect(() => emit(event)).toThrow(failure)
  expect(receive).toHaveBeenCalledExactlyOnceWith(event)
  const member = semantic()
  emit(member)
  expect(globals).toHaveBeenCalledExactlyOnceWith(member)
  const next = output(100)
  expect(() => emit(next)).toThrow(failure)
  expect(receive.mock.calls).toEqual([[event], [next]])
  expect(subscribe).toHaveBeenCalledTimes(1)
})

it('the actual Store semantic subscription consumes status but receives no terminal bytes', async () => {
  const session: SessionSnapshot = { id: 'target-agent', kind: 'agent', providerId: 'codex', executorId: 'codex',
    hostId: 'target-host', workspacePath: '/private-fixture', label: 'Private fixture', createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'target-host', agentSessionId: 'target-agent', run: { runId: 'target-run' } } }
  const config: AppConfig = { version: 9, hosts: [], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  // These native methods isolate unrelated startup services; real API routing, Store.initialize and
  // Store.applyEvent execute. The raw source callback is still the exact actual API owner above.
  Object.assign(api, { config: { get: async () => config }, providers: { list: async () => [] }, demands: { list: async () => [] },
    browser: { onEvent: () => () => {} }, files: { onInvalidated: () => () => {} },
    ui: { requestStorageFlush: async () => {} } })
  api.sessions.snapshot = async () => ({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  window.agentmux!.control.onRequest = () => () => {}
  window.agentmux!.control.onCancellation = () => () => {}
  const { useAppStore } = await import('../src/renderer/src/store')
  const initial = useAppStore.getState()
  const dispose = await initial.initialize()
  disposers.push(dispose)
  try {
    expect(useAppStore.getState().loading).toBe(false)
    expect(useAppStore.getState().sessions.map(item => item.id)).toEqual(['target-agent'])
    const receive = vi.fn()
    onEvent(receive, session.control)
    const bytes = output()
    emit(bytes)
    expect(receive).toHaveBeenCalledExactlyOnceWith(bytes)
    expect(useAppStore.getState().sessions[0]?.latestOutputBytes).toBe(0)
    const status: RuntimeEvent = { type: 'core', hostId: session.hostId, event: { type: 'agent-status', agentSessionId: session.id,
      state: 'working', evidence: { source: 'native-hook', observedAt: 123, run: { runId: 'target-run' } } } }
    emit(status)
    expect(useAppStore.getState().sessions[0]?.status.observedAt).toBe(123)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
  } finally { dispose(); useAppStore.setState(initial, true) }
})
