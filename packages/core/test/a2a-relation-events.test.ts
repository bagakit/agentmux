import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { parseMessageEventsPage, parseMessageEventsQuery } from '../src/agent-message-events.js'
import { parseHostedMessageEvent } from '../src/hosted-value.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import type { AgentMuxRpcResult } from '../src/public-rpc.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function original(id: string, from = 'caller', to = 'recipient'): AgentMuxMessageAppendInput {
  return { messageId: id, operationId: 'operation-' + id, createdAt: fixtureEpoch(1),
    sender: { kind: 'agent-session', agentSessionId: from }, recipient: { kind: 'agent-session', agentSessionId: to },
    senderSessionId: from, senderRunId: 'run-' + from, recipientSessionId: to, recipientRunId: 'run-' + to,
    threadId: 'thread-' + id, correlationId: id, replyTo: null, workspaceId: null, body: 'Private original body ' + id }
}
async function owner() {
  const f = await rpcOwnerFixture(['caller', 'recipient', 'other']); closes.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'relations.sock'), coreClients: f.coreClients })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: f.credentials }); closes.push(() => rpc.dispose())
  return { ...f, server, rpc, queue: new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()) }
}
const sequences = (page: { events: readonly { sequence: number }[] }) => page.events.map(event => event.sequence)

it('the real source CLI and public owner read the latest related window, frozen older pages and independent forward deltas', async () => {
  const f = await owner()
  await f.queue.append(original('first')); await f.queue.append(original('unrelated', 'other'))
  await f.queue.append(original('second')); await f.queue.recordDelivery('second', 'delivered', fixtureEpoch(2))
  const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix://' + f.server.path,
    AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: f.capability })
  for (const args of [['message', 'events', '--help'], ['message', '--skill']]) {
    const help = await runSourceObjectCli(args, env)
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--latest'); expect(help.stdout).toContain('--before-sequence')
  }
  const result = await runSourceObjectCli(['message', 'events', '--latest', '--limit', '2'], env)
  expect(result.code, result.stdout + result.stderr).toBe(0)
  const latest = JSON.parse(result.stdout).result as AgentMuxRpcResult<'message.events'>
  expect(sequences(latest)).toEqual([3, 4]); expect(latest.latest).toBe(true)
  expect(latest.nextBeforeSequence).toBe(3); expect(latest.nextAfterSequence).toBeNull()
  await f.queue.append(original('newer'))
  const before = await runSourceObjectCli(['message', 'events', '--before-sequence', String(latest.nextBeforeSequence),
    '--through-sequence', String(latest.throughSequence), '--incarnation', latest.incarnation], env)
  expect(before.code, before.stdout + before.stderr).toBe(0)
  const older = JSON.parse(before.stdout).result as AgentMuxRpcResult<'message.events'>
  expect(sequences(older)).toEqual([1]); expect(older.nextBeforeSequence).toBeNull(); expect(older.latest).toBe(false)
  expect(older.beforeSequence).toBe(3); expect(older.throughSequence).toBe(4)
  const delta = await f.rpc.call('message.events', { afterSequence: latest.throughSequence })
  expect(sequences(delta)).toEqual([5]); expect(delta.nextBeforeSequence).toBeNull()
  const recipient = await f.client.listMessageEvents({ participantSessionId: 'recipient', latest: true, limit: 2 })
  expect(sequences(recipient)).toEqual([4, 5])
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('latest scoped selection uses related reverse index seeks and never decodes bodies or unrelated notifications', async () => {
  const f = await owner()
  await f.queue.append(original('old')); await f.queue.append(original('recent'))
  await f.client.listMessageEvents({ participantSessionId: 'caller' })
  for (let n = 0; n < 100; n++) await f.queue.append(original('noise-' + n, 'other'))
  await f.queue.recordDelivery('recent', 'delivered', fixtureEpoch(2))
  const queries: string[] = [], prepare = DatabaseSync.prototype.prepare, decoded: string[] = [], parse = JSON.parse
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('WITH selected AS (')) queries.push(sql)
    return prepare.call(this, sql)
  })
  vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: any) => {
    if (text.includes('Private original body')) decoded.push(text)
    return parse(text, reviver)
  })
  const page = await f.rpc.call('message.events', { latest: true, limit: 2 })
  expect(sequences(page)).toEqual([2, 103]); expect(decoded).toEqual([]); expect(queries).toHaveLength(1)
  const db = new DatabaseSync(f.queue.path, { readOnly: true })
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + queries[0]!).all('caller', 0, 103, 3, 'caller').map(row => String(row.detail)).join('\n')
    expect(plan).toContain('SEARCH message_event_positions USING PRIMARY KEY (participant_id=? AND event_sequence>? AND event_sequence<?)')
    expect(plan).not.toMatch(/SCAN (?:records|original|notice)\b/u)
    expect(queries[0]).toContain('ORDER BY event_sequence DESC LIMIT ?')
  } finally { db.close() }
  const exact = await f.rpc.call('message.events', { latest: true, messageId: 'old', limit: 1 })
  expect(sequences(exact)).toEqual([1]); expect(exact.nextBeforeSequence).toBeNull()
})

it('one original query and page contract rejects contradictory directions, cursor retargeting and forged continuation', async () => {
  const f = await owner(); await f.queue.append(original('first')); await f.queue.append(original('second'))
  const page = await f.rpc.call('message.events', { latest: true, limit: 1 })
  for (const bad of [{ latest: true, afterSequence: 0 }, { latest: true, beforeSequence: 2 }, { beforeSequence: 2 }, { latest: false }, { beforeSequence: 0 }]) {
    await expect(f.rpc.call('message.events', bad as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(() => parseMessageEventsQuery({ participantSessionId: 'caller', ...bad })).toThrow()
  }
  await expect(f.rpc.call('message.events', { beforeSequence: 2, throughSequence: page.throughSequence, incarnation: 'another' })).rejects.toMatchObject({ code: 'MESSAGE_EVENT_SOURCE_CHANGED' })
  await expect(f.rpc.call('message.events', { latest: true, participantSessionId: 'other' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
  const { hostId: _host, ...originalPage } = page
  expect(() => parseMessageEventsPage({ ...originalPage, latest: false }, { participantSessionId: 'caller', latest: true })).toThrow()
  expect(() => parseMessageEventsPage({ ...originalPage, nextAfterSequence: 2 }, { participantSessionId: 'caller', latest: true })).toThrow()
  expect(() => parseMessageEventsPage({ ...originalPage, nextBeforeSequence: 1 }, { participantSessionId: 'caller', latest: true })).toThrow()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('latest notifications preserve one original event and only this participant references', async () => {
  const f = await owner()
  await f.queue.append({ ...original('mine'), execution: 'default' }, { deliveryMode: 'reference' })
  await f.queue.append({ ...original('theirs', 'other'), execution: 'default' }, { deliveryMode: 'reference' })
  await f.queue.prepareNotification({ notificationId: 'notice', agentSessionId: 'recipient',
    condition: { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null } })
  const page = await f.rpc.call('message.events', { latest: true, limit: 1 })
  expect(page.events).toHaveLength(1); expect(page.events[0]).toMatchObject({ kind: 'a2a-notification', at: expect.any(Number) })
  expect(page.events[0]!.messages.map(ref => ref.messageId)).toEqual(['mine'])
})

it('a separate source writer publishes Dispatch changes through the real Hosted observer without consuming or replaying history', async () => {
  const f = await owner(), source = await f.queue.append(original('request'))
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client))
  closes.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'hosted.sock'), coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  closes.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false, expectedStorePath: f.store.path })
  closes.push(() => hosted.dispose())
  const events: AgentMuxClientEvent[] = [], release = hosted.onEvent(event => { events.push(event) }, { observeMessages: true }); closes.push(release)
  await hosted.connect()
  await vi.waitFor(() => expect(events.some(event => event.type === 'agent-message-observation' && event.state === 'available')).toBe(true))
  const loader = new URL('../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs', import.meta.url)
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
  async function writer(mode: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration),
      fileURLToPath(new URL('./fixtures/message-journal-writer.mjs', import.meta.url)),
      new URL('../src/agent-global-message-queue.ts', import.meta.url).href, mode, f.queue.path, source.messageId], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stderr.on('data', value => { log += value }); child.stdout.on('data', () => {})
    const [code] = await once(child, 'exit'); expect(code, log).toBe(0)
  }
  await writer('dispatch-open')
  await vi.waitFor(() => expect(events.some(event => event.type === 'agent-message-changed' && event.recordKind === 'dispatch-open')).toBe(true))
  await writer('dispatch-report')
  await vi.waitFor(() => expect(events.some(event => event.type === 'agent-message-changed' && event.recordKind === 'dispatch-event')).toBe(true))
  const changes = events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'agent-message-changed' }> => event.type === 'agent-message-changed' && event.recordKind.startsWith('dispatch-'))
  expect(changes).toHaveLength(2); expect(changes.every(event => event.live && event.messageId === 'request' && event.senderSessionId === 'caller' && event.recipientSessionId === 'recipient')).toBe(true)
  for (const event of changes) expect(() => parseHostedMessageEvent(event)).not.toThrow()
  const page = await hosted.listMessageEvents({ participantSessionId: 'caller', latest: true, limit: 1 })
  expect(page.events[0]).toMatchObject({ kind: 'dispatch-event', eventKind: 'worker_done', replyMessageId: 'request-report' })
  const late: AgentMuxClientEvent[] = [], stop = hosted.onEvent(event => { late.push(event) }, { observeMessages: true }); closes.push(stop)
  await hosted.listMessageEvents({ participantSessionId: 'caller', latest: true })
  expect(late.some(event => event.type === 'agent-message-changed')).toBe(false)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
