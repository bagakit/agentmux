import { describe, expect, it, vi } from 'vitest'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

function session(run = 'run-1'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: run },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',

    createdAt: 100,
    updatedAt: 100
  }
}

describe('semantic session registry concurrency', () => {
  it('does not confuse a user-retired Session with abandoned or other Session Runs', async () => {
    const registry = new AgentMuxAgentSessionRegistry(new AgentMuxMemoryAgentSessionStore())
    const current = session()
    await registry.put(current)
    const stop = await registry.reserveExisting(
      'stop',
      current.agentSessionId,
      current.run,
      'stop-operation',
      {
        daemonInstance: 'daemon-instance',
        operationKey: 'stop-operation',
        runId: current.run.runId
      }
    )
    await registry.commitLifecycle(stop, null)

    expect(registry.retiredAgentSession(current.agentSessionId, current.run)).toMatchObject({
      agentSessionId: current.agentSessionId,
      run: current.run,
      source: 'user'
    })
    expect(registry.retiredAgentSession('another-session', current.run)).toBeUndefined()
    expect(registry.retiredAgentSession(current.agentSessionId, { runId: 'abandoned-run' }))
      .toBeUndefined()
  })

  it('refreshes the target binding from another Client without writing or replacing unrelated projections', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const reader = new AgentMuxAgentSessionRegistry(store), writer = new AgentMuxAgentSessionRegistry(store)
    await reader.put(session())
    const unrelated = { ...session('unrelated-run'), agentSessionId: 'unrelated',
      hookBindingId: 'unrelated-hook', hookToken: 'unrelated-token' }
    await reader.put(unrelated)
    const cachedUnrelated = reader.get('unrelated')
    await writer.load('local')
    await writer.update('semantic-1', { runId: 'run-1' }, current => ({ ...current,
      updatedAt: 200, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 200 } }))
    const writes = vi.spyOn(store, 'compareAndSwap')
    try {
      await expect(reader.refresh('semantic-1', { runId: 'run-1' })).resolves.toMatchObject({
        semanticStatus: { state: 'working', observedAt: 200 }
      })
      expect(writes).not.toHaveBeenCalled()
      expect(reader.get('unrelated')).toBe(cachedUnrelated)
      expect(reader.list().map(value => [value.agentSessionId, value.run.runId])).toEqual([
        ['semantic-1', 'run-1'], ['unrelated', 'unrelated-run']
      ])
    } finally { writes.mockRestore() }
  })

  it('keeps the known binding when an empty Store read cannot confirm it', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const registry = new AgentMuxAgentSessionRegistry(store)
    await registry.put(session())
    const known = registry.get('semantic-1')
    const read = vi.spyOn(store, 'load').mockResolvedValueOnce([])
    try {
      await expect(registry.refresh('semantic-1', { runId: 'run-1' }))
        .rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
      expect(registry.get('semantic-1')).toBe(known)
      expect(registry.list()).toEqual([known])
      await expect(registry.refresh('semantic-1', { runId: 'run-1' })).resolves.toEqual(known)
    } finally { read.mockRestore() }
  })

  it('merges serialized control-state updates from the latest CAS value', async () => {
    const registry = new AgentMuxAgentSessionRegistry(new AgentMuxMemoryAgentSessionStore())
    await registry.put(session())
    await registry.update('semantic-1', { runId: 'run-1' }, (current) => ({
      ...current,
      terminalHandshake: {
        run: { ...current.run },
        operationId: 'handshake-operation',
        inputByteRange: { startByte: 0, endByte: 5 },
        acknowledged: false
      }
    }))
    await registry.update('semantic-1', { runId: 'run-1' }, (current) => ({
      ...current,
      hookReceipt: {
        id: 'hook-receipt',
        providerId: current.providerId,
        agentSessionId: current.agentSessionId,
        run: { ...current.run },
        eventName: 'SessionStart',
        observedAt: 200
      }
    }))

    expect(registry.get('semantic-1')).toMatchObject({
      terminalHandshake: {
        inputByteRange: { startByte: 0, endByte: 5 },
        acknowledged: false
      },
      hookReceipt: { id: 'hook-receipt' }
    })
  })

  it('serializes persistence and rejects an old run update after a resume transition', async () => {
    const memory = new AgentMuxMemoryAgentSessionStore()
    let enteredTransition!: () => void
    let releaseTransition!: () => void
    const transitionEntered = new Promise<void>((resolve) => { enteredTransition = resolve })
    const transitionRelease = new Promise<void>((resolve) => { releaseTransition = resolve })
    const store: AgentMuxAgentSessionStore = {
      withPromptSubmission: (id, operation) => memory.withPromptSubmission(id, operation),
      async load() { return await memory.load() },
      async loadRetiredRuns() { return await memory.loadRetiredRuns() },
      async loadRetiredAgentSessions() { return await memory.loadRetiredAgentSessions() },
      async compareAndSwap(expected, next) {
        if (next?.run.runId === 'run-2') {
          enteredTransition()
          await transitionRelease
        }
        await memory.compareAndSwap(expected, next)
      },
      async reserveLifecycle(value) { await memory.reserveLifecycle(value) },
      async claimStaleLifecycles(value) { return await memory.claimStaleLifecycles(value) },
      async releaseLifecycle(value) { await memory.releaseLifecycle(value) },
      async retireRuns(value) { await memory.retireRuns(value) },
      async commitLifecycle(value, next) { await memory.commitLifecycle(value, next) },
      async loadTimeline(agentSessionId) { return await memory.loadTimeline(agentSessionId) },
      async applyTimelineMutation(value, signal) { return await memory.applyTimelineMutation(value, signal) }
    }
    const registry = new AgentMuxAgentSessionRegistry(store)
    const original = session()
    const resumed = { ...original, run: session('run-2').run, updatedAt: 200 }
    await registry.put(original)

    const transition = registry.put(resumed, original.run)
    await transitionEntered
    const staleUpdate = registry.put({ ...original, updatedAt: 142 }, original.run)
    releaseTransition()

    await transition
    await expect(staleUpdate).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(registry.get('semantic-1')).toEqual(resumed)
    expect(await memory.load()).toEqual([resumed])
  })

  it('cancels only the queued Hook write without aborting its active predecessor', async () => {
    const memory = new AgentMuxMemoryAgentSessionStore()
    let block = false
    let blocked!: () => void
    const entered = new Promise<void>((resolve) => { blocked = resolve })
    let releaseActive!: () => void
    const released = new Promise<void>((resolve) => { releaseActive = resolve })
    let compareCalls = 0
    const store: AgentMuxAgentSessionStore = {
      withPromptSubmission: (id, operation) => memory.withPromptSubmission(id, operation),
      async load() { return await memory.load() },
      async loadRetiredRuns() { return await memory.loadRetiredRuns() },
      async loadRetiredAgentSessions() { return await memory.loadRetiredAgentSessions() },
      async compareAndSwap(expected, next, signal) {
        compareCalls += 1
        if (block) {
          blocked()
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => reject(signal?.reason)
            signal?.addEventListener('abort', abort, { once: true })
            void released.then(() => {
              signal?.removeEventListener('abort', abort)
              resolve()
            })
          })
        }
        await memory.compareAndSwap(expected, next, signal)
      },
      async reserveLifecycle(value) { await memory.reserveLifecycle(value) },
      async claimStaleLifecycles(value) { return await memory.claimStaleLifecycles(value) },
      async releaseLifecycle(value) { await memory.releaseLifecycle(value) },
      async retireRuns(value) { await memory.retireRuns(value) },
      async commitLifecycle(value, next) { await memory.commitLifecycle(value, next) },
      async loadTimeline(agentSessionId) { return await memory.loadTimeline(agentSessionId) },
      async applyTimelineMutation(value, signal) { return await memory.applyTimelineMutation(value, signal) }
    }
    const registry = new AgentMuxAgentSessionRegistry(store)
    await registry.put(session())
    block = true
    const active = registry.update('semantic-1', { runId: 'run-1' }, (current) => ({
      ...current,
      updatedAt: 101
    }))
    let activeSettled = false
    void active.then(
      () => { activeSettled = true },
      () => { activeSettled = true }
    )
    await entered
    const controller = new AbortController()
    const queued = registry.update('semantic-1', { runId: 'run-1' }, (current) => ({
      ...current,
      updatedAt: 102
    }), controller.signal)
    const following = registry.update('semantic-1', { runId: 'run-1' }, (current) => ({
      ...current,
      updatedAt: 103
    }))
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(activeSettled).toBe(false)
    block = false
    releaseActive()
    await expect(active).resolves.toMatchObject({ updatedAt: 101 })
    await expect(following).resolves.toMatchObject({ updatedAt: 103 })
    expect(compareCalls).toBe(3)
    expect(registry.get('semantic-1').updatedAt).toBe(103)
    expect((await memory.load())[0]).toMatchObject({ updatedAt: 103 })
  })
})
