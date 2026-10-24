import type { SessionSnapshot } from '../../../shared/contracts'
import { attentionSortClass, attentionSortRank, categoryFor, isUrgentAttention } from './attention-event'
import { isNeedsYouState } from '@agentmux/client-ui/attention-vocabulary'

/** Only the live Dock badge consumes this rollup; it needs the original request count. */
export function summarizeAgentAttention(sessions: readonly SessionSnapshot[]): { needsYou: number } {
  return { needsYou: sessions.filter(session => session.kind === 'agent' &&
    (session.pendingInteraction !== undefined || isNeedsYouState(session.status.state))).length }
}

function isAgent(session: SessionSnapshot): session is Extract<SessionSnapshot, { kind: 'agent' }> {
  return session.kind === 'agent'
}

/**
 * Advance the original needs-you/error queue, ordered by attention class, observation and ID.
 * An external cursor enters at the first item; the last item wraps to the first. This ordering
 * does not claim which request has been waiting longest or infer current activity.
 */
export function nextAttentionSessionId(
  sessions: readonly SessionSnapshot[],
  from: string | null
): string | null {
  const queue = sessions
    .filter(isAgent)
    .filter((session) => isUrgentAttention(categoryFor(session.status.state)))
    .sort((left, right) =>
      attentionSortRank(attentionSortClass(left.status.state))
        - attentionSortRank(attentionSortClass(right.status.state))
      || left.status.observedAt - right.status.observedAt
      // 同档同时刻时按 id 定序，让这个键的行为可重复——否则队列顺序取决于投影顺序，同一次按键
      // 在两次渲染之间可能走向不同的下一个。
      || left.id.localeCompare(right.id))
  if (queue.length === 0) return null
  const current = from === null ? -1 : queue.findIndex((session) => session.id === from)
  // 游标不在队里（你正看着一个不需要你的 Agent，或什么都没看）→ 队首。见上。
  if (current < 0) return queue[0]!.id
  return queue[(current + 1) % queue.length]!.id
}
