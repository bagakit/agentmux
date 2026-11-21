import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { agentCurrentModel } from '../src/agent-information.js'
import { parseAgentConfigurationSnapshot } from '../src/agent-configuration.js'
import { modelStateOwnerFixture } from './fixtures/model-state-owner.mjs'

vi.setConfig({ testTimeout: 5000 })
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function owner() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-model-state-core-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const f = await modelStateOwnerFixture({ AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, AgentMuxError }, directory)
  cleanup.push(f.close)
  return f
}

it('a confirmed unlisted model remains readable without inventing a selectable choice', () => {
  const value = parseAgentConfigurationSnapshot({ revision: 'original-revision', options: [{ id: 'model', name: 'Model',
    category: 'model', type: 'select', currentValue: 'outside-catalog', choices: [{ value: 'available', name: 'Available' }] }],
    observation: { nativeSessionId: 'native-original', sourceId: 'source-original', sequence: 1, observedAt: 123, state: 'confirmed' } })
  expect(agentCurrentModel(undefined, value)).toMatchObject({ id: 'outside-catalog', scope: 'next-turn' })
  expect(value.options[0]!.type === 'select' && value.options[0]!.choices.map(choice => choice.value)).toEqual(['available'])
  expect(agentCurrentModel(undefined, { ...value, observation: { ...value.observation!, state: 'unconfirmed' } })).toBeUndefined()
})

it('configuration inspection starts one original observer without reading the independent account channel', async () => {
  const f = await owner()
  f.state.mode = 'unavailable'
  const initial = await f.start()
  expect(initial.kind).toBe('configuration')
  await f.client.inspectAgentConfiguration(f.input)
  expect(f.observers).toHaveLength(1)
  expect(f.observers[0].nativeSessionId).toBe(f.nativeId)
  expect(f.state.reads).toBe(0)
  expect(f.state.runtimeWrites).toBe(0)
})

it('an original Provider configuration callback reaches the public Session event and cached inspection', async () => {
  const f = await owner(); await f.start()
  const sample = f.snapshot({ current: 'model-large', sequence: 1, observedAt: 1000 })
  const published = await f.emit(sample)
  expect(published.agentSessionId).toBe(f.id)
  expect(published.run).toEqual({ runId: f.runId })
  expect(published.nativeConfiguration).toEqual(sample)
  expect(f.client.agentSession(f.id).nativeConfiguration).toEqual(sample)
  expect(agentCurrentModel(undefined, published.nativeConfiguration)?.id).toBe('model-large')
  expect(f.state.current).toBe('model-large')
  expect(f.state.writes).toEqual([])
  expect(f.state.runtimeWrites).toBe(0)
})

it('foreign native samples and older sequences cannot replace the current sample or advance its fence', async () => {
  const f = await owner(); await f.start()
  await f.emit(f.snapshot({ current: 'model-large', sequence: 4 }))
  const begin = f.events.length
  f.observers[0].context.onConfiguration(f.snapshot({ current: 'foreign', nativeSessionId: 'another-native', sequence: 100 }))
  f.observers[0].context.onConfiguration(f.snapshot({ current: 'old', sequence: 3, observedAt: 9999 }))
  expect(f.client.agentSession(f.id).nativeConfiguration.options[0].currentValue).toBe('model-large')
  expect(f.events).toHaveLength(begin)
  const current = await f.emit(f.snapshot({ current: 'ordered-current-marker', sequence: 5 }))
  expect(current.nativeConfiguration.options[0].currentValue).toBe('ordered-current-marker')
  expect(f.events.slice(begin).some(event => ['old', 'foreign'].includes(event.nativeConfiguration?.options[0]?.currentValue))).toBe(false)
  expect(f.state.runtimeWrites).toBe(0)
})

it('a source gap preserves the original sample clock and cannot be healed by a sample below its watermark', async () => {
  const f = await owner(); await f.start()
  await f.emit(f.snapshot({ current: 'model-large', sequence: 1, observedAt: 1000 }))
  const unconfirmed = f.next(session => session.nativeConfiguration?.observation?.state === 'unconfirmed')
  f.observers[0].context.onUnavailable('AGENT_NATIVE_CONFIGURATION_GAP', 'An original native event is missing.', { sourceId: 'original-native-source', sequence: 3 })
  const gap = await unconfirmed
  expect(gap.nativeConfiguration.options[0].currentValue).toBe('model-large')
  expect(gap.nativeConfiguration.observation.observedAt).toBe(1000)
  expect(agentCurrentModel(undefined, gap.nativeConfiguration)).toBeUndefined()
  expect(f.observers[0].disposed).toBe(false)
  const begin = f.events.length
  f.observers[0].context.onConfiguration(f.snapshot({ current: 'late-before-gap', sequence: 2, observedAt: 9999 }))
  const healed = await f.emit(f.snapshot({ current: 'model-large', sequence: 4, observedAt: 1200 }))
  expect(healed.nativeConfiguration.observation.state).toBe('confirmed')
  expect(f.events.slice(begin).some(event => event.nativeConfiguration?.options[0]?.currentValue === 'late-before-gap')).toBe(false)
  expect(f.state.runtimeWrites).toBe(0)
})

it('a higher ordered native source can withdraw the old catalog and keep its unlisted current model', async () => {
  const f = await owner(); await f.start()
  await f.emit(f.snapshot({ sequence: 4 }))
  const latest = await f.emit(f.snapshot({ current: 'new-source-current', sourceId: 'new-native-source', sequence: 5, choices: [] }))
  expect(latest.nativeConfiguration.options[0].choices).toEqual([])
  expect(agentCurrentModel(undefined, latest.nativeConfiguration)?.id).toBe('new-source-current')
  f.observers[0].context.onConfiguration(f.snapshot({ current: 'old-source-late', sequence: 4, observedAt: 9999 }))
  expect(f.client.agentSession(f.id).nativeConfiguration.options[0].currentValue).toBe('new-source-current')
  const current = await f.emit(f.snapshot({ current: 'ordered-new-source-marker', sourceId: 'new-native-source', sequence: 6, choices: [] }))
  expect(current.nativeConfiguration.options[0].choices).toEqual([])
  expect(current.nativeConfiguration.observation.sourceId).toBe('new-native-source')
})

it('a callback from the previous actor lifetime cannot alter the replacement observer on the same native Session', async () => {
  const f = await owner(); await f.start()
  await f.emit(f.snapshot({ sequence: 1 }))
  const old = f.observers[0], saved = await f.store.readMetadata(f.id)
  await f.store.compareAndSwap(saved, { ...saved, nativeActor: { protocolId: 'fixture-protocol', actorId: 'replacement-original-actor',
    lifecycleOperationId: 'replacement-original-lifecycle', token: 'b'.repeat(64), launch: { command: 'native-fixture', args: [] } }, updatedAt: saved.updatedAt + 1 })
  await f.client.inspectAgentConfiguration(f.input)
  expect(f.observers).toHaveLength(2)
  expect(old.disposed).toBe(true)
  await f.emit(f.snapshot({ current: 'replacement-current', sourceId: 'replacement-source', sequence: 1 }))
  old.context.onConfiguration(f.snapshot({ current: 'old-lifetime', sequence: 100 }))
  old.context.onUnavailable('AGENT_NATIVE_CONFIGURATION_GAP', 'Old lifetime unavailable.', { sourceId: 'original-native-source', sequence: 101 })
  expect(f.client.agentSession(f.id).nativeConfiguration.options[0].currentValue).toBe('replacement-current')
  const latest = await f.emit(f.snapshot({ current: 'ordered-replacement-marker', sourceId: 'replacement-source', sequence: 2 }))
  expect(latest.nativeConfiguration.options[0].currentValue).toBe('ordered-replacement-marker')
  expect(latest.nativeConfiguration.observation.state).toBe('confirmed')
  expect(f.state.runtimeWrites).toBe(0)
})


it('an unsupported observer settles for this source without timed retries or taking away explicit configuration reads', async () => {
  const f = await owner(); await f.start()
  await f.emit(f.snapshot({ sequence: 1, observedAt: 1000 }))
  const unavailable = f.next(session => session.nativeConfiguration?.observation?.state === 'unconfirmed')
  f.observers[0].context.onUnavailable('AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED', 'The original source has no configuration observation channel.')
  const retained = await unavailable
  expect(retained.nativeConfiguration.options[0].currentValue).toBe('model-large')
  expect(retained.nativeConfiguration.observation.observedAt).toBe(1000)
  expect(f.observers[0].disposed).toBe(true)
  f.observers[0].context.onConfiguration(f.snapshot({ current: 'disposed-reader-late', sequence: 100 }))
  expect(f.client.agentSession(f.id).nativeConfiguration.observation.state).toBe('unconfirmed')
  expect(f.client.agentSession(f.id).nativeConfiguration.options[0].currentValue).toBe('model-large')
  const reread = await f.client.inspectAgentConfiguration(f.input)
  await f.client.inspectAgentConfiguration(f.input)
  expect(reread.kind).toBe('configuration')
  expect(reread.snapshot?.options[0]?.currentValue).toBe('model-large')
  expect(f.observers).toHaveLength(1)
  expect(f.state.runtimeWrites).toBe(0)
})

it.each(['actor', 'run', 'runtime'] as const)('an original native ACK stays applied after the %s changes without overwriting the new scope', async change => {
  const f = await owner(), initial = await f.start()
  const provider = f.client.providers.get('information-fixture'), original = provider.setConfiguration!
  const runtimeIdentity = f.client.kernel.creationRuntimeIdentity
  const set = vi.spyOn(provider, 'setConfiguration').mockImplementationOnce(async (...args) => {
    const acknowledgement = await original(...args)
    if (change === 'runtime') { f.client.kernel.creationRuntimeIdentity = () => { throw new Error('The original Runtime observation is unavailable.') }; return acknowledgement }
    const saved = await f.store.readMetadata(f.id)
    const replacement = change === 'actor' ? { ...saved, nativeActor: { protocolId: 'fixture-protocol', actorId: 'ack-replacement-actor',
      lifecycleOperationId: 'ack-replacement-lifecycle', token: 'c'.repeat(64), launch: { command: 'native-fixture', args: [] } } }
      : { ...saved, run: { runId: 'ack-replacement-run' }, retiredRuns: [...saved.retiredRuns, saved.run] }
    await f.store.compareAndSwap(saved, { ...replacement, updatedAt: saved.updatedAt + 1 })
    await f.client.registry.refresh(f.id)
    return acknowledgement
  })
  try {
    const input = { target: initial.target, operationId: 'original-ack-before-' + change, configId: 'model',
      value: 'model-large', expectedRevision: initial.snapshot!.revision }
    const receipt = await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-user' } })
    expect(receipt).toMatchObject({ outcome: 'applied', target: initial.target, operationId: input.operationId,
      acknowledgement: { options: [{ currentValue: 'model-large' }] } })
    const history = await f.client.inspectAgentConfiguration({ hostId: 'local', agentSessionId: f.id, operationId: input.operationId })
    expect(history).toMatchObject({ kind: 'operation', operation: receipt })
    const current = f.client.agentSession(f.id)
    if (change === 'runtime') expect(current.nativeConfiguration?.options[0]?.currentValue).toBe('model-small')
    else expect(current.nativeConfiguration).toBeUndefined()
    expect(current.run.runId).toBe(change === 'run' ? 'ack-replacement-run' : f.runId)
    expect(f.state.writes).toHaveLength(1)
    expect(f.state.runtimeWrites).toBe(0)
  } finally { f.client.kernel.creationRuntimeIdentity = runtimeIdentity; set.mockRestore() }
})


it('an ended original Run disposes its observer and ignores its later configuration callbacks', async () => {
  const f = await owner(); await f.start()
  await f.emit(f.snapshot({ sequence: 1 }))
  const original = f.observers[0]
  f.run.state = { type: 'exited', code: 0, signal: null }
  f.client.acceptKernelEvent({ type: 'exit', runId: f.runId, state: f.run.state, observedAt: 2000 })
  expect(original.disposed).toBe(true)
  const before = f.client.agentSession(f.id).nativeConfiguration
  original.context.onConfiguration(f.snapshot({ current: 'after-original-exit', sequence: 2 }))
  expect(f.client.agentSession(f.id).nativeConfiguration).toEqual(before)
  expect(f.state.runtimeWrites).toBe(0)
})


it('an ordered direct read raises the active observer fence before a late older callback arrives', async () => {
  const f = await owner(), provider = f.client.providers.get('information-fixture')
  const read = vi.spyOn(provider, 'readConfiguration').mockResolvedValue(f.snapshot({ current: 'read-current', sequence: 10, observedAt: 1000 }))
  try {
    await f.start()
    const before = f.events.length
    f.observers[0].context.onConfiguration(f.snapshot({ current: 'older-stream-value', sequence: 9, observedAt: 9999 }))
    expect(f.client.agentSession(f.id).nativeConfiguration.options[0].currentValue).toBe('read-current')
    expect(f.events).toHaveLength(before)
    await f.emit(f.snapshot({ current: 'ordered-after-read', sequence: 11 }))
  } finally { read.mockRestore() }
})

it('a catalog at the same ordered observation can enrich a model-only push without being erased by its replay', async () => {
  const f = await owner(); await f.start()
  await f.emit(f.snapshot({ current: 'model-large', sequence: 10, choices: [] }))
  const full = f.snapshot({ current: 'model-large', sequence: 10 })
  const provider = f.client.providers.get('information-fixture'), read = vi.spyOn(provider, 'readConfiguration').mockResolvedValue(full)
  try {
    const result = await f.client.inspectAgentConfiguration(f.input)
    expect(result.snapshot).toEqual(full)
    expect(f.client.agentSession(f.id).nativeConfiguration.options[0].choices).toHaveLength(2)
    const before = f.events.length
    f.observers[0].context.onConfiguration(f.snapshot({ current: 'model-large', sequence: 10, choices: [] }))
    expect(f.client.agentSession(f.id).nativeConfiguration.options[0].choices).toHaveLength(2)
    expect(f.events).toHaveLength(before)
  } finally { read.mockRestore() }
})

it('the durable original actor preserves its declared observation capability and rejects invalid capability combinations', async () => {
  const f = await owner(), original = await f.store.readMetadata(f.id)
  const nativeActor = { protocolId: 'fixture-protocol', actorId: 'original-capable-actor', lifecycleOperationId: 'original-capable-lifecycle',
    token: 'd'.repeat(64), launch: { command: 'native-fixture', args: [] }, frontendControl: true, configurationObservation: true }
  await f.store.compareAndSwap(original, { ...original, nativeActor, updatedAt: original.updatedAt + 1 })
  const reread = new AgentMuxFileAgentSessionStore(f.store.path)
  const saved = await reread.readMetadata(f.id)
  expect(saved?.nativeActor).toEqual(nativeActor)
  for (const invalid of [{ ...nativeActor, configurationObservation: false }, { ...nativeActor, frontendControl: undefined }]) {
    await expect(reread.compareAndSwap(saved, { ...saved, nativeActor: invalid, updatedAt: saved.updatedAt + 1 })).rejects.toThrow()
    expect((await reread.readMetadata(f.id))?.nativeActor).toEqual(nativeActor)
  }
  const { configurationObservation: declaration, ...withoutDeclaration } = nativeActor
  expect(declaration).toBe(true)
  await reread.compareAndSwap(saved, { ...saved, nativeActor: withoutDeclaration, updatedAt: saved.updatedAt + 1 })
  expect((await reread.readMetadata(f.id))?.nativeActor.configurationObservation).toBeUndefined()
})

async function changeNativeTranscript(f: Awaited<ReturnType<typeof owner>>, transcriptPath: string) {
  const saved = await f.store.readMetadata(f.id)
  expect(saved?.nativeHandle?.kind).toBe('provider')
  await f.store.compareAndSwap(saved, { ...saved, nativeHandle: { ...saved.nativeHandle, transcriptPath: join(saved.workspacePath, transcriptPath) }, updatedAt: saved.updatedAt + 1 })
  await f.client.registry.refresh(f.id)
}

it.each(['configuration', 'information'] as const)('a cold %s read accepts original transcript discovery and rejects replacement of a known transcript', async kind => {
  const f = await owner()
  const provider = f.client.providers.get('information-fixture')
  const method = kind === 'configuration' ? 'readConfiguration' : 'readInformation'
  const original = provider[method]!
  let path = 'native-original-transcript'
  const read = vi.spyOn(provider, method).mockImplementation(async (...args) => {
    const reply = await original(...args)
    await changeNativeTranscript(f, path)
    return reply
  })
  const inspect = () => kind === 'configuration' ? f.client.inspectAgentConfiguration(f.input) : f.client.inspectAgentInformation(f.input)
  try {
    const reading = inspect()
    await expect(reading).resolves.toMatchObject({ kind, snapshot: expect.any(Object) })
    const discovered = await reading
    expect(discovered.snapshot).not.toBeNull()
    expect(f.client.agentSession(f.id).nativeHandle).toMatchObject({ sessionId: f.nativeId, transcriptPath: join(f.client.agentSession(f.id).workspacePath, path) })
    expect(f.client.agentSession(f.id).run.runId).toBe(f.runId)
    path = 'another-native-transcript'
    await expect(inspect()).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(f.state.writes).toHaveLength(0)
    expect(f.state.runtimeWrites).toBe(0)
  } finally { read.mockRestore() }
})

it.each(['discovery', 'replacement'] as const)('a configuration set treats transcript %s according to original native identity before dispatch', async scenario => {
  const f = await owner()
  if (scenario === 'replacement') await changeNativeTranscript(f, 'native-original-transcript')
  const initial = await f.start()
  let changed = false
  const input = { target: initial.target, operationId: 'transcript-' + scenario, configId: 'model',
    value: 'model-large', expectedRevision: initial.snapshot!.revision }
  const operation = f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-user' },
    assertCurrent: async () => { if (!changed) { changed = true; await changeNativeTranscript(f, 'native-discovered-transcript') } } })
  if (scenario === 'replacement') {
    await expect(operation).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(f.state.writes).toHaveLength(0)
  } else {
    expect(await operation).toMatchObject({ outcome: 'applied', acknowledgement: { options: [{ currentValue: 'model-large' }] } })
    expect(f.state.writes).toHaveLength(1)
    expect(f.client.agentSession(f.id).nativeConfiguration?.options[0]?.currentValue).toBe('model-large')
  }
  expect(f.state.runtimeWrites).toBe(0)
})
