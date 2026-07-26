/**
 * 「它到底动没动」——刚发完 prompt 那一刻，对话体该说什么。
 *
 * 今天的表现是：首行落地之前，`items.length === 0` 落到「暂无活动」空状态。于是刚发完 prompt 的
 * 窗格看上去是**空的、停的**——而实际上 Agent 正在想。一个正在工作的东西显示成空，比慢更糟：
 * 用户会以为自己没发出去，然后再发一遍。
 *
 * 判定拆成两半，因为它们回答的是两个问题：
 * - **turn 在不在工作**：由 Session 的显示状态说了算，那是唯一的真相来源，不从时间轴反推。
 * - **该不该显示"在进行"指示**：工作中、且**用户还看不到实质回答**时才显示。
 *
 * 「实质回答」特指助手正文。只有工具步骤、还没有正文时仍然算"在进行"——那时候用户看到的是一串
 * 机器动作，仍然不知道 Agent 有没有在回应他。正文一到就退场：正文本身已经是"在动"的证据，
 * 两个信号并存会让人以为有两件事在跑。
 *
 * 写成纯函数：本仓库测试用 `renderToStaticMarkup`，effect 不跑，写在组件里的分支没有断言够得着。
 */

import type { AgentDisplayState } from '@agentmux/core'
import type { AgentTimelineItem } from '../../../shared/contracts'

/** Session 显示状态里，代表「这个 turn 正在被处理」的那些。 */
const WORKING_STATES: ReadonlySet<AgentDisplayState> = new Set<AgentDisplayState>([
  'starting',
  'working'
])

/**
 * 这个 turn 在工作吗。
 *
 * 只认 Session 的显示状态。不从"最后一条是不是工具调用"之类的形状反推——那种推断在 Agent 正常
 * 结束于一次工具调用时会永远显示"在进行"，而且没有任何证据支持它。
 */
export function turnWorking(displayState: AgentDisplayState | undefined): boolean {
  return displayState !== undefined && WORKING_STATES.has(displayState)
}

/**
 * 该不该显示「在进行」指示。
 *
 * 助手正文（非空的 assistant_message 内容）一旦出现就退场。注意判的是**有没有正文**，不是
 * "有没有 assistant_message"——一条还没吐出字的流式条目不算实质回答。
 */
export function showWorkingIndicator(
  displayState: AgentDisplayState | undefined,
  items: readonly AgentTimelineItem[]
): boolean {
  if (!turnWorking(displayState)) return false
  return !items.some((item) => item.kind === 'assistant_message' && Boolean(item.content?.trim()))
}

/**
 * 空状态该不该出现。
 *
 * 「没有任何活动」与「正在想」是两回事，后者不该显示成空。而「此 Provider 不报结构化活动」是第三
 * 件事，由 capability 单独承载——这条判定不碰它，那个区分是既有的优点，不许在这里退化成一句话。
 */
export function showEmptyState(
  displayState: AgentDisplayState | undefined,
  items: readonly AgentTimelineItem[]
): boolean {
  return items.length === 0 && !turnWorking(displayState)
}
