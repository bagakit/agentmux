import { observeAgent, type AgentObservation } from '@agentmux/core/agent-status'
import type { SessionSnapshot } from '../../../shared/contracts'

/**
 * 桌面侧读同一份 Provider 观察合同——**不新建第二套判定**。
 *
 * 三条轴（进程活性 / 语义活性 / 就绪性）的收敛逻辑住在 Core 的 {@link observeAgent}（node-free 子路径
 * `@agentmux/core/agent-status`，与主进程、CLI 读的是同一个函数）。这里只做一件事：把渲染侧的
 * `SessionSnapshot` 归一到那个函数要的三条原始事实。若在渲染层自己再拼一份 `busy` 布尔，就正是本
 * Feature 要消灭的「声明了却各造一套」——同一个问题两处各判一次，加成员那天分岔。
 *
 * 输入形状刻意收成一个 agent Session：终端 Session 没有语义活性这层概念，调用方在传入前已按 kind 收窄。
 */
export function observeAgentSession(
  session: Extract<SessionSnapshot, { kind: 'agent' }>,
  now: number
): AgentObservation {
  return observeAgent(
    {
      process: session.processState,
      status: session.status,
      timelineCapability: session.capabilities.timeline,
      // 卡在一个待答的 typed 请求上：普通输入此刻送不进去（会被拒或被当成对请求的回答）。
      awaitingRequest: session.pendingInteraction !== undefined,
      // 终端能力尚未确认（握手降级）：Core 仍收输入，但就绪性诚实报 pending。
      terminalCapabilityUnverified: session.terminalCapability !== undefined
    },
    now
  )
}

/**
 * 一行状态点的 title/aria 说明——把三条轴各自的读数拼成一句人话，谁也不冒充谁。
 *
 * 这是"三轴不折叠"在用户可见文本上的落点：读到的是 `running · idle · ready` 这种三段式，而不是一个
 * 塌成一体的 `busy`。unsupported 与 unknown 在这里也如实分开显示。
 */
export function observationSummary(observation: AgentObservation): string {
  return `${observation.process} · ${observation.semantic} · ${observation.readiness}`
}
