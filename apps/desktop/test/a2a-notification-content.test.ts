import { expect, it, vi } from 'vitest'
import { composeA2AMessageNotification } from '../src/renderer/src/lib/a2a-notification-presentation'
import { createA2AMessageNotifier } from '../src/renderer/src/lib/a2a-message-notifier'
import { a2aNotificationContext } from '../src/renderer/src/lib/a2a-notification-context'
type A2ANotificationSnapshot = Parameters<typeof a2aNotificationContext>[0]
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'

const sender = { sessionId: 'original-sender', fallback: 'Codex · Scratch' }
const recipient = { sessionId: 'original-recipient', fallback: 'Codex · Scratch' }
const arrival = { type: 'core', hostId: 'local', event: { type: 'agent-message-changed', messageId: 'original-mid', sequence: 3,
  messageSequence: 3, recordKind: 'message', live: true, senderSessionId: sender.sessionId, recipientSessionId: recipient.sessionId } } as RuntimeEvent
const session = (id: string) => ({ id, label: 'Codex · Scratch', kind: 'agent', hostId: 'local',
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'original-run' } } }) as SessionSnapshot
const page = () => ({ hostId: 'local', participantSessionId: recipient.sessionId, direction: 'incoming', messages: [{ sequence: 3,
  envelope: { messageId: 'original-mid', senderSessionId: sender.sessionId, recipientSessionId: recipient.sessionId }, bodyPreview: 'Please review the notification copy.' }], nextBeforeSequence: null })
function fixture() {
  const notify = vi.fn(async () => {}), listMessages = vi.fn(async () => page() as never)
  const f = { snapshot: { config: null, sessions: [session(sender.sessionId), session(recipient.sessionId)], agentNames: {}, timelines: {},
    ready: true, windowFocused: false, visibleSessionIds: new Set() } as A2ANotificationSnapshot,
    notify, listMessages, owner: null as unknown as ReturnType<typeof createA2AMessageNotifier> }
  f.owner = createA2AMessageNotifier({ notify, listMessages, current: target => a2aNotificationContext(f.snapshot, target) })
  return f
}

it('puts the current original text below real task names, preserves user naming priority and avoids duplicated fallback names', () => {
  expect(composeA2AMessageNotification({ sender: { ...sender, userName: 'Notification design', firstPrompt: 'Ignored derived name' },
    recipient: { ...recipient, firstPrompt: 'Main coordination\nLater text' }, preview: '  Please\nreview  this copy.  ' })).toEqual({
    title: 'Notification design → Main coordination', body: 'Please review this copy.'
  })
  const same = composeA2AMessageNotification({ sender, recipient, preview: 'A distinct message.' })
  expect(same.title).toBe('Codex · Scratch · original-sender → original-recipient')
  expect(same.body).toBe('A distinct message.')
  expect(composeA2AMessageNotification({ sender, recipient, preview: '😀'.repeat(101) }).body).toBe('😀'.repeat(100) + '…')
  expect(composeA2AMessageNotification({ sender, recipient }).body).toContain('Message preview unavailable')
  expect(composeA2AMessageNotification({ sender, recipient, preview: '  ' }).body).toContain('No text in this preview')
})

it('reads only the bounded original recipient/sequence page without consuming, acknowledging or replaying a message', async () => {
  const f = fixture()
  await f.owner.observe(arrival); await f.owner.observe(arrival)
  expect(f.listMessages).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: recipient.sessionId }, { direction: 'incoming', beforeSequence: 4, limit: 1 })
  expect(f.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: recipient.sessionId, body: 'Please review the notification copy.' }))
})

it.each(['host', 'participant', 'direction', 'message', 'sequence', 'sender', 'recipient', 'missing', 'failed'] as const)('keeps the arrival but never borrows a preview after %s mismatch', async kind => {
  const f = fixture(), wrong = page()
  if (kind === 'host') wrong.hostId = 'other-host'
  if (kind === 'participant') wrong.participantSessionId = 'other-participant'
  if (kind === 'direction') wrong.direction = 'outgoing'
  if (kind === 'message') wrong.messages[0]!.envelope.messageId = 'neighbor-message'
  if (kind === 'sequence') wrong.messages[0]!.sequence = 2
  if (kind === 'sender') wrong.messages[0]!.envelope.senderSessionId = 'other-sender'
  if (kind === 'recipient') wrong.messages[0]!.envelope.recipientSessionId = 'other-recipient'
  if (kind === 'missing') wrong.messages = []
  f.listMessages.mockResolvedValue(wrong as never)
  if (kind === 'failed') f.listMessages.mockRejectedValue(new Error('Original source unavailable'))
  await f.owner.observe(arrival)
  expect(f.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: recipient.sessionId,
    title: 'Codex · Scratch · original-sender → original-recipient', body: 'Message preview unavailable. Open the receiving Agent to read this message.' }))
})

it.each(['muted', 'visible', 'disposed', 'host-changed', 'recipient-rebound'] as const)('does not deliver stale work when the current snapshot is %s after its read', async kind => {
  const f = fixture()
  let finish!: (value: never) => void
  f.listMessages.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = f.owner.observe(arrival)
  if (kind === 'muted') f.snapshot = { ...f.snapshot, config: { a2a: { notifications: 'silent' } } as never }
  if (kind === 'visible') f.snapshot = { ...f.snapshot, windowFocused: true, visibleSessionIds: new Set([recipient.sessionId]) }
  if (kind === 'disposed') f.snapshot = { ...f.snapshot, ready: false }
  if (kind === 'host-changed') f.snapshot = { ...f.snapshot, sessions: f.snapshot.sessions.map(s => ({ ...s, hostId: 'other-host' })) }
  if (kind === 'recipient-rebound') f.snapshot = { ...f.snapshot, sessions: [{ ...session('foreign-agent'), id: recipient.sessionId }] }
  finish(page() as never); await pending
  expect(f.notify).not.toHaveBeenCalled()
})

it('does not confuse a display ID alias with the original canonical sender or recipient', async () => {
  const f = fixture()
  f.snapshot = { ...f.snapshot, sessions: [
    { ...session('foreign-reader'), id: recipient.sessionId }, { ...session('foreign-sender'), id: sender.sessionId },
    { ...session(recipient.sessionId), id: 'recipient-view' }, { ...session(sender.sessionId), id: 'sender-view' }
  ], agentNames: { 'recipient-view': 'Main coordination', 'sender-view': 'Notification design',
    [recipient.sessionId]: 'Wrong recipient', [sender.sessionId]: 'Wrong sender' } }
  await f.owner.observe(arrival)
  expect(f.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'recipient-view', title: 'Notification design → Main coordination' }))
})

it('retains the original arrival when an exclusive preview cursor cannot be represented', async () => {
  const f = fixture()
  await f.owner.observe({ ...arrival, event: { ...arrival.event, sequence: Number.MAX_SAFE_INTEGER, messageSequence: Number.MAX_SAFE_INTEGER } } as RuntimeEvent)
  expect(f.listMessages).not.toHaveBeenCalled()
  expect(f.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: recipient.sessionId, body: expect.stringContaining('Message preview unavailable') }))
})

it('uses current names and sound after reading, retaining the durable recipient across a Run replacement', async () => {
  const f = fixture()
  let finish!: (value: never) => void
  f.listMessages.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = f.owner.observe(arrival)
  f.snapshot = { ...f.snapshot, agentNames: { [sender.sessionId]: 'Notification design', [recipient.sessionId]: 'Main coordination' },
    config: { notifications: { mode: 'patient', sound: true } } as never,
    sessions: f.snapshot.sessions.map(s => ({ ...s, control: { ...s.control, run: { runId: 'replacement-run' } } })) }
  finish(page() as never); await pending
  expect(f.notify).toHaveBeenCalledExactlyOnceWith({ sessionId: recipient.sessionId, title: 'Notification design → Main coordination',
    body: 'Please review the notification copy.', mode: 'patient', sound: true })
})

it.each([false, true])('suppresses any visible presentation of the exact recipient only when focused=%s', async focused => {
  const f = fixture()
  f.snapshot = { ...f.snapshot, windowFocused: focused, visibleSessionIds: new Set(['second-recipient-view']),
    sessions: [...f.snapshot.sessions, { ...session(recipient.sessionId), id: 'second-recipient-view' }] }
  await f.owner.observe(arrival)
  expect(f.listMessages).toHaveBeenCalledTimes(focused ? 0 : 1)
  expect(f.notify).toHaveBeenCalledTimes(focused ? 0 : 1)
})

it('does not suppress the original recipient for a visible display alias or another Host', async () => {
  const f = fixture()
  f.snapshot = { ...f.snapshot, windowFocused: true, visibleSessionIds: new Set(['visible-alias', 'other-host']), sessions: [
    ...f.snapshot.sessions, { ...session('foreign-agent'), id: 'visible-alias' },
    { ...session(recipient.sessionId), hostId: 'other-host', id: 'other-host' }
  ] }
  await f.owner.observe(arrival)
  expect(f.notify).toHaveBeenCalledOnce()
})

it('disposes before future observations without asking its former owner for facts', async () => {
  const current = vi.fn(), listMessages = vi.fn(), notify = vi.fn()
  const owner = createA2AMessageNotifier({ current, listMessages, notify })
  owner.dispose(); owner.dispose()
  await owner.observe(arrival)
  expect(current).not.toHaveBeenCalled(); expect(listMessages).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled()
})

it('disposes an in-flight original read without consulting or notifying the retired owner', async () => {
  const f = fixture()
  const current = vi.fn(target => a2aNotificationContext(f.snapshot, target))
  const owner = createA2AMessageNotifier({ current, listMessages: f.listMessages, notify: f.notify })
  let finish!: (value: never) => void
  f.listMessages.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = owner.observe(arrival)
  owner.dispose(); finish(page() as never); await pending
  expect(current).toHaveBeenCalledOnce(); expect(f.notify).not.toHaveBeenCalled()
})
