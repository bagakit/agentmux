import { describe, expect, it } from 'vitest'
import { renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'
import type { AgentMuxMessageEnvelope } from '../src/agent-global-message-queue.js'

const envelope: AgentMuxMessageEnvelope = {
  schema: 'agentmux.a2a.v1', messageId: 'machine-message-id', operationId: 'machine-operation-id', createdAt: 1,
  sender: { kind: 'agent-session', agentSessionId: 'agent-source' },
  recipient: { kind: 'agent-session', agentSessionId: 'recipient-id' },
  threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
  senderSessionId: 'agent-source', senderRunId: 'sender-run', recipientSessionId: 'recipient-id', recipientRunId: 'recipient-run',
  body: 'raw <body> & text\nincluding a trailing newline\n'
}

describe('readable A2A message', () => {
  it('shows only the participant source and unchanged authored body', () => {
    expect(renderAgentMuxMessageEnvelope(envelope)).toBe('[Message from Agent agent-source]\n' + envelope.body)
  })

  it('honestly labels an unverified source without presenting transport as a participant', () => {
    expect(renderAgentMuxMessageEnvelope({ ...envelope, sender: { kind: 'human', principal: 'local-cli' }, senderSessionId: null, senderRunId: null }))
      .toBe('[Message from unverified local process]\n' + envelope.body)
  })

  it('preserves explicitly authored JSON as body text', () => {
    const body = '{"messageId":"authored-json","body":"author text"}'
    expect(renderAgentMuxMessageEnvelope({ ...envelope, body })).toBe('[Message from Agent agent-source]\n' + body)
  })

  it('uses the Core-authorized sender fact instead of a redundant, potentially forged sender label', () => {
    expect(renderAgentMuxMessageEnvelope({ ...envelope, sender: { kind: 'agent-session', agentSessionId: 'forged-label' } }))
      .toBe('[Message from Agent agent-source]\n' + envelope.body)
    expect(renderAgentMuxMessageEnvelope({ ...envelope, senderSessionId: null }))
      .toBe('[Message from unverified local process]\n' + envelope.body)
  })
})
