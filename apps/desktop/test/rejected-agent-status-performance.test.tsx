// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, RuntimeEvent, RuntimeSnapshot, SessionSnapshot, SessionStatus } from '../src/shared/contracts'
import type { AgentMuxAgentSession } from '@agentmux/core'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  handlers: new Map<string, () => unknown>(),
  calls: [] as string[]
}))
// The real preload, API, Store and mounted component remain intact; only Electron's IPC transport is private.
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => Object.assign(window, { [name]: api }) },
  webFrame: { getZoomFactor: () => 1 },
  ipcRenderer: {
    async invoke(channel: string) {
      bridge.calls.push(channel)
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error(`Unexpected private IPC call: ${channel}`)
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
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'
import { SESSION_EVENT_CHANNEL } from '../src/shared/contracts'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'

const initial = useAppStore.getState()
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private projection fixture' }], executors: {},
  workspaces: [{ id: 'private', name: 'Private', hostId: 'local', path: '/private/projection', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
    selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true
  } }
}
const ids = Array.from({ length: 32 }, (_, i) => `private-agent-${i}`)
function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'private', hostId: 'local',
    workspacePath: '/private/projection', label: id, createdAt: 1, updatedAt: 1000, agentSessionUpdatedAt: 1000,
    processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1000 },
    latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
let dispose: (() => void) | undefined, root: Root | undefined, container: HTMLDivElement | undefined
let commits = 0, collectionChanges = 0, release: (() => void) | undefined
function Activity() {
  // This is WorkspaceSidebar's existing sessions selector, with its actual ProjectActivity child.
  const sessions = useAppStore(state => state.sessions)
  return <Profiler id="actual-activity" onRender={() => commits++}><ProjectActivity sessions={sessions} /></Profiler>
}
async function mount(status: SessionStatus = { state: 'working', source: 'native-hook', observedAt: 1000 }) {
  const sessions = ids.map(agent)
  sessions[0]!.status = status
  const snapshot: RuntimeSnapshot = { sessions, timelines: {}, recoveryCandidates: [] }
  bridge.handlers.set('config:get', () => config)
  bridge.handlers.set('providers:list', () => [])
  bridge.handlers.set('demands:list', () => [])
  bridge.handlers.set('sessions:snapshot', () => structuredClone(snapshot))
  bridge.handlers.set('ui:requestStorageFlush', () => undefined)
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  expect(useAppStore.getState().error).toBeNull()
  expect(bridge.calls).toEqual(['config:get', 'sessions:snapshot', 'providers:list', 'demands:list'])
  expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Activity />))
  expect(container.querySelectorAll('.project-activity')).toHaveLength(1)
  release = useAppStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) collectionChanges++
  })
  commits = 0
}
function statusEvent(change: Partial<Extract<RuntimeEvent['event'], { type: 'agent-status' }>> = {}): RuntimeEvent {
  return { type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: ids[0]!,
    state: 'working', evidence: { source: 'native-hook', observedAt: 1000, run: { runId: `run-${ids[0]}` } }, ...change } }
}
function sessionEvent(change: Partial<AgentMuxAgentSession> = {}): RuntimeEvent {
  return { type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
    kind: 'agent', agentSessionId: ids[0]!, providerId: 'codex', executorId: 'private', hostId: 'local',
    workspacePath: '/private/projection', createdAt: 1, updatedAt: 1000,
    run: { runId: `run-${ids[0]}` }, retiredRuns: [],
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1000 }, ...change
  } } }
}
function resetMeasuredWork() {
  // Drain the already-admitted startup state using its actual owner before counting semantic work.
  prepareRendererUpdate()
  commits = 0; collectionChanges = 0
  const encoding = vi.spyOn(JSON, 'stringify')
  const writes = vi.spyOn(window.localStorage, 'setItem')
  return () => {
    prepareRendererUpdate()
    const persistedEncoding = encoding.mock.calls.filter(([value]) => value && typeof value === 'object' &&
      'state' in value && value.state && typeof value.state === 'object' && 'restoredWorkbench' in value.state)
    expect(persistedEncoding).toHaveLength(0)
    expect(writes).not.toHaveBeenCalled()
    encoding.mockRestore(); writes.mockRestore()
  }
}
async function emit(event: RuntimeEvent) {
  const listeners = bridge.listeners.get(SESSION_EVENT_CHANNEL)
  expect(listeners?.size).toBe(1)
  await act(async () => {
    for (const listener of listeners!) listener({}, event)
    await Promise.resolve()
  })
}
function expectUnrelatedUnchanged(previous: SessionSnapshot[]) {
  const current = useAppStore.getState().sessions
  expect(current.map(session => session.id)).toEqual(ids)
  for (let i = 1; i < ids.length; i++) expect(current[i]).toBe(previous[i])
}
function currentAgent() {
  const item = useAppStore.getState().sessions[0]
  expect(item?.id).toBe(ids[0])
  if (!item || item.kind !== 'agent') throw new Error('Expected the initialized nonempty Agent projection')
  return item
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  bridge.calls.length = 0; bridge.handlers.clear(); bridge.listeners.clear(); window.localStorage.clear()
  useAppStore.setState({ ...initial, loading: true }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  commits = 0; collectionChanges = 0
})
afterEach(async () => {
  release?.(); release = undefined
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); container = undefined
  dispose?.(); dispose = undefined
  expect(bridge.listeners.get(SESSION_EVENT_CHANNEL)?.size).toBe(0)
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('rejects old Run, stale and foreign-host events without waking the mounted activity', async () => {
  await mount()
  const before = useAppStore.getState()
  for (let i = 0; i < 8; i++) {
    await emit(statusEvent({ state: 'waiting', evidence: { source: 'native-hook', observedAt: 2000 + i, run: { runId: 'retired-private-run' } } }))
    await emit(statusEvent({ state: 'waiting', evidence: { source: 'native-hook', observedAt: 999, run: { runId: `run-${ids[0]}` } } }))
    await emit({ ...statusEvent({ state: 'waiting' }), hostId: 'foreign-host' })
  }
  expect(useAppStore.getState()).toBe(before)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expectUnrelatedUnchanged(before.sessions)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 0, commits: 0 })
  // Existing raw transport isolation is a positive control, not another semantic no-op implementation.
  for (let i = 0; i < 8; i++) await emit({ type: 'core', hostId: 'local', event: { type: 'terminal-output',
    run: { runId: `run-${ids[0]}` }, data: 'private-byte', dataBytes: new TextEncoder().encode('private-byte'),
    evidence: { source: 'terminal-output', observedAt: 3000 + i, run: { runId: `run-${ids[0]}` }, outputByteRange: { startByte: i * 12, endByte: (i + 1) * 12 } } } })
  expect(useAppStore.getState()).toBe(before)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 0, commits: 0 })
})

it('preserves references for repeated facts but applies a newer same-state observation', async () => {
  await mount()
  const before = useAppStore.getState()
  for (let i = 0; i < 8; i++) await emit(statusEvent())
  expect(useAppStore.getState()).toBe(before)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 0, commits: 0 })
  await emit(statusEvent({ evidence: { source: 'native-hook', observedAt: 2000, run: { runId: `run-${ids[0]}` } } }))
  const after = useAppStore.getState()
  expect(after.sessions).not.toBe(before.sessions)
  expect(after.sessions[0]).not.toBe(before.sessions[0])
  expect(after.sessions[0]!.status).toEqual({ state: 'working', source: 'native-hook', observedAt: 2000 })
  expect(after.sessions[0]!.updatedAt).toBe(2000)
  expectUnrelatedUnchanged(before.sessions)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 1, commits: 1 })
})

it('publishes current same-timestamp state/source/detail changes and clears old metadata', async () => {
  await mount({ state: 'working', source: 'native-hook', observedAt: 1000,
    detail: 'Previous service window', exitCode: 9, exitReason: 'unknown', continuity: 'conflict', continuityConflict: 'lifecycle-busy' })
  const before = useAppStore.getState().sessions
  await emit(statusEvent({ state: 'waiting', detail: 'Reply required' }))
  expect(useAppStore.getState().sessions[0]!.status).toEqual({ state: 'waiting', source: 'native-hook', observedAt: 1000, detail: 'Reply required' })
  expect(container!.querySelector('.project-activity')!.getAttribute('aria-label')).toContain('1 Needs you')
  expectUnrelatedUnchanged(before)
  await emit(statusEvent({ state: 'waiting', evidence: { source: 'acp', observedAt: 1000, run: { runId: `run-${ids[0]}` } } }))
  expect(useAppStore.getState().sessions[0]!.status).toEqual({ state: 'waiting', source: 'acp', observedAt: 1000 })
  expectUnrelatedUnchanged(before)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 2, commits: 2 })
})

it('keeps disconnected Run projection untouched despite a newer valid Hook', async () => {
  await mount({ state: 'disconnected', source: 'run-process', observedAt: 1000, detail: 'Link unavailable' })
  const before = useAppStore.getState()
  await emit(statusEvent({ evidence: { source: 'native-hook', observedAt: 2000, run: { runId: `run-${ids[0]}` } } }))
  expect(useAppStore.getState()).toBe(before)
  expect(useAppStore.getState().sessions[0]!.status).toEqual({ state: 'disconnected', source: 'run-process', observedAt: 1000, detail: 'Link unavailable' })
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 0, commits: 0 })
})

it('rejects old AgentSession snapshots and unproven Run replacement without collection or mounted work', async () => {
  await mount()
  const finishStorageControl = resetMeasuredWork(), before = useAppStore.getState()
  for (let i = 0; i < 8; i++) {
    await emit(sessionEvent({ updatedAt: 999 }))
    await emit(sessionEvent({ updatedAt: 2000 + i, run: { runId: 'unproven-new-run' }, retiredRuns: [] }))
  }
  expect(useAppStore.getState()).toBe(before)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expectUnrelatedUnchanged(before.sessions)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 0, commits: 0 })
  finishStorageControl()
})

it('repeated accepted AgentSession facts preserve references, notifications and persistent writer control', async () => {
  await mount()
  const usage = { outputTokens: 11, inputTokens: 12, totalTokens: 23, observedAt: 1000,
    context: { usedTokens: 50, capacityTokens: 200 } }
  const event = sessionEvent({ turnUsage: usage })
  await emit(event)
  expect(currentAgent().turnUsage).toEqual(usage)
  const finishStorageControl = resetMeasuredWork(), before = useAppStore.getState()
  for (let i = 0; i < 8; i++) await emit(structuredClone(event))
  expect(useAppStore.getState()).toBe(before)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expectUnrelatedUnchanged(before.sessions)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 0, commits: 0 })
  finishStorageControl()
})

it('same-clock real metadata changes and deletion replace only their related AgentSession', async () => {
  await mount(); await emit(sessionEvent())
  const finishStorageControl = resetMeasuredWork(), before = useAppStore.getState().sessions
  const capability = { state: 'unknown' as const, mode: 'degraded' as const, reason: 'handshake-timeout' as const,
    run: { runId: `run-${ids[0]}` }, observedAt: 1000 }
  await emit(sessionEvent({ terminalCapability: capability }))
  const changed = useAppStore.getState().sessions
  expect(currentAgent().terminalCapability).toEqual(capability)
  expect(changed[0]).not.toBe(before[0])
  expect(changed[0]!.status).toBe(before[0]!.status)
  expectUnrelatedUnchanged(before)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 1, commits: 1 })
  await emit(sessionEvent())
  expect(useAppStore.getState().sessions[0]).not.toBe(changed[0])
  expect(useAppStore.getState().sessions[0]).not.toHaveProperty('terminalCapability')
  expect(useAppStore.getState().sessions[0]!.status).toBe(before[0]!.status)
  expectUnrelatedUnchanged(before)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 2, commits: 2 })
  finishStorageControl()
})

it('proven AgentSession Run takeover and a newer clock remain reachable with unrelated items intact', async () => {
  await mount(); await emit(sessionEvent())
  const finishStorageControl = resetMeasuredWork(), before = useAppStore.getState().sessions
  const oldRun = { ...before[0]!.control.run }, nextRun = { runId: 'proven-next-run' }
  await emit(sessionEvent({ updatedAt: 1001, run: nextRun, retiredRuns: [oldRun] }))
  const resumed = currentAgent()
  expect(resumed.control).toEqual({ kind: 'agent', hostId: 'local', agentSessionId: ids[0], run: nextRun })
  expect(resumed.agentSessionUpdatedAt).toBe(1001)
  expect(resumed.status).toBe(before[0]!.status)
  expectUnrelatedUnchanged(before)
  await emit(sessionEvent({ updatedAt: 2000, run: nextRun, retiredRuns: [oldRun],
    semanticStatus: { state: 'waiting', source: 'native-hook', observedAt: 2000, stateEnteredAt: 1500 } }))
  expect(useAppStore.getState().sessions[0]!.status).toEqual({
    state: 'waiting', source: 'native-hook', observedAt: 2000, stateEnteredAt: 1500
  })
  expect(container!.querySelector('.project-activity')!.getAttribute('aria-label')).toContain('1 Needs you')
  expectUnrelatedUnchanged(before)
  expect({ collectionChanges, commits }).toEqual({ collectionChanges: 2, commits: 2 })
  // No input/recovery transport is admitted by a pure snapshot observation.
  expect(bridge.calls.filter(channel => /^sessions:(write|paste|send|resume|reattach|stop)/.test(channel))).toEqual([])
  finishStorageControl()
})
