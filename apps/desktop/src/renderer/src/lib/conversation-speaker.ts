/**
 * 「这一条是谁说的」——对话体里唯一的说话人判定。
 *
 * 今天这件事散在渲染层三处，每处各自按 `kind` 二选一：图标在 `user_message`/`assistant_message`
 * 之间选形状，`isTurn` 判断这条算不算「人读的话」，`Turn` 的 caption 在 `'You'`/`'Assistant'`
 * 之间选字。三处的判据必须一致却没有共同出处——改一处漏两处，是这个形状本身的问题。
 *
 * ## 为什么权威是 `source` 而不是 `kind`
 *
 * `kind: 'user_message'` 与 `source: 'user'` 在今天恒等价，因为 Core 里只有一个地方产生用户
 * 消息（launch/send 路径），它同时写死这两个字段；`UserPromptSubmit` hook 刻意不重复收，已有
 * 测试守着这条。但这两个字段的**语义强度不同**：`source` 回答「这条事实是谁提供的」，`kind`
 * 回答「这是一条什么事件」。说话人是前者的问题。按 `kind` 反推身份正是当前二值 caption 的形态，
 * 也是设计 SSOT 明确禁止的（「渲染层不得按 kind 反推身份」）。所以这里先看 `source`。
 *
 * ## 为什么返回的不是一个布尔或两个字面量
 *
 * 说话人在设计上是**开放集**：A2A 落地后，同一条对话里会有多个 Agent 各自的身份。但今天 Core
 * 侧的 `AgentTimelineItem` 没有任何身份字段（`kind` 与 `source` 都是闭集，都不携带身份），所以
 * 真正的开放集是一次公共合同变更，不在本轮。本轮要做对的是**形状**：值域是今天真实存在的两个
 * 身份，而返回结构能容纳第三个身份而不必改调用方。
 *
 * 具体地：`SpeakerRole` 保持窄集合（今天只有 human/agent 两个真实取值），而识别一个**具体是谁**
 * 靠 `id`。今天 agent 的 id 就是它的 agentSessionId，human 只有一个所以是常量；A2A 落地后新增的
 * 参与者拿到自己的 id，`role` 仍然是 `'agent'`，调用方（选头像、选形状、排轴）不需要改。
 * 这不是预防性抽象——它没有多出任何配置层或分支，只是没把「只有两种」写进类型。
 */

import type { AgentTimelineItem } from '../../../shared/contracts'

/**
 * 说话人的类别。**不是身份**——身份是 {@link ConversationSpeaker.id}。
 *
 * `'human'` 与 `'agent'` 之外没有第三个类别：`tool_call`/`permission`/`lifecycle` 这些机器上报
 * 不是「谁说了话」，它们根本不进对话体（见 {@link speakerOf} 返回 null）。A2A 带来的是更多
 * `'agent'` 身份，不是一个新类别。
 */
export type SpeakerRole = 'human' | 'agent'

/**
 * 对话体里的一个说话人。
 *
 * `id` 是身份，用于寻址与取头像；`role` 只用于选表示形状。二者分开是「显示名与身份严格分离」
 * 的同一条约束：不要用 role 当身份（那样所有 Agent 会挤成一个），也不要用 id 选形状（那样每
 * 新增一个身份都得改渲染分支）。
 */
export type ConversationSpeaker = {
  role: SpeakerRole
  /** 这个说话人的稳定标识。今天：human 恒为 HUMAN_SPEAKER_ID，agent 为其 agentSessionId。 */
  id: string
}

/**
 * 代表「这台机器前面的人」的身份。
 *
 * 是个常量而不是从 item 里读出来的，因为今天说话人轴上只会有人类用户的发言，Core 侧也没有区分
 * 多个人类用户的事实。A2A 预留的是 agent 侧的多身份，不是多个人类。
 */
export const HUMAN_SPEAKER_ID = 'human'

/**
 * 这一条时间轴条目的说话人；不是一句话（机器上报）时返回 null。
 *
 * null 是有意义的返回而不是兜底：`tool_call`/`permission`/`lifecycle` 是机器上报，它们在对话体
 * 里走 24px 紧凑行而不是 turn register。调用方据此二选一，而不必自己再判一次 kind。
 */
export function speakerOf(item: AgentTimelineItem): ConversationSpeaker | null {
  // `source` 先行：它回答「这条事实谁提供的」，正是说话人的问题。人类的话只从 Core 的
  // launch/send 路径来，那里是唯一写 `source: 'user'` 的地方。
  if (item.source === 'user') return { role: 'human', id: HUMAN_SPEAKER_ID }
  if (item.kind === 'assistant_message') return { role: 'agent', id: item.agentSessionId }
  return null
}

/**
 * 这一条是否属于对话体（turn register）而不是机器上报行。
 *
 * 与 {@link speakerOf} 同一个判据的两种问法——**不是**第二份实现。渲染层原先用一个只看 `kind`
 * 的 `isTurn`，与 caption 的判据各写一遍；这里让「有说话人」直接定义「是一轮对话」，两者不可能
 * 再漂移。
 */
export function isConversationTurn(item: AgentTimelineItem): boolean {
  return speakerOf(item) !== null
}
