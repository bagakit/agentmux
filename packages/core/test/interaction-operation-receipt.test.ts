import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxControlServer } from '../src/control-host.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { interactionOperationHook, OPERATION_SESSION_ID as AGENT_SESSION_ID, OPERATION_RUN_ID as RUN_ID } from './fixtures/interaction-operation-hook.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

const resources: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of resources.splice(0).reverse()) await close() })
async function fixture() {
  const h = await interactionOperationHook(); resources.push(h.close)
  return h
}

it('retains original response facts across callback closure, replacement and a cold file owner', async () => {
  const h = await fixture()
  expect(await h.client.respondAgentInteraction(h.input)).toMatchObject({ operationId: h.input.operationId,
    delivery: 'hook-written', nativeAdoption: 'unknown' })
  expect(await h.callback).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } })
  const receipt = await h.client.inspectAgentInteractionOperation(h.input)
  expect(receipt).not.toHaveProperty('nativeCompleted')
  expect(receipt).not.toHaveProperty('inputByteRange')
  expect(await h.client.respondAgentInteraction(h.input)).toEqual(receipt)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const saved = (await h.store.readMetadata(AGENT_SESSION_ID))!
  const store = new AgentMuxFileAgentSessionStore(join(h.root, 'cold-sessions.json'))
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: saved.agentSessionId, providerId: saved.providerId,
    executorId: saved.executorId, hostId: saved.hostId, workspacePath: saved.workspacePath,
    hookBindingId: saved.hookBindingId, hookToken: saved.hookToken,
    createdAt: saved.createdAt, updatedAt: saved.updatedAt,
    run: { runId: 'replacement-run' }, retiredRuns: [saved.run], interactionOperations: saved.interactionOperations
  })
  const cold = new AgentMuxClient({ store }); resources.push(() => cold.dispose())
  expect(await cold.inspectAgentInteractionOperation(h.input)).toEqual(receipt)
  expect(await cold.respondAgentInteraction(h.input)).toEqual(receipt)
  expect(cold.agentSessions()).toEqual([])
  const projected = h.client.agentSession(AGENT_SESSION_ID)
  expect(projected).toMatchObject({ agentSessionId: AGENT_SESSION_ID })
  expect(projected).not.toHaveProperty('interactionOperations')
})

it('accepts one cross-client operation and refuses conflicting answers and exact-content stale cards', async () => {
  const h = await fixture()
  const results = await Promise.allSettled([h.client.respondAgentInteraction(h.input), h.client.respondAgentInteraction({ ...h.input, operationId: 'other-response' })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  const receipts = await Promise.all([h.input.operationId, 'other-response'].map(operationId =>
    h.client.inspectAgentInteractionOperation({ agentSessionId: AGENT_SESSION_ID, operationId })))
  expect(receipts.filter(Boolean)).toHaveLength(1)
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await expect(h.client.respondAgentInteraction({ ...h.input, response: { ...h.input.response, decision: { outcome: 'selected', optionId: 'allow-once' } } }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
  const fresh = await fixture()
  const stale = await fresh.client.respondAgentInteraction({ ...fresh.input,
    expectedRequest: { ...fresh.input.expectedRequest, title: 'Changed request content' } }).then(() => null, error => error)
  expect(stale).toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
  await expect(fresh.client.respondAgentInteraction({ ...fresh.input, expectedRun: { runId: 'old-run' } }))
    .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(fresh.inner.kernel.input).not.toHaveBeenCalled()
  await fresh.client.writeAgent({ agentSessionId: AGENT_SESSION_ID, expectedRun: { runId: RUN_ID }, source: 'user', data: 'native input' })
  expect(fresh.inner.kernel.input).toHaveBeenCalledExactlyOnceWith(RUN_ID, expect.objectContaining({ data: 'native input' }))
})

it('queries an unknown original attempt without replaying input or changing its answer', async () => {
  const h = await fixture()
  const failure = Object.assign(new Error('Receipt unavailable'), { code: 'RECEIPT_UNAVAILABLE', detail: 'unknown' })
  const original = h.server.respondPermission.bind(h.server)
  const dispatch = vi.spyOn(h.server, 'respondPermission').mockImplementation(async (...args) => { await original(...args); throw failure })
  await expect(h.client.respondAgentInteraction(h.input)).rejects.toBe(failure)
  expect(await h.client.inspectAgentInteractionOperation(h.input)).toMatchObject({ delivery: 'unknown', nativeAdoption: 'unknown' })
  expect(await h.client.inspectAgentInteractionOperation(h.input)).toMatchObject({ delivery: 'unknown' })
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(dispatch).toHaveBeenCalledOnce()
  await expect(h.client.respondAgentInteraction(h.input)).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
  expect(dispatch).toHaveBeenCalledOnce()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await expect(h.client.respondAgentInteraction({ ...h.input, operationId: 'replacement-response' }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
})

it('the compiled CLI and public client reach the original callback and retain its exact receipt', async () => {
  const h = await fixture()
  const root = h.root
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
  await server.start(); resources.push(() => server.stop())
  const inputPath = join(root, 'input.json'); await writeFile(inputPath, JSON.stringify(h.input))
  const result = await runCompiledObjectCli(['agent', 'interaction', 'respond', '--input', inputPath], objectCliEnvironment(root))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ operation: 'agent.interaction.respond', result: { operationId: h.input.operationId, delivery: 'hook-written' } })
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  const inspected = await runCompiledObjectCli(['agent', 'interaction', 'inspect', '--session', AGENT_SESSION_ID, '--operation-id', h.input.operationId], objectCliEnvironment(root))
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result.receipt).toEqual(await h.client.inspectAgentInteractionOperation(h.input))
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('the Hosted SDK consumes the same original callback over public Unix RPC', async () => {
  const h = await fixture()
  const owner = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  resources.push(() => owner.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients, hostedRuntime: () => owner })
  await server.start(); resources.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); resources.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); resources.push(() => hosted.dispose())
  const receipt = await hosted.respondAgentInteraction(h.input)
  expect(receipt).toMatchObject({ operationId: h.input.operationId, delivery: 'hook-written', nativeAdoption: 'unknown' })
  expect(await hosted.inspectAgentInteractionOperation(h.input)).toEqual(receipt)
  expect(await h.callback).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
})
