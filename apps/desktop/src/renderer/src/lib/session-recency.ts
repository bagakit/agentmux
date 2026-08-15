/**
 * 「这个 Agent 最近在干什么」——四个界面（Project 活动菜单、roster 明细行等）都要的一行人话。
 *
 * 此前有两份各答一半、互不共享、且会打架的派生：`projectSessionReason` 只走 pendingInteraction →
 * status.detail → 状态句；`stepTitle` 只把**一次**工具调用翻成 `Bash npm test`。都答不出用户真正问的
 * 「最近在**改**什么」——那条事实躺在时间轴最后一条 tool_call 里，整份 transcript 之外没人捞它。
 * 这个文件把它收成唯一一份，按优先级从「必须让用户行动」到「只剩裸状态」逐级下探。
 *
 * 纯函数：不碰 store、不读时钟（连 staleness 也不靠 `Date.now()`——见下方「新旧」的判定）。这样它
 * 可测、不随时间漂移。时间轴按需拉取（store.ts:273 / resyncTimeline），绝大多数 Session 多数时候**没有**
 * 时间轴——缺席必须如实退回到基于状态的答案，绝不返回空串，也绝不谎报一个「Idle」把「还没加载」
 * 伪装成「真的闲着」（原则 11 class 3：判不出就别猜着当真去做）。
 */

import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentTimelineItem } from '../../../shared/contracts'
import type { AgentDisplayState } from '@agentmux/core'
import { clampStep, stepTitle } from './activity-step-summary'

/**
 * Agent「此刻正在推进工作」的状态。只有在这些状态下，一条**已完成**的 tool_call 才还算「最近」——
 * 一旦 Run 结束/出错/等待用户，那条编辑就是历史，不是「正在干的事」，把它当现状展示会读成还在跑。
 * 这就是本函数对「多旧算太旧」的回答：用 Session 状态这个手上就有的粗信号判新旧，而不是掐表。
 * ponytail: 粗到状态级；若日后要区分「working 但时间轴滞后于 status」，再加 `now` 形参并比对
 * item.updatedAt 与 status.observedAt——今天没有那个需求，不预支这层复杂度。
 */
const ACTIVE_STATES: ReadonlySet<AgentDisplayState> = new Set(['starting', 'running', 'working'])

/** 压成单行并封顶，让它塞得进窄菜单的一行。复用 step 摘要的同一上限——同一处 UI，同一个「一行」。 */
function oneLine(value: string): string {
  return clampStep(value.replace(/\s+/gu, ' ').trim())
}

/** 时间轴按时间顺序追加（store 只 append/upsert，不重排），故最后一条 tool_call 从尾部倒着找最快。 */
function latestToolCall(timeline: readonly AgentTimelineItem[]): AgentTimelineItem | undefined {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i]!.kind === 'tool_call') return timeline[i]
  }
  return undefined
}

/**
 * @param workspaceRoot 这个 Session 所属仓库的磁盘根，用来把绝对路径缩成相对路径。省略即不缩短。
 *
 * 它必须传，原因不是「短一点好看」，而是**这两个消费面都会再被 CSS 截一刀，且截的正是保下来的那一头**。
 * `.resource-usage__activity` 与活动菜单行都是 `text-overflow: ellipsis`，而 CSS 的省略号永远吃**尾巴**——
 * 于是 JS 在认得字段名的那一层辛苦保住的文件名，到了窄面板上一定被剪掉。实测本仓 984 个源文件，在 236px
 * 面板上文件名可读率 **0%**：每一行都停在 `…renderer/src/lib/sess…` 这种位置，而这条摘要存在的唯一理由
 * 就是「不展开也认得出是哪个」。先无损缩短再交出去，可读率 0% → 24%（264px 上）。
 *
 * 换句话说：这个形参补的不是排版，是这行字的**全部识别力**。本文件第 57 行那段注释早就写明了这个道理
 * （「再截一刀……恰好吃掉刚保住的文件名」），只是当时说的是 oneLine，没料到 CSS 在做同一件事。
 */
export function sessionRecentActivity(
  session: SessionSnapshot,
  timeline: readonly AgentTimelineItem[],
  workspaceRoot?: string
): string {
  // 终端（非 agent）没有时间轴、没有 pendingInteraction，也没有「最近在改什么」这层语义——如实只报状态。
  if (session.kind !== 'agent') return session.status.state

  // 1) pendingInteraction：Agent 卡在**用户**身上。它凌驾一切——这是唯一一种字符串本该促使用户去操作的
  //    情形，排在最前才不会被下面任何「它在忙什么」的描述盖掉。
  const request = session.pendingInteraction
  if (request) {
    return oneLine(request.kind === 'permission' ? request.title : request.questions.map((q) => q.prompt).join(' · '))
  }

  // 2) 最近一条 tool_call：用户问的「最近在改什么」。直接复用 stepTitle，不重造那套按工具取字段的逻辑。
  //    新旧判定：streaming 的那条**定义上就在此刻发生**，任何状态下都算最近；complete/failed 的那条只在
  //    Session 仍活跃（working/running/starting）时才算「正在干」，否则它是历史，落到状态答案更诚实。
  //
  //    **不套 oneLine**：stepTitle 已经在认得字段名的那一层截好了（路径保尾、其余保头），且保证已在上界内。
  //    再过一次 oneLine 只会按头部把它重截一刀，恰好吃掉刚保住的文件名——那正是这条摘要存在的意义。
  //    换行压平也不必：字段值在 stepSummary 里已 flatten 过，title 是协议里的工具名。
  const call = latestToolCall(timeline)
  if (call && (call.status === 'streaming' || ACTIVE_STATES.has(session.status.state))) {
    return stepTitle(call.title, call.toolName, call.toolInput, workspaceRoot)
  }

  // 3) status.detail：Core 给了这一刻的具体说明就用它。
  if (session.status.detail) return oneLine(session.status.detail)

  // 4) 状态专属句，再退到裸状态。保持与旧 projectSessionReason 逐字一致，供 groupSummary 判「有没有比
  //    裸状态更具体的话」时命中同一分支。
  if (session.status.state === 'waiting') return 'Waiting for your reply in the terminal'
  if (session.status.state === 'error') return 'Agent reported an error; open the terminal for details'
  return session.status.state
}
