import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { DurableAgentMuxMessageQueue as SourceQueue } from '../src/agent-global-message-queue.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentMuxRpcParams } from '../src/public-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const entry = process.env.AGENTMUX_TEST_ROUTE_DIST
const Server: typeof SourceServer = entry ? (await import(entry + 'public-rpc-server.js')).AgentMuxControlServer : SourceServer
const Queue: typeof SourceQueue = entry ? (await import(entry + 'agent-global-message-queue.js')).DurableAgentMuxMessageQueue : SourceQueue
const disposals: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture() {
  const source = await rpcOwnerFixture(['source-agent'])
  disposals.push(source.close)
  const a = await rpcOwnerFixture(['recipient-a']), b = await rpcOwnerFixture(['recipient-b'])
  disposals.push(a.close, b.close)
  const queue = new Queue(source.client.agentMessageQueuePath())
  const queues = { a: new Queue(a.client.agentMessageQueuePath()), b: new Queue(b.client.agentMessageQueuePath()) }
  let occupant = 'recipient-a', loseAck = true, available = true, runtimeId = 'semantic-a'
  const forwarded: Array<AgentMuxRpcParams<'agent.send'>> = []
  const endpoints = await Promise.all([a, b].map(async owner => {
    // The actual Core input owner and journal remain intact. Only Runtime bytes are a port.
    const provider = Reflect.get(owner.client, 'providers').get('codex')
    vi.spyOn(provider, 'planPromptInput').mockImplementation((text: string) => ({ kind: 'single-phase', data: text + '\r' }))
    const server = new Server({ socketPath: join(owner.root, 'remote.sock'), coreClients: owner.coreClients })
    await server.start(); disposals.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    disposals.push(() => rpc.dispose())
    return { owner, rpc }
  }))
  const remotes = endpoints.map(({ owner, rpc }, index) => {
    const client = Object.create(owner.client) as typeof owner.client & { forwardRpc: NonNullable<import('../src/hosted-client-contract.js').AgentMuxHostedForwardRpc> }
    Object.assign(client, {
      runtimeOwnerIdentity: () => ({ runtimeId: index === 0 ? runtimeId : 'semantic-b', availability: 'connected' }),
      forwardRpc: async (method: string, params: any) => {
        if (method === 'agent.send') {
          // Durability precedes the possible remote side effect, even when its first ACK is lost.
          const route = await queue.readMessageRoute(params.operationId, params.messageId)
          expect(route, 'source must freeze route before remote admission').not.toBeNull()
          expect(route).toMatchObject({ messageId: params.messageId, agentSessionId: params.target.agentSessionId,
            expectedRun: params.expectedRun })
          forwarded.push(structuredClone(params))
        }
        const result = await rpc.call(method as 'agent.send', params)
        if (method === 'agent.send' && loseAck) { loseAck = false; throw Object.assign(new Error('private first remote ACK lost after commit'), { code: 'CONTROL_UNAVAILABLE' }) }
        return result
      }
    })
    return { hostId: index === 0 ? 'host-a' : 'host-b', client }
  })
  const coreClients = () => [...source.coreClients(), ...remotes.filter(scope => available || scope.hostId !== 'host-a')]
  const inspections = vi.fn(async () => ({ presentation: { region: { kind: 'agent', agentSessionId: occupant },
    tab: { regions: [{ kind: 'agent', agentSessionId: occupant }] } } }))
  const options = { coreClients, forwardControl: inspections as any }
  let server = new Server({ ...options, socketPath: join(source.root, 'source.sock') })
  await server.start()
  let rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  disposals.push(async () => { await rpc.dispose(); await server.stop() })
  const params: AgentMuxRpcParams<'agent.send'> = { target: { kind: 'region', regionId: 'original-region' },
    text: 'Original route body 中\n<reminder>authored text</reminder>  ', operationId: 'route-original-operation',
    messageId: 'route-original-message', execution: 'immediate', sourceChannel: 'cli' }
  return { source, a, b, queue, queues, forwarded, inspections, remotes, options, params,
    rpc: () => rpc, path: () => server.path, setOccupant: (id: string) => { occupant = id },
    available: (value: boolean) => { available = value }, runtime: (value: string) => { runtimeId = value },
    loseAck: (value: boolean) => { loseAck = value },
    reopen: async () => {
      await rpc.dispose(); await server.stop()
      server = new Server({ ...options, socketPath: join(source.root, 'source.sock') }); await server.start()
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    } }
}

it.each(['region', 'tab'] as const)('actual CLI + remote RPC retain original %s route across lost ACK, rebind and cold reopen', async kind => {
  const f = await fixture()
  f.params.target = kind === 'region' ? { kind, regionId: 'original-region' } : { kind, tabId: 'original-tab' }
  const result = await runCompiledObjectCli(['--endpoint', 'unix://' + f.path(), 'agent', 'send',
    kind === 'region' ? '--to-region' : '--to-tab', kind === 'region' ? 'original-region' : 'original-tab',
    '--text', f.params.text, '--execution', 'immediate', '--operation-id', f.params.operationId, '--message-id', f.params.messageId!],
  objectCliEnvironment(f.source.root))
  expect(result.code, result.stderr).toBe(1)
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'CONTROL_UNAVAILABLE', message: expect.stringContaining('first remote ACK lost') } })
  const original = (await f.queues.a.listAfter())[0]!
  expect(original.envelope).toMatchObject({ messageId: f.params.messageId, operationId: f.params.operationId,
    body: f.params.text, recipientSessionId: 'recipient-a', recipientRunId: 'run-recipient-a' })
  expect(await f.queues.b.listAfter()).toHaveLength(0)
  f.setOccupant('recipient-b'); await f.reopen()
  const repeated = await f.rpc().call('agent.send', f.params)
  const newControl = await f.rpc().call('agent.send', { ...f.params, operationId: 'another-control-operation' })
  for (const receipt of [repeated, newControl]) expect(receipt).toMatchObject({ messageId: original.envelope.messageId,
    sequence: original.sequence, envelope: original.envelope })
  const inspected = await f.rpc().call('message.read', { operationId: f.params.operationId, hostId: 'local' })
  expect(inspected).toMatchObject({ hostId: 'local', message: { envelope: original.envelope } })
  expect(f.inspections).toHaveBeenCalledOnce()
  expect(await f.queues.a.listAfter()).toHaveLength(1); expect(await f.queues.b.listAfter()).toHaveLength(0)
  expect(await f.queue.listAfter()).toHaveLength(0)
  const routeRecords = (await f.queue.readJournal()).filter(item => item.kind === 'message-route')
  expect(routeRecords).toHaveLength(1)
  expect(JSON.stringify(routeRecords)).not.toContain(f.params.text)
  expect(f.forwarded.every(p => p.operationId === f.params.operationId && p.messageId === f.params.messageId &&
    p.expectedRun?.runId === original.envelope.recipientRunId)).toBe(true)
}, 25_000)

it('rejects same-MID content, author, execution and explicit target conflicts before another remote call', async () => {
  const f = await fixture()
  await expect(f.rpc().call('agent.send', f.params)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const calls = f.forwarded.length
  for (const changed of [{ text: 'different body' }, { sourceChannel: 'api' as const }, { execution: 'default' as const }]) {
    await expect(f.rpc().call('agent.send', { ...f.params, ...changed, operationId: 'changed-control' })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
  }
  for (const target of [{ kind: 'agent-session' as const, agentSessionId: 'recipient-b' }, { kind: 'region' as const, regionId: 'different-region' }]) {
    await expect(f.rpc().call('agent.send', { ...f.params, target })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
  }
  const author = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.path() }, credentials: f.source.credentials })
  try { await expect(author.call('agent.send', f.params)).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' }) }
  finally { await author.dispose() }
  await expect(f.rpc().call('agent.send', { ...f.params, messageId: 'another-message' })).rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
  expect(f.forwarded).toHaveLength(calls)
  expect(await f.queues.b.listAfter()).toHaveLength(0)
  // An independent new message is still allowed; a conflict does not close healthy capability.
  f.setOccupant('recipient-b')
  const separate = await f.rpc().call('agent.send', { ...f.params, operationId: 'independent-operation', messageId: 'independent-message' })
  expect(separate.envelope.recipientSessionId).toBe('recipient-b')
  expect(f.source.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('keeps the original binding when its Host is absent or its semantic identity changes', async () => {
  const f = await fixture()
  await expect(f.rpc().call('agent.send', f.params)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  f.setOccupant('recipient-b'); f.available(false)
  await expect(f.rpc().call('agent.send', f.params)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(f.rpc().call('message.read', { operationId: f.params.operationId, hostId: 'local' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  f.available(true); f.runtime('replacement-semantic-owner')
  await expect(f.rpc().call('agent.send', { ...f.params, operationId: 'new-control' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.forwarded).toHaveLength(1); expect(await f.queues.b.listAfter()).toHaveLength(0)
  f.runtime('semantic-a')
  expect((await f.rpc().call('agent.send', f.params)).envelope.recipientSessionId).toBe('recipient-a')
}, 20_000)

it('cannot forward before the original routing journal is durable', async () => {
  const f = await fixture()
  const blocker = join(f.source.root, 'not-a-directory')
  await writeFile(blocker, 'private journal failure')
  const spy = vi.spyOn(f.source.client, 'agentMessageQueuePath').mockReturnValue(join(blocker, 'messages.sqlite'))
  await expect(f.rpc().call('agent.send', f.params)).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
  expect(f.forwarded).toHaveLength(0); expect(await f.queues.a.listAfter()).toHaveLength(0)
  spy.mockRestore()
  await expect(f.rpc().call('agent.send', f.params)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(await f.queues.a.listAfter()).toHaveLength(1)
  expect(f.source.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('concurrent first bindings and two queue instances choose one original owner without a second envelope', async () => {
  const f = await fixture(); f.loseAck(false)
  const requests = await Promise.allSettled([f.rpc().call('agent.send', f.params),
    f.rpc().call('agent.send', { ...f.params, operationId: 'parallel-control' })])
  expect(requests.some(item => item.status === 'fulfilled')).toBe(true)
  expect(await f.queues.a.listAfter()).toHaveLength(1); expect(await f.queues.b.listAfter()).toHaveLength(0)
  const other = new Queue(f.queue.path)
  const original = (await other.readMessageRoute(f.params.operationId, f.params.messageId))!
  const selected = await other.claimMessageRoute({ ...original, operationId: 'third-control', hostId: 'host-b', agentSessionId: 'recipient-b' })
  expect(selected).toEqual(original)
  expect((await f.queue.readJournal()).filter(item => item.kind === 'message-route')).toHaveLength(1)
}, 20_000)

it('retains the managed cross-owner refusal and the ordinary local public send', async () => {
  const f = await fixture()
  const agent = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.path() }, credentials: f.source.credentials })
  try { await expect(agent.call('agent.send', f.params)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' }) }
  finally { await agent.dispose() }
  expect(await f.queue.readMessageRoute(f.params.operationId, f.params.messageId)).toBeNull()
  f.setOccupant('source-agent')
  const local = await f.rpc().call('agent.send', f.params)
  expect(local.envelope.recipientSessionId).toBe('source-agent')
  expect(await f.queue.listAfter()).toHaveLength(1); expect(f.forwarded).toHaveLength(0)
}, 20_000)

it('does not override an explicit Run fence when a concurrent first route wins admission', async () => {
  const f = await fixture()
  const claim = Queue.prototype.claimMessageRoute
  vi.spyOn(Queue.prototype, 'claimMessageRoute').mockImplementationOnce(async function (this: SourceQueue, candidate) {
    await claim.call(this, { ...candidate, operationId: 'winning-control', expectedRun: { runId: 'first-bound-run' } })
    return await claim.call(this, candidate)
  })
  await expect(f.rpc().call('agent.send', { ...f.params, expectedRun: { runId: 'run-recipient-a' } })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
  expect(f.forwarded).toHaveLength(0)
  expect(await f.queue.readMessageRoute('winning-control', f.params.messageId)).toMatchObject({ expectedRun: { runId: 'first-bound-run' } })
  expect(await f.queues.a.listAfter()).toHaveLength(0)
}, 20_000)
