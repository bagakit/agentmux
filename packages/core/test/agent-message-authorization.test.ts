import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'

describe('Core A2A envelope authorization', () => {
  it('rejects sender or recipient Run facts that do not match the authorized live sessions', () => {
    const client = Object.create(AgentMuxClient.prototype) as AgentMuxClient
    const sender = { agentSessionId: 'sender', run: { runId: 'sender-run' } }
    const recipient = { agentSessionId: 'recipient', run: { runId: 'recipient-run' } }
    const runtime = client as unknown as { authorizeAgentCaller: () => typeof sender; agentSession: () => typeof recipient }
    runtime.authorizeAgentCaller = () => sender
    runtime.agentSession = () => recipient
    expect(() => client.authorizeAgentMessage({ capability: 'cap', callerAgentSessionId: 'sender', senderSessionId: 'sender', senderRunId: 'wrong-run', recipientSessionId: 'recipient', recipientRunId: 'recipient-run' })).toThrow('sender facts')
    expect(() => client.authorizeAgentMessage({ capability: 'cap', callerAgentSessionId: 'sender', senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: 'wrong-run' })).toThrow('recipient facts')
  })
})
