import type { AgentMuxInspectedRegion } from './control.js'
import { AgentMuxError } from './errors.js'

/**
 * 启动定向握手（whoami）里，坐标与能力如何从既有投影拼出——判定层放这里，让每一条都能被直接断言。
 *
 * 坐标不新建第二份来源：Session/Workspace/能力取自 `statusAgent(self)`（每个 intent 读的同一份
 * Session 投影），View/Region 复用既有的 `inspect.region self`。这个模块只负责 View 那一半的
 * **缺席判定**——一次 whoami 应答绝不能因为查不到 View 就整个失败（那会把"没有 View"这种正常状态
 * 变成握手不可用），但也绝不能把"没查成"静默说成"没有 View"（那是原则 11 第二边界禁止的"把未知
 * 当成好的"）。
 */

/**
 * Topic 一项在 whoami 里的解释性缺席。
 *
 * Topic 是 Scratch 文件系统事实：`topic.md` 与 `.agents/` 才是唯一真相，topicId 由展示侧从工作区
 * 路径派生，Core 够不到。whoami 若要输出 Topic，只能在 Core 复刻那套目录约定——那就是给 Topic
 * 造第二份来源，两份必然漂移且漂移那天不会有测试变红。所以这里不产出 Topic，只带一句指向工作区
 * 文件的话，让缺席变成"这里不管 Topic、去文件里找"的可辨缺席，而不是甩给接收方去猜。
 */
export const SELF_CONTEXT_TOPIC_HINT =
  'Topic is not a Core fact. Read topic.md and the .agents/ files in your Workspace to find your Topic and collaborators.'

export type SelfViewOutcome =
  | { attached: true; region: AgentMuxInspectedRegion }
  | { attached: false; reason: 'no-desktop-view' }
  | { attached: false; reason: 'view-unavailable'; error: { code: string; message: string } }

/**
 * 把 `inspect.region self` 的失败分成"确定没有 View"与"没查成"。
 *
 * `CALLER_NOT_OPEN`/`REGION_NOT_OPEN` 是 Desktop 明确回答"这个 Agent 此刻没有投影到任何 View"——
 * 那是正常答案，`no-desktop-view`。其余一切（Control 面不可达、超时、协议错、非 AgentMuxError 的
 * 意外）都只说明**我们没查成**，不代表没有 View；这一类如实带上错误码与消息 `view-unavailable`，
 * 让失败可见——**默认落在"没查成"这边**，要判成"确定没有"必须显式命中上面两个码，而不是反过来。
 */
export function classifySelfViewFailure(error: unknown): Exclude<SelfViewOutcome, { attached: true }> {
  if (error instanceof AgentMuxError && (error.code === 'CALLER_NOT_OPEN' || error.code === 'REGION_NOT_OPEN')) {
    return { attached: false, reason: 'no-desktop-view' }
  }
  const code = error instanceof AgentMuxError ? error.code : 'CONTROL_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  return { attached: false, reason: 'view-unavailable', error: { code, message } }
}
