/** Activity rows use Core's admitted semantic entry time; observations only describe last activity. */

import type { AgentTimelineItem, SessionSnapshot } from '../../../shared/contracts'
import { agentEvidenceStale } from '@agentmux/core/agent-status'
import { attentionAccentFor, type AttentionCategory } from './attention-event'
import { contextUsedPercent } from './agent-usage'
import { sessionBoardColumn } from './project-board'
import { sessionRecentActivity } from './session-recency'
import { agentStateEnteredAt } from './agent-state-time'

export type ProjectActivityRow = {
  /** 主句：这个 Agent 最近在改什么 / 在等什么（session-recency 的优先级阶梯）。 */
  reason: string
  /** 该行的关注度描色，或 null 表示中性。取自共享的 attentionAccentFor，绝不本地重判。 */
  attention: AttentionCategory | null
  /** 尾随的次要事实，按类别而变；null 表示这一行不该有尾随。 */
  meta: string | null
}

/** 压成 30s / 4m / 2h，与旧 quietDuration 的数值口径一致，只是把 " idle" 后缀交给调用处拼。 */
function elapsedShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

/**
 * 上下文占用百分比，算不出就返回 null——绝不塌成 0（验收：absent turnUsage 显示「无」而非「0」）。
 *
 * 判定本身在 `agent-usage.ts` 的 {@link contextUsedPercent}：这里曾经照抄那 6 行，并留了 `ponytail:`
 * 说「若第三处也要它，再抽到 agent-usage.ts」。名册成了第三处，所以已经抽走了。这里只剩「先确认这是
 * 个 agent Session」这一句本地判断。
 */
function contextPercent(session: SessionSnapshot): number | null {
  if (session.kind !== 'agent') return null
  return contextUsedPercent(session.turnUsage?.context)
}

/**
 * 一个 Agent 行的完整展示决策。`now` 作形参传入（不在函数里读时钟），与 session-recency 同样保持可测、
 * 不随时间漂移。
 */
export function projectActivityRow(
  session: SessionSnapshot,
  timeline: readonly AgentTimelineItem[],
  now: number,
  workspaceRoot?: string
): ProjectActivityRow {
  const reason = sessionRecentActivity(session, timeline, workspaceRoot)
  const attention = attentionAccentFor(session.status.state)
  const enteredAt = agentStateEnteredAt(session, now)
  const elapsed = enteredAt === undefined ? undefined : elapsedShort(now - enteredAt)
  const unknown = 'start time unknown'

  if (attention === 'needs-you') return { reason, attention, meta: elapsed === undefined ? unknown : `waiting ${elapsed}` }
  if (attention === 'error') return { reason, attention, meta: elapsed === undefined ? unknown : `error for ${elapsed}` }

  // A decayed working observation describes past activity, never the current state's age.
  // Board membership still has its existing single owner.
  if (sessionBoardColumn(session) === 'working') {
    if (agentEvidenceStale(session.status, now)) {
      return { reason, attention, meta: `last active ${elapsedShort(now - session.status.observedAt)}` }
    }
    const percent = contextPercent(session)
    const duration = elapsed === undefined ? unknown : `working ${elapsed}`
    return { reason, attention, meta: percent === null ? duration : `${duration} · ctx ${percent}%` }
  }

  return { reason, attention, meta: elapsed === undefined ? unknown : `${elapsed} idle` }
}
