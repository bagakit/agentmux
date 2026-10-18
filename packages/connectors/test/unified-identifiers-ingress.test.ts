import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, DurableAgentMuxMessageQueue, isObjectId } from '@agentmux/core'
import { ingressFixture } from './fixtures/ingress.js'

const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close() })

it('original external ingress freezes shared IDs through Core journal and public inspection without replacing unknown input on redelivery', async () => {
  const f = await ingressFixture(true); clean.push(() => f.close())
  const received = await f.receive(), submitted = await f.ingress.dispatch(received.ingress.ingressId), ref = submitted.ingress!.input!
  for (const value of [received.ingress.ingressId, ref.operationId, ref.messageId]) expect(isObjectId(value)).toBe(true)
  expect(ref.operationId).not.toBe(ref.messageId)
  const journal = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  const original = await journal.readByOperationId(ref.operationId)
  expect(original?.envelope).toMatchObject({ messageId: ref.messageId, operationId: ref.operationId, recipientRunId: ref.expectedRun.runId, body: f.event().body, sender: ref.author })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'identity-inspect.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start(); clean.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); clean.push(() => sdk.dispose())
  const inspected = await sdk.call('connection.ingress.inspect', { ingressId: received.ingress.ingressId })
  expect(inspected.ingress?.input).toEqual(ref)
  expect(inspected.inputReceipt?.originalControlOperationId).toBe(ref.operationId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const replay = await f.receive()
  expect(replay.ingress.ingressId).toBe(received.ingress.ingressId)
  await f.ingress.dispatch(replay.ingress.ingressId)
  expect((await sdk.call('connection.ingress.inspect', { ingressId: replay.ingress.ingressId })).ingress?.input).toEqual(ref)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})
