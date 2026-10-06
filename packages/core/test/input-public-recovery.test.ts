import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxError } from '../src/errors.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
async function fixture() {
  const h = await rpcOwnerFixture(['caller', 'recipient', 'outsider']); cleanup.push(() => h.close())
  h.inner.kernel.identity = () => ({ buildIdentity: 'private-input-fixture', protocolVersion: 1, daemonInstanceId: 'private-input-runtime' })
  const hosted = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  cleanup.push(() => hosted.dispose())
  const path = join(h.root, 'input.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients,
    hostedRuntime: () => hosted, http: { host: '127.0.0.1', port: 0, token: 'private-input-test' } })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  return { ...h, path, server, rpc, queue: new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()) }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function saved(h: Fixture, id: string, managed = false) {
  const key = managed
    ? { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: id }
    : { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: id }
  if (managed) {
    await h.queue.append({ messageId: id, operationId: id + '-operation', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'caller' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'caller', senderRunId: 'run-caller', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
    threadId: id, correlationId: id, replyTo: null, workspaceId: null, body: 'Original private recovery body',
    admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun }, execution: 'immediate' },
    { inputEnvironment: { providerId: 'codex', executorId: 'codex' } })
    const entry = await h.queue.inspectInput({ key }); expect(entry).not.toBeNull(); return entry!
  }
  const entry = await h.queue.savePromptInput({ key, admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun },
    execution: 'immediate', environment: { providerId: 'codex', executorId: 'codex' }, source: { kind: 'prompt', prompt: 'Original private recovery body', authorHuman: true } })
  expect(entry).not.toBeNull(); return entry!
}
function unavailableBulk(h: Fixture) {
  return vi.spyOn(h.store, 'loadMetadata').mockRejectedValue(new AgentMuxError('Unrelated catalogue unavailable', 'PRIVATE_BULK_UNAVAILABLE'))
}
it.each(['unix', 'http'] as const)('recovers the exact original input over %s without reading bulk metadata', async transport => {
  const h = await fixture(), entry = await saved(h, 'bulk-' + transport), bulk = unavailableBulk(h)
  const rpc = transport === 'unix' ? h.rpc : await connectAgentMuxRpc({ endpoint: {
    transport: 'http', url: `http://127.0.0.1:${h.server.httpAddress!.port}/`, token: 'private-input-test' } })
  if (rpc !== h.rpc) cleanup.push(() => rpc.dispose())
  expect((await rpc.call('agent.input.inspect', { key: entry.intent.key })).input?.status).toBe('waiting')
  expect(await rpc.call('agent.input.stop', { ref: entry.control.ref, cancelOperationId: 'stop-' + transport }))
    .toMatchObject({ outcome: 'stopped-before-dispatch', ref: entry.control.ref })
  expect((await h.client.inspectAgentInput({ key: entry.intent.key }))?.status).toBe('stopped')
  expect(bulk).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('keeps retained input controllable after its active metadata row disappears, without recreating a Session', async () => {
  const h = await fixture(), entry = await saved(h, 'retained')
  await h.store.compareAndSwapMetadata((await h.store.readMetadata('recipient'))!, null)
  expect((await h.rpc.call('agent.input.inspect', { key: entry.intent.key })).input?.status).toBe('waiting')
  expect(await h.rpc.call('agent.input.stop', { ref: entry.control.ref, cancelOperationId: 'retained-stop' }))
    .toMatchObject({ outcome: 'stopped-before-dispatch' })
  expect(await h.store.readMetadata('recipient')).toBeNull()
  await expect(h.rpc.call('agent.input.stop', { ref: { ...entry.control.ref,
    key: { ...entry.intent.key, submissionId: 'actually-missing' } }, cancelOperationId: 'missing-stop' }))
    .rejects.toMatchObject({ code: 'AGENT_INPUT_NOT_FOUND' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('uses current original Agent authority and preserves stale generation, wrong author and wrong capability rejection', async () => {
  const h = await fixture(), entry = await saved(h, 'managed', true), bulk = unavailableBulk(h)
  const auth = { credentials: h.credentials }
  expect((await h.rpc.call('agent.input.inspect', { key: entry.intent.key }, auth)).input?.status).toBe('waiting')
  await expect(h.rpc.call('agent.input.inspect', { key: entry.intent.key }, { credentials: { ...h.credentials, capability: 'wrong' } }))
    .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(h.rpc.call('agent.input.stop', { ref: entry.control.ref, cancelOperationId: 'outsider-stop' },
    { credentials: { agentSessionId: 'outsider', capability: h.capability } })).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
  expect(await h.rpc.call('agent.input.stop', { ref: { ...entry.control.ref, waitGeneration: entry.control.ref.waitGeneration + 1 },
    cancelOperationId: 'stale-stop' }, auth)).toMatchObject({ outcome: 'stale-generation' })
  expect((await h.client.inspectAgentInput({ key: entry.intent.key }))?.status).toBe('waiting')
  expect(await h.rpc.call('agent.input.stop', { ref: entry.control.ref, cancelOperationId: 'managed-stop' }, auth))
    .toMatchObject({ outcome: 'stopped-before-dispatch' })
  expect(bulk).not.toHaveBeenCalled()
})
it('rejects an unconfirmed endpoint and ambiguous aggregate rather than guessing an input owner', async () => {
  const h = await fixture(), entry = await saved(h, 'scope')
  const unverified = Object.assign(Object.create(h.client), { runtimeOwnerIdentity: () => ({ availability: 'unverified' }) })
  const uncertain = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: unverified }] })
  await expect(uncertain.call('agent.input.inspect', { key: entry.intent.key })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  const aggregate = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }, { hostId: 'local', client: h.client }] })
  await expect(aggregate.call('agent.input.stop', { ref: entry.control.ref, cancelOperationId: 'ambiguous-stop' },
    { principal: { kind: 'user', id: 'local-user' } })).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
  expect((await h.client.inspectAgentInput({ key: entry.intent.key }))?.status).toBe('waiting')
})
it('carries exact read and Stop through Hosted control while general connection observation fails', async () => {
  const h = await fixture(), entry = await saved(h, 'hosted'), bulk = unavailableBulk(h)
  vi.spyOn(h.client, 'connect').mockRejectedValue(new AgentMuxError('Only general observation unavailable', 'PRIVATE_OBSERVATION_UNAVAILABLE'))
  const hosted = await connectHostedAgentMux({ rpc: h.rpc, waitForReady: false }); cleanup.push(() => hosted.dispose())
  expect((await hosted.inspectAgentInput({ key: entry.intent.key }))?.status).toBe('waiting')
  expect(await hosted.stopAgentInputWaiting({ ref: entry.control.ref, cancelOperationId: 'hosted-stop' }))
    .toMatchObject({ outcome: 'stopped-before-dispatch' })
  expect(bulk).toHaveBeenCalled() // General observation failed; exact control remained available.
})
it('uses the compiled public CLI for exact inspect and Stop with unavailable bulk metadata', async () => {
  const h = await fixture(), entry = await saved(h, 'compiled'), bulk = unavailableBulk(h)
  const env = objectCliEnvironment(h.root), prefix = ['--endpoint', 'unix://' + h.path, 'agent', 'input']
  const inspected = await runCompiledObjectCli([...prefix, 'inspect', '--input', '-'], env, JSON.stringify({ key: entry.intent.key }))
  expect(inspected.code, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).result.input.status).toBe('waiting')
  const stopped = await runCompiledObjectCli([...prefix, 'stop', '--input', '-'], env,
    JSON.stringify({ ref: entry.control.ref, cancelOperationId: 'compiled-stop' }))
  expect(stopped.code, stopped.stderr).toBe(0); expect(JSON.parse(stopped.stdout).result.outcome).toBe('stopped-before-dispatch')
  expect(bulk).not.toHaveBeenCalled()
})

it('does not read or stop a different semantic owner input using a valid foreign Agent capability', async () => {
  const h = await fixture(), entry = await saved(h, 'other-scope', true)
  const foreign = await rpcOwnerFixture(['foreign']); cleanup.push(() => foreign.close())
  const aggregate = new AgentMuxRpcService({ coreClients: () => [
    { hostId: 'local', client: h.client }, { hostId: 'local', client: foreign.client } ] })
  const context = { caller: foreign.credentials }
  await expect(aggregate.call('agent.input.stop', { ref: entry.control.ref, cancelOperationId: 'foreign-stop' }, context))
    .rejects.toMatchObject({ code: 'AGENT_INPUT_NOT_FOUND' })
  expect((await h.client.inspectAgentInput({ key: entry.intent.key }))?.status).toBe('waiting')
})

async function retireMetadata(h: Pick<Fixture, 'store'>, id: string) {
  const previous = (await h.store.readMetadata(id))!
  const reservation = { kind: 'stop' as const, reservationId: 'retire-' + id, ownerId: 'private-history-owner',
    ownerPid: process.pid, agentSessionId: id, operationId: 'retire-' + id, expiresAt: Date.now() + 60_000,
    expectedRun: previous.run, stopOperation: { daemonInstance: 'private-history-runtime', operationKey: 'retire-' + id, runId: previous.run.runId } }
  await h.store.reserveLifecycle(reservation); await h.store.commitLifecycle(reservation, null)
}
it.each(['unique', 'ambiguous', 'unreadable'] as const)('preserves original aggregate retired-history inspect routing: %s', async mode => {
  const h = await fixture(), entry = await saved(h, 'retired-history-' + mode)
  await retireMetadata(h, 'recipient')
  const peer = await rpcOwnerFixture([mode === 'ambiguous' ? 'recipient' : 'peer']); cleanup.push(() => peer.close())
  if (mode === 'ambiguous') await retireMetadata(peer, 'recipient')
  if (mode === 'unreadable') vi.spyOn(peer.store, 'loadRetiredAgentSessions')
    .mockRejectedValue(new AgentMuxError('Original peer history unavailable', 'PRIVATE_HISTORY_UNAVAILABLE'))
  const aggregate = new AgentMuxRpcService({ coreClients: () => [
    { hostId: 'local', client: h.client }, { hostId: 'local', client: peer.client } ] })
  const outcome = await aggregate.call('agent.input.inspect', { key: entry.intent.key })
    .then(value => ({ value }), error => ({ error }))
  if (mode === 'unique') expect(outcome).toMatchObject({ value: { input: { status: 'waiting', key: entry.intent.key } } })
  else expect(outcome).toMatchObject({ error: { code: mode === 'ambiguous' ? 'AMBIGUOUS_AGENT_SESSION' : 'PRIVATE_HISTORY_UNAVAILABLE' } })
  expect(await h.store.readMetadata('recipient')).toBeNull()
  expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(peer.inner.kernel.stop).not.toHaveBeenCalled()
})
