import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentHookServer } from '../src/hook-server.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { CLAUDE_NOTICE_ADMISSION_EVENT, CLAUDE_TURN_END_EVENT } from '@agentmux/providers/claude/native-activity'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

// Real authenticated Hook HTTP, Core Store/journal and notification owner. The managed module's
// requests are the exact envelopes the Hook runner sends for it; Runtime bytes are a port.
async function fixture() {
  const h = await rpcOwnerFixture(['sender', 'recipient'], undefined, () => ({ providerId: 'claude', executorId: 'claude' }))
  cleanup.push(h.close)
  const original = (await h.store.readMetadata('recipient'))!
  await h.store.compareAndSwapMetadata(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-recipient' } })
  await h.inner.registry.load('local')
  const server = Reflect.get(h.client, 'hookServer') as AgentHookServer
  await server.start()
  const binding = server.createBinding('recipient', 'claude'); await binding.bindRun('run-recipient')
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
  const post = (receiptId: string, eventName: string, payload: Record<string, unknown>, decision: boolean) => fetch(binding.endpoint.url, {
    method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId, eventName, ...(decision ? { decision: true } : {}),
      payload: { hook_event_name: eventName, session_id: 'native-recipient', ...payload } }) })
  /** The module's ask at an answered main turn end. */
  const ask = (receiptId: string, payload: Record<string, unknown> = {}) =>
    post(receiptId, CLAUDE_TURN_END_EVENT, { turnId: 'turn-1', reason: 'answer', ...payload }, true)
  /** The module's report of what Claude's own idle queue did with the notice. */
  const report = async (receiptId: string, notificationId: string, outcome: { entered: true } | { dropped: string }, sessionId = 'native-recipient') => {
    const response = await post(receiptId, CLAUDE_NOTICE_ADMISSION_EVENT, { notificationId, ...outcome, session_id: sessionId }, false)
    expect(response.status).toBe(204)
    const state = Reflect.get(notifications, 'observation') as { ready?: Promise<void> } | undefined
    await state?.ready
  }
  const notices = async () => (await queue.readJournal()).filter(record => record.kind === 'a2a-notification')
  const results = async () => (await queue.readJournal()).filter(record => record.kind === 'a2a-notification-result')
  const read = (messageId: string) => h.client.readMessage({ messageId, caller: h.credentials })
  return { ...h, server, binding, events, send, ask, report, notices, results, read, settled }
}

it('hands the frozen references to Claude’s idle queue and records them submitted only on its admission', async () => {
  const h = await fixture()
  await h.send('pending-1')
  const response = await h.ask('ask-1')
  expect(response.headers.get('x-agentmux-hook-mode')).toBe('decision')
  const { agentmuxNotice } = await response.json() as { agentmuxNotice: { notificationId: string; text: string } }
  expect(agentmuxNotice.text).toContain('msg-id="pending-1"')
  expect(agentmuxNotice.text).not.toContain('Original body')
  const [notice] = await h.notices()
  expect(notice).toMatchObject({ notification: { notificationId: agentmuxNotice.notificationId, wire: agentmuxNotice.text,
    turnEnd: { nativeTurnId: 'turn-1', hookReceiptId: 'ask-1' } } })
  // Written to the module is only "handed over"; the native queue's own admission decides.
  await new Promise(resolve => setTimeout(resolve, 50))
  // Handed to the native queue, it no longer waits for an automatic path, so it names none.
  expect((await h.read('pending-1'))?.notification).toMatchObject({ state: 'pending', notificationId: agentmuxNotice.notificationId })
  expect((await h.read('pending-1'))?.notification).not.toHaveProperty('automatic')
  await h.report('admit-1', agentmuxNotice.notificationId, { entered: true })
  await expect.poll(async () => (await h.read('pending-1'))?.notification?.state).toBe('submitted')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(h.rawInput).not.toHaveBeenCalled()
})

it('returns references to awaiting notification when Claude’s queue drops the notice', async () => {
  const h = await fixture()
  await h.send('dropped')
  const first = await (await h.ask('ask-drop')).json() as { agentmuxNotice: { notificationId: string } }
  await h.report('admit-drop', first.agentmuxNotice.notificationId, { dropped: 'the session was stopped and nobody has sent input since' })
  // The notice itself is a confirmed whole refusal; its original message is awaiting notification again.
  await expect.poll(async () => (await h.results()).find(record => record.notificationId === first.agentmuxNotice.notificationId)?.state).toBe('not-applied')
  expect((await h.read('dropped'))?.notification).toEqual({ state: 'pending', automatic: 'turn-end' })
  // The next real turn end hands the same original reference again, through a new notice.
  const next = await (await h.ask('ask-next', { turnId: 'turn-2' })).json() as { agentmuxNotice: { notificationId: string; text: string } }
  expect(next.agentmuxNotice.notificationId).not.toBe(first.agentmuxNotice.notificationId)
  expect(next.agentmuxNotice.text).toContain('msg-id="dropped"')
})

it.each([
  ['an interrupted turn', { reason: 'aborted' }],
  ['a refused turn', { reason: 'refusal' }],
  ['a subagent turn', { agent_id: 'child-1' }],
  ['another native session', { session_id: 'native-foreign' }],
])('abstains on %s and keeps the Inbox pending', async (_label, payload) => {
  const h = await fixture()
  await h.send('pending')
  expect(await (await h.ask('ask-other', payload)).json()).toEqual({})
  expect(await h.notices()).toEqual([])
  expect((await h.read('pending'))?.notification?.state).toBe('pending')
})

it('decides each native turn once and never hands an earlier notice again', async () => {
  const h = await fixture()
  await h.send('first')
  const a = await (await h.ask('ask-a')).json() as { agentmuxNotice: { notificationId: string } }
  expect(a.agentmuxNotice).toBeDefined()
  expect(await (await h.ask('ask-b')).json()).toEqual({})
  await h.send('second')
  const c = await (await h.ask('ask-c', { turnId: 'turn-2' })).json() as { agentmuxNotice: { text: string } }
  expect(c.agentmuxNotice.text).toContain('msg-id="second"')
  expect(c.agentmuxNotice.text).not.toContain('msg-id="first"')
})

it('ignores an admission report for another session, an unknown notice or one already settled', async () => {
  const h = await fixture()
  await h.send('guarded')
  const { agentmuxNotice } = await (await h.ask('ask-guard')).json() as { agentmuxNotice: { notificationId: string } }
  await h.report('admit-foreign', agentmuxNotice.notificationId, { entered: true }, 'native-foreign')
  await h.report('admit-unknown', 'a2a-notice-unknown', { entered: true })
  expect((await h.read('guarded'))?.notification?.state).toBe('pending')
  await h.report('admit-real', agentmuxNotice.notificationId, { entered: true })
  await expect.poll(async () => (await h.read('guarded'))?.notification?.state).toBe('submitted')
  await h.report('admit-late-drop', agentmuxNotice.notificationId, { dropped: 'late' })
  expect((await h.read('guarded'))?.notification?.state).toBe('submitted')
})

it('ignores an admission report that names a still-pending Input-owner notice of the same Run', async () => {
  const h = await fixture()
  await h.send('input-owned')
  // An Input-owner notice of this exact Run that has not settled yet: only its Input owner may record it.
  const queue = Reflect.get(h.client, 'messageQueue') as DurableAgentMuxMessageQueue
  const owned = await queue.prepareNotification({ agentSessionId: 'recipient', notificationId: 'a2a-notice-input-owned',
    condition: { expectedRun: h.client.agentSession('recipient').run, afterSubmissionId: null }, idle: { completionId: 'completion-owned', inputByte: 0 } })
  expect(owned?.state).toBe('pending')
  await h.report('admit-input-owned', owned!.notificationId, { entered: true })
  expect((await queue.readNotification(owned!.notificationId))?.state).toBe('pending')
})

it('keeps the module’s notice traffic out of Claude’s working and idle state', async () => {
  const h = await fixture()
  const before = h.client.agentSession('recipient').semanticStatus
  await h.send('quiet')
  const { agentmuxNotice } = await (await h.ask('ask-quiet')).json() as { agentmuxNotice: { notificationId: string } }
  await h.report('admit-quiet', agentmuxNotice.notificationId, { entered: true })
  await expect.poll(async () => (await h.read('quiet'))?.notification?.state).toBe('submitted')
  expect(h.client.agentSession('recipient').semanticStatus).toEqual(before)
})
