import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const sessionId = 'first-execution-agent'
const workspaceId = 'workspace'
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private test' }],
  executors: {}, workspaces: [{ id: workspaceId, name: 'Private', hostId: 'local', path: _hygiene_fixturePath("private/fixture"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }

function agent(runId = 'old-run', processState: 'running' | 'exited' | 'interrupted' = 'exited', id = sessionId): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'probe', hostId: 'local',
    workspacePath: _hygiene_fixturePath("private/fixture"), label: 'Private Agent', createdAt: 1, updatedAt: 2, processState,
    status: { state: 'done', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    promptSubmissionPredecessor: null,
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
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => agent(control.run.runId, 'running', control.kind === 'agent' ? control.agentSessionId : sessionId))
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
    let bindingObserved = false
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
      if (queue()?.[0]?.runId !== 'canonical-run' || queue()[0]!.status !== 'restoring') return
      bindingObserved = true
      expect(persistedQueue()).toEqual([expect.objectContaining({ runId: 'canonical-run', status: 'restoring' })])
      expect(submit).not.toHaveBeenCalled()
      await gate.promise
    })
    expect(store.getState().send(sessionId, 'first execution')).toBe(true)
    const entry = queue()[0]!
    expect(entry).not.toHaveProperty('runId')
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(bindingObserved).toBe(true))
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
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
      if (queue()?.[0]?.runId === 'canonical-run' && queue()[0]!.status === 'restoring') throw new Error('Chromium flush request failed')
    })
    store.getState().send(sessionId, 'retain intent')
    const operationId = queue()[0]!.operationId
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(queue()).toEqual([expect.objectContaining({ operationId, runId: 'canonical-run', status: 'restoring', error: 'Chromium flush request failed' })])
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.ui.requestStorageFlush).mock.calls.length).toBeGreaterThan(0)
    vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
    await store.getState().sendQueuedAgentSteer(sessionId, operationId)
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
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
    expect(refresh.mock.calls).toEqual([[agent().control], [revived.control]])
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
    let bindingObserved = false
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
      if (queue()?.[0]?.runId !== 'canonical-run' || queue()[0]!.status !== 'restoring') return
      bindingObserved = true
      await gate.promise
    })
    store.getState().send(sessionId, 'removed while pending')
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(bindingObserved).toBe(true))
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
    expect(queue()).toEqual([expect.objectContaining({ operationId, status: 'restoring', error: 'restore unavailable' })])
    expect(queue()[0]).not.toHaveProperty('runId')
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    expect(api.sessions.refresh).toHaveBeenCalledTimes(1)
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    const other = agent('other-run', 'running', 'other')
    store.setState(state => ({ sessions: [...state.sessions, other] }))
    expect(store.getState().send('other', 'healthy input')).toBe(true)
    await store.getState().flushAgentSteerQueue('other')
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[0].agentSessionId, call[1]])).toEqual([['other', 'healthy input']])
    await store.getState().sendQueuedAgentSteer(sessionId, operationId)
    expect(api.sessions.recover).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[0].agentSessionId, call[2]])).toEqual([
      ['other', expect.any(String)], [sessionId, operationId]
    ])
    expect(store.getState().agentSteerQueues[sessionId]).toBeUndefined()
  })

  it('ends one refused recovery attempt even when a second recovery would succeed', async () => {
    await initialize()
    // The second result makes the broken loop terminate, so its failure is an assertion rather
    // than a timeout that could hide cleanup or starve Vitest's timers.
    const recover = vi.spyOn(store.getState(), 'recoverSession')
      .mockRejectedValueOnce(new Error('one restoration refused'))
      .mockImplementation(async () => { store.setState({ sessions: [revived] }); return revived })
    expect(store.getState().send(sessionId, 'single failed attempt')).toBe(true)
    const entry = queue()[0]!
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(recover).toHaveBeenCalledExactlyOnceWith(sessionId, entry.operationId)
    expect(queue()).toEqual([{ ...entry, status: 'restoring', error: 'one restoration refused' }])
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(store.getState().agentSteerInFlight[sessionId]).toBeUndefined()
  })

  it.each(['same', 'different'] as const)('keeps a new %s intent authorization received during a failed restoration', async mode => {
    await initialize()
    const gate = deferred()
    vi.mocked(api.sessions.recover).mockImplementationOnce(async () => {
      await gate.promise; throw new Error('first restoration refused')
    })
    vi.spyOn(api.sessions, 'refresh').mockRejectedValueOnce(new Error('first canonical read refused'))
    store.getState().send(sessionId, 'first retained intent')
    const first = queue()[0]!
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(api.sessions.recover).toHaveBeenCalledTimes(1))
    let selectedId = first.operationId
    if (mode === 'same') void store.getState().sendQueuedAgentSteer(sessionId, first.operationId)
    else {
      expect(store.getState().send(sessionId, 'new explicit intent')).toBe(true)
      selectedId = queue()[1]!.operationId
    }
    gate.resolve(); await drain
    expect(api.sessions.recover).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.sessions.recover).mock.calls.map(call => call[2])).toEqual([first.operationId, selectedId])
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[2], call[4]])).toEqual([
      [selectedId, { allowUncertainTurn: true }]
    ])
    if (mode === 'same') expect(store.getState().agentSteerQueues[sessionId]).toBeUndefined()
    else expect(queue()).toEqual([expect.objectContaining({ operationId: first.operationId,
      text: first.text, status: 'restoring', error: 'first restoration refused' })])
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
    let bindingObserved = false
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
      if (queue()?.[0]?.runId !== 'canonical-run' || queue()[0]!.status !== 'restoring') return
      bindingObserved = true
      await gate.promise
    })
    store.getState().send(sessionId, 'bound once')
    const operationId = queue()[0]!.operationId
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    await vi.waitFor(() => expect(bindingObserved).toBe(true))
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
      { operationId: 'bound-old', runId: 'old-run', text: 'old bound intent', status: 'queued' as const,
        promptCondition: { expectedRun: { runId: 'old-run' }, afterSubmissionId: null } },
      { operationId: 'unbound-old', text: 'old unbound intent', status: 'queued' as const, promptCondition: null }
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


function immediate(session: Extract<SessionSnapshot, { kind: 'agent' }>) {
  return { ...session, capabilities: { ...session.capabilities,
    promptExecution: { immediate: 'interrupt-before-input' as const } } }
}
function clearedFact(session: Extract<SessionSnapshot, { kind: 'agent' }>) {
  return { kind: 'agent' as const, agentSessionId: session.id, providerId: session.providerId,
    executorId: session.executorId, hostId: session.hostId, workspacePath: session.workspacePath,
    createdAt: session.createdAt, updatedAt: 200, run: session.control.run, retiredRuns: [],
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: 200 } }
}

describe('original explicit selection survives recovery and only known local preparation can be reset', () => {
  it('freezes before recovery, then the real subscribed clear resumes only the edited original selected mode', async () => {
    await initialize()
    store.setState({ sessions: [immediate(agent())], viewModes: { [sessionId]: 'conversation' } })
    const resumed = { ...immediate(revived), pendingInteraction: {
      kind: 'permission' as const, requestId: 'resumed-decision', summary: 'Private resumed request',
      options: [{ id: 'deny', label: 'Deny' }], observedAt: 100
    } }
    const recovery = deferred()
    vi.mocked(api.sessions.recover).mockImplementation(async (_control, _directory, operationId) => {
      expect(queue().find(entry => entry.operationId === operationId)).toMatchObject({ execution: 'immediate', promptCondition: null })
      await recovery.promise
      return { kind: 'resumed', session: resumed }
    })
    vi.mocked(api.sessions.refresh).mockResolvedValue(immediate(revived))
    expect(store.getState().enqueueAgentSteer(sessionId, 'ordinary tail', undefined, 'ordinary-tail', 'manual')).toBe(true)
    expect(store.getState().send(sessionId, 'original requested text', undefined, 'manual', 'original note')).toBe(true)
    const selected = queue()[1]!
    expect(selected).toMatchObject({ execution: 'immediate', promptCondition: null, agentMuxNote: 'original note' })
    expect(selected.runId).toBeUndefined()
    const drain = store.getState().flushAgentSteerQueue(sessionId)
    recovery.resolve(); await drain
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(queue()[1]).toMatchObject({ ...selected, runId: resumed.control.run.runId, promptCondition: null })
    expect(store.getState().viewModes[sessionId]).toBe('conversation')
    store.getState().editQueuedAgentSteer(sessionId, selected.operationId, selected.text, 'CAS revised original text')
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(queue()[1]).toMatchObject({ operationId: selected.operationId, execution: 'immediate', promptCondition: null })
    // A typed answer uses the actual Store response owner. This unit supplies its Core event;
    // the separate native proof must produce and clear the real Provider request.
    vi.spyOn(api.sessions, 'respondInteraction').mockImplementation(async () => {
      runtimeEvent!({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: clearedFact(resumed) } })
    })
    await store.getState().respondInteraction(sessionId, { kind: 'permission', requestId: 'resumed-decision', decision: { outcome: 'selected', optionId: 'deny' } })
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[0].run.runId, call[1], call[2], call[4], call[6]])).toEqual([
      [resumed.control.run.runId, 'CAS revised original text', selected.operationId, { allowUncertainTurn: true, execution: 'immediate' }, 'original note']
    ])
    expect(queue()).toEqual([expect.objectContaining({ operationId: 'ordinary-tail', text: 'ordinary tail', promptCondition: null })])
    expect(queue()[0]!.execution).toBeUndefined()
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })

  it('keeps frozen default across fresh capability changes and does not silently downgrade frozen immediate', async () => {
    await initialize()
    const pending = { ...revived, pendingInteraction: { kind: 'permission' as const,
      requestId: 'hold', summary: 'Private', options: [{ id: 'deny', label: 'Deny' }], observedAt: 100 } }
    store.setState({ sessions: [pending] })
    store.getState().send(sessionId, 'original default')
    const entry = queue()[0]!
    expect(entry.execution).toBe('default')
    await store.getState().flushAgentSteerQueue(sessionId)
    store.setState({ sessions: [immediate(revived)] })
    vi.mocked(api.sessions.refresh).mockResolvedValue(immediate(revived))
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[2], call[4]])).toEqual([[entry.operationId, { allowUncertainTurn: true }]])
    store.setState({ sessions: [immediate(revived)] })
    vi.mocked(api.sessions.refresh).mockResolvedValue(revived)
    store.getState().send(sessionId, 'immediate cannot degrade')
    const rejected = queue()[0]!
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(queue()[0]).toMatchObject({ operationId: rejected.operationId, execution: 'immediate', promptCondition: null,
      error: expect.stringContaining('immediate-send capability is unconfirmed') })
    expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
    vi.mocked(api.sessions.refresh).mockResolvedValue(immediate(revived))
    await store.getState().sendQueuedAgentSteer(sessionId, rejected.operationId)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.at(-1)?.[4]).toEqual({ allowUncertainTurn: true, execution: 'immediate' })
  })

  it.each(['explicit', 'queue-only'] as const)('keeps %s known not submitted after the prepared binding save fails, without manufacturing a selection', async producer => {
    await initialize()
    store.setState({ sessions: [immediate(agent())] })
    vi.mocked(api.sessions.recover).mockResolvedValue({ kind: 'resumed', session: immediate(revived) })
    vi.mocked(api.sessions.refresh).mockResolvedValue(immediate(revived))
    let observedPrepared = false
    vi.mocked(api.ui.requestStorageFlush).mockImplementation(async () => {
      if (queue()?.some(entry => entry.promptCondition !== null && entry.promptCondition !== undefined)) {
        observedPrepared = true
        throw new Error('Prepared binding save unavailable')
      }
    })
    if (producer === 'explicit') store.getState().send(sessionId, 'local preflight failure')
    else store.getState().enqueueAgentSteer(sessionId, 'local preflight failure', undefined, 'queue-preflight', 'manual')
    const original = queue()[0]!
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(observedPrepared).toBe(true)
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(queue()[0]).toMatchObject({ operationId: original.operationId, text: original.text, enqueuedAt: original.enqueuedAt,
      runId: revived.control.run.runId, promptCondition: null, status: 'deferred', error: 'Prepared binding save unavailable' })
    expect(queue()[0]!.execution).toBe(producer === 'explicit' ? 'immediate' : undefined)
    const listed = await store.getState().executeControl({ schemaVersion: 5, requestId: 'preflight-list',
      operation: 'message.pending.ls', agentSessionId: sessionId })
    expect(listed).toMatchObject({ messages: [{ pendingId: original.operationId, delivery: 'not-submitted', editable: true }] })
    vi.mocked(api.ui.requestStorageFlush).mockResolvedValue(undefined)
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[2], call[4]])).toEqual([
      [original.operationId, producer === 'explicit' ? { allowUncertainTurn: true, execution: 'immediate' } : undefined]
    ])
  })

  it('holds the exact condition after an invoked BUSY and ignores background wakes until original explicit retry', async () => {
    await initialize()
    store.setState({ sessions: [immediate(revived)] })
    vi.mocked(api.sessions.refresh).mockResolvedValue(immediate(revived))
    const invoked = vi.mocked(api.sessions.submitPrompt).mockRejectedValueOnce(Object.assign(new Error('Same original operation may be active elsewhere'), { code: 'AGENT_PROMPT_SUBMISSION_BUSY' }))
    store.getState().send(sessionId, 'invoked original immediate')
    await store.getState().flushAgentSteerQueue(sessionId)
    const retained = queue()[0]!
    expect(retained.promptCondition).toEqual({ expectedRun: revived.control.run, afterSubmissionId: null })
    expect(retained.execution).toBe('immediate')
    runtimeEvent!({ type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: sessionId, state: 'done',
      evidence: { source: 'native-hook', observedAt: 201, run: revived.control.run } } })
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(invoked).toHaveBeenCalledTimes(1)
    expect(queue()[0]!.promptCondition).toEqual(retained.promptCondition)
    const listed = await store.getState().executeControl({ schemaVersion: 5, requestId: 'unknown-list',
      operation: 'message.pending.ls', agentSessionId: sessionId })
    expect(listed).toMatchObject({ messages: [{ delivery: 'unconfirmed', editable: false }] })
    await store.getState().sendQueuedAgentSteer(sessionId, retained.operationId)
    expect(invoked.mock.calls.map(call => [call[2], call[3], call[4]])).toEqual(Array(2).fill([
      retained.operationId, retained.promptCondition, { allowUncertainTurn: true, execution: 'immediate' }
    ]))
  })

  it('boot pauses the persisted original immediate/default choices and no historical input upgrades', async () => {
    const saved = [{ operationId: 'original-immediate', runId: revived.control.run.runId, enqueuedAt: 44,
      text: 'before independent restart', status: 'queued' as const, promptCondition: null, execution: 'immediate' as const },
      { operationId: 'original-default', runId: revived.control.run.runId, text: 'frozen default',
        status: 'queued' as const, promptCondition: null, execution: 'default' as const },
      { operationId: 'historical-undefined', runId: revived.control.run.runId, text: 'historical unknown', status: 'queued' as const }]
    store.setState({ agentSteerQueues: { [sessionId]: saved } })
    vi.mocked(api.sessions.snapshot).mockResolvedValue({ sessions: [immediate(revived)], timelines: {}, recoveryCandidates: [] })
    vi.mocked(api.sessions.refresh).mockResolvedValue(immediate(revived))
    await initialize()
    await store.getState().flushAgentSteerQueue(sessionId)
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(queue().map(entry => [entry.operationId, entry.execution, entry.errorCode])).toEqual([
      ['original-immediate', 'immediate', 'AGENT_EXECUTION_NOT_REQUESTED'],
      ['original-default', 'default', 'AGENT_EXECUTION_NOT_REQUESTED'],
      ['historical-undefined', undefined, 'AGENT_EXECUTION_NOT_REQUESTED']
    ])
    await store.getState().sendQueuedAgentSteer(sessionId, 'original-default')
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => [call[2], call[4]])).toEqual([
      ['original-default', { allowUncertainTurn: true }]
    ])
    await store.getState().sendQueuedAgentSteer(sessionId, 'historical-undefined')
    expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
    expect(queue().find(entry => entry.operationId === 'historical-undefined')?.execution).toBeUndefined()
  })
})
