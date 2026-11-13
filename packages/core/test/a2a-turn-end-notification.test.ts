import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentHookServer } from '../src/hook-server.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

// Real authenticated Hook HTTP, Core Store/journal and notification owner; Runtime bytes are a port.
async function fixture(providerId: 'grok' | 'codex' = 'grok') {
  const h = await rpcOwnerFixture(['sender', 'recipient'], undefined, () => ({ providerId, executorId: providerId }))
  cleanup.push(h.close)
  // The Store owns one native identity per Session; only the recipient is bound to it.
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, nativeHandle: { kind: 'provider', providerId, sessionId: 'native-recipient' } })
  await h.inner.registry.load('local')
  const server = Reflect.get(h.client, 'hookServer') as AgentHookServer
  await server.start()
  const binding = server.createBinding('recipient', providerId); await binding.bindRun('run-recipient')
  const queue = new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson'))
  const events: AgentMuxClientEvent[] = []; h.client.onEvent(event => { events.push(event) })
  const notifications = Reflect.get(h.client, 'messageNotifications')
  const settled = async () => {
    await notifications.observation?.ready
    const drains = Reflect.get(notifications, 'drains') as Map<string, { pending: Promise<void> }>
    while (drains.size) await Promise.all([...drains.values()].map(entry => entry.pending))
  }
  const send = async (messageId: string) => {
    await h.client.submitAgentMessage({ agentSessionId: 'recipient', caller: h.credentials,
      envelope: { schema: 'agentmux.a2a.v1', messageId, operationId: 'send-' + messageId, createdAt: 1,
        sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
        senderSessionId: 'sender', senderRunId: 'run-sender', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
        threadId: 'thread', correlationId: 'correlation-' + messageId, replyTo: null, workspaceId: null, body: 'Original body ' + messageId } })
    await settled()
  }
  /** The real Hook worker's request: it offers to wait, ingress chooses the declared decision. */
  const stop = (receiptId: string, payload: Record<string, unknown>, signal?: AbortSignal) => fetch(binding.endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, eventName: 'stop', decision: true, payload: { hookEventName: 'stop', sessionId: 'native-recipient',
      reason: 'end_turn', promptId: 'prompt-1', stopHookActive: false, ...payload } }), ...(signal ? { signal } : {}) })
  const notices = async () => (await queue.readJournal()).filter(record => record.kind === 'a2a-notification')
  const results = async () => (await queue.readJournal()).filter(record => record.kind === 'a2a-notification-result')
  const read = (messageId: string) => h.client.readMessage({ messageId, caller: h.credentials })
  return { ...h, server, binding, events, send, stop, notices, results, read, settled }
}

it('continues one genuinely completing Grok turn with the frozen references and records it submitted', async () => {
  const h = await fixture()
  await h.send('pending-1'); await h.send('pending-2')
  const response = await h.stop('stop-1', {})
  expect(response.headers.get('x-agentmux-hook-mode')).toBe('decision')
  const output = await response.json() as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(output.hookSpecificOutput.hookEventName).toBe('Stop')
  const wire = output.hookSpecificOutput.additionalContext
  expect(wire).toContain('msg-id="pending-1"'); expect(wire).toContain('msg-id="pending-2"')
  expect(wire).not.toContain('Original body')
  await expect.poll(async () => (await h.read('pending-1'))?.notification?.state).toBe('submitted')
  const [notice] = await h.notices()
  expect(notice).toMatchObject({ notification: { mode: 'idle', wire, messageIds: ['pending-1', 'pending-2'],
    turnEnd: { nativeTurnId: 'prompt-1', hookReceiptId: 'stop-1' } } })
  expect((await h.read('pending-2'))?.notification?.state).toBe('submitted')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.rawInput).not.toHaveBeenCalled()
})

it.each([
  ['a continuation stop of the same turn', { stopHookActive: true }],
  ['a stop that is not a genuine turn end', { reason: 'channel_closed' }],
  ['a subagent stop', { subagentType: 'explore', sessionId: 'native-child' }],
  ['a stop of another native session', { sessionId: 'native-foreign' }],
])('abstains on %s and keeps the Inbox pending', async (_label, payload) => {
  const h = await fixture()
  await h.send('pending')
  const response = await h.stop('stop-other', payload)
  expect(await response.json()).toEqual({})
  expect(await h.notices()).toEqual([])
  expect((await h.read('pending'))?.notification?.state).toBe('pending')
})

it('decides each native turn once and never answers a later stop of that turn', async () => {
  const h = await fixture()
  await h.send('first')
  expect((await (await h.stop('stop-a', {})).json() as Record<string, unknown>).hookSpecificOutput).toBeDefined()
  await h.send('second')
  expect(await (await h.stop('stop-b', { promptId: 'prompt-1' })).json()).toEqual({})
  expect(await h.notices()).toHaveLength(1)
  const next = await (await h.stop('stop-c', { promptId: 'prompt-2' })).json() as { hookSpecificOutput: { additionalContext: string } }
  expect(next.hookSpecificOutput.additionalContext).toContain('msg-id="second"')
  expect(next.hookSpecificOutput.additionalContext).not.toContain('msg-id="first"')
})

it('abstains without inventing a notice when nothing new is pending', async () => {
  const h = await fixture()
  expect(await (await h.stop('stop-empty', {})).json()).toEqual({})
  expect(await h.notices()).toEqual([])
})

it('never answers a later turn end with an earlier notice that is still unconfirmed', async () => {
  const h = await fixture()
  await h.send('unknown-earlier')
  // The Input owner holds an earlier idle notice whose outcome is unknown: it stays active for that owner.
  const queue = Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue
  const session = h.client.agentSession('recipient')
  const earlier = await queue.prepareNotification({ agentSessionId: 'recipient', notificationId: 'a2a-notice-earlier',
    condition: { expectedRun: session.run, afterSubmissionId: null }, idle: { completionId: 'completion-earlier', inputByte: 0 } })
  await queue.recordNotificationResult(earlier!.notificationId, 'unconfirmed', 'Original admission unknown.')
  expect(await (await h.stop('stop-after-unknown', {})).json()).toEqual({})
  expect((await h.notices()).map(record => record.notification.notificationId)).toEqual(['a2a-notice-earlier'])
})

it('records a lost response unconfirmed and never resends its references at a later turn end', async () => {
  const h = await fixture()
  await h.send('lost')
  const hold = Reflect.get(h.server, 'decide') as (...args: unknown[]) => Promise<boolean>
  vi.spyOn(h.server as unknown as { decide: typeof hold }, 'decide').mockImplementation(async function (this: AgentHookServer, ...args: unknown[]) {
    const callback = args[0] as { response: import('node:http').ServerResponse }
    callback.response.destroy()
    return await hold.apply(this, args)
  })
  await h.stop('stop-lost', {}).catch(() => undefined)
  await expect.poll(async () => (await h.read('lost'))?.notification?.state).toBe('unconfirmed')
  vi.restoreAllMocks()
  expect(await (await h.stop('stop-later', { promptId: 'prompt-2' })).json()).toEqual({})
  expect(await h.notices()).toHaveLength(1)
  // An idle opportunity and a later message never hand the lost notice to the Input owner as input.
  await h.send('after-loss')
  const messageNotifications = Reflect.get(h.client, 'messageNotifications') as { restore(): Promise<void> }
  await messageNotifications.restore(); await h.settled()
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.rawInput).not.toHaveBeenCalled()
  expect((await h.read('lost'))?.notification?.state).toBe('unconfirmed')
  expect(h.events.some(event => event.type === 'agent-error' && /Cannot read properties/u.test(event.message))).toBe(false)
})

it('tells the sender an idle Grok waits for its next turn end, without an error notice, while explicit notification stays available', async () => {
  const h = await fixture()
  await h.send('idle-wait')
  expect((await h.read('idle-wait'))?.notification).toEqual({ state: 'pending', automatic: 'turn-end' })
  // Waiting for the next turn end is a known path of a healthy Agent, not a failed observation.
  expect(h.events.filter(event => event.type === 'agent-error')).toEqual([])
  const explicit = await h.client.notifyMessages({ operationId: 'explicit-now', messageIds: ['idle-wait'], caller: h.credentials })
  expect(explicit.notification).toMatchObject({ mode: 'steer', messageIds: ['idle-wait'] })
})

it('keeps Codex on its native idle queue and never offers it a turn-end decision', async () => {
  const h = await fixture('codex')
  await h.send('codex-pending')
  const response = await h.stop('stop-codex', {})
  expect(response.headers.get('x-agentmux-hook-mode')).not.toBe('decision')
  expect(await h.notices()).toEqual([])
})
