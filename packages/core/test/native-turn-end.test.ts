import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { fixturePath } from './helpers/fixture-values.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { nativeTurnEndFixture } from './fixtures/native-turn-end.js'
import type { AgentProviderSessionStatus } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const ends: Array<Pick<AgentProviderSessionStatus, 'state' | 'endReason'>> = [
  { state: 'done' }, { state: 'error' }, { state: 'unknown', endReason: 'interrupted' }
]

it.each(ends)('retains exact $state end before original Hook adoption and refuses only that response', async end => {
  const h = await nativeTurnEndFixture()
  try {
    await h.observe({ ...end, recordId: 'original-end', nativeTurnId: 'turn-original', nativeObservedAt: _historyFixtureEpoch(0, 0, 17) })
    const { pending } = await h.open('late-hook')
    const result = await h.client.respondAgentInteraction(h.input('late-hook')).then(() => null, error => error)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    const request = h.read('late-hook')
    expect(request?.kind === 'permission' && request.permissionHook?.nativeTurnEnded).toMatchObject({ recordId: 'original-end' })
    expect(h.client.agentSession('recipient')).toMatchObject({ agentSessionId: 'recipient', run: { runId: 'run-recipient' } })
    await h.binding.close(); expect(await (await pending).json()).toEqual({})
  } finally { await h.close() }
})

it.each(ends)('retains exact $state end after original Hook adoption', async end => {
  const h = await nativeTurnEndFixture()
  try {
    const { pending } = await h.open('adopted-hook')
    await h.observe({ ...end, recordId: 'adopted-end', nativeTurnId: 'turn-original' })
    const result = await h.client.respondAgentInteraction(h.input('adopted-hook')).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    expect((await h.store.readMetadata('recipient'))!.nativeTurnEnds?.turns['turn-original']).toMatchObject({ recordId: 'adopted-end' })
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    await h.binding.close(); expect(await (await pending).json()).toEqual({})
  } finally { await h.close() }
})

it.each(['unknown', 'working'] as const)('keeps a healthy original callback answerable after only $state', async state => {
  const h = await nativeTurnEndFixture()
  try {
    await h.observe({ state, recordId: 'unconfirmed', nativeTurnId: 'turn-original' })
    const { pending } = await h.open('healthy-hook')
    expect((await h.store.readMetadata('recipient'))!).not.toHaveProperty('nativeTurnEnds')
    await h.client.respondAgentInteraction(h.input('healthy-hook'))
    expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('retains each exact turn end through unknown and later activity on another turn', async () => {
  const h = await nativeTurnEndFixture()
  try {
    await h.observe({ state: 'done', recordId: 'first-end', nativeTurnId: 'turn-original', nativeObservedAt: _historyFixtureEpoch(0, 0, 11) })
    await h.observe({ state: 'unknown', recordId: 'gap', nativeTurnId: 'turn-original' })
    await h.observe({ state: 'working', recordId: 'next-working', nativeTurnId: 'next-turn' })
    await h.observe({ state: 'done', recordId: 'next-end', nativeTurnId: 'next-turn', nativeObservedAt: _historyFixtureEpoch(0, 0, 19) })
    const retained = (await h.store.readMetadata('recipient'))!.nativeTurnEnds!
    expect(retained.turns['turn-original']).toMatchObject({ recordId: 'first-end', nativeObservedAt: _historyFixtureEpoch(0, 0, 11) })
    expect(retained.turns['next-turn']).toMatchObject({ recordId: 'next-end', nativeObservedAt: _historyFixtureEpoch(0, 0, 19) })
    expect(h.client.agentSession('recipient').semanticStatus?.nativeTurnId).toBe('next-turn')
    const { pending } = await h.open('late-original')
    const result = await h.client.respondAgentInteraction(h.input('late-original')).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    await h.binding.close(); expect(await (await pending).json()).toEqual({})
  } finally { await h.close() }
})

it('keeps a suppressed old turn end without replacing the newer Hook current display or callback', async () => {
  const h = await nativeTurnEndFixture()
  try {
    await h.observe({ state: 'working', recordId: 'new-working', nativeTurnId: 'new-turn' })
    const { pending: newer } = await h.open('newer-hook', 'new-turn')
    const originalStatus = h.client.agentSession('recipient').semanticStatus
    expect((Reflect.get(h.client, 'hookTurnPhases') as Map<string, string>).get('run-recipient')).toBe('in-turn')
    await h.observe({ state: 'done', recordId: 'old-end', nativeTurnId: 'turn-original', nativeObservedAt: _historyFixtureEpoch(0, 0, 1) })
    expect(h.client.agentSession('recipient').semanticStatus).toEqual(originalStatus)
    expect((await h.store.readMetadata('recipient'))!.nativeTurnEnds?.turns['turn-original']?.recordId).toBe('old-end')
    const { pending: older } = await h.open('suppressed-old-hook')
    const result = await h.client.respondAgentInteraction(h.input('suppressed-old-hook')).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    await h.client.respondAgentInteraction(h.input('newer-hook'))
    expect(await (await newer).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
    await h.binding.close(); expect(await (await older).json()).toEqual({})
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it.each(['run', 'provider', 'subject', 'source'] as const)('does not borrow a retained end from another %s scope', async scope => {
  const h = await nativeTurnEndFixture()
  try {
    await h.observe({ state: 'done', recordId: 'other-scope-end', nativeTurnId: 'turn-original' })
    await h.change(session => {
      const ends = session.nativeTurnEnds!
      return { ...session, nativeTurnEnds: { ...ends,
        ...(scope === 'run' ? { run: { runId: 'previous-run' } } : {}),
        ...(scope === 'provider' ? { providerId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-original' } } : {}),
        ...(scope === 'subject' ? { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'another-native' } } : {}),
        ...(scope === 'source' ? { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-original', transcriptPath: join(h.root, 'other-source') } } : {}) } }
    })
    const { pending } = await h.open('current-scope-hook')
    const request = h.read('current-scope-hook')
    expect(request?.kind === 'permission' ? request.permissionHook?.nativeTurnEnded : undefined).toBeUndefined()
    const result = await h.client.respondAgentInteraction(h.input('current-scope-hook')).then(() => null, error => error)
    expect(result).toBeNull()
    expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('ignores the original observer after its exact native source changes', async () => {
  const h = await nativeTurnEndFixture(), originalObserver = h.observers[0]!
  try {
    const handle = { kind: 'provider', providerId: 'codex', sessionId: 'native-original', transcriptPath: join(h.root, 'next-source') } as const
    h.witness(handle); await h.change(session => ({ ...session, nativeHandle: handle }))
    await h.observe({ state: 'done', recordId: 'stale-source-end', nativeTurnId: 'turn-original' }, originalObserver)
    expect((await h.store.readMetadata('recipient'))!).not.toHaveProperty('nativeTurnEnds')
    const { pending } = await h.open('new-source-hook')
    await h.client.respondAgentInteraction(h.input('new-source-hook'))
    expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  } finally { await h.close() }
})

it('does not lend a different turn end to a still-open original callback', async () => {
  const h = await nativeTurnEndFixture()
  try {
    await h.observe({ state: 'error', recordId: 'foreign-turn-end', nativeTurnId: 'foreign-turn' })
    const { pending } = await h.open('another-turn-hook')
    const request = h.read('another-turn-hook')
    expect(request?.kind === 'permission' ? request.permissionHook?.nativeTurnEnded : undefined).toBeUndefined()
    const result = await h.client.respondAgentInteraction(h.input('another-turn-hook')).then(() => null, error => error)
    expect(result).toBeNull()
    expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  } finally { await h.close() }
})

it('rechecks the durable end immediately before effect even without a request annotation', async () => {
  const h = await nativeTurnEndFixture()
  try {
    const { pending } = await h.open('effect-hook'), input = h.input('effect-hook')
    let inserted = false
    const dispatch = vi.spyOn(h.server, 'respondPermission')
    const result = await h.client.respondAgentInteraction(input, { assertCurrent: async () => {
      const request = h.read('effect-hook')
      if (inserted || request?.kind !== 'permission' || request.permissionHook?.response?.delivery !== 'unknown') return
      inserted = true
      await h.observe({ state: 'done', recordId: 'effect-end', nativeTurnId: 'turn-original' })
      // Isolate the final fact lookup from the already-proved request annotation.
      await h.change(session => {
        const request = session.pendingInteraction!.request
        if (request.kind !== 'permission' || !request.permissionHook) throw new Error('Missing original permission fixture.')
        const { nativeTurnEnded: _annotation, ...permissionHook } = request.permissionHook
        return { ...session, pendingInteraction: { ...session.pendingInteraction!, request: { ...request, permissionHook } } }
      })
    } }).then(() => null, error => error)
    expect(inserted).toBe(true)
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await (await pending).json()).toEqual({})
    expect(await h.client.inspectAgentInteractionOperation(input)).toMatchObject({ delivery: 'saved', nativeAdoption: 'unknown' })
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('keeps the internal fact strict, private and distinct from optional Provider time', async () => {
  const h = await nativeTurnEndFixture()
  try {
    await h.observe({ state: 'done', recordId: 'untimed-end', nativeTurnId: 'turn-original' })
    const stored = (await h.store.readMetadata('recipient'))!
    expect(stored.nativeTurnEnds!.turns['turn-original']).toHaveProperty('observedAt', expect.any(Number))
    expect(stored.nativeTurnEnds!.turns['turn-original']).not.toHaveProperty('nativeObservedAt')
    expect(h.client.agentSession('recipient')).not.toHaveProperty('nativeTurnEnds')
    const invalid = (nativeTurnEnds: unknown) => normalizeStoredAgentSession({ ...stored, nativeTurnEnds })
    for (const value of [
      { ...stored.nativeTurnEnds, surprise: true },
      { ...stored.nativeTurnEnds, run: { runId: 'run-recipient', extra: true } },
      { ...stored.nativeTurnEnds, nativeHandle: { ...stored.nativeTurnEnds!.nativeHandle, extra: true } },
      { ...stored.nativeTurnEnds, turns: { 'turn-original': { recordId: 'end', observedAt: _historyFixtureEpoch(0, 0, -1) } } },
      { ...stored.nativeTurnEnds, turns: { 'turn-original': { recordId: 'end', observedAt: _historyFixtureEpoch(0, 0, 1), nativeObservedAt: 'missing' } } },
      { ...stored.nativeTurnEnds, turns: { 'turn-original': { recordId: 'end', observedAt: _historyFixtureEpoch(0, 0, 1), guessed: true } } }
    ]) expect(() => invalid(value)).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_STORE' }))
  } finally { await h.close() }
})

it('the actual Hosted SDK and compiled CLI consume the same late-end refusal and original operation', async () => {
  const h = await nativeTurnEndFixture()
  const owner = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients, hostedRuntime: () => owner })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false })
  try {
    await h.observe({ state: 'done', recordId: 'public-end', nativeTurnId: 'turn-original' })
    const { pending } = await h.open('public-late-hook'), input = h.input('public-late-hook')
    const result = await hosted.respondAgentInteraction(input).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    expect(await hosted.inspectAgentInteractionOperation(input)).toMatchObject({ operationId: input.operationId, delivery: 'saved', nativeAdoption: 'unknown' })
    const inputPath = join(h.root, 'response.json'); await writeFile(inputPath, JSON.stringify(input))
    const cli = await runCompiledObjectCli(['agent', 'interaction', 'respond', '--input', inputPath], objectCliEnvironment(h.root))
    expect(cli.code, cli.stderr).not.toBe(0)
    expect(JSON.parse(cli.stderr)).toMatchObject({ error: { code: 'AGENT_INTERACTION_UNCONFIRMED' } })
    const inspected = await runCompiledObjectCli(['agent', 'interaction', 'inspect', '--session', 'recipient', '--operation-id', input.operationId], objectCliEnvironment(h.root))
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout).result.receipt).toMatchObject({ operationId: input.operationId, delivery: 'saved' })
    expect(h.client.agentSession('recipient')).not.toHaveProperty('nativeTurnEnds')
    await h.binding.close(); expect(await (await pending).json()).toEqual({})
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await hosted.dispose(); await rpc.dispose(); await server.stop(); await owner.dispose(); await h.close() }
})

it('keeps an unknown original response inspectable without replay after its exact end arrives', async () => {
  const h = await nativeTurnEndFixture()
  try {
    const { pending } = await h.open('unknown-hook'), input = h.input('unknown-hook')
    const original = h.server.respondPermission.bind(h.server)
    const dispatch = vi.spyOn(h.server, 'respondPermission').mockImplementation(async (...args) => {
      await original(...args); throw Object.assign(new Error('Original receipt unavailable.'), { code: 'RECEIPT_UNAVAILABLE' })
    })
    const first = await h.client.respondAgentInteraction(input).then(() => null, error => error)
    expect(first).toMatchObject({ code: 'RECEIPT_UNAVAILABLE' })
    expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
    await h.observe({ state: 'done', recordId: 'unknown-response-end', nativeTurnId: 'turn-original' })
    for (let index = 0; index < 2; index++) expect(await h.client.inspectAgentInteractionOperation(input)).toMatchObject({ delivery: 'unknown', nativeAdoption: 'unknown' })
    const repeat = await h.client.respondAgentInteraction(input).then(() => null, error => error)
    expect(repeat).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('a real isolated Node writer and fresh reader retain the exact end and original callback refusal', async () => {
  const root = await mkdtemp(fixturePath('tmp/native-end-restart-'))
  const script = fileURLToPath(new URL('./fixtures/native-turn-end-process.mjs', import.meta.url))
  const invoke = async (mode: string) => {
    const result = await promisify(execFile)(process.execPath, [script, mode, root], { env: objectCliEnvironment(root), timeout: 15_000 })
    return JSON.parse(result.stdout)
  }
  try {
    const writer = await invoke('writer')
    expect(writer).toMatchObject({ mode: 'writer', inputCalls: 0, agentSessionId: 'durable-agent', run: { runId: 'durable-run' },
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-durable' },
      nativeTurnEnds: { run: { runId: 'durable-run' }, providerId: 'codex',
        turns: { 'durable-turn': { recordId: 'durable-end', nativeObservedAt: _historyFixtureEpoch(0, 0, 7) } } } })
    const reader = await invoke('reader')
    console.info('isolated-native-turn-end-lifecycle', JSON.stringify({ writer, reader }))
    expect(reader.pid).not.toBe(writer.pid)
    expect(reader).toMatchObject({ mode: 'reader', inputCalls: 0, publicFactLeaked: false,
      error: { code: 'AGENT_INTERACTION_UNCONFIRMED' }, body: {}, operation: { operationId: 'durable-response', delivery: 'saved', nativeAdoption: 'unknown' },
      request: { id: 'durable-hook', agentSessionId: 'durable-agent', permissionHook: { nativeSessionId: 'native-durable', nativeTurnId: 'durable-turn', nativeTurnEnded: { recordId: 'durable-end' } } } })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 25_000)

it.each([
  { state: 'done', nativeTurnId: 'turn-original', refuses: true },
  { state: 'done', nativeTurnId: 'another-turn', refuses: false },
  { state: 'unknown', nativeTurnId: 'turn-original', refuses: false },
  { state: 'working', nativeTurnId: 'turn-original', refuses: false }
] as const)('reads another Core owner after final authority wait: $state on $nativeTurnId', async observation => {
  const h = await nativeTurnEndFixture()
  const { AgentMuxClient } = await import('../src/client.js')
  const { AgentMuxFileAgentSessionStore } = await import('../src/agent-session-store.js')
  const second = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
  const inner = second as unknown as typeof h.inner
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  inner.kernel.status = vi.fn(async (id: string) => h.run(id))
  let onStatus: ((status: AgentProviderSessionStatus) => void) | undefined
  second.providers.get('codex').observeSessionStatus = async context => { onStatus = context.onStatus; return { dispose() {} } }
  let committed = false
  try {
    const { pending } = await h.open('cross-owner-hook'), input = h.input('cross-owner-hook')
    const result = await h.client.respondAgentInteraction(input, { assertCurrent: async () => {
      const request = h.read('cross-owner-hook')
      if (committed || request?.kind !== 'permission' || request.permissionHook?.response?.delivery !== 'unknown') return
      await second.statusAgent('recipient')
      if (!onStatus) throw new Error('The other original Core status observer is missing.')
      onStatus({ state: observation.state, nativeTurnId: observation.nativeTurnId, recordId: 'other-owner-end' })
      const watches = Reflect.get(second, 'nativeStatusWatches') as Map<string, { pending: Promise<void> }>
      await watches.get('recipient')!.pending
      const durable = (await h.store.readMetadata('recipient'))!
      if (observation.state === 'done') expect(durable.nativeTurnEnds?.turns[observation.nativeTurnId]?.recordId).toBe('other-owner-end')
      else expect(durable).not.toHaveProperty('nativeTurnEnds')
      const cached = h.read('cross-owner-hook')
      expect(cached?.kind === 'permission' && cached.permissionHook?.nativeTurnEnded).toBeUndefined()
      committed = true
    } }).then(value => value, error => error)
    expect(committed).toBe(true)
    if (observation.refuses) {
      expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(await (await pending).json()).toEqual({})
      expect(await h.client.inspectAgentInteractionOperation(input)).toMatchObject({ delivery: 'saved', nativeAdoption: 'unknown' })
    } else {
      expect(result).toMatchObject({ delivery: 'hook-written', nativeAdoption: 'unknown' })
      expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
    }
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await second.dispose(); await h.close() }
})
