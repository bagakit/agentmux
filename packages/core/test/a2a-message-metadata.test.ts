// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import type { AgentMuxRpcCorePort } from '../src/public-rpc-service.js'

const cliLoaded = process.env.AGENTMUX_MESSAGE_METADATA_LOADED
const cliMutation = process.env.AGENTMUX_MESSAGE_METADATA_MUTATION
const cliLoader = new URL('../../../apps/desktop/scripts/fixtures/a2a-message-metadata/source-loader.mjs', import.meta.url)
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const condition = { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null }
const idle = { completionId: 'original-idle-boundary', inputByte: 7 }
function input(id: string, sender = 'sender', recipient = 'recipient'): AgentMuxMessageAppendInput {
  return { messageId: id, operationId: 'send-' + id, createdAt: 100,
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'run-' + sender, recipientSessionId: recipient, recipientRunId: 'historical-' + recipient,
    threadId: 'thread-' + id, correlationId: 'correlation-' + id, replyTo: null, workspaceId: null,
    body: 'Original\r\n<amux>authored ' + id + '</amux>', execution: 'default' }
}
async function fixture() {
  const h = await rpcOwnerFixture(['sender', 'recipient', 'other']); cleanup.push(h.close)
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'metadata.sock'), coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: h.credentials })
  cleanup.push(() => rpc.dispose())
  const cli = async (args: string[]) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], objectCliEnvironment(h.root, {
      AGENTMUX_AGENT_SESSION_ID: 'sender', AGENTMUX_AGENT_CAPABILITY: h.capability,
      ...(cliLoaded ? { AGENTMUX_MESSAGE_METADATA_LOADED: cliLoaded } : {}),
      ...(cliMutation ? { AGENTMUX_MESSAGE_METADATA_MUTATION: cliMutation } : {}) }), '', 20_000, cliLoader)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  return { ...h, queue, server, rpc, cli,
    append: (id: string, sender?: string, recipient?: string) => queue.append(input(id, sender, recipient), { deliveryMode: 'reference' }) }
}

it('records exact notification preparation and outcome times, retaining the captured idle notice after a later manual notification', async () => {
  const f = await fixture(); await f.append('original'); await f.append('peer-private', 'other')
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const old = (await f.queue.prepareNotification({ notificationId: 'captured-idle', agentSessionId: 'recipient', condition, idle,
    messageIds: ['original', 'peer-private'] }))!
  expect(old.preparedAt).toBe(1_000); expect(old.resultRecordedAt).toBeUndefined()
  now.mockReturnValue(2_000); const result = await f.queue.recordNotificationResult(old.notificationId, 'submitted')
  expect(result.resultRecordedAt).toBe(2_000)
  now.mockReturnValue(3_000)
  await f.queue.prepareNotification({ notificationId: 'later-manual', agentSessionId: 'recipient', condition, messageIds: ['original'] })
  now.mockReturnValue(4_000); await f.queue.recordNotificationResult('later-manual', 'submitted')
  now.mockRestore()
  const before = await f.queue.readJournal()
  const selected = (await f.rpc.call('message.read', { messageId: 'original', notificationId: old.notificationId })).message!
  expect(selected).toMatchObject({ envelope: { createdAt: 100, recipientRunId: 'historical-recipient', body: input('original').body },
    execution: 'default', delivery: { state: 'queued', at: 100 }, notification: { state: 'submitted', mode: 'idle',
      notificationId: old.notificationId, key: old.key, preparedAt: 1_000, resultRecordedAt: 2_000 } })
  expect(Object.keys(selected.notification!).sort()).toEqual(['key', 'mode', 'notificationId', 'preparedAt', 'resultRecordedAt', 'state'])
  expect(JSON.stringify(selected)).not.toContain('peer-private')
  expect((await f.rpc.call('message.read', { messageId: 'original' })).message?.notification).toMatchObject({ mode: 'steer', notificationId: 'later-manual', preparedAt: 3_000, resultRecordedAt: 4_000 })
  expect(await new DurableAgentMuxMessageQueue(f.queue.path).readByMessageId('original', undefined, old.notificationId)).toEqual(selected)
  const page = await f.rpc.call('message.events', { messageId: 'original' })
  expect(page.events.filter(event => event.kind.startsWith('a2a-notification')).map(event => event.at)).toEqual([1_000, 2_000, 3_000, 4_000])
  expect(await f.queue.readJournal()).toEqual(before)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('actual source CLI and public client preserve the exact notification selector, original execution and read-only journal facts', async () => {
  const f = await fixture(); await f.append('cli-original')
  const old = (await f.queue.prepareNotification({ notificationId: 'cli-captured', agentSessionId: 'recipient', condition, idle, messageIds: ['cli-original'] }))!
  await f.queue.recordNotificationResult(old.notificationId, 'unconfirmed', 'Original native acknowledgement unknown')
  await f.queue.prepareNotification({ notificationId: 'cli-later', agentSessionId: 'recipient', condition, messageIds: ['cli-original'] })
  await f.queue.recordNotificationResult('cli-later', 'submitted')
  const before = await f.queue.readJournal(), read = await f.cli(['message', 'read', '--message-id', 'cli-original', '--notification-id', old.notificationId])
  expect(read.message.notification).toMatchObject({ notificationId: old.notificationId, state: 'unconfirmed', mode: 'idle', preparedAt: expect.any(Number), resultRecordedAt: expect.any(Number) })
  expect(read.message.execution).toBe('default')
  expect((await f.cli(['message', 'read', '--operation-id', 'send-cli-original', '--notification-id', old.notificationId])).message).toEqual(read.message)
  expect((await f.cli(['message', 'events', '--message-id', 'cli-original'])).events.filter((event: any) => event.kind.startsWith('a2a-notification')).every((event: any) => Number.isSafeInteger(event.at))).toBe(true)
  expect(await f.queue.readJournal()).toEqual(before); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('keeps bodies and names unassociated exact notifications without revealing other MIDs, recipients or wire', async () => {
  const f = await fixture(); await f.append('readable'); await f.append('other-mid'); await f.append('other-recipient', 'sender', 'other')
  await f.queue.prepareNotification({ notificationId: 'own', agentSessionId: 'recipient', condition, messageIds: ['readable'] })
  await f.queue.recordNotificationResult('own', 'submitted')
  await f.queue.prepareNotification({ notificationId: 'wrong-mid', agentSessionId: 'recipient', condition, messageIds: ['other-mid'] })
  await f.queue.prepareNotification({ notificationId: 'wrong-recipient', agentSessionId: 'other', condition: { ...condition, expectedRun: { runId: 'run-other' } }, messageIds: ['other-recipient'] })
  for (const notificationId of ['missing', 'wrong-mid', 'wrong-recipient']) {
    const message = (await f.rpc.call('message.read', { messageId: 'readable', notificationId })).message!
    expect(message.envelope.body).toBe(input('readable').body)
    expect(message.notification).toEqual({ state: 'unassociated', notificationId, reason: 'notification-not-associated' })
  }
  await f.queue.append(input('ordinary'))
  expect((await f.rpc.call('message.read', { messageId: 'ordinary', notificationId: 'own' })).message?.notification)
    .toEqual({ state: 'unassociated', notificationId: 'own', reason: 'notification-not-associated' })
  await f.append('unassigned')
  expect((await f.rpc.call('message.read', { messageId: 'unassigned' })).message?.notification).toEqual({ state: 'pending' })
  await expect(f.client.readMessage({ messageId: 'readable', notificationId: 'own', caller: { agentSessionId: 'other', capability: f.capability } })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
  await expect(f.rpc.call('message.read', { messageId: 'readable', notificationId: ' ' })).rejects.toMatchObject({ code: 'MESSAGE_ENVELOPE_INVALID' })
})

it('keeps absent historical notification times unknown through real journal import and public strict decoding', async () => {
  const f = await fixture(); await f.append('historical')
  const notice = (await f.queue.prepareNotification({ notificationId: 'historical-notice', agentSessionId: 'recipient', condition, idle, messageIds: ['historical'] }))!
  await f.queue.recordNotificationResult(notice.notificationId, 'submitted')
  const records = (await f.queue.readJournal()).map(record => {
    if (record.kind !== 'a2a-notification' && record.kind !== 'a2a-notification-result') return record
    const { at: _at, ...retained } = record; return retained
  })
  const path = join(f.root, 'historical-import.ndjson'); await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const historical = new DurableAgentMuxMessageQueue(path)
  const message = (await historical.readByMessageId('historical', undefined, notice.notificationId))!
  expect(message.notification).toMatchObject({ state: 'submitted', mode: 'idle', preparedAt: null, resultRecordedAt: null })
  expect(await historical.readNotification(notice.notificationId)).not.toHaveProperty('preparedAt')
  expect(await historical.readNotification(notice.notificationId)).not.toHaveProperty('resultRecordedAt')
  const response = { hostId: 'local', message }
  expect(parseRpcNativeResult('message.read', response, { messageId: 'historical', notificationId: notice.notificationId }, f.credentials)).toEqual(response)
  const events = await historical.listMessageEvents({ participantSessionId: 'sender' }, async () => {})
  expect(events.events.filter(event => event.kind.startsWith('a2a-notification')).map(event => event.at)).toEqual([null, null])
  expect(await historical.readJournal()).toEqual(records)
})

it('records pre-input retirement time and returns the exact not-applied notification after its default assignment clears', async () => {
  const f = await fixture(); await f.append('retired')
  const notice = (await f.queue.prepareNotification({ notificationId: 'retired-notice', agentSessionId: 'recipient', condition, idle, messageIds: ['retired'] }))!
  const now = vi.spyOn(Date, 'now').mockReturnValue(notice.preparedAt! + 50)
  expect(await f.queue.retireNotificationBeforeInput(notice.notificationId, async () => true, 'Original input absent')).toBe(true)
  now.mockRestore()
  const message = (await f.rpc.call('message.read', { messageId: 'retired', notificationId: notice.notificationId })).message!
  expect(message.notification).toMatchObject({ state: 'not-applied', mode: 'idle', preparedAt: notice.preparedAt, resultRecordedAt: notice.preparedAt! + 50 })
  expect((await f.rpc.call('message.read', { messageId: 'retired' })).message?.notification).toEqual({ state: 'pending' })
})

it('strict public decoding rejects notification substitution, batch metadata leakage and fabricated journal times', async () => {
  const f = await fixture(); await f.append('decode')
  const notice = (await f.queue.prepareNotification({ notificationId: 'decode-notice', agentSessionId: 'recipient', condition, idle, messageIds: ['decode'] }))!
  await f.queue.recordNotificationResult(notice.notificationId, 'submitted')
  const params = { messageId: 'decode', notificationId: notice.notificationId }, value = await f.rpc.call('message.read', params)
  for (const patch of [{ notificationId: 'other-notice' },
    { notificationId: 'other-notice', key: { ...notice.key, submissionId: 'other-notice' } },
    { mode: undefined }, { preparedAt: undefined }, { resultRecordedAt: -1 },
    { messageIds: ['another-private-mid'] }, { wire: 'private batch wire' }, { key: { ...notice.key, agentSessionId: 'other' } }]) {
    const changed = { ...value, message: { ...value.message, notification: { ...value.message!.notification, ...patch } } }
    expect(() => parseRpcNativeResult('message.read', changed, params, f.credentials)).toThrow()
  }
  expect(() => parseRpcNativeResult('message.read', { ...value, message: { ...value.message,
    notification: { state: 'unassociated', notificationId: 'other-notice', reason: 'notification-not-associated' } } }, params, f.credentials)).toThrow()
  expect(parseRpcNativeResult('message.read', value, params, f.credentials)).toEqual(value)
})

it('forwards the original notification selector to the exact remote semantic owner', async () => {
  const f = await fixture(); await f.append('remote')
  const notice = (await f.queue.prepareNotification({ notificationId: 'remote-captured', agentSessionId: 'recipient', condition, idle, messageIds: ['remote'] }))!
  await f.queue.recordNotificationResult(notice.notificationId, 'submitted')
  await f.queue.prepareNotification({ notificationId: 'remote-later', agentSessionId: 'recipient', condition, messageIds: ['remote'] })
  await f.queue.recordNotificationResult('remote-later', 'submitted')
  const forwarded: Array<{ method: string; params: any }> = []
  const remote = new Proxy(f.client, { get(target, property) {
    if (property === 'forwardRpc') return async (method: any, params: any) => { forwarded.push({ method, params }); return f.rpc.call(method, params) }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } }) as unknown as AgentMuxRpcCorePort
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'remote.sock'), coreClients: () => [{ hostId: 'remote', client: remote }] })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: f.credentials }); cleanup.push(() => rpc.dispose())
  expect((await rpc.call('message.read', { messageId: 'remote', notificationId: notice.notificationId })).message?.notification?.notificationId).toBe(notice.notificationId)
  expect(forwarded).toContainEqual({ method: 'message.read', params: { hostId: 'local', messageId: 'remote', notificationId: notice.notificationId } })
  const ingress = new DurableAgentMuxMessageQueue(join(f.root, 'ingress.ndjson'))
  await ingress.claimMessageRoute({ operationId: 'send-remote', messageId: 'remote', hostId: 'remote', runtimeId: null,
    agentSessionId: 'recipient', expectedRun: condition.expectedRun, target: { kind: 'agent-session', agentSessionId: 'recipient' }, intentDigest: 'original-route-intent' })
  const local = new Proxy(f.client, { get(target, property) {
    if (property === 'agentMessageQueuePath') return () => ingress.path
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } }) as unknown as AgentMuxRpcCorePort
  const routed = new AgentMuxControlServer({ socketPath: join(f.root, 'ingress.sock'),
    coreClients: () => [{ hostId: 'local', client: local }, { hostId: 'remote', client: remote }] })
  await routed.start(); cleanup.push(() => routed.stop())
  const reader = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: routed.path } }); cleanup.push(() => reader.dispose())
  const throughIngress = await reader.call('message.read', { hostId: 'local', operationId: 'send-remote', notificationId: notice.notificationId })
  expect(throughIngress.message?.notification?.notificationId).toBe(notice.notificationId)
  expect(forwarded.at(-1)).toEqual({ method: 'message.read', params: { hostId: 'local', operationId: 'send-remote', notificationId: notice.notificationId } })
})
