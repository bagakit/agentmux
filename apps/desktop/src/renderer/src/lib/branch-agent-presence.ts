import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import { attentionSortClass, attentionSortRank } from './attention-event'
import type { SessionSnapshot } from '../../../shared/contracts'

export type RunningAgentPresence = {
  providerId: AgentProviderId
  executorId: string
  state: AgentDisplayState
  count: number
  updatedAt: number
}

export function worktreePresenceKey(hostId: string, workspacePath: string): string {
  return `${hostId}\0${workspacePath}`
}

/** Projects live Core Session truth onto worktrees without creating Branch-owned state. */
const presenceIndexes = new WeakMap<readonly SessionSnapshot[], ReadonlyMap<string, readonly RunningAgentPresence[]>>()

export function runningAgentPresenceByWorktree(
  sessions: readonly SessionSnapshot[]
): ReadonlyMap<string, readonly RunningAgentPresence[]> {
  const cached = presenceIndexes.get(sessions)
  if (cached) return cached
  const grouped = new Map<string, Map<string, RunningAgentPresence>>()
  for (const session of sessions) {
    if (session.kind !== 'agent' || session.processState !== 'running') continue
    const key = worktreePresenceKey(session.hostId, session.workspacePath)
    const agents = grouped.get(key) ?? new Map<string, RunningAgentPresence>()
    const current = agents.get(session.executorId)
    agents.set(session.executorId, {
      providerId: session.providerId,
      executorId: session.executorId,
      state: current && attentionSortRank(attentionSortClass(current.state)) <= attentionSortRank(attentionSortClass(session.status.state))
        ? current.state : session.status.state,
      count: (current?.count ?? 0) + 1,
      updatedAt: Math.max(current?.updatedAt ?? 0, session.updatedAt)
    })
    grouped.set(key, agents)
  }

  const result = new Map(
    Array.from(grouped, ([key, agents]) => [
      key,
      Array.from(agents.values()).sort(
        (left, right) => right.updatedAt - left.updatedAt || left.executorId.localeCompare(right.executorId)
      )
    ])
  )
  presenceIndexes.set(sessions, result)
  return result
}

export type WorktreePresence = Omit<RunningAgentPresence, 'updatedAt'>
const EMPTY_PRESENCE: readonly WorktreePresence[] = []

/** A leaf subscribes to its displayed facts, including their real recency order. */
export function createWorktreePresenceSelector(hostId: string, workspacePath: string) {
  const key = worktreePresenceKey(hostId, workspacePath)
  let previous: readonly WorktreePresence[] = EMPTY_PRESENCE
  return (sessions: readonly SessionSnapshot[]): readonly WorktreePresence[] => {
    const current = runningAgentPresenceByWorktree(sessions).get(key) ?? EMPTY_PRESENCE
    if (current.length === previous.length && current.every((agent, index) => {
      const old = previous[index]!
      return agent.providerId === old.providerId && agent.executorId === old.executorId &&
        agent.state === old.state && agent.count === old.count
    })) return previous
    previous = current.map(({ providerId, executorId, state, count }) => ({ providerId, executorId, state, count }))
    return previous
  }
}
