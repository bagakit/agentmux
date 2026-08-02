import type { AgentProviderId } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState } from './attention-vocabulary'
import { sessionBoardColumn } from './project-board'

// A window-wide cross-session rollup of Agent attention. Every other indicator in the window is
// scoped — the tab dot is one Session, Board columns are one Project, the Agents tool total is one
// Workspace and only while its dock is open. This answers the single question none of them do:
// anywhere in this window, does any Agent need me right now? It reads only the Session projection
// already in the Store and adds no new plumbing.
export type AgentAttentionRollup = {
  // Every Agent Session the window is projecting, regardless of whether it currently has a View.
  total: number
  working: number
  // The states {@link isNeedsYouState} names: the Agent has surfaced a request or is stuck and cannot
  // proceed without you. That table is the definition; this field is one of its readers.
  needsYou: number
  error: number
  // The earliest Session by status.observedAt in each attention class, so a click lands on the one
  // that has been waiting longest — null when that class is empty.
  needsYouSessionId: string | null
  errorSessionId: string | null
}

function isAgent(session: SessionSnapshot): session is Extract<SessionSnapshot, { kind: 'agent' }> {
  return session.kind === 'agent'
}

// The earliest by observedAt wins; on an exact tie the first in projection order holds, so the
// result is deterministic. status.observedAt is the field this rollup finally reads.
function earliest(
  sessions: readonly SessionSnapshot[],
  matches: (state: SessionSnapshot['status']['state']) => boolean
): string | null {
  let winner: SessionSnapshot | null = null
  for (const session of sessions) {
    if (!isAgent(session) || !matches(session.status.state)) continue
    if (!winner || session.status.observedAt < winner.status.observedAt) winner = session
  }
  return winner?.id ?? null
}

export function summarizeAgentAttention(
  sessions: readonly SessionSnapshot[]
): AgentAttentionRollup {
  const agents = sessions.filter(isAgent)
  return {
    total: agents.length,
    working: agents.filter((session) => session.status.state === 'working').length,
    needsYou: agents.filter((session) => isNeedsYouState(session.status.state)).length,
    error: agents.filter((session) => session.status.state === 'error').length,
    // Both needs-you readings go through the shared table, so the count and the jump target can never
    // disagree about which states qualify — they were two hand-written copies of the same `||` before.
    needsYouSessionId: earliest(sessions, isNeedsYouState),
    errorSessionId: earliest(sessions, (state) => state === 'error')
  }
}

// 一个 Provider 现在有几个 Agent 在跑、几个闲着。
//
// "活跃"与"待机"不在这里定义——它们是 `sessionBoardColumn` 的 working 列与其余列，也就是
// Board 用的那一个开关。照抄一份 switch 会让同一个 Session 出现两种说法：Board 判它在跑
// （`starting`/`running` 都在 working 列），状态栏却因为只认 `state === 'working'` 判它待机。
// 所以这里调用那个函数，而不是复述它。
//
// 上面的 `working`/`needsYou`/`error` 是另一套刻意不同的口径（关注度：谁需要我现在就去看），
// 两套并存是有意的——本函数回答的是"哪个 Provider 在干活"，不是"谁在等我"。
export type ProviderActivityCount = {
  providerId: AgentProviderId
  // Board working 列：starting / running / working。
  active: number
  // 该 Provider 其余的 Agent——needs-you 列与 done 列合起来，即"没在跑"。
  idle: number
}

export function summarizeProviderActivity(
  sessions: readonly SessionSnapshot[]
): ProviderActivityCount[] {
  // 首次出现的顺序决定展示顺序：它随 Session 投影稳定，不会因为计数变化而让整排图标跳位。
  const byProvider = new Map<AgentProviderId, ProviderActivityCount>()
  for (const session of sessions) {
    if (!isAgent(session)) continue
    const entry = byProvider.get(session.providerId)
      ?? { providerId: session.providerId, active: 0, idle: 0 }
    if (sessionBoardColumn(session) === 'working') entry.active += 1
    else entry.idle += 1
    byProvider.set(session.providerId, entry)
  }
  // 零 Agent 的 Provider 从来不会进这张表——只有出现过的 Provider 才有条目，因此不占位。
  return [...byProvider.values()]
}
