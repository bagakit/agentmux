/**
 * 「同一步的入参和结果，是一行还是两行」——时间轴的折叠规则。
 *
 * 一次工具调用会发两个 hook：`PreToolUse` 落一行入参，`PostToolUse` 再落一行**同名同参**的。
 * 原先的折叠只比 kind/title/toolInput，于是这两行被判为「重复」折成一行并显示 `×2`——**显示的是
 * 排在前面的那一行，也就是没有结果的那一行**。结果字段接上之后，如果折叠规则不动，用户看到的
 * 仍然是入参，输出和失败标记全被吃掉，而且所有只测采集的用例照样全绿。
 *
 * 所以折叠必须认结果：**有结果的那一行永远赢**。同一步的 Pre/Post 仍然折成一行（用户不需要看见
 * 同一条命令出现两次），但留下的是带着输出与成败的那一行。
 *
 * 真正的重复——重试循环里同一条命令跑了三遍——依然折叠计数，那是这个机制原本要解决的噪音。
 *
 * 写成纯函数：本仓库测试用 `renderToStaticMarkup`，写在组件里的分支没有断言够得着。
 */

import type { AgentTimelineItem } from '../../../shared/contracts'
import { isConversationTurn } from './conversation-speaker'

export type TimelineRow = {
  item: AgentTimelineItem
  count: number
}

/** 这一条有没有携带结果（输出，或者观察到的失败）。 */
function carriesOutcome(item: AgentTimelineItem): boolean {
  return item.toolOutput !== undefined || item.status === 'failed'
}

/** 两条是不是「同一步/同一件事」——折叠只在这个前提下发生。 */
function sameStep(left: AgentTimelineItem, right: AgentTimelineItem): boolean {
  // Conversation turns are durable user/assistant messages, not repeated machine steps. Two prompts
  // can legitimately share the same title and have no tool input; folding them is the "only first
  // sentence is visible" failure. Keep every turn as its own row and reserve folding for machine data.
  if (isConversationTurn(left) || isConversationTurn(right)) return false
  return left.kind === right.kind
    && left.title === right.title
    && left.toolInput === right.toolInput
}

/**
 * 把相邻的同一步折成一行。
 *
 * **合并时保留带结果的那一条**，而不是先到的那一条。两条都带结果说明是真的重复执行（重试），
 * 计数加一并保留后一条——后一条是最新的事实。
 *
 * 计数的语义没变：`×N` 表示这一步在时间轴上出现了 N 次。Pre/Post 这一对本质是同一次执行的两个
 * 侧面，折成一行后计数仍然是 2——它如实反映了「时间轴上有两条」，而用户看到的是有结果的那条。
 */
export function timelineRows(items: readonly AgentTimelineItem[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const item of items) {
    const previous = rows[rows.length - 1]
    if (previous && sameStep(previous.item, item)) {
      previous.count += 1
      // 有结果的顶掉没结果的；两条都有结果时后来者为准。没结果的绝不顶掉有结果的。
      if (carriesOutcome(item) || !carriesOutcome(previous.item)) previous.item = item
      continue
    }
    rows.push({ item, count: 1 })
  }
  return rows
}
