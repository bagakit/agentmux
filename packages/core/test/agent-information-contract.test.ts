import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { parseAgentInformationSnapshot } from '../src/agent-information.js'
import { parseAgentConfigurationReceipt } from '../src/agent-configuration.js'
import { informationNativeFixture } from './fixtures/agent-information-native.mjs'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-information-contract-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const result = await informationNativeFixture({ AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, AgentMuxError }, root)
  cleanup.push(result.close)
  return result
}

it('the optional native information read projects the original source without ACP or unrelated Session reads', async () => {
  const f = await fixture()
  expect((await f.client.statusAgent(f.id)).session.nativeInformation).toBeUndefined()
  expect(f.state.reads).toBe(0)
  const result = await f.client.inspectAgentInformation(f.input)
  expect(result).toMatchObject({ kind: 'information', target: { agentSessionId: f.id, expectedRun: { runId: f.runId } },
    snapshot: { nativeSessionId: f.nativeId, sourceId: 'native-source-original', observedAt: fixtureEpoch(2, 0, 123),
      model: { id: 'model-small', scope: 'next-turn' }, plan: { id: 'team', name: 'Team' },
      limits: [{ id: 'weekly', usedPercent: 25, windowMinutes: 10080, resetsAt: fixtureEpoch(8, 81_600) }] },
    configuration: null })
  expect(f.state.configurations).toBe(0)
  const configuration = await f.client.inspectAgentConfiguration(f.input)
  expect(configuration).toMatchObject({ kind: 'configuration', target: result.target,
    snapshot: { options: [{ category: 'model', currentValue: 'model-small' }] } })
  expect(f.state.configurations).toBe(1)
  const reads = f.state.reads
  expect((await f.client.statusAgent(f.id)).session.nativeInformation).toEqual(result.snapshot)
  expect((await f.client.statusAgent(f.id)).session.nativeConfiguration).toEqual(configuration.snapshot)
  expect(f.state.reads).toBe(reads)
  const projected = await f.client.inspectAgentInformation(f.input)
  expect(projected.configuration).toEqual(configuration.snapshot)
  expect(f.state.configurations).toBe(1)
  expect(f.state.runtimeWrites).toBe(0)
})

it('a foreign native Session result cannot become the original public information', async () => {
  const f = await fixture(); f.state.mode = 'wrong-native'
  await expect(f.client.inspectAgentInformation(f.input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect((await f.client.statusAgent(f.id)).session.nativeInformation).toBeUndefined()
  expect(f.state.runtimeWrites).toBe(0)
})

it('a read failure preserves the last native observation and its original time without changing the Run', async () => {
  const f = await fixture(), before = await f.client.inspectAgentInformation(f.input)
  f.state.mode = 'unavailable'
  const result = await f.client.inspectAgentInformation(f.input)
  expect(result.snapshot).toEqual(before.snapshot)
  expect(result.issue).toBeDefined()
  expect((await f.client.statusAgent(f.id)).session).toMatchObject({ agentSessionId: f.id, run: { runId: f.runId },
    nativeInformation: { observedAt: fixtureEpoch(2, 0, 123) } })
  expect(f.state.runtimeWrites).toBe(0)
})

it('configuration failures and null withdrawal are independent of native account reads and retain their original projections', async () => {
  const f = await fixture(), configuration = await f.client.inspectAgentConfiguration(f.input)
  const original = await f.client.inspectAgentInformation(f.input)
  expect(configuration.snapshot).not.toBeNull()
  f.state.configurationUnavailable = true
  await expect(f.client.inspectAgentConfiguration(f.input)).rejects.toMatchObject({ code: 'NATIVE_CONFIGURATION_UNAVAILABLE' })
  const failed = await f.client.inspectAgentInformation(f.input)
  expect(failed.configuration).toEqual(configuration.snapshot)
  expect(failed.issue).toBeUndefined()
  f.state.configurationUnavailable = 'null'; f.state.mode = 'unavailable'
  expect(await f.client.inspectAgentConfiguration(f.input)).toMatchObject({ kind: 'configuration', snapshot: null })
  const withdrawn = await f.client.inspectAgentInformation(f.input)
  expect(withdrawn.configuration).toBeNull(); expect(withdrawn.snapshot).toEqual(original.snapshot)
  expect(withdrawn.issue).toBeDefined()
  const session = (await f.client.statusAgent(f.id)).session
  expect(session.nativeConfiguration).toBeUndefined(); expect(session.nativeInformation).toEqual(original.snapshot)
  expect(f.state.configurations).toBe(3)
  expect(f.state.reads).toBe(3)
  expect(f.state.runtimeWrites).toBe(0)
})

it('an explicit null from configuration.inspect withdraws the original cached configuration without losing native information', async () => {
  const f = await fixture(), configuration = await f.client.inspectAgentConfiguration(f.input)
  const original = await f.client.inspectAgentInformation(f.input)
  expect(configuration.snapshot).not.toBeNull()
  f.state.configurationUnavailable = 'null'
  const result = await f.client.inspectAgentConfiguration(f.input)
  expect(result).toMatchObject({ kind: 'configuration', snapshot: null })
  const session = (await f.client.statusAgent(f.id)).session
  expect(session.nativeConfiguration).toBeUndefined()
  expect(session.nativeInformation).toEqual(original.snapshot)
  expect(session.run).toEqual({ runId: f.runId })
  expect(f.state.runtimeWrites).toBe(0)
})

it('mutating a direct SDK information DTO cannot modify its original owner facts or Run', async () => {
  const f = await fixture(), configuration = await f.client.inspectAgentConfiguration(f.input)
  const result = await f.client.inspectAgentInformation(f.input)
  const original = structuredClone(result)
  result.snapshot!.model!.id = 'caller-tampered-model'
  result.snapshot!.plan!.name = 'caller-tampered-plan'
  result.configuration!.options[0]!.currentValue = 'caller-tampered-selection'
  configuration.snapshot!.options[0]!.currentValue = 'caller-tampered-configuration-read'
  result.target.expectedRun.runId = 'caller-tampered-run'
  f.state.mode = 'unavailable'; f.state.configurationUnavailable = true
  const immediate = f.client.agentSession(f.id)
  expect(immediate.run).toEqual({ runId: f.runId })
  expect(immediate.nativeInformation).toEqual(original.snapshot)
  expect(immediate.nativeConfiguration).toEqual(original.configuration)
  const session = (await f.client.statusAgent(f.id)).session
  expect(session.run).toEqual({ runId: f.runId })
  expect(session.nativeInformation).toEqual(original.snapshot)
  expect(session.nativeConfiguration).toEqual(original.configuration)
  const retained = await f.client.inspectAgentInformation(f.input)
  expect(retained.target.expectedRun).toEqual({ runId: f.runId })
  expect(retained.snapshot).toEqual(original.snapshot)
  expect(retained.configuration).toEqual(original.configuration)
  expect(f.state.configurations).toBe(1)
  expect(f.state.runtimeWrites).toBe(0)
})

it('a late null configuration read preserves a newer original model ACK and returns its confirmed snapshot', async () => {
  const f = await fixture(), initial = await f.client.inspectAgentConfiguration(f.input)
  const provider = f.client.providers.get('information-fixture')
  let beginRead!: () => void, finishRead!: (value: null) => void
  const entered = new Promise<void>(resolve => { beginRead = resolve })
  const deferred = new Promise<null>(resolve => { finishRead = resolve })
  const read = vi.spyOn(provider, 'readConfiguration').mockImplementationOnce(async () => { beginRead(); return deferred })
  const pending = f.client.inspectAgentConfiguration(f.input)
  try {
    await entered
    const receipt = await f.client.setAgentConfiguration({ target: initial.target, operationId: 'model-operation-before-late-null',
      configId: 'model', value: 'model-large', expectedRevision: initial.snapshot!.revision },
    { actor: { kind: 'user', id: 'fixture-person' } })
    expect(receipt.outcome).toBe('applied')
    finishRead(null)
    expect(await pending).toMatchObject({ kind: 'configuration', snapshot: receipt.acknowledgement })
    expect((await f.client.statusAgent(f.id)).session.nativeConfiguration).toEqual(receipt.acknowledgement)
    expect(f.state.writes).toHaveLength(1)
    expect(f.state.reads).toBe(0)
    expect(f.state.runtimeWrites).toBe(0)
  } finally { finishRead(null); await pending.catch(() => {}); read.mockRestore() }
})

it('the same native Session name on a different original actor cannot expose the previous account or model cache', async () => {
  const f = await fixture()
  expect((await f.client.inspectAgentConfiguration(f.input)).snapshot).not.toBeNull()
  await f.client.inspectAgentInformation(f.input)
  const saved = (await f.store.readMetadata(f.id))!
  await f.store.compareAndSwap(saved, { ...saved, nativeActor: { protocolId: 'fixture-protocol', actorId: 'different-actor',
    lifecycleOperationId: 'different-lifecycle', token: 'a'.repeat(64), launch: { command: 'native-fixture', args: [] } }, updatedAt: saved.updatedAt + 1 })
  f.state.mode = 'unavailable'; f.state.configurationUnavailable = true
  const result = await f.client.inspectAgentInformation(f.input)
  expect(result.snapshot).toBeNull(); expect(result.configuration).toBeNull(); expect(result.issue).toBeDefined()
  const status = await f.client.statusAgent(f.id)
  expect(status.session.nativeInformation).toBeUndefined(); expect(status.session.nativeConfiguration).toBeUndefined()
  expect(f.state.configurations).toBe(1)
  expect(f.state.runtimeWrites).toBe(0)
})

it('a native configuration ACK must confirm the selected value and repeated operations never dispatch again', async () => {
  const f = await fixture(), initial = await f.client.inspectAgentConfiguration(f.input)
  const input = { target: initial.target, operationId: 'model-operation-original', configId: 'model',
    value: 'model-large', expectedRevision: initial.snapshot!.revision }
  const receipt = await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })
  expect(receipt).toMatchObject({ target: initial.target, operationId: input.operationId, phase: 'settled', outcome: 'applied',
    acknowledgement: { options: [{ id: 'model', currentValue: 'model-large' }] }, diskDurability: 'confirmed' })
  expect(await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })).toEqual(receipt)
  expect(f.state.writes).toHaveLength(1)
  expect(f.state.writes[0]).toMatchObject({ requestId: receipt.nativeOperationId, expectedRevision: input.expectedRevision })
  expect(f.state.reads).toBe(0)
  expect(f.state.runtimeWrites).toBe(0)
})

it('an ACK that does not confirm the selected model remains unknown and retains the original operation for inspection', async () => {
  const f = await fixture(), initial = await f.client.inspectAgentConfiguration(f.input)
  f.state.mode = 'fake-ack'
  const input = { target: initial.target, operationId: 'model-operation-unconfirmed', configId: 'model',
    value: 'model-large', expectedRevision: initial.snapshot!.revision }
  const receipt = await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })
  expect(receipt).toMatchObject({ outcome: 'unknown', acknowledgement: null, target: initial.target, operationId: input.operationId })
  const inspection = await f.client.inspectAgentConfiguration({ hostId: 'local', agentSessionId: f.id, operationId: input.operationId })
  expect(inspection).toMatchObject({ kind: 'operation', operation: receipt })
  expect(f.state.current).toBe('model-small')
  expect(f.state.writes).toHaveLength(1)
  expect(f.state.reads).toBe(0)
  expect(f.state.runtimeWrites).toBe(0)
})

it('the strict public snapshot rejects additional credentials and invented field meanings', () => {
  const valid = { nativeSessionId: 'native-original', sourceId: 'source-original', observedAt: 123,
    model: { id: 'native-model', scope: 'session' }, issues: [] }
  expect(parseAgentInformationSnapshot(valid)).toEqual(valid)
  for (const value of [{ ...valid, apiKey: 'private-credential' }, { ...valid, model: { id: 'native-model', scope: 'historical' } },
    { ...valid, observedAt: -1 }, { ...valid, issues: [{ field: 'model', kind: 'success', code: 'BAD', message: 'bad' }] }]) {
    expect(() => parseAgentInformationSnapshot(value)).toThrow()
  }
})

it('the public configuration decoder rejects foreign targets and missing or mismatched selected-value ACKs', async () => {
  const f = await fixture(), initial = await f.client.inspectAgentConfiguration(f.input)
  const input = { target: initial.target, operationId: 'wire-operation-original', configId: 'model',
    value: 'model-large', expectedRevision: initial.snapshot!.revision }
  const receipt = await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })
  expect(parseAgentConfigurationReceipt(receipt, input)).toEqual(receipt)
  expect(() => parseAgentConfigurationReceipt({ ...receipt, acknowledgement: { ...receipt.acknowledgement,
    options: receipt.acknowledgement!.options.map(option => ({ ...option, currentValue: 'model-small' })) } }, input)).toThrow()
  expect(() => parseAgentConfigurationReceipt({ ...receipt, acknowledgement: null }, input)).toThrow()
  expect(() => parseAgentConfigurationReceipt({ ...receipt, target: { ...receipt.target,
    expectedRun: { runId: 'foreign-run' } } }, input)).toThrow()
})
