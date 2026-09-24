import { describe, expect, it } from 'vitest'
import { handOff, openDispatch, recordDispatchEvent } from '../src/agent-handoff.js'
import type { AgentMuxMessageEnvelope } from '../src/agent-global-message-queue.js'

const source: AgentMuxMessageEnvelope = {
  schema: 'agentmux.a2a.v1', messageId: 'source', operationId: 'source-operation', createdAt: 10,
  sender: { kind: 'agent-session', agentSessionId: 'owner' },
  recipient: { kind: 'agent-session', agentSessionId: 'worker' },
  senderSessionId: 'owner', senderRunId: 'owner-run', recipientSessionId: 'worker', recipientRunId: 'worker-run',
  threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: '/synthetic', body: 'Synthetic source'
}
function reply(messageId: string, cleanup = false): AgentMuxMessageEnvelope {
  return { ...source, messageId, operationId: `operation-${messageId}`, replyTo: source.messageId,
    sender: { kind: 'agent-session', agentSessionId: cleanup ? 'owner' : 'worker' },
    recipient: { kind: 'agent-session', agentSessionId: cleanup ? 'worker' : 'owner' },
    senderSessionId: cleanup ? 'owner' : 'worker', senderRunId: cleanup ? 'owner-run' : 'worker-run',
    recipientSessionId: cleanup ? 'worker' : 'owner', recipientRunId: cleanup ? 'worker-run' : 'owner-run' }
}

it('declares a communication handoff without an external Task mutation', () => {
  expect(handOff({ fromAgentSessionId: 'a', toAgentSessionId: 'b', taskId: 'caller-reference', at: 10 }))
    .toEqual({ ownerAgentSessionId: 'b', originAwaits: false, taskId: 'caller-reference', at: 10 })
})

describe('Dispatch message projection', () => {
  it('derives supervision from the actual source and retains the owner', () => {
    expect(openDispatch(source, 20)).toEqual({ sourceMessageId: 'source', ownerAgentSessionId: 'owner',
      workerAgentSessionId: 'worker', threadId: 'thread', openedAt: 20, originAwaits: true, events: [] })
  })
  it('retains distinct questions, replays the same reply once and refuses a conflicting kind', () => {
    const dispatch = openDispatch(source, 20)
    const first = recordDispatchEvent(dispatch, reply('question-one'), 'question', 30)
    expect(recordDispatchEvent(first, reply('question-one'), 'question', 40)).toBe(first)
    const second = recordDispatchEvent(first, reply('question-two'), 'question', 50)
    expect(second.events).toEqual([{ replyMessageId: 'question-one', kind: 'question', at: 30 },
      { replyMessageId: 'question-two', kind: 'question', at: 50 }])
    expect(() => recordDispatchEvent(second, reply('question-one'), 'worker_done', 60))
      .toThrowError(expect.objectContaining({ code: 'DISPATCH_EVENT_CONFLICT' }))
    expect(dispatch.events).toEqual([])
  })
  it('only worker_done settles waiting; question, escalation and owner cleanup do not', () => {
    const dispatch = openDispatch(source, 20)
    for (const kind of ['question', 'escalation', 'cleanup'] as const) {
      expect(recordDispatchEvent(dispatch, reply(kind, kind === 'cleanup'), kind, 30).originAwaits).toBe(true)
    }
    const done = recordDispatchEvent(dispatch, reply('done'), 'worker_done', 40)
    expect(done.originAwaits).toBe(false)
    expect(done.ownerAgentSessionId).toBe('owner')
    expect(recordDispatchEvent(done, reply('cleanup', true), 'cleanup', 50).originAwaits).toBe(false)
  })
  it('requires an Agent-authored resolved source and an exact reverse reply/thread', () => {
    expect(() => openDispatch({ ...source, sender: { kind: 'human', principal: 'local-cli' } }, 20)).toThrow()
    const dispatch = openDispatch(source, 20)
    for (const invalid of [{ ...reply('q'), replyTo: 'other' }, { ...reply('q'), threadId: 'other' },
      { ...reply('q'), recipientSessionId: 'other' }, reply('q', true)]) {
      expect(() => recordDispatchEvent(dispatch, invalid, 'question', 30))
        .toThrowError(expect.objectContaining({ code: 'DISPATCH_MESSAGE_INVALID' }))
    }
  })
})
