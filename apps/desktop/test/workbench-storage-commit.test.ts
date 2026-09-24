// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const storageName = 'agentmux-workbench-v1'
const sessionId = 'storage-commit-agent'
const workspaceId = 'storage-commit-workspace'
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private storage fixture' }], executors: {},
  workspaces: [{ id: workspaceId, name: 'Private fixture', hostId: 'local', path: '/private/storage-commit', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function agent(runId = 'healthy-run', processState: 'running' | 'exited' = 'running'): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id: sessionId, kind: 'agent', providerId: 'codex', executorId: 'probe', hostId: 'local',
    workspacePath: '/private/storage-commit', label: 'Private Agent', createdAt: 1, updatedAt: 1,
    agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, processState,
    status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: sessionId, run: { runId } }
  }
}

let store: typeof import('../src/renderer/src/store').useAppStore
let api: typeof import('../src/renderer/src/lib/api').api
let backing: Map<string, string>
let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
let trace: Array<{ kind: 'write' | 'remove' | 'commit'; at: number }>
let runtimeEvent: ((event: RuntimeEvent) => void) | undefined
let dispose: (() => void) | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  backing = new Map()
  trace = []
  storage = {
    getItem: name => backing.get(name) ?? null,
    setItem: (name, value) => { backing.set(name, value); trace.push({ kind: 'write', at: Date.now() }) },
    removeItem: name => { backing.delete(name); trace.push({ kind: 'remove', at: Date.now() }) }
  }
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue(storage as Storage)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  store = (await import('../src/renderer/src/store')).useAppStore
  api = (await import('../src/renderer/src/lib/api')).api
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [agent()], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => {
    runtimeEvent = listener
    return () => { runtimeEvent = undefined }
  })
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => agent(control.run.runId))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => {
    trace.push({ kind: 'commit', at: Date.now() })
  })
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  runtimeEvent = undefined
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function initialize(): Promise<void> {
  const tab = createWorkbenchTab('commit-tab', {
    regionId: 'commit-region', kind: 'agent', phase: 'attached', workspaceId, sessionId
  })
  store.setState({ restoredWorkbench: {
    tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('commit-group', [tab.id]) }
  } })
  dispose = await store.getState().initialize()
  expect(store.getState().loading).toBe(false)
  expect(Object.keys(store.getState().tabs)).toEqual([tab.id])
  await vi.advanceTimersByTimeAsync(400)
  expect(backing.has(storageName)).toBe(true)
  trace.length = 0
  vi.mocked(api.ui.requestStorageFlush).mockClear()
}

function saved() {
  const raw = backing.get(storageName)
  expect(raw).toBeTypeOf('string')
  return JSON.parse(raw!) as { state: Pick<ReturnType<typeof store.getState>,
    'agentComposerDrafts' | 'agentFocus' | 'toolsOpen' | 'agentSteerQueues'> }
}

function status(observedAt: number): void {
  expect(runtimeEvent).toBeTypeOf('function')
  runtimeEvent!({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: sessionId, state: 'working',
    evidence: { source: 'native-hook', observedAt, run: { runId: 'healthy-run' } }
  } })
}

describe('actual workbench writes request native storage commit', () => {
  it('requests one commit after a real batch writes, while 200 accepted Agent events keep arriving', async () => {
    await initialize()
    const start = Date.now()
    store.getState().setAgentComposerDraft(sessionId, 'Newest unsent draft')
    store.getState().focusExecutionSession(sessionId)
    store.setState({ toolsOpen: false })
    for (let index = 0; index < 200; index += 1) {
      await vi.advanceTimersByTimeAsync(100)
      status(index + 2)
    }
    expect(store.getState().sessions.map(item => [item.id, item.status.observedAt])).toEqual([[sessionId, 201]])
    expect(trace.map(item => [item.kind, item.at - start])).toEqual([['write', 400], ['commit', 400]])
    expect(saved().state).toMatchObject({
      agentComposerDrafts: { [sessionId]: 'Newest unsent draft' },
      agentFocus: { execution: { sessionId, history: [{ sessionId, focusedAt: start }] }, pmo: { sessionId: null } },
      toolsOpen: false
    })
    expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(1)
  })

  it('does not commit same content, storage reads or consumed transient state updates', async () => {
    await initialize()
    store.getState().setAgentComposerDraft(sessionId, 'Saved draft')
    await vi.advanceTimersByTimeAsync(400)
    const before = backing.get(storageName)
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'Saved draft' })
    trace.length = 0
    vi.mocked(api.ui.requestStorageFlush).mockClear()
    store.getState().setAgentComposerDraft(sessionId, 'Saved draft')
    await store.persist.getOptions().storage!.getItem(storageName)
    for (let index = 0; index < 200; index += 1) {
      status(index + 2)
      store.setState({ startupProgress: { step: 'runtime' } })
    }
    await vi.advanceTimersByTimeAsync(800)
    expect(store.getState().sessions.map(item => [item.id, item.status.observedAt])).toEqual([[sessionId, 201]])
    expect(backing.get(storageName)).toBe(before)
    expect(trace).toEqual([])
    expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
  })

  it('shows a failed commit through the existing notice, leaves healthy input usable, and retries the next real change without a feedback loop', async () => {
    await initialize()
    const healthy = store.getState().sessions[0]
    vi.mocked(api.ui.requestStorageFlush).mockRejectedValueOnce(new Error('Private native commit rejection'))
    store.getState().setAgentComposerDraft(sessionId, 'Kept unsent draft')
    await vi.advanceTimersByTimeAsync(400)
    expect(store.getState().workbenchSaveWarning).toBe('Private native commit rejection')
    expect(store.getState().error).toBeNull()
    const [{ createElement, act }, { createRoot }, { GlobalSystemNotices }] = await Promise.all([
      import('react'), import('react-dom/client'), import('../src/renderer/src/components/GlobalSystemNotices')
    ])
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let html: string
    try {
      await act(async () => root.render(createElement(GlobalSystemNotices)))
      html = container.innerHTML
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
    expect(html).toContain('role="status"')
    expect(html).toContain('Saving the workbench is unconfirmed')
    expect(html).toContain('Private native commit rejection')
    expect(html).toContain('Retry saving')
    expect(store.getState().sessions).toEqual([healthy])
    expect(store.getState().agentComposerDrafts).toEqual({ [sessionId]: 'Kept unsent draft' })
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'Kept unsent draft' })
    await vi.advanceTimersByTimeAsync(800)
    expect(trace.map(item => item.kind)).toEqual(['write'])
    expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(1)
    expect(store.getState().send(sessionId, 'Healthy Agent can still work')).toBe(true)
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[0].run.runId, call[1]])).toEqual([
      ['healthy-run', 'Healthy Agent can still work']
    ])
    expect(store.getState().sessions).toEqual([healthy])
    // Sending has its own durable outbox writes. Measure the next actual draft change separately.
    await vi.advanceTimersByTimeAsync(400)
    trace.length = 0
    vi.mocked(api.ui.requestStorageFlush).mockClear()
    store.getState().setAgentComposerDraft(sessionId, 'Next real draft change')
    await vi.advanceTimersByTimeAsync(400)
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'Next real draft change' })
    expect(trace.map(item => item.kind)).toEqual(['write', 'commit'])
    expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(1)
    expect(store.getState().workbenchSaveWarning).toBeNull()
  })

  it('commits a real clear once and never requests commit for an absent record', async () => {
    await initialize()
    store.persist.clearStorage()
    expect(backing.has(storageName)).toBe(false)
    expect(trace.map(item => item.kind)).toEqual(['remove', 'commit'])
    store.persist.clearStorage()
    await vi.advanceTimersByTimeAsync(800)
    expect(trace.map(item => item.kind)).toEqual(['remove', 'commit'])
    expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(1)
  })

  it('does not request commit when a synchronous write fails, and a same-value retry still writes and requests commit', async () => {
    await initialize()
    const before = backing.get(storageName)
    vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('Private storage write failure') })
    store.getState().setAgentComposerDraft(sessionId, 'Retry the retained draft')
    expect(() => vi.advanceTimersByTime(400)).toThrow('Private storage write failure')
    expect(backing.get(storageName)).toBe(before)
    expect(trace).toEqual([])
    expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
    store.getState().setAgentComposerDraft(sessionId, 'Retry the retained draft')
    await vi.advanceTimersByTimeAsync(400)
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'Retry the retained draft' })
    expect(trace.map(item => item.kind)).toEqual(['write', 'commit'])
  })

  it('does not request commit when a real synchronous removal fails', async () => {
    await initialize()
    const before = backing.get(storageName)
    vi.spyOn(storage, 'removeItem').mockImplementationOnce(() => { throw new Error('Private storage removal failure') })
    expect(() => store.persist.clearStorage()).toThrow('Private storage removal failure')
    expect(backing.get(storageName)).toBe(before)
    expect(trace).toEqual([])
    expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
  })

  it('keeps typed first execution awaiting its foreground request after the background commit request', async () => {
    vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [agent('old-run', 'exited')], timelines: {}, recoveryCandidates: [] })
    await initialize()
    vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: agent('canonical-run') })
    let resolve!: () => void
    const gate = new Promise<void>(done => { resolve = done })
    const submit = vi.mocked(api.sessions.submitPrompt)
    const flush = vi.mocked(api.ui.requestStorageFlush)
    flush.mockImplementationOnce(async () => {
      expect(saved().state.agentSteerQueues[sessionId]).toEqual([
        expect.objectContaining({ runId: 'canonical-run', status: 'restoring' })
      ])
      expect(submit).not.toHaveBeenCalled()
    }).mockReturnValueOnce(gate)
    expect(store.getState().send(sessionId, 'First typed execution')).toBe(true)
    const operationId = store.getState().agentSteerQueues[sessionId]![0]!.operationId
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2))
    expect(submit).not.toHaveBeenCalled()
    expect(store.getState().agentSteerQueues[sessionId]).toEqual([
      expect.objectContaining({ operationId, runId: 'canonical-run', status: 'restoring' })
    ])
    resolve()
    await drain
    expect(submit.mock.calls.map(call => [call[0].run.runId, call[1], call[2]])).toEqual([
      ['canonical-run', 'First typed execution', operationId]
    ])
    expect(store.getState().agentSteerQueues[sessionId]).toBeUndefined()
  })

  it('retains a typed binding when its foreground request fails even though the background commit request succeeded', async () => {
    vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [agent('old-run', 'exited')], timelines: {}, recoveryCandidates: [] })
    await initialize()
    vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: agent('canonical-run') })
    vi.mocked(api.ui.requestStorageFlush).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Private foreground commit rejection'))
    expect(store.getState().send(sessionId, 'Keep exact binding')).toBe(true)
    const operationId = store.getState().agentSteerQueues[sessionId]![0]!.operationId
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(store.getState().agentSteerQueues[sessionId]).toEqual([
      expect.objectContaining({ operationId, runId: 'canonical-run', status: 'restoring', error: 'Private foreground commit rejection' })
    ])
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(2)
  })
})
