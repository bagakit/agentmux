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

import type { AgentTimelineItem } from '../../../shared/contracts'
import { createRulerScale } from './activity-ruler'
import { speakerOf, type ConversationSpeaker } from './conversation-speaker'

/**
 * 轴语义：一个说话人是否属于这条轴。作用在已判定的身份上，而不是 item——所以它无从按 kind 反推。
 *
 * 今天两条轴各用一个（{@link speaksAsHuman}/{@link speaksAsAgent}）；A2A 落地后要把某个具体 Agent
 * 单独排一条轴，只需传 `(s) => s.id === 目标id`，函数签名与返回形状都不必改。这就是「按轴语义参数化」
 * 要买到的可扩展性，而不是现在就造一个假的身份来源。
 */
export type SpeakerPredicate = (speaker: ConversationSpeaker) => boolean

/** 说话人轴的语义：今天这条轴上只会有人类用户的发言（设计 SSOT 明确）。 */
export const speaksAsHuman: SpeakerPredicate = (speaker) => speaker.role === 'human'

/**
 * 自我 Agent 轴的语义：该 Agent 说话的位置。一条 per-session 时间轴里只有一个 Agent
 * （session-timeline 校验器拒绝异源 item），所以今天「该 Agent」就是所有 `role: 'agent'` 的标记，
 * 无需额外告诉它「自我」是谁。
 */
export const speaksAsAgent: SpeakerPredicate = (speaker) => speaker.role === 'agent'

/**
 * 这条轴上的一个标记。
 *
 * - `item` 是**反查回原话的出处**（设计 SSOT：hover 面板取原话，用的是这条对应的 timeline item），
 *   T-005 会读它的 `content` 逐字展示。带的是**同一个引用**而不是拷贝。
 *   真正的替代方案不是「带 id 再建一张 id→item 表」——`index` 就在这里，调用方本来也持有 `items`，
 *   所以替代方案是 `items[mark.index]`，不多任何簿记。带 item 是**便利**而非结构上必需：它让 T-005
 *   的组件只吃一个 `mark` 就自洽，不必把 `items` 和 `index` 一起穿进去。
 * - `index` 是这条 item 在**全量** items 里的原始下标，也是定位的依据（见 `fraction`）。
 * - `fraction` 是 0..1 的位置，来自全量 scale 的 `fractionOf(index)`，直接驱动 CSS 定位。刻意不带
 *   `at`：位置是诚实的（序数轴上也均匀），但时刻不能在这里被制造出来。
 *
 *   **由此有一条约束落在下游**：ruler 的诚实性是**类型级**的——序数轴上 `RulerReadout` 根本没有 `at`
 *   字段，所以「在没有时间跨度的轴上显示钟点」写不出来。这个标记**继承不到**那层保护：它手里的
 *   `item.createdAt` 永远是个数。所以要显示时刻必须走 `scale.readoutOf(mark.index)`，绝不能直接读
 *   `mark.item.createdAt`——后者会把 ruler 特意做成不可表达的那种不诚实又请回来。
 * - `speaker` 是身份 `{role, id}`：role 选头像画法（human 给人形、agent 复用图标），id 用于寻址取
 *   providerId。身份表示两条轴共用，正是「共用同一套身份表示」的兑现。
 */
export type ConversationAxisMark = {
  index: number
  fraction: number
  speaker: ConversationSpeaker
  item: AgentTimelineItem
}

/**
 * 求一条轴的标记。`belongs` 是轴语义；两条轴只是这个参数不同，定位逻辑在此只此一份。
 *
 * scale 在**全量 items** 上建（复用 {@link createRulerScale}，宽度对分数无意义，与 ActivityView 同取
 * 1），随后按原始下标取位置。这保证两条轴与 ruler 主刻度时间基准同源；一旦改成在筛过的子集上建
 * scale，位置就会按不同的时间基准算出来，两条轴便不再对齐。
 */
export function conversationAxis(
  items: readonly AgentTimelineItem[],
  belongs: SpeakerPredicate
): ConversationAxisMark[] {
  const scale = createRulerScale(
    items.map((item) => item.createdAt),
    1
  )
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
