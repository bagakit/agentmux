import type { AgentActivity, SessionSnapshot } from '../../../shared/contracts'

const RECENT_MESSAGE_LIMIT = 96

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function abbreviatedSessionId(sessionId: string): string {
  return sessionId.length <= 16 ? sessionId : sessionId.slice(0, 8)
}

export function latestSessionActivityAt(
  session: Pick<SessionSnapshot, 'updatedAt'>,
  activities: readonly AgentActivity[]
): number {
  return activities.reduce(
    (latest, activity) => Math.max(latest, activity.createdAt),
    session.updatedAt
  )
}

export function recentSessionMessage(activities: readonly AgentActivity[]): string | null {
  const activity = activities.reduce<AgentActivity | null>((latest, candidate) => {
    if ((candidate.kind !== 'prompt' && candidate.kind !== 'assistant') || !candidate.content?.trim()) {
      return latest
    }
    return !latest || candidate.createdAt >= latest.createdAt ? candidate : latest
  }, null)
  if (!activity?.content) return null
  const speaker = activity.kind === 'prompt' ? 'You' : 'Agent'
  const content = compactText(activity.content)
  const available = RECENT_MESSAGE_LIMIT - speaker.length - 2
  const clipped = content.length <= available ? content : `${content.slice(0, Math.max(1, available - 1))}…`
  return `${speaker}: ${clipped}`
}
