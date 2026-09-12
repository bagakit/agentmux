import type { AgentMuxAgentRuntimeStatus } from './client.js'

/**
 * `pmo sessions` 的过滤谓词，抽成纯函数只为一个理由：`agentmux.ts` 在模块顶层 `void main()`，导入即执行
 * CLI，谓词写在那里没有任何测试能不启动整个命令就验它——而它恰好曾经**恒假**。
 *
 * 那个 bug 是本仓「谎报事实 / 洗白类型」这一族的活样本：`--status` 过滤原先读
 * `(session.session as unknown as { processState?: string }).processState`，可 `AgentMuxAgentSession`
 * 上**没有** `processState` 这个字段（它住在 `control.ts` 的控制协议会话上，那次 cast 是从那儿抄来的）。
 * `as unknown as` 把类型检查也一并绕过，于是每一次比较都是 `'' === status`，`pmo sessions --status <任意值>`
 * 永远返回零条——一个声明能过滤、实则永不匹配的假能力，且没有任何测试挡得住。
 *
 * 进程活性的诚实来源是 `observation.process`（`running` / `exited` / `interrupted`，即 `AgentMuxRunState`）
 * ——CLI 与渲染层读的同一条观察轴。这里读它，不再有第二个字段。
 */
export function pmoSessionStatus(session: AgentMuxAgentRuntimeStatus): string {
  return session.observation.process
}

export type PmoSessionFilter = {
  sessionId?: string | undefined
  status?: string | undefined
  since?: number | undefined
}

export function pmoSessionMatches(session: AgentMuxAgentRuntimeStatus, filter: PmoSessionFilter): boolean {
  return (!filter.sessionId || session.session.agentSessionId === filter.sessionId)
    && (!filter.status || pmoSessionStatus(session) === filter.status)
    && (filter.since === undefined || session.session.updatedAt >= filter.since)
}
