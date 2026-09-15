import { describe, expect, it } from 'vitest'
import { renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'

describe('A2A message wrapper', () => {
  it('escapes every XML attribute while preserving the body', () => {
    const rendered = renderAgentMuxMessageEnvelope({
      schema: 'agentmux.a2a.v1', messageId: 'm"<&\'', operationId: 'op', createdAt: 1,
      sender: { kind: 'agent-session', agentSessionId: 'sender<&' },
      recipient: { kind: 'agent-session', agentSessionId: 'recipient"' },
      threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
      senderSessionId: 'sender', senderRunId: 'run-sender', recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
      body: 'raw <body> & text'
    })
    expect(rendered).toContain('from="sender&lt;&amp;"')
    expect(rendered).toContain('to="recipient&quot;"')
    expect(rendered).toContain('messageId="m&quot;&lt;&amp;&apos;"')
    expect(rendered).toContain('raw <body> & text')
  })
})
