import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentConfigurationSnapshot, AgentConfigurationObservedSnapshot } from '../src/agent-configuration.js'
import { openCodexFrontendControl, observeCodexTerminalFrontend, readCodexConfigurationControl } from '../src/providers/codex-managed-frontend.js'
import { createCodexConfigurationSource, codexConfigurationSnapshot, codexConfigurationSourceId, type CodexConfigurationCurrent, type CodexConfigurationPacket } from '../src/providers/codex-configuration-source.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(options: { oldProducer?: boolean; missingMethod?: boolean; wrongInitial?: boolean } = {}) {
  const token = randomBytes(32).toString('hex'), actorId = 'original-configuration-actor', lifecycleOperationId = 'original-lifecycle'
  const nativeSessionId = 'original-native', runtime = 'original-native-runtime'
  const source = (modelProvider = 'original-provider') => codexConfigurationSourceId({ actorId, lifecycleOperationId,
    nativeSessionId, nativeRuntimeSessionId: runtime, modelProvider })
  const packet = (sequence: number, model = 'model-original', modelProvider = 'original-provider'): CodexConfigurationPacket => ({
    state: 'confirmed', nativeSessionId, nativeRuntimeSessionId: runtime, modelProvider, model, sourceId: source(modelProvider),
    sequence, observedAt: fixtureEpoch(2) + sequence })
  let current: AgentConfigurationSnapshot | null = codexConfigurationSnapshot({ nativeSessionId, sourceId: source(), observedAt: fixtureEpoch(2) },
    'model-original', [{ value: 'model-original', name: 'Original' }, { value: 'model-selected', name: 'Selected' }])
  const events: AgentConfigurationObservedSnapshot[] = [], unavailable: Array<{ code: string; message: string; source?: unknown }> = []
  const frontend = { frontendId: 'original-frontend', state: 'attached' as const, backendState: 'running' as const,
    source: 'managed-process' as const, observedAt: fixtureEpoch(2) }
  const configurationRead = vi.fn(async (requested: string) => {
    expect(requested).toBe(nativeSessionId)
    return options.wrongInitial ? { ...packet(1), nativeSessionId: 'foreign-native' } : packet(1)
  })
  const reconnect = vi.fn(async () => { throw new Error('An observer cannot reconnect a frontend or native conversation.') })
  const producer = await openCodexFrontendControl(token, { actorId, lifecycleOperationId, processId: process.pid }, {
    current: () => frontend, reconnect, ...(options.oldProducer || options.missingMethod ? {} : { configuration: configurationRead }) })
  let producerClosed = false
  const closeProducer = async () => { if (!producerClosed) { producerClosed = true; await producer.close() } }
  cleanup.push(closeProducer)
  const lifetime = new AbortController(); cleanup.push(() => lifetime.abort())
  const context = { processId: process.pid, workspacePath: '/original-workspace', signal: lifetime.signal,
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: nativeSessionId },
    nativeActor: { protocolId: 'codex-app-server-v2-0.163', actorId, lifecycleOperationId, token, frontendControl: true as const,
      ...(options.oldProducer ? {} : { configurationObservation: true as const }),
      launch: { command: 'codex', args: ['--model', 'stale-launch-model'] } },
    getConfiguration: () => current, onConfiguration: (snapshot: AgentConfigurationObservedSnapshot) => { current = snapshot; events.push(snapshot) },
    onUnavailable: (code: string, message: string, source?: unknown) => unavailable.push({ code, message, ...(source ? { source } : {}) }) }
  const observe = async (extra: Partial<typeof context> = {}) => {
    const result = await new AgentProviderRegistry().get('codex').observeConfiguration!({ ...context, ...extra }, nativeSessionId)
    cleanup.push(() => result.dispose()); return result
  }
  return { context, producer, closeProducer, packet, source, events, unavailable, observe, configurationRead, reconnect,
    current: () => current, replace: (snapshot: AgentConfigurationSnapshot | null) => { current = snapshot } }
}

it('the original private producer stream updates the Provider snapshot without resuming or reading a catalog for each change', async () => {
  const f = await fixture(), original = f.current()!
  await f.observe()
  expect(f.events[0]).toMatchObject({ revision: original.revision, observation: { nativeSessionId: 'original-native',
    sourceId: f.source(), sequence: 1, state: 'confirmed' } })
  f.producer.publishConfiguration(f.packet(2, 'model-selected'))
  await vi.waitFor(() => expect(f.events).toHaveLength(2))
  expect(f.current()!.options[0]).toMatchObject({ currentValue: 'model-selected', choices: [{ value: 'model-original' }, { value: 'model-selected' }] })
  expect(f.configurationRead).toHaveBeenCalledTimes(1)
  expect(f.reconnect).not.toHaveBeenCalled()
})

it('a native model-provider change publishes its current value and withdraws the previous provider catalog', async () => {
  const f = await fixture(); await f.observe()
  f.producer.publishConfiguration(f.packet(3, 'new-provider-model', 'new-provider'))
  await vi.waitFor(() => expect(f.events).toHaveLength(2))
  expect(f.current()).toMatchObject({ options: [{ currentValue: 'new-provider-model', choices: [] }],
    observation: { sourceId: f.source('new-provider'), state: 'confirmed', issue: { code: 'AGENT_NATIVE_CONFIGURATION_CATALOG_UNAVAILABLE' } } })
  // The old source's late callback cannot borrow a new provider's observation clock or choices.
  f.producer.publishConfiguration(f.packet(2, 'model-original'))
  await new Promise(resolve => setImmediate(resolve))
  expect(f.events).toHaveLength(2)
})

it('an unlisted current native model is reported without fabricating a selectable row', async () => {
  const f = await fixture(); await f.observe()
  f.producer.publishConfiguration(f.packet(2, 'native-unlisted-model'))
  await vi.waitFor(() => expect(f.current()!.options[0]?.currentValue).toBe('native-unlisted-model'))
  const model = f.current()!.options[0]!
  expect(model.type === 'select' && model.choices.map(row => row.value)).toEqual(['model-original', 'model-selected'])
})

it('an observation without a proven catalog source preserves the real current model and offers no guessed choices', async () => {
  const f = await fixture(); f.replace({ revision: 'old-unscoped-catalog', options: f.current()!.options })
  await f.observe()
  expect(f.current()).toMatchObject({ options: [{ currentValue: 'model-original', choices: [] }],
    observation: { state: 'confirmed', issue: { code: 'AGENT_NATIVE_CONFIGURATION_CATALOG_UNAVAILABLE' } } })
})

it('a typed native gap carries its original source watermark and cannot be cleared by an old callback', async () => {
  const f = await fixture(); await f.observe()
  const original = f.current()!
  f.producer.publishConfiguration({ ...f.packet(3), state: 'unconfirmed', code: 'AGENT_NATIVE_CONFIGURATION_GAP', message: 'Original source gap.' })
  await vi.waitFor(() => expect(f.unavailable).toHaveLength(1))
  expect(f.unavailable[0]).toEqual({ code: 'AGENT_NATIVE_CONFIGURATION_GAP', message: 'Original source gap.', source: { sourceId: f.source(), sequence: 3 } })
  f.producer.publishConfiguration(f.packet(2, 'model-selected'))
  await new Promise(resolve => setImmediate(resolve))
  expect(f.current()).toEqual(original)
  f.producer.publishConfiguration(f.packet(4, 'model-selected'))
  await vi.waitFor(() => expect(f.current()!.options[0]?.currentValue).toBe('model-selected'))
  expect(f.current()!.observation?.sequence).toBe(4)
})

it('a foreign native target or forged source cannot update the original configuration', async () => {
  const f = await fixture(); await f.observe()
  f.producer.publishConfiguration({ ...f.packet(2), nativeSessionId: 'foreign-native' })
  f.producer.publishConfiguration({ ...f.packet(3), sourceId: 'forged-native-source' })
  await vi.waitFor(() => expect(f.unavailable).toHaveLength(1))
  expect(f.events).toHaveLength(1)
  expect(f.current()!.options[0]?.currentValue).toBe('model-original')
})

it('closing the private producer reports an observation failure without dispatching any native action', async () => {
  const f = await fixture(); await f.observe(); const original = f.current()!
  await f.closeProducer()
  await vi.waitFor(() => expect(f.unavailable.length).toBeGreaterThan(0))
  expect(f.current()).toEqual(original); expect(f.reconnect).not.toHaveBeenCalled()
})

it('an old producer lacking the fixed observation method stays honest while its frontend observation works', async () => {
  const f = await fixture({ oldProducer: true })
  await expect(f.observe()).rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED' })
  const frontend: unknown[] = []
  const watch = await observeCodexTerminalFrontend({ ...f.context, nativeActor: f.context.nativeActor,
    onFrontend: value => frontend.push(value), onUnavailable: () => {} })
  cleanup.push(() => watch.dispose())
  expect(frontend).toEqual([expect.objectContaining({ frontendId: 'original-frontend', state: 'attached' })])
  expect(f.reconnect).not.toHaveBeenCalled()
  expect(f.configurationRead).not.toHaveBeenCalled()
})

it('an explicit unsupported method response is a capability fact without reading error prose', async () => {
  const f = await fixture({ missingMethod: true })
  await expect(f.observe()).rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED' })
  expect(f.events).toEqual([])
})

it('a foreign initial source is refused before a configuration sample is adopted', async () => {
  const f = await fixture({ wrongInitial: true })
  await expect(f.observe()).rejects.toMatchObject({ code: 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED' })
  expect(f.events).toEqual([])
})

it('a one-shot source barrier ignores interleaved pushes until its own read completes', async () => {
  const f = await fixture()
  let resolve!: (packet: CodexConfigurationPacket) => void
  f.configurationRead.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  let settled = false
  const result = readCodexConfigurationControl(f.context, 'original-native').then(value => { settled = true; return value })
  await vi.waitFor(() => expect(f.configurationRead).toHaveBeenCalledTimes(1))
  f.producer.publishConfiguration(f.packet(1, 'obsolete-push'))
  await new Promise(done => setImmediate(done))
  expect(settled).toBe(false)
  resolve(f.packet(2, 'requested-barrier'))
  expect(await result).toMatchObject({ sequence: 2, model: 'requested-barrier' })
})

it('cancelling a pending source barrier settles immediately instead of waiting for a separate handshake timer', async () => {
  const f = await fixture(), controller = new AbortController()
  let resolve!: (packet: CodexConfigurationPacket) => void
  f.configurationRead.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const pending = readCodexConfigurationControl({ ...f.context, signal: controller.signal }, 'original-native')
  await vi.waitFor(() => expect(f.configurationRead).toHaveBeenCalledTimes(1))
  const failure = expect(pending).rejects.toThrow('Original barrier caller cancelled')
  controller.abort(new Error('Original barrier caller cancelled'))
  await failure
  resolve(f.packet(2, 'late-barrier'))
})

function sourceFixture() {
  const pending: Array<{ resolve(value: CodexConfigurationCurrent): void; reject(error: Error): void }> = []
  const packets: CodexConfigurationPacket[] = []
  const read = vi.fn(() => new Promise<CodexConfigurationCurrent>((resolve, reject) => pending.push({ resolve, reject })))
  const source = createCodexConfigurationSource({ actorId: 'original-actor', lifecycleOperationId: 'original-operation', read,
    publish: packet => packets.push(packet) })
  const current = (model: string): CodexConfigurationCurrent => ({ nativeSessionId: 'original-native',
    nativeRuntimeSessionId: 'original-runtime', modelProvider: 'original-provider', model })
  return { source, packets, pending, read, current }
}

it('a finite burst of native invalidations coalesces to one final read and never publishes the obsolete payload', async () => {
  const f = sourceFixture(), first = f.source.read()
  for (let index = 0; index < 100; index++) f.source.invalidate()
  expect(f.read).toHaveBeenCalledTimes(1)
  f.pending[0]!.resolve(f.current('obsolete-model'))
  await Promise.resolve()
  expect(f.packets).toEqual([]); expect(f.read).toHaveBeenCalledTimes(2)
  f.pending[1]!.resolve(f.current('current-model'))
  expect(await first).toMatchObject({ sequence: 1, model: 'current-model' })
  expect(f.packets).toEqual([expect.objectContaining({ sequence: 1, model: 'current-model' })])
})

it('an explicit barrier during an in-flight read obtains a subsequent original-source read and monotonic sequence', async () => {
  const f = sourceFixture(), initial = f.source.read()
  f.pending[0]!.resolve(f.current('model-initial')); await initial
  f.source.invalidate()
  const barrier = f.source.read()
  f.pending[1]!.resolve(f.current('model-before-barrier'))
  await Promise.resolve()
  expect(f.read).toHaveBeenCalledTimes(3)
  expect(f.packets).toHaveLength(1)
  f.pending[2]!.resolve(f.current('model-after-barrier'))
  expect(await barrier).toMatchObject({ sequence: 2, model: 'model-after-barrier' })
  expect(f.packets.map(packet => packet.sequence)).toEqual([1, 2])
})

it('a source gap fences pending results and only a later read can restore confirmed current state', async () => {
  const f = sourceFixture(), first = f.source.read()
  f.pending[0]!.resolve(f.current('model-initial')); await first
  const pending = f.source.read(); f.source.unavailable('AGENT_NATIVE_CONFIGURATION_GAP')
  f.pending[1]!.resolve(f.current('stale-before-gap')); await Promise.resolve()
  expect(f.packets.at(-1)).toMatchObject({ sequence: 2, state: 'unconfirmed', code: 'AGENT_NATIVE_CONFIGURATION_GAP' })
  f.pending[2]!.resolve(f.current('model-after-gap'))
  expect(await pending).toMatchObject({ sequence: 3, state: 'confirmed', model: 'model-after-gap' })
})
