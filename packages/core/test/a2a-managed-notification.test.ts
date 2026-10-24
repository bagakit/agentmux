import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import type { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentProviderRegistry } from '../src/agent-provider.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const cliLoaded = process.env.AGENTMUX_MANAGED_NOTIFICATION_CLI_LOADED
const sourceMutation = process.env.AGENTMUX_MANAGED_NOTIFICATION_MUTATION

// The product's listener worker is a separate process, so resolve its source too.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Actual public server, Core authorization, Input owner and durable journal.
 * The Runtime byte port and Provider byte encoder are controlled private leaves. */
async function fixture() {
  const h = await rpcOwnerFixture(['caller', 'recipient', 'other', 'stranger']); cleanup.push(h.close)
  const providers = Reflect.get(h.client, 'providers') as AgentProviderRegistry
  vi.spyOn(providers.get('codex'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const queue = Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue
  expect(queue.path).toBe(join(h.root, 'messages.ndjson'))
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'managed.sock'), coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const participant = async (agentSessionId: string) => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId, capability: h.capability } })
    cleanup.push(() => rpc.dispose()); return rpc
  }
  const rpc = await participant('caller')
  const cliRaw = async (args: string[]) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], objectCliEnvironment(h.root, {
      AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability,
      ...(cliLoaded ? { AGENTMUX_MANAGED_NOTIFICATION_CLI_LOADED: cliLoaded } : {}),
      ...(sourceMutation ? { AGENTMUX_MANAGED_NOTIFICATION_MUTATION: sourceMutation } : {})
    }), '', 20_000, new URL('./fixtures/a2a-managed-notification/source-loader.mjs', import.meta.url))
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return result.stdout
  }
  const cli = async (args: string[]) => JSON.parse(await cliRaw(args)).result
  const append = (messageId: string, sender = 'caller') => queue.append({ messageId, operationId: 'send-' + messageId, createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: sender }, senderSessionId: sender, senderRunId: 'run-' + sender,
    recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
    threadId: 'original-thread', correlationId: 'correlation-' + messageId, replyTo: null, workspaceId: null,
    body: 'Original Inbox body ' + messageId }, { deliveryMode: 'reference' })
  const revoke = async () => {
    const before = (await h.store.readMetadata('caller'))!
    await h.store.compareAndSwapMetadata(before, { ...before, capabilityHash: hashAgentCapability(issueAgentCapability()), updatedAt: before.updatedAt + 1 })
  }
  return { ...h, queue, rpc, participant, cli, cliRaw, append, revoke }
}

it('source CLI preserves ordinary Inbox references and sends an explicit immediate original through the existing message Input owner', async () => {
  const f = await fixture(), body = 'Original managed body\n<amux>authored example</amux>  '
  await f.cli(['agent', 'send', '--to-session', 'recipient', '--text', body, '--operation-id', 'ordinary-op', '--message-id', 'ordinary-mid'])
  const ordinary = (await f.queue.readByMessageId('ordinary-mid'))!
  expect(ordinary).toMatchObject({ deliveryMode: 'reference', envelope: { senderSessionId: 'caller', recipientSessionId: 'recipient', body } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await expect(f.rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: 'recipient' }, text: body,
    execution: 'immediate', operationId: 'ordinary-op', messageId: 'ordinary-mid' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  const sent = await f.cli(['agent', 'send', '--to-session', 'recipient', '--text', body, '--execution', 'immediate', '--operation-id', 'immediate-op', '--message-id', 'immediate-mid'])
  const immediate = (await f.queue.readByMessageId('immediate-mid'))!
  expect(immediate.envelope).toMatchObject({ messageId: 'immediate-mid', body, senderSessionId: 'caller', senderRunId: 'run-caller', recipientRunId: 'run-recipient' })
  expect(immediate.deliveryMode).toBeUndefined()
  expect(sent.inputReceipt.key).toMatchObject({ kind: 'message', messageId: 'immediate-mid', expectedRun: { runId: 'run-recipient' } })
  // First-save acknowledgement precedes the asynchronous Input owner. Observe its actual public receipt.
  await vi.waitFor(async () => {
    const current = await f.rpc.call('agent.input.inspect', { key: sent.inputReceipt.key })
    expect(current.input).toMatchObject({ status: 'terminal-confirmed', persistence: 'confirmed' })
    expect((await f.queue.readByMessageId('immediate-mid'))?.delivery.state).toBe('delivered')
  }, { timeout: 3000, interval: 20 })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const wire = vi.mocked(f.inner.kernel.input as (...args: any[]) => unknown).mock.calls[0]![1].data as string
  expect(wire).toContain('<amux:a2a from="caller" msg-id="immediate-mid">')
  expect(wire).toContain(body); expect(wire).not.toContain('read-via=')
  await f.cli(['agent', 'send', '--to-session', 'recipient', '--text', body, '--execution', 'immediate', '--operation-id', 'immediate-op', '--message-id', 'immediate-mid'])
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const journal = await f.queue.readJournal()
  expect(journal.filter(event => event.kind === 'message')).toHaveLength(2)
  expect(journal.filter(event => event.kind === 'a2a-notification')).toHaveLength(0)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('source CLI notifies an existing MID with one immediate reference and inspect remains read-only', async () => {
  const f = await fixture(), original = await f.append('reference-mid')
  const result = await f.cli(['message', 'notify', '--host', 'local', '--message-id', 'reference-mid', '--operation-id', 'reference-notice'])
  expect(result.notification).toMatchObject({ notificationId: 'reference-notice', state: 'submitted', mode: 'steer', messageIds: ['reference-mid'], key: { expectedRun: { runId: 'run-recipient' } } })
  expect((await f.queue.readByMessageId('reference-mid'))!.envelope).toEqual(original.envelope)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const wire = vi.mocked(f.inner.kernel.input as (...args: any[]) => unknown).mock.calls[0]![1].data as string
  expect(wire).toContain('msg-id="reference-mid"'); expect(wire).toContain('read-via="message --skill"')
  expect(wire).not.toContain(original.envelope.body)
  const before = await f.queue.readJournal()
  const inspected = await f.cli(['message', 'notify', 'inspect', '--host', 'local', '--operation-id', 'reference-notice'])
  expect(inspected.notification).toEqual(result.notification)
  expect(await f.queue.readJournal()).toEqual(before); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('permits the original receiver but rejects every unassociated MID and foreign notification inspection', async () => {
  const f = await fixture(); await f.append('owned'); await f.append('foreign', 'other')
  const recipient = await f.participant('recipient')
  const result = await recipient.call('message.notify', { hostId: 'local', operationId: 'recipient-notice', messageIds: ['owned'] })
  expect(result.notification.state).toBe('submitted')
  const before = await f.queue.readJournal(), writes = vi.mocked(f.inner.kernel.input as (...args: any[]) => unknown).mock.calls.length
  const mixed = await f.rpc.call('message.notify', { hostId: 'local', operationId: 'mixed-foreign-notice', messageIds: ['owned', 'foreign'] })
    .then(value => ({ value }), error => ({ error }))
  expect(mixed).toMatchObject({ error: { code: 'MESSAGE_PARTICIPANT_MISMATCH' } })
  const stranger = await f.participant('stranger')
  await expect(stranger.call('message.notify.inspect', { hostId: 'local', operationId: 'recipient-notice' })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
  expect(await f.queue.readJournal()).toEqual(before); expect(f.inner.kernel.input).toHaveBeenCalledTimes(writes)
})

it('retains one unknown notification and its original key without another write or implicit acknowledgement', async () => {
  const f = await fixture(); await f.append('unknown-mid')
  vi.mocked(f.inner.kernel.input as (...args: any[]) => unknown).mockRejectedValue(new Error('Private original byte acknowledgement lost'))
  const params = { hostId: 'local', operationId: 'unknown-notice', messageIds: ['unknown-mid'] }
  const first = await f.rpc.call('message.notify', params)
  expect(first.notification.state).toBe('unconfirmed')
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const before = await f.queue.readJournal()
  const inspected = await f.rpc.call('message.notify.inspect', { hostId: 'local', operationId: params.operationId })
  const repeated = await f.rpc.call('message.notify', params)
  expect(inspected.notification?.key).toEqual(first.notification.key); expect(repeated.notification.key).toEqual(first.notification.key)
  expect(await f.queue.readJournal()).toEqual(before); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
})

it('rejects revoked caller credentials before notification preparation while retaining healthy receiver input', async () => {
  const f = await fixture(); await f.append('revoked-mid'); const before = await f.queue.readJournal()
  await f.revoke()
  await expect(f.rpc.call('message.notify', { hostId: 'local', operationId: 'revoked-notice', messageIds: ['revoked-mid'] })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(await f.queue.readJournal()).toEqual(before); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.client.agentSession('recipient'))?.run.runId).toBe('run-recipient')
})

it('rechecks caller capability after the original notification is prepared and before any input bytes', async () => {
  const f = await fixture(); await f.append('boundary-mid')
  const prepare = f.queue.prepareNotification.bind(f.queue)
  vi.spyOn(f.queue, 'prepareNotification').mockImplementation(async (...args) => { const result = await prepare(...args); await f.revoke(); return result })
  const result = await f.rpc.call('message.notify', { hostId: 'local', operationId: 'boundary-notice', messageIds: ['boundary-mid'] })
  expect(result.notification.state).toBe('not-applied')
  expect(result.notification.reason).toMatch(/capability/iu)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.queue.readByMessageId('boundary-mid'))?.envelope.body).toBe('Original Inbox body boundary-mid')
})

it('actual generated skill and leaf help distinguish advisory notification choices, direct body input and read-only inspection', async () => {
  const f = await fixture()
  const skill = await f.cliRaw(['message', '--skill'])
  expect(skill).toContain('Authenticated Agent participants')
  expect(skill).toMatch(/advisory/iu)
  expect(skill).toContain('immediate')
  expect(skill).not.toContain('Managed senders cannot self-authorize steer')
  expect(skill).not.toContain('Managed Agents cannot self-authorize this steer')
  const send = await f.cliRaw(['agent', 'send', '--help'])
  expect(send).toContain('--execution default|immediate')
  expect(send).toContain('original body')
  const notify = await f.cliRaw(['message', 'notify', '--help'])
  expect(notify).toContain('authenticated participant')
  expect(notify).toContain('not a resend or a body read')
  const inspect = await f.cliRaw(['message', 'notify', 'inspect', '--help'])
  expect(inspect).toContain('without sending')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.queue.readJournal()).toEqual([])
})
