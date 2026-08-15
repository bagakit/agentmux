/**
 * 项目活动菜单里**每个 Agent 行**该显示的三件事：一句人话（在改什么/在等什么）、一个关注度分级
 * （决定描色和整行的形状）、一段尾随的次要事实（等了多久 / 上下文压力 / 空闲多久）。
 *
 * 为什么把它抽成纯函数而不是写在 ProjectActivity.tsx 里：本仓库的测试用 renderToStaticMarkup，
 * 组件里的分支断言够不着；且组件一 import store 就把 native api 拖进来，测起来要 mock 一堆。
 * 编辑规则（哪种 Session 显示哪些字段）是这个 feature 的**难点**，必须能被逐条钉住——见
 * session-recency.ts / agent-usage.ts / row-attention.ts 同样的抽法。
 *
 * 核心编辑判断：**一个「卡在你身上」的行和一个「安静干活」的行不该长一个样。** 一行只有一条 <small>
 * 的宽度，每加一个字段都在跟别的字段抢那条窄缝。所以不是「把所有字段都塞上」，而是**按 Session 的
 * 类别决定尾随事实**：
 *   - needs-you（等你批准/回答）：尾随「等了多久」——此刻唯一还有用的次要事实是它已经等了你多久。
 *   - error：尾随「多久以前坏的」。
 *   - working（starting/running/working）：尾随上下文压力 `ctx N%`（只有报用量的 Provider、且这一 turn
 *     真采到了才有），否则退回 `active now`。对一个正在跑的 Agent，第二个问题是「它是不是快压缩了」，
 *     不是它跑了多久。
 *   - 其余（idle/done/disconnected）：尾随「空闲多久」。
 *
 * 主句（reason）不在这里重造：直接复用 session-recency 的那份唯一派生。这个文件只负责**分级**与**尾随**。
 */

import type { AgentTimelineItem, SessionSnapshot } from '../../../shared/contracts'
import { attentionAccentFor, type AttentionCategory } from './attention-event'
import { sessionBoardColumn } from './project-board'
import { sessionRecentActivity } from './session-recency'

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
 * 判定与 AgentContextUsage 的 `known`/`used` 同源（那份在组件里，import 会拖进 React，故这 6 行照抄）：
 * 容量与已用都必须有限且合理，任一缺失即读作「这个 Provider 此刻没报」，返回 null。
 * ponytail: 与 AgentContextUsage 的 known 判定重复；若第三处也要它，再抽到 agent-usage.ts。
 */
function contextPercent(session: SessionSnapshot): number | null {
  if (session.kind !== 'agent') return null
  const context = session.turnUsage?.context
  if (!context) return null
  if (!Number.isFinite(context.capacityTokens) || context.capacityTokens <= 0) return null
  if (!Number.isFinite(context.usedTokens) || context.usedTokens < 0) return null
  return Math.min(100, Math.max(0, Math.round((context.usedTokens / context.capacityTokens) * 100)))
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
  const elapsed = elapsedShort(now - session.status.observedAt)

  // needs-you：它卡在你身上，尾随的应是「已经等了你多久」——这是催你行动的次要信号，不是它在忙什么。
  if (attention === 'needs-you') return { reason, attention, meta: `waiting ${elapsed}` }
  // error：坏了，尾随「多久以前」。不用 " idle"——它不是闲着，是死了。
  if (attention === 'error') return { reason, attention, meta: `${elapsed} ago` }

  // working：正在跑。尾随上下文压力（「是不是快压缩了」），报不出就退回 active now——绝不显示 0%。
  if (sessionBoardColumn(session) === 'working') {
    const percent = contextPercent(session)
    return { reason, attention, meta: percent === null ? 'active now' : `ctx ${percent}%` }
  }

  // 其余：idle / done / exited / disconnected——尾随空闲时长。
  return { reason, attention, meta: `${elapsed} idle` }
}
