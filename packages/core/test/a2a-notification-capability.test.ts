import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentMuxError } from '../src/errors.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

async function fixture(providerId: 'grok' | 'codex', working = true) {
  const h = await rpcOwnerFixture(['sender', 'recipient'], undefined, () => ({ providerId, executorId: providerId }))
  cleanup.push(h.close)
  const original = (await h.store.readMetadata('recipient'))!
  const semanticStatus: NonNullable<AgentMuxStoredAgentSession['semanticStatus']> = {
    state: 'working', source: 'native-hook', observedAt: 1, detail: 'post_tool_use'
  }
  await h.store.compareAndSwapMetadata(original, { ...original,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'original-native' }, ...(working ? { semanticStatus } : {}) })
  await h.inner.registry.load('local')
  const providers = Reflect.get(h.client, 'providers') as AgentProviderRegistry
  const notifications = Reflect.get(h.client, 'messageNotifications')
  const publisher = Reflect.get(h.client, 'publisher') as AgentMuxClientEventPublisher
  const queue = new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson'))
  const events: AgentMuxClientEvent[] = []; h.client.onEvent(event => events.push(event))
  const settled = async () => {
    await notifications.observation?.ready
    const drains = Reflect.get(notifications, 'drains') as Map<string, { pending: Promise<void> }>
    while (drains.size) await Promise.all([...drains.values()].map(entry => entry.pending))
  }
  const send = async (messageId: string) => {
    await h.client.submitAgentMessage({ agentSessionId: 'recipient', caller: h.credentials,
      envelope: { schema: 'agentmux.a2a.v1', messageId, operationId: 'send-' + messageId, createdAt: 1,
        sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
        senderSessionId: 'sender', senderRunId: 'run-sender', recipientSessionId: 'recipient', recipientRunId: original.run.runId,
        threadId: 'original-thread', correlationId: 'correlation-' + messageId, replyTo: null, workspaceId: null,
        body: 'Retained original ' + messageId } })
    await settled()
  }
  const changed = async () => { publisher.publish({ type: 'agent-session', session: h.client.agentSession('recipient') }); await settled() }
  const diagnostics = () => events.filter((event): event is Extract<AgentMuxClientEvent, { type: 'agent-error' }> =>
    event.type === 'agent-error' && event.code === 'A2A_NOTIFICATION_UNCONFIRMED')
  return { ...h, original, semanticStatus: working ? semanticStatus : undefined, providers, queue, events, send, settled, notifications, changed, diagnostics }
}

async function retained(h: Awaited<ReturnType<typeof fixture>>, messageId: string) {
  const message = await h.client.readMessage({ messageId, caller: h.credentials })
  expect(message).toMatchObject({ deliveryMode: 'reference', delivery: { state: 'queued' }, notification: { state: 'pending' },
    envelope: { body: 'Retained original ' + messageId, recipientRunId: h.original.run.runId } })
  expect((await h.queue.readJournal()).some(record => record.kind === 'a2a-notification')).toBe(false)
  expect(h.client.agentSession('recipient').run).toEqual(h.original.run)
  expect(h.client.agentSession('recipient').semanticStatus).toEqual(h.semanticStatus)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
}

it('explains the missing built-in Grok idle notification transport while preserving its Inbox and manual input', async () => {
  const h = await fixture('grok')
  expect(h.providers.get('grok').prepareNativeInput).toBeUndefined()
  await h.send('original-grok-message'); await retained(h, 'original-grok-message')
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: 'recipient',
    code: 'A2A_NOTIFICATION_UNCONFIRMED', message: expect.stringContaining('automatic idle-only Inbox notifications'), evidence: expect.objectContaining({ run: h.original.run }) }))
  expect(h.diagnostics()[0]?.message).toContain('healthy manual input')
  expect(h.diagnostics()[0]?.message).toContain('explicitly notify')
  const ack = await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: h.original.run, source: 'user', data: 'Existing draft' })
  expect(ack.appliedByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength('Existing draft') })
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  expect(h.client.agentSession('recipient').semanticStatus).toEqual(h.semanticStatus)
})

it('uses the built-in Grok terminal input to explicitly notify an original MID while its automatic queue is unavailable', async () => {
  const h = await fixture('grok')
  await h.send('original-grok-reference'); await retained(h, 'original-grok-reference')
  const request = { operationId: 'grok-explicit-notice', messageIds: ['original-grok-reference'], caller: h.credentials }
  const result = await h.client.notifyMessages(request)
  expect(result.notification).toMatchObject({ state: 'submitted', mode: 'steer', messageIds: ['original-grok-reference'],
    key: { expectedRun: h.original.run, submissionId: request.operationId } })
  expect(result.input?.admission?.acknowledged === true || result.input?.terminalPromptSubmission?.submit.acknowledged === true).toBe(true)
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1)
  const wire = vi.mocked(h.inner.kernel.input as (...args: any[]) => unknown).mock.calls[0]![1].data as string
  expect(wire).toContain('msg-id="original-grok-reference"')
  expect(wire).not.toContain('Retained original original-grok-reference')
  expect((await h.queue.readByMessageId('original-grok-reference'))?.envelope.body).toBe('Retained original original-grok-reference')
  const repeated = await h.client.notifyMessages(request)
  expect(repeated.notification.key).toEqual(result.notification.key)
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each([true, false])('checks the actual native input contribution before waiting on current working=%s', async working => {
  const h = await fixture('codex', working), provider = h.providers.get('codex')
  expect(provider.catalog.capabilities.nativeConversationInput?.managedRuns).toBe(true)
  h.providers.replace({ ...provider, prepareNativeInput: undefined })
  await h.send('missing-implementation'); await retained(h, 'missing-implementation')
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: 'recipient',
    code: 'A2A_NOTIFICATION_UNCONFIRMED', message: expect.stringContaining('idle-only') }))
})

it('does not invent unsupported transport from an absent catalog field when the native input contribution exists', async () => {
  const h = await fixture('codex'), provider = h.providers.get('codex')
  const { nativeConversationInput: _discovery, ...capabilities } = provider.catalog.capabilities
  const prepare = vi.fn(async () => { throw new Error('A working recipient has no idle input opportunity') })
  h.providers.replace({ ...provider, catalog: { ...provider.catalog, capabilities }, prepareNativeInput: prepare })
  await h.send('supported-current-work'); await retained(h, 'supported-current-work')
  expect(prepare).not.toHaveBeenCalled()
  expect(h.events.filter(event => event.type === 'agent-error' && event.code === 'A2A_NOTIFICATION_UNCONFIRMED')).toEqual([])
})

it('keeps one failure observation through repeated Session updates, unavailable reads and reconnection', async () => {
  const h = await fixture('grok')
  await h.send('pending-reference')
  expect(h.diagnostics()).toHaveLength(1)
  for (let index = 0; index < 3; index++) await h.changed()
  await h.notifications.restore(); await h.settled()
  const registry = Reflect.get(h.client, 'registry') as import('../src/agent-session-registry.js').AgentMuxAgentSessionRegistry
  const absent = vi.spyOn(registry, 'has').mockReturnValue(false)
  await h.changed(); absent.mockRestore(); await h.changed()
  expect(h.diagnostics()).toHaveLength(1)
  await retained(h, 'pending-reference')
})

it('reports a new failure after successful observation or a changed Run without settling the original message', async () => {
  const h = await fixture('grok'), missing = h.providers.get('grok')
  await h.send('recoverable-reference')
  const prepare = vi.fn(async () => { throw new Error('A working recipient cannot prepare an idle notice') })
  h.providers.replace({ ...missing, prepareNativeInput: prepare }); await h.changed()
  h.providers.replace(missing); await h.changed()
  expect(h.diagnostics()).toHaveLength(2)
  await retained(h, 'recoverable-reference'); expect(prepare).not.toHaveBeenCalled()
  const original = (await h.store.readMetadata('recipient'))!, nextRun = { runId: 'next-recipient-run' }
  await h.store.compareAndSwap(original, { ...original, run: nextRun, retiredRuns: [original.run] })
  await h.inner.registry.load('local'); await h.changed()
  expect(h.diagnostics()).toHaveLength(3)
  expect(h.diagnostics().map(event => event.evidence.run)).toEqual([h.original.run, h.original.run, nextRun])
  expect((await h.queue.readByMessageId('recoverable-reference'))?.envelope.recipientRunId).toBe(h.original.run.runId)
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('retains the observed Run when a Provider read rejects after the registry advances', async () => {
  const h = await fixture('codex', false), provider = h.providers.get('codex')
  h.providers.replace({ ...provider, prepareNativeInput: undefined }); await h.send('read-race')
  let reject!: (error: Error) => void
  const pending = new Promise<never>((_resolve, rejectRead) => { reject = rejectRead })
  const read = vi.fn(() => pending)
  h.providers.replace({ ...provider, readPromptExecutionEvidence: read })
  const changed = h.changed(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwap(original, { ...original, run: { runId: 'replacement-run' }, retiredRuns: [original.run] })
  await h.inner.registry.load('local')
  reject(new AgentMuxError('Native read rejected', 'PRIVATE_READ_UNAVAILABLE')); await changed
  expect(h.diagnostics().at(-1)).toMatchObject({ message: expect.stringContaining('Native read rejected'), evidence: { run: h.original.run } })
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('delivers the pending reference through the original owner when the native capability becomes available', async () => {
  const h = await fixture('codex', false), provider = h.providers.get('codex')
  h.providers.replace({ ...provider, prepareNativeInput: undefined }); await h.send('awaiting-capability')
  const native = vi.fn(async (_wire: string) => ({ outcome: 'admitted' as const, queuedSubmissionId: 'private-native-notice' }))
  h.inner.kernel.status = vi.fn(async id => ({ ...h.run(id), pid: 1234 }))
  h.providers.replace({ ...provider,
    readPromptExecutionEvidence: async () => ({ state: 'idle', sourceId: 'private-source', id: 'private-idle' }),
    prepareNativeInput: async (_context, target) => ({ plan: { kind: 'native-rpc', protocolId: 'private-capability',
      sourceId: JSON.stringify([target.providerId, target.nativeSessionId]), threadId: target.nativeSessionId,
      actorId: 'private-writer', operation: 'queue-idle' }, assertCurrent: async () => {}, dispose: async () => {}, send: native }) })
  await h.changed()
  expect(native).toHaveBeenCalledTimes(1)
  expect(native.mock.calls[0]?.[0]).toContain('awaiting-capability')
  expect((await h.queue.readByMessageId('awaiting-capability'))?.notification).toMatchObject({ state: 'submitted' })
  expect(h.diagnostics()).toHaveLength(1)
  await h.changed(); expect(native).toHaveBeenCalledTimes(1)
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
