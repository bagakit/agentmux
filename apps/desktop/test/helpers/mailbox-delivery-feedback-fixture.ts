import type { AgentSessionUserMessage } from '@agentmux/core'

export const feedbackSessionId = 'mailbox-original-input'
export function feedbackMessage(id: string, status?: NonNullable<AgentSessionUserMessage['inputSubmission']>['status'], native = false): AgentSessionUserMessage {
  return {
    id, rawId: id, agentSessionId: feedbackSessionId, author: { kind: 'human' },
    source: native ? { kind: 'native', providerId: 'codex', nativeSessionId: 'original-native-session', recordId: id }
      : { kind: 'captured', submissionId: id },
    content: 'Please continue the original work and keep the saved message.', contentParts: [],
    recordedAt: 24 * 60 * 60 * 1000, deliveryStatus: 'streaming',
    ...(status ? { inputSubmission: { status, observation: status === 'waiting' ? 'owned' as const : 'closed' as const } } : {})
  }
}
