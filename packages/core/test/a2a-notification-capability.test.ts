import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

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
  return { ...h, original, semanticStatus: working ? semanticStatus : undefined, providers, queue, events, send, settled }
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
    code: 'A2A_NOTIFICATION_UNCONFIRMED', message: expect.stringContaining('idle-only') }))
  const ack = await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: h.original.run, source: 'user', data: 'Existing draft' })
  expect(ack.appliedByteRange).toEqual({ startByte: 0, endByte: Buffer.byteLength('Existing draft') })
  expect(h.inner.kernel.input).toHaveBeenCalledTimes(1)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  expect(h.client.agentSession('recipient').semanticStatus).toEqual(h.semanticStatus)
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
