import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const sessionId = 'first-execution-agent'
const workspaceId = 'workspace'
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private test' }],
  executors: {}, workspaces: [{ id: workspaceId, name: 'Private', hostId: 'local', path: '/private/fixture', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }

function agent(runId = 'old-run', processState: 'running' | 'exited' | 'interrupted' = 'exited', id = sessionId): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'probe', hostId: 'local',
    workspacePath: '/private/fixture', label: 'Private Agent', createdAt: 1, updatedAt: 2, processState,
    status: { state: 'done', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId } } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

let store: typeof import('../src/renderer/src/store').useAppStore
let api: typeof import('../src/renderer/src/lib/api').api
let backing: Map<string, string>
let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
let dispose: (() => void) | undefined
let runtimeEvent: ((event: RuntimeEvent) => void) | undefined
const revived = agent('canonical-run', 'running')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  backing = new Map()
  storage = { getItem: name => backing.get(name) ?? null,
    setItem: (name, value) => { backing.set(name, value) }, removeItem: name => { backing.delete(name) } }
  vi.stubGlobal('window', { localStorage: storage, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  store = (await import('../src/renderer/src/store')).useAppStore
  api = (await import('../src/renderer/src/lib/api')).api
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [agent()], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { runtimeEvent = listener; return () => { runtimeEvent = undefined } })
  vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: revived })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  const tab = createWorkbenchTab('tab', { regionId: 'region', kind: 'agent', phase: 'attached', workspaceId, sessionId })
  store.setState({ restoredWorkbench: { tabs: { tab }, layouts: { [workspaceId]: createWorkspaceLayout('group', [tab.id]) } } })
})
afterEach(() => {
  dispose?.(); dispose = undefined
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function initialize() {
  dispose = await store.getState().initialize()
  expect(store.getState().loading).toBe(false)
  expect(store.getState().tabs.tab).toBeDefined()
}
function queue() { return store.getState().agentSteerQueues[sessionId]! }
function persistedQueue() {
  const record = backing.get('agentmux-workbench-v1')
  expect(record).toBeTypeOf('string')
  return JSON.parse(record!).state.agentSteerQueues[sessionId]
}

describe('one existing intent owns first execution', () => {
  it('restores without a prompt, binds durably before a flush request, then submits the same operation exactly once', async () => {
    await initialize()
    const gate = deferred()
    const submit = vi.mocked(api.sessions.submitPrompt)
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(() => {
      expect(persistedQueue()).toEqual([expect.objectContaining({ runId: 'canonical-run', status: 'restoring' })])
      expect(submit).not.toHaveBeenCalled()
      return gate.promise
    })
    expect(store.getState().send(sessionId, 'first execution')).toBe(true)
    const entry = queue()[0]!
    expect(entry).not.toHaveProperty('runId')
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(1))
    expect(api.sessions.recover).toHaveBeenCalledExactlyOnceWith(agent().control, agent().workspacePath, entry.operationId)
    expect(queue()).toEqual([expect.objectContaining({ ...entry, runId: 'canonical-run', status: 'restoring' })])
    expect(submit).not.toHaveBeenCalled()
    gate.resolve(); await drain
    expect(submit.mock.calls.map(call => [call[0].run.runId, call[1], call[2]])).toEqual([
      ['canonical-run', 'first execution', entry.operationId]
    ])
    expect(store.getState().agentSteerQueues[sessionId]).toBeUndefined()
  })

  it('coalesces duplicate send attempts of one restoring intent without a recovery/drain self-await', async () => {
    await initialize()
    const gate = deferred()
    vi.mocked(api.sessions.recover).mockImplementation(async () => { await gate.promise; return { kind: 'resumed', session: revived } })
    store.getState().send(sessionId, 'one intent')
    const operationId = queue()[0]!.operationId
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(api.sessions.recover).toHaveBeenCalledTimes(1))
    const again = store.getState().sendQueuedAgentSteer(sessionId, operationId)
    gate.resolve(); await Promise.all([drain, again])
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[2])).toEqual([operationId])
  })

  it('retains the exact binding after a flush-request failure and retries without another recovery', async () => {
    await initialize()
    vi.mocked(api.ui.requestStorageFlush).mockRejectedValueOnce(new Error('Chromium flush request failed'))
    store.getState().send(sessionId, 'retain intent')
    const operationId = queue()[0]!.operationId
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(queue()).toEqual([expect.objectContaining({ operationId, runId: 'canonical-run', status: 'restoring', error: 'Chromium flush request failed' })])
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    await store.getState().sendQueuedAgentSteer(sessionId, operationId)
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[2])).toEqual([operationId])
  })

  it('does not dispatch or request Chromium flush when the existing writer fails to save the binding', async () => {
    await initialize()
    const write = vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('local storage write failed') })
    store.getState().send(sessionId, 'keep before dispatch')
    const operationId = queue()[0]!.operationId
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(queue()).toEqual([expect.objectContaining({ operationId, runId: 'canonical-run', status: 'restoring', error: 'local storage write failed' })])
    expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    write.mockRestore()
    await store.getState().sendQueuedAgentSteer(sessionId, operationId)
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[2])).toEqual([operationId])
  })

  it('keeps an unbound execution from dispatch when hydration leaves the writer fence closed, without blocking healthy input', async () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('saved workbench read failed') })
    await initialize()
    expect(store.getState().error).toContain('saved workbench read failed')
    store.getState().send(sessionId, 'binding must be saved')
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(queue()).toEqual([expect.objectContaining({ runId: 'canonical-run', status: 'restoring',
      error: 'Saved workbench storage is unavailable. Your execution intent is kept without dispatch.' })])
    expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    const other = agent('other-run', 'running', 'other')
    store.setState(state => ({ sessions: [...state.sessions, other] }))
    expect(store.getState().send('other', 'healthy without presentation storage')).toBe(true)
    await store.getState().flushAgentSteerQueue('other')
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[0].agentSessionId)).toEqual(['other'])
  })

  it('reconciles a lost continuity reply through fresh canonical facts before binding, without starting again', async () => {
    await initialize()
    vi.mocked(api.sessions.recover).mockRejectedValueOnce(new Error('continuity reply lost'))
    const refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(revived)
    store.getState().send(sessionId, 'reply lost')
    const operationId = queue()[0]!.operationId
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(refresh).toHaveBeenCalledExactlyOnceWith(agent().control)
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[0].run.runId, call[2]])).toEqual([['canonical-run', operationId]])
  })

  it.each(['resumed', 'lost-reply'] as const)('never stops a healthy canonical Agent when its view closes during %s recovery', async mode => {
    await initialize()
    const gate = deferred()
    const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
    if (mode === 'resumed') {
      vi.mocked(api.sessions.recover).mockImplementationOnce(async () => {
        await gate.promise; return { kind: 'resumed', session: revived }
      })
    } else {
      vi.mocked(api.sessions.recover).mockRejectedValueOnce(new Error('continuity reply lost'))
      vi.spyOn(api.sessions, 'refresh').mockImplementationOnce(async () => { await gate.promise; return revived })
    }
    store.getState().send(sessionId, 'view closes before continuation')
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(api.sessions.recover).toHaveBeenCalledTimes(1))
    store.setState({ tabs: {}, agentSteerQueues: {} })
    gate.resolve(); await drain
    expect(stop).not.toHaveBeenCalled()
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(api.ui.requestStorageFlush).not.toHaveBeenCalled()
    expect(store.getState().agentSteerQueues).toEqual({})
  })

  it('does not resurrect an intent removed while the binding flush request is outstanding', async () => {
    await initialize()
    const gate = deferred()
    vi.mocked(api.ui.requestStorageFlush).mockReturnValueOnce(gate.promise)
    store.getState().send(sessionId, 'removed while pending')
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(1))
    store.setState({ agentSteerQueues: {} })
    gate.resolve(); await drain
    expect(store.getState().agentSteerQueues).toEqual({})
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  })

  it('preserves an unbound failed restoration and leaves an unrelated healthy Agent input usable', async () => {
    await initialize()
    vi.mocked(api.sessions.recover).mockRejectedValueOnce(new Error('restore unavailable'))
    vi.spyOn(api.sessions, 'refresh').mockRejectedValueOnce(new Error('canonical facts unavailable'))
    store.getState().send(sessionId, 'keep failed intent')
    const operationId = queue()[0]!.operationId
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(queue()).toEqual([expect.objectContaining({ operationId, status: 'restoring', error: 'canonical facts unavailable' })])
    expect(queue()[0]).not.toHaveProperty('runId')
    const other = agent('other-run', 'running', 'other')
    store.setState(state => ({ sessions: [...state.sessions, other] }))
    expect(store.getState().send('other', 'healthy input')).toBe(true)
    await store.getState().flushAgentSteerQueue('other')
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[0].agentSessionId, call[1]])).toEqual([['other', 'healthy input']])
  })

  it.each(['AGENT_STATE_ENTRY_PERSIST_FAILED', 'PRIVATE_UNSCOPED_DIAGNOSTIC'])('shows %s through real subscribed ingress without painting or blocking the healthy Agent', async code => {
    vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [revived], timelines: {}, recoveryCandidates: [] })
    await initialize()
    const before = store.getState().sessions[0]
    expect(runtimeEvent).toBeTypeOf('function')
    runtimeEvent!({ type: 'core', hostId: 'local', event: {
      type: 'agent-error', message: 'Private durable observation failed; input was acknowledged.',
      code, evidence: { source: 'user', observedAt: 3, run: revived.control.run }
    } })
    expect(store.getState().error).toContain('Private durable observation failed; input was acknowledged.')
    expect(store.getState().errorDismissed).toBe(false)
    expect(store.getState().sessions).toEqual([before])
    expect(store.getState().send(sessionId, 'still working')).toBe(true)
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[0].run.runId, call[1]])).toEqual([
      ['canonical-run', 'still working']
    ])
    expect(api.sessions.recover).not.toHaveBeenCalled()
  })

  it('shows a host-wide diagnostic immediately while membership resync is pending and healthy input remains usable', async () => {
    const snapshot = { sessions: [revived], timelines: { [sessionId]: { agentSessionId: sessionId, revision: 0, items: [] } }, recoveryCandidates: [] }
    vi.mocked(api.sessions.snapshot).mockResolvedValue(snapshot)
    await initialize()
    const before = store.getState().sessions[0]
    const gate = deferred()
    vi.mocked(api.sessions.snapshot).mockImplementationOnce(async () => {
      await gate.promise; return snapshot
    })
    expect(runtimeEvent).toBeTypeOf('function')
    runtimeEvent!({ type: 'core', hostId: 'local', event: {
      type: 'agent-status', agentSessionId: 'new-private-membership', state: 'done',
      evidence: { source: 'native-hook', observedAt: 3, run: { runId: 'new-private-run' } }
    } })
    expect(api.sessions.snapshot).toHaveBeenCalledTimes(2)
    runtimeEvent!({ type: 'core', hostId: 'local', event: {
      type: 'agent-error', code: 'AGENT_STATE_ENTRY_PERSIST_FAILED',
      message: 'Private idle fact is unconfirmed after acknowledged input.',
      evidence: { source: 'user', observedAt: 4, run: revived.control.run }
    } })
    expect(store.getState().error).toContain('Private idle fact is unconfirmed after acknowledged input.')
    expect(store.getState().sessions).toEqual([before])
    expect(store.getState().send(sessionId, 'healthy during resync')).toBe(true)
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[1])).toEqual(['healthy during resync'])
    gate.resolve()
    await Promise.resolve(); await Promise.resolve()
    expect(store.getState().error).toContain('Private idle fact is unconfirmed after acknowledged input.')
    expect(store.getState().tabs.tab).toBeDefined()
  })

  it('never rebinds an old bound intent, including a Run change while its flush request is pending', async () => {
    await initialize()
    const gate = deferred()
    vi.mocked(api.ui.requestStorageFlush).mockReturnValueOnce(gate.promise)
    store.getState().send(sessionId, 'bound once')
    const operationId = queue()[0]!.operationId
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(api.ui.requestStorageFlush).toHaveBeenCalledTimes(1))
    store.setState({ sessions: [agent('replacement-run', 'running')] })
    gate.resolve(); await drain
    expect(queue()).toEqual([expect.objectContaining({ operationId, runId: 'canonical-run', status: 'deferred', error: expect.stringContaining('delivery result is unknown') })])
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    await store.getState().sendQueuedAgentSteer(sessionId, operationId)
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  })

  it('keeps historical bound and unbound queue entries read-only until one exact intent is explicitly sent', async () => {
    const historical = [
      { operationId: 'bound-old', runId: 'old-run', text: 'old bound intent', status: 'queued' as const },
      { operationId: 'unbound-old', text: 'old unbound intent', status: 'queued' as const }
    ]
    vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [agent('old-run', 'running')], timelines: {}, recoveryCandidates: [] })
    store.setState({ agentSteerQueues: { [sessionId]: historical } })
    await initialize()
    store.getState().setAgentComposerDraft(sessionId, 'only editing a draft')
    store.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: 3 }
    } } as never)
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(queue()).toHaveLength(2)
    expect(queue().map(entry => [entry.operationId, entry.runId, entry.errorCode])).toEqual([
      ['bound-old', 'old-run', 'AGENT_EXECUTION_NOT_REQUESTED'], ['unbound-old', undefined, 'AGENT_EXECUTION_NOT_REQUESTED']
    ])
    expect(api.sessions.recover).not.toHaveBeenCalled(); expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    await store.getState().sendQueuedAgentSteer(sessionId, 'bound-old')
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[2])).toEqual(['bound-old'])
    expect(queue()).toEqual([expect.objectContaining({ operationId: 'unbound-old', errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' })])
    expect(api.sessions.recover).not.toHaveBeenCalled()
  })
})
