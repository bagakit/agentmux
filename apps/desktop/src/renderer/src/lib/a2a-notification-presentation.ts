import { compactReferenceId, resolveAgentName } from '@agentmux/client-ui/display-name'
import { notificationPreview } from './notification-preview'

type Participant = Parameters<typeof resolveAgentName>[0] & { sessionId: string; fallback: string }
const name = (participant: Participant) => {
  const resolved = resolveAgentName(participant)
  const text = notificationPreview(resolved.name, 'title')
  const points = Array.from(text)
  return points.length > 40 ? points.slice(0, 39).join('') + '…' : text
}

/** Display only: the original message, notification eligibility and click target stay with their owners. */
export function composeA2AMessageNotification(input: { sender: Participant; recipient: Participant; preview?: string | undefined }) {
  const sender = name(input.sender), recipient = name(input.recipient)
  const title = sender === recipient
    ? `${sender} · ${compactReferenceId(input.sender.sessionId)} → ${compactReferenceId(input.recipient.sessionId)}`
    : `${sender} → ${recipient}`
  const preview = input.preview === undefined ? undefined : notificationPreview(input.preview, 'title')
  return {
    title,
    body: preview || (input.preview === undefined
      ? 'Message preview unavailable. Open the receiving Agent to read this message.'
      : 'No text in this preview. Open the receiving Agent to read the original.')
  }
}
