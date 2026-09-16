// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentSemanticState, AgentStatus } from '@agentmux/core'
import type { AppConfig, RuntimeEvent, RuntimeSnapshot, SessionSnapshot } from '../src/shared/contracts'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  handlers: new Map<string, () => unknown>(),
  calls: [] as string[]
}))
// Only Electron's transport is replaced. The real preload wraps the IPC event,
// the real Desktop api selects it, and initialize installs the actual Store consumer.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => Object.assign(window, { [name]: api }) },
  webFrame: { getZoomFactor: () => 1 },
  ipcRenderer: {
    async invoke(channel: string) {
      bridge.calls.push(channel)
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error(`Unexpected fixture IPC call: ${channel}`)
      return await handler()
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      const listeners = bridge.listeners.get(channel) ?? new Set()
      listeners.add(listener); bridge.listeners.set(channel, listeners)
    },
    off: (channel: string, listener: (...args: unknown[]) => void) => bridge.listeners.get(channel)?.delete(listener),
    send: vi.fn()
  }
}))
import '../src/preload/index'
import { SESSION_EVENT_CHANNEL } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { agentStateEnteredAt } from '../src/renderer/src/lib/agent-state-time'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
type Semantic = Exclude<AgentSemanticState, 'unknown'>
const NOW = 10_000, initial = useAppStore.getState()
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private state-time fixture' }], executors: {},
  workspaces: [{ id: 'private', name: 'Private', hostId: 'local', path: '/private/state-time', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
    selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true
  } }
}
const semantic = (state: Semantic = 'working', observedAt = 1000, stateEnteredAt: number | undefined = 100,
  source: AgentStatus['source'] = 'native-hook'): AgentStatus => ({ state, source, observedAt,
  ...(stateEnteredAt === undefined ? {} : { stateEnteredAt }) })
function initialAgent(): Agent {
  const status = semantic()
  return { id: 'state-agent', kind: 'agent', providerId: 'codex', executorId: 'private', hostId: 'local',
    workspacePath: '/private/state-time', label: 'Private Agent', createdAt: 1, updatedAt: 1000,
    processState: 'running', status: structuredClone(status), semanticStatus: status, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'state-agent', run: { runId: 'state-run' } } }
}
let dispose: (() => void) | undefined
function current(): Agent {
  const sessions = useAppStore.getState().sessions
  expect(sessions.map(s => s.id)).toEqual(['state-agent'])
  const session = sessions[0]!
  expect(session.kind).toBe('agent')
  if (session.kind !== 'agent') throw new Error('Missing actual Agent projection')
  return session
}
function snapshot(status: AgentStatus | undefined, updatedAt = status?.observedAt ?? 2000,
  change: Partial<AgentMuxAgentSession> = {}): RuntimeEvent {
  const session = current()
  return { type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
    kind: 'agent', agentSessionId: session.id, providerId: session.providerId, executorId: session.executorId,
    hostId: session.hostId, workspacePath: session.workspacePath, run: { ...session.control.run },
    retiredRuns: [], outputCursorBytes: 0, createdAt: session.createdAt, updatedAt,
    ...(status ? { semanticStatus: structuredClone(status) } : {}), ...change
  } } }
}
function observation(status: AgentStatus): RuntimeEvent {
  return { type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: 'state-agent',
    state: status.state as Semantic, evidence: { source: status.source, observedAt: status.observedAt, run: { ...current().control.run } } } }
}
async function emit(event: RuntimeEvent): Promise<void> {
  const listeners = bridge.listeners.get(SESSION_EVENT_CHANNEL)
  expect(listeners?.size).toBe(1)
  for (const listener of listeners!) listener({}, event)
  await Promise.resolve()
}
beforeEach(async () => {
  bridge.calls.length = 0; bridge.handlers.clear(); bridge.listeners.clear(); window.localStorage.clear()
  useAppStore.setState({ ...initial, loading: true }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  const canonical: RuntimeSnapshot = { sessions: [initialAgent()], timelines: {}, recoveryCandidates: [] }
  bridge.handlers.set('config:get', () => config)
  bridge.handlers.set('providers:list', () => [])
  bridge.handlers.set('demands:list', () => [])
  bridge.handlers.set('sessions:snapshot', () => structuredClone(canonical))
  bridge.handlers.set('ui:requestStorageFlush', () => undefined)
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  expect(useAppStore.getState().error).toBeNull()
  expect(bridge.calls).toEqual(['config:get', 'sessions:snapshot', 'providers:list', 'demands:list'])
  expect(agentStateEnteredAt(current(), NOW)).toBe(100)
})
afterEach(() => {
  dispose?.(); dispose = undefined
  expect(bridge.listeners.get(SESSION_EVENT_CHANNEL)?.size).toBe(0)
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})

describe('actual preload → initialized Store semantic entry-time mirror', () => {
  it.each(['native-hook', 'acp'] as const)('preserves the Core entry in the real %s event order', async source => {
    const status = semantic('working', 2000, 100, source)
    const full = snapshot(status)
    if (source === 'native-hook') {
      await emit(observation(status))
      expect(agentStateEnteredAt(current(), NOW)).toBeUndefined()
      await emit(full)
    } else {
      await emit(full)
      await emit(observation(status))
    }
    expect(current().semanticStatus).toEqual(status)
    expect(agentStateEnteredAt(current(), NOW)).toBe(100)
    // Core payload ownership does not transfer to the mutable incoming envelope.
    if (full.event.type !== 'agent-session') throw new Error('Expected snapshot fixture')
    full.event.session.semanticStatus!.stateEnteredAt = 999
    expect(current().semanticStatus?.stateEnteredAt).toBe(100)
  })

  it('repeated waiting observations retain the original epoch, not the new observation time', async () => {
    await emit(snapshot(semantic('waiting', 2000, 1500)))
    expect(agentStateEnteredAt(current(), NOW)).toBe(1500)
    const repeated = semantic('waiting', 3000, 1500)
    await emit(observation(repeated)); await emit(snapshot(repeated))
    expect(current().status.observedAt).toBe(3000)
    expect(agentStateEnteredAt(current(), NOW)).toBe(1500)
  })

  it('mirrors a same-observation authoritative clock clear without fabricating a new display observation', async () => {
    await emit(snapshot(semantic('done', 2000, 1500)))
    const display = current().status
    expect(agentStateEnteredAt(current(), NOW)).toBe(1500)
    const cleared = semantic('done', 2000)
    delete cleared.stateEnteredAt
    await emit(snapshot(cleared, 2100))
    expect(current().semanticStatus).toEqual({ state: 'done', source: 'native-hook', observedAt: 2000 })
    expect(current().status).toBe(display)
    expect(agentStateEnteredAt(current(), NOW)).toBeUndefined()
  })

  it('removes the whole raw semantic fact when an accepted snapshot no longer contains it', async () => {
    expect(current().semanticStatus).toBeDefined()
    await emit(snapshot(undefined, 1100))
    expect(current()).not.toHaveProperty('semanticStatus')
    expect(current().status.state).toBe('working')
    expect(agentStateEnteredAt(current(), NOW)).toBeUndefined()
  })

  it('accepts an explicitly retired old Run transition and does not carry its raw fact into the replacement', async () => {
    const oldRun = { ...current().control.run }
    await emit(snapshot(undefined, 2000, { run: { runId: 'replacement-run' }, retiredRuns: [oldRun] }))
    expect(current().control.run).toEqual({ runId: 'replacement-run' })
    expect(current()).not.toHaveProperty('semanticStatus')
    expect(agentStateEnteredAt(current(), NOW)).toBeUndefined()
    const late = observation(semantic('waiting', 3000, 2000))
    if (late.event.type !== 'agent-status') throw new Error('Expected status fixture')
    late.event.evidence.run = oldRun
    await emit(late)
    expect(current().status.state).toBe('working')
  })

  it.each(['other-host', 'old-run', 'old-session', 'old-snapshot'] as const)('rejects %s without overwriting the current clock', async rejected => {
    const event = snapshot(semantic('waiting', 2000, 1700))
    if (event.event.type !== 'agent-session') throw new Error('Expected snapshot fixture')
    if (rejected === 'other-host') event.hostId = 'other-host'
    if (rejected === 'old-run') event.event.session.run = { runId: 'old-run' }
    if (rejected === 'old-session') event.event.session.agentSessionId = 'old-session'
    if (rejected === 'old-snapshot') event.event.session.updatedAt = 999
    await emit(event)
    expect(current().semanticStatus).toEqual(semantic())
    expect(agentStateEnteredAt(current(), NOW)).toBe(100)
  })

  it('does not revive a decayed display on an equal-observation full snapshot', async () => {
    useAppStore.getState().decayStaleAgentStatuses(1_000_000)
    expect(current().status.state).toBe('running')
    await emit(snapshot(semantic(), 1100))
    expect(current().semanticStatus).toEqual(semantic())
    expect(current().status.state).toBe('running')
    expect(agentStateEnteredAt(current(), NOW)).toBeUndefined()
  })

  it('does not wash disconnected away when fresh semantic observations and snapshots still arrive', async () => {
    await emit({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'lost',
      evidence: { source: 'run-process', observedAt: 2000 } } })
    expect(current().status.state).toBe('disconnected')
    const newer = semantic('working', 3000, 100)
    await emit(observation(newer)); await emit(snapshot(newer))
    expect(current().semanticStatus).toEqual(newer)
    expect(current().status.state).toBe('disconnected')
    expect(agentStateEnteredAt(current(), NOW)).toBeUndefined()
  })
})

describe('current authoritative state-time admission', () => {
  it.each(['working', 'waiting', 'blocked', 'done', 'error'] as const)('admits %s and the legitimate zero epoch', state => {
    const session = structuredClone(current())
    session.status = semantic(state, 1000, 0); session.semanticStatus = structuredClone(session.status)
    expect(agentStateEnteredAt(session, NOW)).toBe(0)
    expect(session.semanticStatus.stateEnteredAt).toBe(0)
  })

  const invalid: Array<[string, (session: Agent) => void, number?]> = [
    ['ended process', s => { s.processState = 'exited' }],
    ['control kind', s => { s.control.kind = 'terminal' as 'agent' }],
    ['control host', s => { s.control.hostId = 'other-host' }],
    ['control Session', s => { s.control.agentSessionId = 'other-agent' }],
    ['missing current Run', s => { s.control.run.runId = '' }],
    ['absent raw fact', s => { delete s.semanticStatus }],
    ['absent clock', s => { delete s.semanticStatus!.stateEnteredAt }],
    ['process source', s => { s.semanticStatus!.source = 'run-process'; s.status.source = 'run-process' }],
    ['raw/display state mismatch', s => { s.semanticStatus!.state = 'waiting' }],
    ['raw/display source mismatch', s => { s.semanticStatus!.source = 'acp' }],
    ['raw/display observation mismatch', s => { s.semanticStatus!.observedAt = 1001 }],
    ['negative clock', s => { s.semanticStatus!.stateEnteredAt = -1 }],
    ['fractional clock', s => { s.semanticStatus!.stateEnteredAt = 1.5 }],
    ['NaN clock', s => { s.semanticStatus!.stateEnteredAt = NaN }],
    ['infinite clock', s => { s.semanticStatus!.stateEnteredAt = Infinity }],
    ['unsafe clock', s => { s.semanticStatus!.stateEnteredAt = Number.MAX_SAFE_INTEGER + 1 }],
    ['clock after observation', s => { s.semanticStatus!.stateEnteredAt = 1001 }],
    ['fractional observation', s => { s.semanticStatus!.observedAt = 1000.5; s.status.observedAt = 1000.5 }],
    ['future observation', s => { s.semanticStatus!.observedAt = NOW + 1; s.status.observedAt = NOW + 1 }],
    ['stale working before the local decay action', () => {}, 1_000_000],
    ['nonfinite now', s => { s.status.state = 'waiting'; s.semanticStatus!.state = 'waiting' }, Infinity],
    ['NaN now', () => {}, NaN]
  ]
  it.each(invalid)('leaves %s unknown without altering the Agent', (_name, change, now = NOW) => {
    const session = structuredClone(current()); change(session)
    const before = structuredClone(session), calls = [...bridge.calls]
    expect(agentStateEnteredAt(session, now)).toBeUndefined()
    expect(session).toEqual(before)
    expect(bridge.calls).toEqual(calls)
  })

  it.each(['starting', 'running', 'disconnected', 'exited'] as const)('does not call process-only %s a proven semantic epoch', state => {
    const session = structuredClone(current())
    session.status.state = state; session.semanticStatus!.state = state
    expect(agentStateEnteredAt(session, NOW)).toBeUndefined()
  })

  it('does not borrow a semantic clock for a Terminal', () => {
    const agent = current()
    const terminal: SessionSnapshot = { ...agent, kind: 'terminal', providerId: null,
      control: { kind: 'terminal', hostId: 'local', runId: 'terminal-run', run: { runId: 'terminal-run' } } }
    expect(agentStateEnteredAt(terminal, NOW)).toBeUndefined()
  })
})
