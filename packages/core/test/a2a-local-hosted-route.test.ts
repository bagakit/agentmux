import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { DurableAgentMuxMessageQueue as SourceQueue } from '../src/agent-global-message-queue.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const entry = process.env.AGENTMUX_TEST_ROUTE_DIST
const Server: typeof SourceServer = entry ? (await import(entry + 'public-rpc-server.js')).AgentMuxControlServer : SourceServer
const Queue: typeof SourceQueue = entry ? (await import(entry + 'agent-global-message-queue.js')).DurableAgentMuxMessageQueue : SourceQueue
const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('a local Hosted proxy and receiving Core share one original journal across first send and a lost ACK', async () => {
  const f = await rpcOwnerFixture(['recipient-a', 'recipient-b']); disposals.push(f.close)
  vi.spyOn(Reflect.get(f.client, 'providers').get('codex'), 'planPromptInput')
    .mockImplementation((text: string) => ({ kind: 'single-phase', data: text + '\r' }))
  const queue = new Queue(f.client.agentMessageQueuePath())
  const receiving = new Server({ socketPath: join(f.root, 'receiving.sock'), coreClients: f.coreClients })
  await receiving.start(); disposals.push(() => receiving.stop())
  const receiver = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: receiving.path } }); disposals.push(() => receiver.dispose())
  let loseAck = true, occupant = 'recipient-a'
  const client = Object.create(f.client)
  client.forwardRpc = async (method: string, params: any) => {
    const result = await receiver.call(method as 'agent.send', params)
    if (method === 'agent.send' && loseAck) { loseAck = false; throw Object.assign(new Error('private local ACK lost after commit'), { code: 'CONTROL_UNAVAILABLE' }) }
    return result
  }
  const inspect = vi.fn(async () => ({ presentation: { region: { kind: 'agent', agentSessionId: occupant } } }))
  const proxy = new Server({ socketPath: join(f.root, 'proxy.sock'), coreClients: () => [{ hostId: 'local', client }], forwardControl: inspect as any })
  await proxy.start(); disposals.push(() => proxy.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: proxy.path } }); disposals.push(() => rpc.dispose())
  const params = { target: { kind: 'region' as const, regionId: 'original-region' }, text: 'Local original <reminder>authored</reminder>',
    execution: 'immediate' as const, sourceChannel: 'cli' as const, operationId: 'local-original-operation', messageId: 'local-original-message' }
  const failure = await rpc.call('agent.send', params).catch(error => error)
  expect(failure.code).toBe('CONTROL_UNAVAILABLE')
  expect(failure.message).toBe('private local ACK lost after commit')
  const original = (await queue.listAfter())[0]!
  expect(original.envelope).toMatchObject({ messageId: params.messageId, body: params.text, recipientSessionId: 'recipient-a', recipientRunId: 'run-recipient-a' })
  occupant = 'recipient-b'
  const repeated = await rpc.call('agent.send', { ...params, operationId: 'another-local-control' })
  expect(repeated).toMatchObject({ sequence: original.sequence, envelope: original.envelope })
  expect(await rpc.call('message.read', { hostId: 'local', operationId: params.operationId })).toMatchObject({ message: { envelope: original.envelope } })
  expect(inspect).toHaveBeenCalledOnce()
  expect(await queue.listAfter()).toHaveLength(1)
  expect(await queue.readMessageRoute(params.operationId, params.messageId)).toBeNull()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)
