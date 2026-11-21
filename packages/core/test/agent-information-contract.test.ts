import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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
    configuration: { options: [{ category: 'model', currentValue: 'model-small' }] } })
  const reads = f.state.reads
  expect((await f.client.statusAgent(f.id)).session.nativeInformation).toEqual(result.snapshot)
  expect(f.state.reads).toBe(reads)
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

it('the same native Session name on a different original actor cannot expose the previous account or model cache', async () => {
  const f = await fixture(); await f.client.inspectAgentInformation(f.input)
  const saved = (await f.store.readMetadata(f.id))!
  await f.store.compareAndSwap(saved, { ...saved, nativeActor: { protocolId: 'fixture-protocol', actorId: 'different-actor',
    lifecycleOperationId: 'different-lifecycle', token: 'a'.repeat(64), launch: { command: 'native-fixture', args: [] } }, updatedAt: saved.updatedAt + 1 })
  f.state.mode = 'unavailable'; f.state.configurationUnavailable = true
  const result = await f.client.inspectAgentInformation(f.input)
  expect(result.snapshot).toBeNull(); expect(result.configuration).toBeNull(); expect(result.issue).toBeDefined()
  const status = await f.client.statusAgent(f.id)
  expect(status.session.nativeInformation).toBeUndefined(); expect(status.session.nativeConfiguration).toBeUndefined()
  expect(f.state.runtimeWrites).toBe(0)
})

it('a native configuration ACK must confirm the selected value and repeated operations never dispatch again', async () => {
  const f = await fixture(), initial = await f.client.inspectAgentInformation(f.input)
  const input = { target: initial.target, operationId: 'model-operation-original', configId: 'model',
    value: 'model-large', expectedRevision: initial.configuration!.revision }
  const receipt = await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })
  expect(receipt).toMatchObject({ target: initial.target, operationId: input.operationId, phase: 'settled', outcome: 'applied',
    acknowledgement: { options: [{ id: 'model', currentValue: 'model-large' }] }, diskDurability: 'confirmed' })
  expect(await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })).toEqual(receipt)
  expect(f.state.writes).toHaveLength(1)
  expect(f.state.writes[0]).toMatchObject({ requestId: receipt.nativeOperationId, expectedRevision: input.expectedRevision })
  expect(f.state.runtimeWrites).toBe(0)
})

it('an unconfirmed model ACK remains unknown and retains the original operation for inspection', async () => {
  const f = await fixture(), initial = await f.client.inspectAgentInformation(f.input)
  f.state.mode = 'fake-ack'
  const input = { target: initial.target, operationId: 'model-operation-unconfirmed', configId: 'model',
    value: 'model-large', expectedRevision: initial.configuration!.revision }
  const receipt = await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })
  expect(receipt).toMatchObject({ outcome: 'unknown', acknowledgement: null, target: initial.target, operationId: input.operationId })
  const inspection = await f.client.inspectAgentConfiguration({ hostId: 'local', agentSessionId: f.id, operationId: input.operationId })
  expect(inspection).toMatchObject({ kind: 'operation', operation: receipt })
  expect(f.state.current).toBe('model-small')
  expect(f.state.writes).toHaveLength(1)
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

it('the public configuration decoder cannot promote a foreign or unconfirmed ACK to applied', async () => {
  const f = await fixture(), initial = await f.client.inspectAgentInformation(f.input)
  const input = { target: initial.target, operationId: 'wire-operation-original', configId: 'model',
    value: 'model-large', expectedRevision: initial.configuration!.revision }
  const receipt = await f.client.setAgentConfiguration(input, { actor: { kind: 'user', id: 'fixture-person' } })
  expect(parseAgentConfigurationReceipt(receipt, input)).toEqual(receipt)
  expect(() => parseAgentConfigurationReceipt({ ...receipt, acknowledgement: { ...receipt.acknowledgement,
    options: receipt.acknowledgement!.options.map(option => ({ ...option, currentValue: 'model-small' })) } }, input)).toThrow()
  expect(() => parseAgentConfigurationReceipt({ ...receipt, acknowledgement: null }, input)).toThrow()
  expect(() => parseAgentConfigurationReceipt({ ...receipt, target: { ...receipt.target,
    expectedRun: { runId: 'foreign-run' } } }, input)).toThrow()
})
