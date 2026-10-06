import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxControlServer } from '../src/control-host.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { connectedClient, permission, storedSession, completeNativeRequest, AGENT_SESSION_ID, RUN_ID } from './fixtures/interaction-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const resources: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of resources.splice(0).reverse()) await close() })
async function fixture() {
  const h = await connectedClient(permission('original-question'), 'claude', 'original-native'); resources.push(() => h.client.dispose())
  const input = { agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, operationId: 'original-response',
    expectedRequest: permission('original-question'), response: { kind: 'permission' as const, requestId: 'original-question',
      decision: { outcome: 'selected' as const, optionId: 'reject-once' } } }
  return { ...h, input }
}

it('retains original response facts across completion, replacement and a cold file owner', async () => {
  const h = await fixture()
  expect(await h.client.respondAgentInteraction(h.input)).toMatchObject({ operationId: h.input.operationId,
    delivery: 'bytes-accepted', nativeAdoption: 'unknown', inputByteRange: { startByte: 0, endByte: 1 } })
  await completeNativeRequest(h.client)
  expect(h.client.agentSession(AGENT_SESSION_ID).pendingInteraction).toBeUndefined()
  const receipt = await h.client.inspectAgentInteractionOperation(h.input)
  expect(receipt).toMatchObject({ delivery: 'bytes-accepted', nativeCompleted: { source: 'native-hook' } })
  expect(await h.client.respondAgentInteraction(h.input)).toEqual(receipt)
  expect(h.writes).toHaveLength(1)
  const root = await mkdtemp(join(tmpdir(), 'interaction-receipts-')); resources.push(() => rm(root, { recursive: true, force: true }))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const saved = (await h.store.readMetadata(AGENT_SESSION_ID))!
  await store.compareAndSwap(null, { ...storedSession(undefined, 'claude'), run: { runId: 'replacement-run' }, retiredRuns: [saved.run], interactionOperations: saved.interactionOperations })
  const cold = new AgentMuxClient({ store }); resources.push(() => cold.dispose())
  expect(await cold.inspectAgentInteractionOperation(h.input)).toEqual(receipt)
  expect(await cold.respondAgentInteraction(h.input)).toEqual(receipt)
  expect(cold.agentSessions().map(session => Object.keys(session))).not.toContain('interactionOperations')
})

it('accepts one cross-client operation and refuses conflicting answers and exact-content stale cards', async () => {
  const h = await fixture()
  const results = await Promise.allSettled([h.client.respondAgentInteraction(h.input), h.client.respondAgentInteraction({ ...h.input, operationId: 'other-response' })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(h.writes).toHaveLength(1)
  await expect(h.client.respondAgentInteraction({ ...h.input, response: { ...h.input.response, decision: { outcome: 'selected', optionId: 'allow-once' } } }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
  const fresh = await fixture()
  await expect(fresh.client.respondAgentInteraction({ ...fresh.input, expectedRequest: { ...fresh.input.expectedRequest, title: 'Changed request content' } }))
    .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
  await expect(fresh.client.respondAgentInteraction({ ...fresh.input, expectedRun: { runId: 'old-run' } }))
    .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(fresh.writes).toEqual([])
  await fresh.client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, source: 'user', data: 'native input' })
  expect(fresh.writes).toEqual(['native input'])
})

it('queries an unknown original attempt without replaying input or changing its answer', async () => {
  const h = await fixture()
  const failure = Object.assign(new Error('Receipt unavailable'), { code: 'RECEIPT_UNAVAILABLE', detail: 'unknown' })
  const original = h.state.kernel.input as (...args: unknown[]) => Promise<unknown>
  let receipt: unknown
  const input = vi.fn().mockImplementationOnce(async (...args: unknown[]) => { receipt = await original(...args); throw failure }).mockImplementation(async () => receipt)
  h.state.kernel.input = input
  await expect(h.client.respondAgentInteraction(h.input)).rejects.toBe(failure)
  expect(await h.client.inspectAgentInteractionOperation(h.input)).toMatchObject({ delivery: 'unknown', nativeAdoption: 'unknown' })
  expect(await h.client.inspectAgentInteractionOperation(h.input)).toMatchObject({ delivery: 'unknown' })
  expect(input).toHaveBeenCalledTimes(1)
  expect(await h.client.respondAgentInteraction(h.input)).toMatchObject({ delivery: 'bytes-accepted' })
  expect(input).toHaveBeenCalledTimes(2)
  expect(h.writes).toHaveLength(1)
  await expect(h.client.respondAgentInteraction({ ...h.input, operationId: 'replacement-response' }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
})

it('the compiled CLI and public client reach the original owner and retain settled receipts', async () => {
  const h = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'interaction-cli-')); resources.push(() => rm(root, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
  await server.start(); resources.push(() => server.stop())
  const inputPath = join(root, 'input.json'); await writeFile(inputPath, JSON.stringify(h.input))
  const result = await runCompiledObjectCli(['agent', 'interaction', 'respond', '--input', inputPath], objectCliEnvironment(root))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ operation: 'agent.interaction.respond', result: { operationId: h.input.operationId, delivery: 'bytes-accepted' } })
  await completeNativeRequest(h.client)
  const inspected = await runCompiledObjectCli(['agent', 'interaction', 'inspect', '--session', AGENT_SESSION_ID, '--operation-id', h.input.operationId], objectCliEnvironment(root))
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result.receipt).toEqual(await h.client.inspectAgentInteractionOperation(h.input))
  expect(h.writes).toHaveLength(1)
})
