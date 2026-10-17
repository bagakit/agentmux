import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { prepareCodexNativeInput } from '../src/providers/codex-native-input.js'
import { createNativeInputCorrelation } from '../src/native-input-correlation.js'

const locator = vi.hoisted(() => ({ endpoint: '' }))
vi.mock('../src/agent-native-process.js', () => ({ nativeProcessBirth: async (pid: number) => `original-birth-${pid}`,
  nativeProcessTcpListeners: async () => [{ processId: 4321, endpoint: locator.endpoint }] }))
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const source = { providerId: 'codex', nativeSessionId: 'original-thread' }, prompt = 'Original frozen reference notification'
const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }

async function fixture(options: { lostAck?: boolean; conflict?: 'client-id' | 'wire'; invalid?: boolean; active?: boolean } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Private actor socket is missing')
  locator.endpoint = `ws://127.0.0.1:${address.port}`
  const requests: Array<{ method: string; params: Record<string, any> }> = []
  const authorization: Array<string | undefined> = []
  const queued: unknown[] = []
  server.on('connection', (socket, request) => {
    authorization.push(request.headers.authorization)
    socket.on('message', data => {
      const value = JSON.parse(data.toString()); requests.push(value)
      if (!Object.hasOwn(value, 'id')) return
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }))
      switch (value.method) {
        case 'initialize': return reply({})
        case 'thread/read': return reply({ thread: { id: source.nativeSessionId, canAcceptDirectInput: true, status: { type: options.active ? 'active' : 'idle' } } })
        case 'thread/queue/add': {
          if (options.invalid) return socket.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32600, message: 'Original actor rejected this queue input' } }))
          const item = { id: 'original-queue-item', clientUserMessageId: value.params.clientUserMessageId, input: value.params.input }; queued.push(item)
          if (options.lostAck) return socket.close()
          return reply({ queuedSubmission: { ...item, ...(options.conflict === 'client-id' ? { clientUserMessageId: 'foreign-input' } : {}),
            ...(options.conflict === 'wire' ? { input: [{ type: 'text', text: 'changed wire' }] } : {}) } })
        }
        case 'turn/start': return reply({ turn: { id: 'manual-turn' } })
        case 'turn/steer': return reply({ turnId: value.params.expectedTurnId })
        default: return socket.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'No such operation' } }))
      }
    })
  })
  closes.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const prepare = async (idleOnly = true, expectedTurnId?: string) => {
    const result = await prepareCodexNativeInput({ processId: 1234, nativeActor: actor, workspacePath: '.', signal: new AbortController().signal },
      { ...source, ...(idleOnly ? { idleOnly: true } : {}), ...(expectedTurnId ? { expectedTurnId } : {}) })
    closes.push(async () => result.dispose())
    return result
  }
  const correlation = createNativeInputCorrelation({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'original-notification' })
  return { prepare, correlation, requests, authorization, queued }
}

it.each([false, true])('sends only the exact frozen native queue input even when active=%s; never starts another queue item', async active => {
  const f = await fixture({ active }), prepared = await f.prepare(), plan = { ...prepared.plan, clientCorrelation: f.correlation }
  expect(prepared.plan.operation).toBe('queue-idle')
  await expect(prepared.send(prompt, plan)).resolves.toEqual({ outcome: 'admitted', queuedSubmissionId: 'original-queue-item' })
  expect(f.queued).toEqual([{ id: 'original-queue-item', clientUserMessageId: f.correlation, input: [{ type: 'text', text: prompt, text_elements: [] }] }])
  expect(f.requests.filter(value => value.method === 'thread/queue/add')).toEqual([expect.objectContaining({ params: { threadId: source.nativeSessionId,
    input: [{ type: 'text', text: prompt, text_elements: [] }], clientUserMessageId: f.correlation } })])
  expect(f.requests.some(value => ['thread/queue/start', 'turn/start', 'turn/steer'].includes(value.method))).toBe(false)
  expect(f.authorization).toEqual([`Bearer ${actor.token}`])
})

it.each(['client-id', 'wire'] as const)('does not claim queue acceptance from a mismatched %s receipt', async conflict => {
  const f = await fixture({ conflict }), prepared = await f.prepare()
  await expect(prepared.send(prompt, { ...prepared.plan, clientCorrelation: f.correlation })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect(f.queued).toHaveLength(1)
})

it('keeps ACK loss unknown and distinguishes an explicit native rejection without retrying', async () => {
  const lost = await fixture({ lostAck: true }), prepared = await lost.prepare()
  await expect(prepared.send(prompt, { ...prepared.plan, clientCorrelation: lost.correlation })).rejects.toThrow()
  expect(lost.queued).toHaveLength(1)
  const rejected = await fixture({ invalid: true }), original = await rejected.prepare()
  await expect(original.send(prompt, { ...original.plan, clientCorrelation: rejected.correlation })).resolves.toEqual({ outcome: 'not-applied', errorCode: -32600 })
  expect(rejected.queued).toHaveLength(0)
})

it('retains original manual start-or-steer and exact-turn steer semantics', async () => {
  const f = await fixture({ active: true }), manual = await f.prepare(false), exact = await f.prepare(false, 'original-active-turn')
  await expect(manual.send('Original manual input', { ...manual.plan, clientCorrelation: f.correlation })).resolves.toEqual({ outcome: 'admitted', turnId: 'manual-turn' })
  await expect(exact.send('Original turn reply', { ...exact.plan, clientCorrelation: f.correlation })).resolves.toEqual({ outcome: 'admitted', turnId: 'original-active-turn' })
  expect(f.queued).toHaveLength(0)
  expect(f.requests.filter(value => value.method.startsWith('turn/')).map(value => value.method)).toEqual(['turn/start', 'turn/steer'])
})
