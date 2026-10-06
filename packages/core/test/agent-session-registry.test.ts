import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { metadataTestRuntime } from './helpers/metadata-test-runtime.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
const { AgentMuxError, AgentMuxAgentSessionRegistry, AgentMuxMemoryAgentSessionStore, AgentMuxSessionDurabilityError } = metadataTestRuntime

function session(run = 'run-1'): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: fixturePath("tmp/work"),
    run: { runId: run },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',

    createdAt: reshapeFixtureEpoch(0, 0, 100),
    updatedAt: reshapeFixtureEpoch(0, 0, 100)
  }
}

describe('semantic session registry concurrency', () => {
  it.each(['stop', 'delete'] as const)('a cold absent binding cannot return after exact admission and accepted %s', async shape => {
    const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store)
    const original = { ...session(), nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'cold-original-native-handle' } }
    await store.compareAndSwap(null, original)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
    const read = store.loadMetadata.bind(store)
    vi.spyOn(store, 'loadMetadata').mockImplementationOnce(async () => { const snapshot = await read(); entered(); await held; return snapshot })
    const loading = registry.load('local')
    await reading
    expect(registry.has(original.agentSessionId)).toBe(false)
    await registry.resolveMetadata(original.agentSessionId, 'local', () => {})
    if (shape === 'delete') await registry.delete(original.agentSessionId, original.run)
    else {
      const stop = await registry.reserveExisting('stop', original.agentSessionId, original.run, 'cold-stop', {
        daemonInstance: 'cold-native-epoch', operationKey: 'cold-stop', runId: original.run.runId
      })
      await registry.commitLifecycle(stop, null)
    }
    expect(await store.readMetadata(original.agentSessionId)).toBeNull()
    expect(registry.has(original.agentSessionId)).toBe(false)
    release(); await loading
    expect(registry.has(original.agentSessionId), 'an absent→admit→remove→absent owner cut must not resurrect the old active binding').toBe(false)
    if (shape === 'stop') expect(registry.retiredAgentSession(original.agentSessionId, original.run))
      .toMatchObject({ history: { nativeHandle: original.nativeHandle } })
  })

  it('a cold retirement and unbound prefix cannot return after accepted exact reopen', async () => {
    const store = new AgentMuxMemoryAgentSessionStore(), writer = new AgentMuxAgentSessionRegistry(store), original = session()
    await writer.put(original)
    const stop = await writer.reserveExisting('stop', original.agentSessionId, original.run, 'seed-stop', {
      daemonInstance: 'seed-native-epoch', operationKey: 'seed-stop', runId: original.run.runId
    })
    await writer.commitLifecycle(stop, null)
    const retirement = writer.retiredAgentSession(original.agentSessionId, original.run)!
    const registry = new AgentMuxAgentSessionRegistry(store)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
    const read = store.loadRetiredRuns.bind(store)
    vi.spyOn(store, 'loadRetiredRuns').mockImplementationOnce(async () => { const snapshot = await read(); entered(); await held; return snapshot })
    const loading = registry.load('local')
    await reading
    await registry.retireRuns([original.run])
    const reopen = await registry.reserveReopen(original.agentSessionId, retirement.observedAt, 'cold-reopen', 'cold-reopen-caller')
    const next = { ...original, run: { runId: 'cold-reopened-run' }, retiredRuns: [original.run],
      reopenedFrom: { run: retirement.run, source: retirement.source, observedAt: retirement.observedAt } }
    await registry.commitLifecycle(reopen, next)
    release(); await loading
    expect(registry.retiredAgentSession(original.agentSessionId, original.run), 'a cold retired read must not restore the retirement removed by exact reopen').toBeUndefined()
    await expect(registry.update(original.agentSessionId, next.run, value => ({ ...value, updatedAt: reshapeFixtureEpoch(0, 0, 101) })),
      'an absent→retire→reopen→absent unbound prefix must remain owned by the reopened Session')
      .resolves.toMatchObject({ run: next.run })
  })

  it('two pending cold reads both preserve the exact accepted removal', async () => {
    const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store), original = session()
    await store.compareAndSwap(null, original)
    const release: Array<() => void> = [], entered: Array<Promise<void>> = []
    const read = store.loadMetadata.bind(store)
    for (let index = 0; index < 2; index++) {
      let begin!: () => void
      entered.push(new Promise<void>(resolve => { begin = resolve }))
      const held = new Promise<void>(resolve => { release.push(resolve) })
      vi.spyOn(store, 'loadMetadata').mockImplementationOnce(async () => { const snapshot = await read(); begin(); await held; return snapshot })
    }
    const first = registry.load('local'); await entered[0]
    const second = registry.load('local'); await entered[1]
    await registry.resolveMetadata(original.agentSessionId, 'local', () => {})
    await registry.delete(original.agentSessionId, original.run)
    release[0]!(); await first
    expect(registry.has(original.agentSessionId)).toBe(false)
    release[1]!(); await second
    expect(registry.has(original.agentSessionId), 'each original read must preserve the accepted removal even after another read publishes').toBe(false)
    expect(await store.readMetadata(original.agentSessionId)).toBeNull()
  })

  it.each(['success', 'store-error', 'epoch-error'] as const)('releases the original read cut after %s', async shape => {
    const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store), original = session()
    await store.compareAndSwap(null, original)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
    const read = store.loadMetadata.bind(store)
    vi.spyOn(store, 'loadMetadata').mockImplementationOnce(async () => {
      const snapshot = await read(); entered(); await held
      if (shape === 'store-error') throw new Error('Original metadata read failed.')
      return snapshot
    })
    let current = true
    const loading = registry.load('local', () => { if (!current) throw new AgentMuxError('Read epoch changed.', 'CTXMUX_DISCONNECTED') })
    const outcome = loading.then(() => ({ ok: true }), error => ({ error }))
    await reading
    const cuts = Reflect.get(registry, 'metadataLoadCuts') as Set<unknown>
    expect(cuts.size).toBe(1)
    await registry.resolveMetadata(original.agentSessionId, 'local', () => {})
    if (shape === 'epoch-error') current = false
    release()
    expect(await outcome).toHaveProperty(shape === 'success' ? 'ok' : 'error')
    expect(cuts.size, 'completed or failed reads must release all temporary target observations').toBe(0)
    expect(registry.get(original.agentSessionId).run).toEqual(original.run)
  })

  it.each(['stop', 'reopen'] as const)('keeps exact accepted %s identity when the original retired snapshot arrives late', async shape => {
    const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store)
    const original = { ...session(), nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native-handle' } }
    await registry.put(original)
    const stop = await registry.reserveExisting('stop', original.agentSessionId, original.run, 'original-stop', {
      daemonInstance: 'original-native-epoch', operationKey: 'original-stop', runId: original.run.runId
    })
    if (shape === 'reopen') await registry.commitLifecycle(stop, null)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
    const read = store.loadMetadata.bind(store)
    vi.spyOn(store, 'loadMetadata').mockImplementationOnce(async () => { const snapshot = await read(); entered(); await held; return snapshot })
    const loading = registry.load('local')
    await reading
    if (shape === 'stop') await registry.commitLifecycle(stop, null)
    else {
      const retirement = registry.retiredAgentSession(original.agentSessionId, original.run)!
      const reopen = await registry.reserveReopen(original.agentSessionId, retirement.observedAt, 'original-reopen', 'original-caller-reopen')
      await registry.commitLifecycle(reopen, { ...original, run: { runId: 'reopened-exact-run' }, retiredRuns: [original.run],
        reopenedFrom: { run: retirement.run, source: retirement.source, observedAt: retirement.observedAt } })
    }
    release(); await loading
    if (shape === 'stop') {
      expect(registry.retiredAgentSession(original.agentSessionId, original.run), 'the accepted Stop must retain its original native recovery address').toMatchObject({ history: { nativeHandle: original.nativeHandle } })
      expect(registry.isRetiredRun(original.run), 'the completed retirement is an exact Run fact').toBe(true)
    } else {
      expect(registry.get(original.agentSessionId).run).toEqual({ runId: 'reopened-exact-run' })
      expect(registry.retiredAgentSession(original.agentSessionId, original.run), 'the accepted reopen must cover its prior retired projection').toBeUndefined()
      // The old prefix stays retired but belongs to this current Session; the
      // stale unbound set must not reject its next exact metadata operation.
      await expect(registry.update(original.agentSessionId, { runId: 'reopened-exact-run' }, value => ({ ...value, updatedAt: reshapeFixtureEpoch(0, 0, 101) })))
        .resolves.toMatchObject({ run: { runId: 'reopened-exact-run' } })
    }
  })

  it('adopts only the missing exact metadata binding and keeps known raw access free of catalog/body reads', async () => {
    const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store), original = session()
    await store.compareAndSwap(null, original)
    const catalog = vi.spyOn(store, 'loadMetadata'), bodies = vi.spyOn(store, 'load'), read = vi.spyOn(store, 'readMetadata')
    const [first, joined] = await Promise.all([registry.resolveMetadata(original.agentSessionId, 'local', () => {}), registry.resolveMetadata(original.agentSessionId, 'local', () => {})])
    expect(first).toEqual(original); expect(joined).toEqual(original)
    await expect(registry.resolveMetadata(original.agentSessionId, 'local', () => {})).resolves.toEqual(original)
    expect(read).toHaveBeenCalledTimes(1); expect(catalog).not.toHaveBeenCalled(); expect(bodies).not.toHaveBeenCalled()
    await expect(registry.resolveMetadata(original.agentSessionId, 'foreign-host', () => {})).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    await expect(registry.resolveMetadata('really-absent-session', 'local', () => {})).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each(['epoch', 'new-binding'] as const)('a late missing-binding read cannot publish after %s takes ownership', async shape => {
    const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store), original = session()
    await store.compareAndSwap(null, original)
    let release!: () => void, entered!: () => void, current = true
    const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
    let releaseCatalog!: () => void, catalogEntered!: () => void
    const catalogHeld = new Promise<void>(resolve => { releaseCatalog = resolve }), catalogReading = new Promise<void>(resolve => { catalogEntered = resolve })
    const catalog = store.loadMetadata.bind(store)
    // The original global read starts before the exact queue acquires its turn.
    // Its drain snapshot is therefore empty; both real readers can finish independently.
    vi.spyOn(store, 'loadMetadata').mockImplementationOnce(async () => { catalogEntered(); await catalogHeld; return await catalog() })
    const loading = shape === 'new-binding' ? registry.load('local') : undefined
    if (loading) await catalogReading
    const read = store.readMetadata.bind(store)
    vi.spyOn(store, 'readMetadata').mockImplementationOnce(async id => { const snapshot = await read(id); entered(); await held; return snapshot })
    const pending = registry.resolveMetadata(original.agentSessionId, 'local', () => { if (!current) throw new AgentMuxError('Original Native observation epoch changed.', 'CTXMUX_DISCONNECTED') })
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await reading
    if (shape === 'epoch') current = false
    else {
      await store.compareAndSwapMetadata(original, { ...original, run: { runId: 'later-current-run' } })
      releaseCatalog(); await loading
    }
    release()
    if (shape === 'epoch') { expect(await outcome).toMatchObject({ error: { code: 'CTXMUX_DISCONNECTED' } }); expect(registry.has(original.agentSessionId)).toBe(false) }
    else { expect(await outcome).toMatchObject({ value: { run: { runId: 'later-current-run' } } }); expect(registry.get(original.agentSessionId).run).toEqual({ runId: 'later-current-run' }) }
  })

  it.each(['binding', 'deleted', 'durability'] as const)('a late full metadata snapshot cannot replace the current exact subject (%s)', async shape => {
    const store = new AgentMuxMemoryAgentSessionStore(), registry = new AgentMuxAgentSessionRegistry(store)
    const original = session()
    await registry.put(original)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
    const load = store.loadMetadata.bind(store)
    vi.spyOn(store, 'loadMetadata').mockImplementationOnce(async () => { const snapshot = await load(); entered(); await held; return snapshot })
    const pending = registry.load('local')
    await reading
    const next = { ...original, run: { runId: 'current-exact-run' }, retiredRuns: [original.run], updatedAt: reshapeFixtureEpoch(0, 0, 100) }
    if (shape === 'deleted') await registry.delete(original.agentSessionId, original.run)
    else if (shape === 'durability') {
      vi.spyOn(store, 'compareAndSwapMetadata').mockRejectedValueOnce(new AgentMuxSessionDurabilityError(new Error('Private commit outcome unknown.'), 'unknown'))
      await expect(registry.put(next, original.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED' })
      expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(true)
    } else await registry.put(next, original.run)
    release(); await pending
    if (shape === 'deleted') expect(registry.has(original.agentSessionId), 'a completed exact retirement must not be revived by the old read').toBe(false)
    else {
      expect(registry.get(original.agentSessionId).run, 'the completed original metadata turn must not be rolled back').toEqual(next.run)
      if (shape === 'durability') expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(true)
    }
  })

  it('confirms original metadata through the real Registry without loading or losing retained future facts', async () => {
    const store = new AgentMuxMemoryAgentSessionStore(), original = { ...session(), futurePromptIntents: {
      retained: { operationId: 'retained-save', prompt: 'original', active: true, message: { userContent: 'original' } }
    } }
    await store.compareAndSwap(null, original)
    const registry = new AgentMuxAgentSessionRegistry(store); await registry.load('local')
    expect(registry.get(original.agentSessionId)).not.toHaveProperty('futurePromptIntents')
    const fullReads = vi.spyOn(store, 'load')
    await expect(registry.confirmDurability(original.agentSessionId, original.run)).resolves.toMatchObject({ run: original.run })
    expect(fullReads).not.toHaveBeenCalled()
    expect(await store.readFuturePromptIntent(original.agentSessionId, 'retained')).toEqual(original.futurePromptIntents.retained)
    expect(await store.load()).toEqual([original])
  })

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
      updatedAt: reshapeFixtureEpoch(0, 0, 200), semanticStatus: { state: 'working', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 200) } }))
    const writes = vi.spyOn(store, 'compareAndSwap')
    try {
      await expect(reader.refresh('semantic-1', { runId: 'run-1' })).resolves.toMatchObject({
        semanticStatus: { state: 'working', observedAt: reshapeFixtureEpoch(0, 0, 200) }
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
    const read = vi.spyOn(store, 'readMetadata').mockResolvedValueOnce(null)
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
        observedAt: reshapeFixtureEpoch(0, 0, 200)
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
      confirmDurability: (id, run, expected) => memory.confirmDurability(id, run, expected),
      async load() { return await memory.load() },
      loadMetadata: memory.loadMetadata.bind(memory),
      readMetadata: memory.readMetadata.bind(memory),
      readHistorySource: memory.readHistorySource.bind(memory),
      readFuturePromptIntent: memory.readFuturePromptIntent.bind(memory),
      listFuturePromptIntents: memory.listFuturePromptIntents.bind(memory),
      loadCreationSessionId: memory.loadCreationSessionId.bind(memory),
      loadCreationCorrelation: memory.loadCreationCorrelation.bind(memory),
      prepareCreate: memory.prepareCreate.bind(memory),
      claimCreate: memory.claimCreate.bind(memory),
      prepareReopen: memory.prepareReopen.bind(memory),
      releaseReopenOwner: memory.releaseReopenOwner.bind(memory),
      claimReopen: memory.claimReopen.bind(memory),
      async loadRetiredRuns() { return await memory.loadRetiredRuns() },
      async loadRetiredAgentSessions() { return await memory.loadRetiredAgentSessions() },
      async loadReopenCorrelations() { return await memory.loadReopenCorrelations() },
      compareAndSwap: memory.compareAndSwap.bind(memory),
      async compareAndSwapMetadata(expected, next) {
        if (next?.run.runId === 'run-2') {
          enteredTransition()
          await transitionRelease
        }
        await memory.compareAndSwapMetadata(expected, next)
      },
      async reserveLifecycle(value) { await memory.reserveLifecycle(value) },
      async claimStaleLifecycles(value, target) { return await memory.claimStaleLifecycles(value, target) },
      async releaseLifecycle(value) { await memory.releaseLifecycle(value) },
      async retireRuns(value) { await memory.retireRuns(value) },
      async commitLifecycle(value, next) { await memory.commitLifecycle(value, next) },
      async loadTimeline(agentSessionId) { return await memory.loadTimeline(agentSessionId) },
      async applyTimelineMutation(value, signal) { return await memory.applyTimelineMutation(value, signal) }
    }
    const registry = new AgentMuxAgentSessionRegistry(store)
    const original = session()
    const resumed = { ...original, run: session('run-2').run, updatedAt: reshapeFixtureEpoch(0, 0, 200) }
    await registry.put(original)

    const transition = registry.put(resumed, original.run)
    await transitionEntered
    const staleUpdate = registry.put({ ...original, updatedAt: reshapeFixtureEpoch(0, 0, 142) }, original.run)
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
      confirmDurability: (id, run, expected) => memory.confirmDurability(id, run, expected),
      async load() { return await memory.load() },
      loadMetadata: memory.loadMetadata.bind(memory),
      readMetadata: memory.readMetadata.bind(memory),
      readHistorySource: memory.readHistorySource.bind(memory),
      readFuturePromptIntent: memory.readFuturePromptIntent.bind(memory),
      listFuturePromptIntents: memory.listFuturePromptIntents.bind(memory),
      loadCreationSessionId: memory.loadCreationSessionId.bind(memory),
      loadCreationCorrelation: memory.loadCreationCorrelation.bind(memory),
      prepareCreate: memory.prepareCreate.bind(memory),
      claimCreate: memory.claimCreate.bind(memory),
      prepareReopen: memory.prepareReopen.bind(memory),
      releaseReopenOwner: memory.releaseReopenOwner.bind(memory),
      claimReopen: memory.claimReopen.bind(memory),
      async loadRetiredRuns() { return await memory.loadRetiredRuns() },
      async loadRetiredAgentSessions() { return await memory.loadRetiredAgentSessions() },
      async loadReopenCorrelations() { return await memory.loadReopenCorrelations() },
      async compareAndSwap(expected, next, signal) { compareCalls += 1; await memory.compareAndSwap(expected, next, signal) },
      async compareAndSwapMetadata(expected, next, signal) {
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
        await memory.compareAndSwapMetadata(expected, next, signal)
      },
      async reserveLifecycle(value) { await memory.reserveLifecycle(value) },
      async claimStaleLifecycles(value, target) { return await memory.claimStaleLifecycles(value, target) },
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
      updatedAt: reshapeFixtureEpoch(0, 0, 101)
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
      updatedAt: reshapeFixtureEpoch(0, 0, 102)
    }), controller.signal)
    const following = registry.update('semantic-1', { runId: 'run-1' }, (current) => ({
      ...current,
      updatedAt: reshapeFixtureEpoch(0, 0, 103)
    }))
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(activeSettled).toBe(false)
    block = false
    releaseActive()
    await expect(active).resolves.toMatchObject({ updatedAt: reshapeFixtureEpoch(0, 0, 101) })
    await expect(following).resolves.toMatchObject({ updatedAt: reshapeFixtureEpoch(0, 0, 103) })
    expect(compareCalls).toBe(3)
    expect(registry.get('semantic-1').updatedAt).toBe(reshapeFixtureEpoch(0, 0, 103))
    expect((await memory.load())[0]).toMatchObject({ updatedAt: reshapeFixtureEpoch(0, 0, 103) })
  })
})
