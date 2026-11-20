import { expect, it } from 'vitest'
import { prepareMessageInputRepresentation } from '../src/agent-message-input.js'
import { AGENTMUX_CHANNEL_INSTANT_REPLY } from '../src/agent-messaging-guidance.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import type { AgentMuxMessageEnvelope } from '../src/agent-message-envelope.js'

/**
 * A chat reply read like a work report: long, full of progress narration, and in a group it could
 * carry private material. The connector now passes the adapter's typed conversation kind, and Core
 * freezes one reply note into the first copy of that external input. No kind, no note.
 */
const envelope = (body = 'Original external request'): AgentMuxMessageEnvelope => ({ schema: 'agentmux.a2a.v1', messageId: 'original-message', operationId: 'original-operation',
  createdAt: 1, sender: { kind: 'external', connectionId: 'connection', actor: { application: { domain: 'chat.example', appId: 'app' }, idType: 'open_id', userId: 'person' },
    externalConversationId: 'room', externalMessageId: 'original-message', bindingId: 'binding', bindingRevision: 1, grantId: 'grant', grantRevision: 1 },
  recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
  senderSessionId: null, senderRunId: null, recipientSessionId: 'recipient', recipientRunId: 'run', body })
const DIRECT = 'This message came from a direct chat with one person.'
const GROUP = 'This message came from a group chat; everyone there can read your replies, so keep unrelated private material out.'
const reminder = (kind?: 'direct' | 'group', body?: string) => prepareMessageInputRepresentation(envelope(body), kind).representation.reminder

it('freezes the reply norm and the kind of chat into a direct-chat input', () => {
  const text = reminder('direct')
  expect(text).toContain(DIRECT); expect(text).not.toContain(GROUP)
  expect(text).toContain(AGENTMUX_CHANNEL_INSTANT_REPLY)
  expect(text.indexOf(AGENTMUX_CHANNEL_INSTANT_REPLY)).toBeLessThan(text.indexOf('For reactions'))
})

it('tells a group-chat input that every member reads the reply', () => {
  const text = reminder('group')
  expect(text).toContain(GROUP); expect(text).not.toContain(DIRECT)
  expect(text).toContain(AGENTMUX_CHANNEL_INSTANT_REPLY)
})

it('adds no note when the adapter did not state the kind of chat', () => {
  const text = reminder(undefined)
  expect(text).not.toContain(AGENTMUX_CHANNEL_INSTANT_REPLY); expect(text).not.toContain(DIRECT); expect(text).not.toContain(GROUP)
  expect(text).toContain('For reactions')
})

it('keeps the note when the body is too large to inline', () => {
  const text = reminder('group', 'x'.repeat(64 * 1024))
  expect(text).toContain('Read it before acting'); expect(text).toContain(GROUP); expect(text).toContain(AGENTMUX_CHANNEL_INSTANT_REPLY)
})

it('places the note in the delivered wire', () => {
  expect(prepareMessageInputRepresentation(envelope(), 'direct').promptWire).toContain(AGENTMUX_CHANNEL_INSTANT_REPLY)
})

it('the connection skill carries the same reply norm, so the input note and the skill never drift', () => {
  const skill = agentMuxModuleSkill('connection')!
  expect(skill).toContain('## Reply in a connected conversation')
  expect(AGENTMUX_CHANNEL_INSTANT_REPLY).toContain("amux connection --skill")
  for (const rule of ['at most 100 words', 'Do not repost them through the platform API', 'inspect its delivery', 'do not promise follow-up'])
    expect(skill).toContain(rule)
})

it('the queue freezes the note only into a new external input, from the kind its caller passed', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { DurableAgentMuxMessageQueue } = await import('../src/agent-global-message-queue.js')
  const root = await mkdtemp(join(tmpdir(), 'amx-channel-norm-'))
  try {
    const queue = new DurableAgentMuxMessageQueue(join(root, 'messages.sqlite'))
    const append = (id: string, kind?: 'direct' | 'group') => queue.append({ ...envelope(), messageId: id, operationId: 'operation-' + id, execution: 'immediate' },
      { admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'run' } }, inputEnvironment: { providerId: 'claude', executorId: 'claude' },
        ...(kind ? { conversationKind: kind } : {}) })
    await append('group-message', 'group'); await append('plain-message')
    const wire = async (id: string) => ((await queue.inspectInput({ kind: 'message-control', originalControlOperationId: 'operation-' + id }))
      ?.intent.source as { promptWire?: string } | undefined)?.promptWire
    const wires = { 'group-message': await wire('group-message'), 'plain-message': await wire('plain-message') }
    expect(wires['group-message']).toContain(GROUP); expect(wires['group-message']).toContain(AGENTMUX_CHANNEL_INSTANT_REPLY)
    expect(wires['plain-message']).toBeDefined(); expect(wires['plain-message']).not.toContain(AGENTMUX_CHANNEL_INSTANT_REPLY)
    // The raw saved journal rows carry the note in the frozen wire, and the kind nowhere else.
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(root, 'messages.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare('SELECT json FROM records').all().map(row => String(row.json))
      expect(rows.some(row => row.includes('group chat'))).toBe(true)
      expect(rows.filter(row => row.includes('"conversationKind"'))).toEqual([])
    } finally { db.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('the client passes the chat kind with a new external input to the queue and never into the envelope', async () => {
  const { vi } = await import('vitest'), { rpcOwnerFixture } = await import('./helpers/public-rpc-owner.js')
  const h = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'claude', executorId: 'claude' }))
  try {
    const queue = (h.client as unknown as { messageQueue: { append(...args: unknown[]): Promise<unknown> } }).messageQueue
    const append = vi.spyOn(queue, 'append')
    const author = envelope().sender as Extract<AgentMuxMessageEnvelope['sender'], { kind: 'external' }>
    await h.client.submitAgentMessage({ agentSessionId: 'recipient', execution: 'immediate', conversationKind: 'group',
      envelope: { ...envelope(), recipientRunId: 'run-recipient' }, admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'run-recipient' } } },
      { externalAuthor: { identity: author, assertCurrent: async () => {} } })
    expect(append).toHaveBeenCalledOnce()
    expect(append.mock.calls[0]![1]).toMatchObject({ conversationKind: 'group' })
    expect(append.mock.calls[0]![0]).not.toHaveProperty('conversationKind')
  } finally { await h.close() }
})
