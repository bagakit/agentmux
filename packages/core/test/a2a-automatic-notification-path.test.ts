import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

// The product's listener worker is a separate process, so resolve its source too.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** A sender's real source CLI over the actual public server, Core authorization and durable journal;
 * the recipient is one built-in Provider and the Runtime byte port is a controlled leaf. */
async function fixture(providerId: 'codex' | 'grok' | 'gemini') {
  const h = await rpcOwnerFixture(['caller', 'recipient'], undefined, () => ({ providerId, executorId: providerId })); cleanup.push(h.close)
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'managed.sock'), coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const events: AgentMuxClientEvent[] = []; h.client.onEvent(event => { events.push(event) })
  const cli = async (args: string[]) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], objectCliEnvironment(h.root, {
      AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability }), '', 20_000)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const settled = async () => {
    const notifications = Reflect.get(h.client, 'messageNotifications')
    await notifications.observation?.ready
    const drains = Reflect.get(notifications, 'drains') as Map<string, { pending: Promise<void> }>
    while (drains.size) await Promise.all([...drains.values()].map(entry => entry.pending))
  }
  return { ...h, cli, events, settled }
}

it.each([
  ['gemini', 'none'],
  ['grok', 'turn-end'],
  ['codex', 'idle-queue'],
] as const)('tells a %s recipient\'s sender its automatic path is %s on the send receipt and the read', async (providerId, automatic) => {
  const f = await fixture(providerId)
  const sent = await f.cli(['agent', 'send', '--to-session', 'recipient', '--text', 'Original body', '--operation-id', 'send-op', '--message-id', 'mid'])
  expect(sent).toMatchObject({ messageId: 'mid', deliveryMode: 'reference', notification: { state: 'pending', automatic } })
  await f.settled()
  const read = await f.cli(['message', 'read', '--message-id', 'mid'])
  expect(read.message).toMatchObject({ envelope: { body: 'Original body', recipientRunId: 'run-recipient' } })
  if (providerId !== 'codex') expect(read.message.notification).toEqual({ state: 'pending', automatic })
  const listed = await f.cli(['message', 'ls', '--direction', 'outgoing'])
  if (providerId !== 'codex') expect(listed.messages.map((message: { notification?: unknown }) => message.notification)).toEqual([{ state: 'pending', automatic }])
  // A healthy recipient without an automatic path is not an error to report.
  if (providerId !== 'codex') expect(f.events.filter(event => event.type === 'agent-error')).toEqual([])
})

it('keeps a recipient without an automatic path whole and reachable by explicit notification', async () => {
  const f = await fixture('gemini')
  await f.cli(['agent', 'send', '--to-session', 'recipient', '--text', 'Original body', '--operation-id', 'send-op', '--message-id', 'mid'])
  await f.settled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.client.agentSession('recipient').run).toEqual({ runId: 'run-recipient' })
  const ack = await f.client.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, source: 'user', data: 'Manual draft' })
  expect(ack.appliedByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength('Manual draft') })
  const notified = await f.cli(['message', 'notify', '--host', 'local', '--message-id', 'mid', '--operation-id', 'notify-op'])
  expect(notified.notification).toMatchObject({ state: 'submitted', mode: 'steer', messageIds: ['mid'] })
  // A prepared notice is no longer waiting for an automatic path, so the field is gone.
  const read = await f.client.readMessage({ messageId: 'mid' })
  expect(read?.notification).toMatchObject({ state: 'submitted', notificationId: 'notify-op' })
  expect(read?.notification).not.toHaveProperty('automatic')
})

it('keeps the path unknown when Core cannot name the recipient Session', async () => {
  const f = await fixture('gemini')
  await f.cli(['agent', 'send', '--to-session', 'recipient', '--text', 'Original body', '--operation-id', 'send-op', '--message-id', 'mid'])
  const registry = Reflect.get(f.client, 'registry') as { has(id: string): boolean }
  const has = registry.has.bind(registry)
  vi.spyOn(registry, 'has').mockImplementation(id => id !== 'recipient' && has(id))
  expect((await f.client.readMessage({ messageId: 'mid' }))?.notification).toEqual({ state: 'pending' })
  expect((await f.client.listMessages({ participantSessionId: 'caller', direction: 'outgoing' })).messages[0]?.notification).toEqual({ state: 'pending' })
})

it('refuses a path on a status that is no longer waiting for one at the public result boundary', async () => {
  const { parseRpcNativeResult } = await import('../src/rpc-native-codec.js')
  const envelope = { schema: 'agentmux.a2a.v1', messageId: 'mid', operationId: 'send-op', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'caller' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'caller', senderRunId: 'run-caller', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
    threadId: 'mid', correlationId: 'mid', replyTo: null, workspaceId: null, body: 'Original body' }
  const result = (notification: Record<string, unknown>) => ({ hostId: 'local', field: undefined, message: { sequence: 1, envelope,
    delivery: { state: 'queued', at: 1 }, deliveryMode: 'reference', notification, inputOrigin: null } })
  const read = (notification: Record<string, unknown>) => parseRpcNativeResult('message.read', result(notification), { messageId: 'mid' })
  const key = { kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'notify-op' }
  expect(() => read({ state: 'pending', automatic: 'none' })).not.toThrow()
  expect(() => read({ state: 'pending', automatic: 'idle' })).toThrow()
  expect(() => read({ state: 'submitted', notificationId: 'notify-op', key, mode: 'steer', preparedAt: 1, resultRecordedAt: 2, automatic: 'none' })).toThrow()
  expect(() => read({ state: 'pending', notificationId: 'notify-op', key, mode: 'steer', preparedAt: 1, resultRecordedAt: null, automatic: 'none' })).toThrow()
})
