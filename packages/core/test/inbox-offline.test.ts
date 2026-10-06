import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxError } from '../src/errors.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
async function available<T>(operation: Promise<T>): Promise<T> {
  const outcome = await operation.then(value => ({ value }), error => ({ error }))
  expect(outcome).toHaveProperty('value')
  return (outcome as { value: T }).value
}
async function fixture() {
  const h = await rpcOwnerFixture(); cleanup.push(() => h.close())
  h.inner.kernel.identity = () => ({ buildIdentity: 'private-inbox-fixture', protocolVersion: 1, daemonInstanceId: 'private-inbox-runtime' })
  const owner = hostedTestOwner(h.client)
  const hosted = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => owner); cleanup.push(() => hosted.dispose())
  const path = join(h.root, 'inbox.sock'), server = new AgentMuxControlServer({ socketPath: path,
    coreClients: h.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  await queue.append({ messageId: 'original-inbox', operationId: 'original-inbox-operation', createdAt: 1,
    sender: { kind: 'human', principal: 'local-cli' }, recipient: { kind: 'agent-session', agentSessionId: 'caller' },
    senderSessionId: null, senderRunId: null, recipientSessionId: 'caller', recipientRunId: 'run-caller',
    threadId: 'original-inbox', correlationId: 'original-inbox', replyTo: null, workspaceId: null, body: 'Original durable inbox body' })
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new AgentMuxError('Native connection unavailable', 'PRIVATE_NATIVE_UNAVAILABLE'))
  return { ...h, path, rpc, queue, connect, auth: { capability: h.capability, callerAgentSessionId: 'caller' } }
}
it('checks and acknowledges the original durable batch through actual Unix RPC without connecting Native', async () => {
  const h = await fixture(), options = { credentials: h.credentials }
  const batch = await available(h.rpc.call('message.inbox.check', { limit: 10 }, options))
  expect(batch).toMatchObject({ consumerId: 'caller', readerRun: { runId: 'run-caller' },
    messages: [{ envelope: { messageId: 'original-inbox', body: 'Original durable inbox body' } }] })
  expect(await available(h.rpc.call('message.inbox.ack', { generation: batch.generation, readerRun: batch.readerRun }, options)))
    .toMatchObject({ consumerId: 'caller', nextGeneration: batch.generation + 1, acknowledgedMessageIds: ['original-inbox'] })
  expect((await available(h.rpc.call('message.inbox.check', { limit: 10 }, options))).messages).toEqual([])
  expect(h.connect).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('keeps Hosted check and ack available when general Native observation cannot connect', async () => {
  const h = await fixture(), hosted = await connectHostedAgentMux({ rpc: h.rpc, waitForReady: false }); cleanup.push(() => hosted.dispose())
  const batch = await available(hosted.checkDeliveries({ ...h.auth, limit: 10 }))
  expect(batch.messages.map(message => message.envelope.body)).toEqual(['Original durable inbox body'])
  expect(await available(hosted.ackDeliveryBatch({ ...h.auth, readerRun: batch.readerRun, generation: batch.generation })))
    .toMatchObject({ acknowledgedMessageIds: ['original-inbox'], nextGeneration: batch.generation + 1 })
  expect((await available(h.client.checkDeliveries({ ...h.auth, limit: 10 }))).messages).toEqual([])
})
it('uses compiled CLI inbox check and ack against the original offline semantic endpoint', async () => {
  const h = await fixture(), env = objectCliEnvironment(h.root, {
    AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
  const prefix = ['--endpoint', 'unix://' + h.path, 'message', 'inbox']
  const checked = await runCompiledObjectCli([...prefix, 'check', '--limit', '10'], env)
  expect(checked.code, checked.stderr).toBe(0)
  const batch = JSON.parse(checked.stdout).result
  expect(batch.messages.map((message: { envelope: { body: string } }) => message.envelope.body)).toEqual(['Original durable inbox body'])
  const ack = await runCompiledObjectCli([...prefix, 'ack', '--generation', String(batch.generation), '--reader-run', batch.readerRun.runId], env)
  expect(ack.code, ack.stderr).toBe(0); expect(JSON.parse(ack.stdout).result.acknowledgedMessageIds).toEqual(['original-inbox'])
  expect(h.connect).not.toHaveBeenCalled()
})
it('still rejects a wrong capability, stale generation and changed reader Run while Native is offline', async () => {
  const h = await fixture(), batch = await available(h.client.checkDeliveries({ ...h.auth, limit: 10 }))
  await expect(h.rpc.call('message.inbox.check', { limit: 10 }, { credentials: { ...h.credentials, capability: 'wrong' } }))
    .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(h.client.ackDeliveryBatch({ ...h.auth, generation: batch.generation + 1, readerRun: batch.readerRun }))
    .rejects.toMatchObject({ code: 'AGENT_DELIVERY_GENERATION_STALE' })
  await expect(h.client.ackDeliveryBatch({ ...h.auth, generation: batch.generation, readerRun: { runId: 'wrong-run' } }))
    .rejects.toMatchObject({ code: 'MESSAGE_ACK_GENERATION_STALE' })
  expect((await available(h.client.checkDeliveries({ ...h.auth, limit: 10 }))).messages.map(message => message.envelope.messageId)).toEqual(['original-inbox'])
})
it.each(['check', 'ack'] as const)('reauthorizes current capability inside the real %s journal transaction', async method => {
  const h = await fixture(), batch = await available(h.client.checkDeliveries({ ...h.auth, limit: 10 }))
  const ownerQueue = Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue
  const original = ownerQueue[method].bind(ownerQueue), replacement = issueAgentCapability()
  const rotate = async () => {
    const previous = (await h.store.readMetadata('caller'))!
    await h.store.compareAndSwapMetadata(previous, { ...previous, capabilityHash: hashAgentCapability(replacement) })
  }
  if (method === 'check') vi.spyOn(ownerQueue, 'check').mockImplementationOnce(async (...args) => { await rotate(); return await (original as typeof ownerQueue.check)(...args) })
  else vi.spyOn(ownerQueue, 'ack').mockImplementationOnce(async (...args) => { await rotate(); return await (original as typeof ownerQueue.ack)(...args) })
  const pending = method === 'check' ? h.client.checkDeliveries({ ...h.auth, limit: 10 })
    : h.client.ackDeliveryBatch({ ...h.auth, generation: batch.generation, readerRun: batch.readerRun })
  await expect(pending).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const current = await available(h.client.checkDeliveries({ ...h.auth, capability: replacement, limit: 10 }))
  expect(current.messages.map(message => message.envelope.messageId)).toEqual(['original-inbox'])
})
it('rechecks the current reader Run inside the ack transaction rather than trusting intake metadata', async () => {
  const h = await fixture(), batch = await available(h.client.checkDeliveries({ ...h.auth, limit: 10 }))
  const ownerQueue = Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue, original = ownerQueue.ack.bind(ownerQueue)
  vi.spyOn(ownerQueue, 'ack').mockImplementationOnce(async (...args) => {
    const previous = (await h.store.readMetadata('caller'))!
    await h.store.compareAndSwapMetadata(previous, { ...previous, run: { runId: 'current-reader' }, retiredRuns: [previous.run] })
    return await original(...args)
  })
  await expect(h.client.ackDeliveryBatch({ ...h.auth, generation: batch.generation, readerRun: batch.readerRun }))
    .rejects.toMatchObject({ code: 'MESSAGE_ACK_GENERATION_STALE' })
  const current = await available(h.client.checkDeliveries({ ...h.auth, limit: 10 }))
  expect(current.readerRun).toEqual({ runId: 'current-reader' })
  expect(current.messages.map(message => message.envelope.messageId)).toEqual(['original-inbox'])
})
