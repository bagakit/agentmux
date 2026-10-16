import { fixtureEpoch as _tailFixtureEpoch } from "../../../../test/fixture-values.mjs"
import { expect } from 'vitest'
import type { AgentMuxClient, AgentMuxMessageEnvelope } from '@agentmux/core'
import { renderAgentMuxMessageEnvelope } from '@agentmux/core/agent-message-render'

/** A real authorized SDK input; only the fixture's Runtime byte port is controlled. */
export async function submitRecordedAgentMessage(client: AgentMuxClient, senderId: string, recipientId: string,
  operationId: string, body: string, capability: string) {
  const sender = client.agentSession(senderId), recipient = client.agentSession(recipientId)
  const envelope: AgentMuxMessageEnvelope = { schema: 'agentmux.a2a.v1', messageId: operationId, operationId: 'operation:' + operationId, createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: senderId }, recipient: { kind: 'agent-session', agentSessionId: recipientId },
    senderSessionId: senderId, senderRunId: sender.run.runId, recipientSessionId: recipientId, recipientRunId: recipient.run.runId,
    threadId: operationId, correlationId: operationId, replyTo: null, workspaceId: null, body }
  await client.submitAgentMessage({ agentSessionId: recipientId, envelope, execution: 'immediate',
    admissionIntent: { kind: 'manual-actor', expectedRun: recipient.run }, caller: { agentSessionId: senderId, capability } })
  const key = { kind: 'message' as const, agentSessionId: recipientId, expectedRun: recipient.run, messageId: operationId }
  await expect.poll(async () => (await client.inspectAgentInput({ key }))?.status).toBe('terminal-confirmed')
  return { envelope, wire: renderAgentMuxMessageEnvelope(envelope) }
}
