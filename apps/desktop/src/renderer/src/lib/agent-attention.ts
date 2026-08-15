import type { AgentProviderId } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { attentionSortClass, attentionSortRank, categoryFor, isUrgentAttention } from './attention-event'
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
    // "在跑"是 `sessionBoardColumn` 的 working 列，不是 `state === 'working'`。这一行曾经写后者，
    // 于是同一个窗口里四个投影对同一批 Agent 报出两组数——用户实测：Scratch 侧栏 3 running、
    // Board 的 WORKING 列 3、Provider 汇总 4 active，而这里 0 working。差额全部是 `running`：
    // 它不是边角状态而是**主稳态**——`agentDisplayState`（core/agent-status-freshness.ts:81）是
    // `unknown → 'running'` 的唯一映射处，而那个函数自己的注释（:76-79）列出了三条到达它的路：
    // hook-normalizer（Provider 的 rules 认不出事件）、session-state 的 agent-status 分支（含 ACP）、
    // 以及 15 分钟静默衰减（`DECAYED_SEMANTIC_STATE` 就是 `unknown`）。所以严格判据的稳定结论
    // 是"一个都没在跑"。
    // 这一列的语义是"有几个在干活"，与下面 Provider 那段、`workingAgentCount`、Board 的列
    // 完全是同一个问题；同一个问题必须共用那一个开关，而不是各自判一次。
    working: agents.filter((session) => sessionBoardColumn(session) === 'working').length,
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
// 上面的 `working` 走的是同一个开关。这段注释一度写着"两套刻意不同的口径"——那是错的，而且是
// 它自己上面三行刚描述过的那个缺陷：`working` 与本函数的 `active` 回答的是同一个问题（谁在干活），
// 不同的只有分组粒度（整窗 vs 逐 Provider）。`needsYou`/`error` 才是另一套口径（谁在等我），
// 它们走 `isNeedsYouState`。刻意的差异是"关注度 vs 活动"这条线，不是同一条线上的两种算法。
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

/**
 * 下一个要你处理的 Agent——从 `from` 往后数的那一个，没有则 null。
 *
 * 为什么是「循环」而不是「跳到最急的那一个」：状态栏那两个按钮已经在做后者（`needsYouSessionId` /
 * `errorSessionId`，各自跳到本档里等得最久的）。键盘要答的是另一个问题——**把它们一个个过一遍**。
 * 只跳最急那一个的话，处理完第一个之前，这个键会一直把你送回同一行；而真实动作是「这个回完了，下一个
 * 是谁」。所以按键的语义是游标推进，`from` 就是游标。
 *
 * 顺序 = 急迫档（`attentionSortClass` → `attentionSortRank`，与切换器、花名册、活动列表同一张表）
 * 内按 `observedAt` 升序，即等得最久的先来——与状态栏那两个按钮的「跳到等得最久的那个」是同一条约定，
 * 于是从任意一处进入、键盘继续往下走，走的都是同一条队。**不另写一份排序**：这正是本仓反复出现的
 * 那个形状（同一个问题两处各判一次，今天一致，加成员那天分岔）。
 *
 * 只收「要你处理」的那两档（needs-you 与 error，即 `isUrgentAttention` 认的那两个）。`working` 不进队：
 * 一个在跑的 Agent 不需要你做任何事，把它塞进这条队会让这个键在一个大窗口里几乎总是停在某个跑着的
 * Agent 上，而你按它是为了找**卡住的**那个。`done` 同理——完成是一条通知，不是一个待办。
 *
 * `from` 传当前正看着的那个 Session（没有就传 null）。它**不必**自己在队里：从一个闲着的 Agent 上按，
 * 得到的是队首；这比「找不到游标就不动」好，因为后者会让这个键在最常见的那个场景（你正看着一个刚回完
 * 话的 Agent）下什么也不做。
 *
 * 队里只有一个、且它就是 `from` 时，返回它自己而不是 null：让这个键成为一个无声的 no-op，用户会以为
 * 键没绑上；返回自己则至少把它重新聚焦一次，语义是「就是这一个」。
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
