/**
 * 「这条轴上有哪些说话人的标记，各自落在时间轴的哪个位置」——两条轴（说话人轴、自我 Agent 轴）
 * 唯一的定位与筛选出处。
 *
 * ## 为什么是一个函数、按轴语义参数化，而不是两份
 *
 * 设计 SSOT 要求两条轴是「同一个可复用组件按轴的语义参数化，不是两个」。两条轴唯一诚实的差别是
 * **哪些说话人会在这条轴上留下标记**（说话人轴今天只收人类、自我 Agent 轴收该 Agent），而
 * **定位算法完全相同**（都用同一条诚实时间轴、按每个 item 在全量列表里的原始下标取位置）。所以轴
 * 语义被表达成一个作用在 {@link ConversationSpeaker} 上的谓词 {@link SpeakerPredicate}，而不是一个
 * 会读成两条代码路径的布尔开关，也不是一套多余的插件注册表。定位只写一遍。
 *
 * ## 为什么谓词吃的是 speaker 而不是 item
 *
 * 谓词只能看到 {@link speakerOf} 已经判定出的 `{role, id}`，看不到 `item.kind`。这从结构上兑现了
 * 设计 SSOT「渲染层不得按 kind 反推身份」：调用方没有任何路径能在这里对 kind 分支。机器上报
 * （tool_call/permission/lifecycle）在 {@link speakerOf} 处就返回 null，根本到不了谓词，所以两条轴
 * 都不会吞进机器上报。
 *
 * ## 时间基准同源，且不引入第二套坐标换算
 *
 * 位置一律来自 {@link createRulerScale}——ruler 的时间基准 SSOT——**在全量 items 上**建的 scale，再按
 * 每个标记的**原始下标**取 `fractionOf`。绝不在筛选后的子集上重建 scale：那会悄悄换掉时间基准，让
 * 两条轴不再同源（见下方 `fractionOf(index)` 处的注释）。零跨度（所有事件同一时刻或只有一条）时
 * scale 自动退化为序数，这条轴跟着退化，无需本文件另写一套；也因此标记上**不带任何 `at`**——诚实
 * 的时刻只在原始 item 的 `createdAt` 或 scale 的 readout 里，本函数不制造能伪造时刻的字段。
 */

import type { AgentSessionUserMessage } from '@agentmux/core'
import type { AgentTimelineItem } from '../../../shared/contracts'
import { createRulerScale } from './activity-ruler'
import { speakerOf, type ConversationSpeaker } from './conversation-speaker'

export type ConversationAxisItem = AgentTimelineItem | AgentSessionUserMessage

/**
 * 轴语义：一个说话人是否属于这条轴。作用在已判定的身份上，而不是 item——所以它无从按 kind 反推。
 */
export type SpeakerPredicate = (speaker: ConversationSpeaker) => boolean

/** 说话人轴的默认语义：人类用户发言与未记录/原生用户输入。 */
export const speaksAsHuman: SpeakerPredicate = (speaker) => speaker.role === 'human' || speaker.role === 'unknown'

/**
 * 自我 Agent 轴的语义：所有 agent 身份的基准谓词。在具体渲染时结合 sessionId 精确限定 recipient。
 */
export const speaksAsAgent: SpeakerPredicate = (speaker) => speaker.role === 'agent'

/**
 * 这条轴上的一个标记。
 */
export type ConversationAxisMark = {
  index: number
  fraction: number
  speaker: ConversationSpeaker
  item: ConversationAxisItem
}

/**
 * 求一条轴的标记。`belongs` 是轴语义；两条轴只是这个参数不同，定位逻辑在此只此一份。
 */
export function conversationAxis(
  items: readonly ConversationAxisItem[],
  belongs: SpeakerPredicate
): ConversationAxisMark[] {
  const timestamps = items.map((item) => ('createdAt' in item ? item.createdAt : item.recordedAt))
  const scale = createRulerScale(timestamps, 1)
  const marks: ConversationAxisMark[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    const speaker = speakerOf(item)
    // 机器上报在这里被挡住：speakerOf 对 tool_call/permission/lifecycle 返回 null，两条轴都不吞它。
    if (!speaker) continue
    // 轴语义：只有属于这条轴的身份才留下标记。谓词看不到 kind，无从反推身份。
    if (!belongs(speaker)) continue
    // 位置按**原始下标**从全量 scale 取，绝不在子集上重建 scale——那会换掉时间基准。
    marks.push({ index, fraction: scale.fractionOf(index), speaker, item })
  }
  return marks
}
