import { createHash } from 'node:crypto'
import {
  resolveCapabilityAuthor,
  type AgentCapabilityBinding
} from './agent-capability.js'
import { createThread, type AgentThread } from './agent-message.js'
import { AgentMuxError } from './errors.js'

/**
 * 一次 Discussion 的计划：受管 Agent A 用一次 operation 创建专属 Agent B 并投递首条消息。
 *
 * 这里只决定**要做什么**，不执行创建——因此每一条失败态（伪造身份、旧 Run 重放、
 * 跨 Workspace、空正文）都能离线证明，不必起进程。真正的 Session 创建由 client 承担，
 * 它已经拥有 reservation → commit 那条原子路径。
 */
export type DiscussionPlan = {
  readonly threadId: string
  readonly thread: AgentThread
  /**
   * 首条消息的正文，将作为目标 Agent 的启动 Prompt 投递。
   *
   * 它只是**账本首条消息的 transport**：Message ledger 始终是消息真相，
   * 而"Provider 收下了启动参数"最多证明 delivered，证明不了对方接受或回复了。
   */
  readonly launchPrompt: string
}

/**
 * Thread 身份由 operation id 决定。
 *
 * 于是同 id 的重试落到同一个 Thread——不会再建一个，也不会重复注入 Prompt。
 * 用派生而非随机，正是为了让"重试"这件事无需额外的去重表。
 */
function threadIdFor(operationId: string): string {
  return `th-${createHash('sha256').update(operationId).digest('base64url').slice(0, 22)}`
}

export function planDiscussion(input: {
  /** 调用方交回的 raw 凭证。Core 据此解析 author——不接受调用方自己声称的身份。 */
  capability: string
  binding: AgentCapabilityBinding
  currentRunId: string
  targetWorkspacePath: string
  body: string
  operationId: string
  now: number
}): DiscussionPlan {
  // 先定 author：后面每一条事实都挂在它上面，身份不成立就无从谈起。
  const author = resolveCapabilityAuthor(input.capability, input.binding, input.currentRunId)

  const body = input.body.trim()
  if (!body) {
    throw new AgentMuxError('A Discussion needs a first message.', 'INVALID_AGENT_PROMPT')
  }
  // P0 只允许同一 Workspace 内的显式授权 source 与 target；跨 Workspace 默认拒绝。
  if (input.targetWorkspacePath !== input.binding.workspacePath) {
    throw new AgentMuxError(
      'Cross-workspace delivery is not allowed.',
      'AGENT_MESSAGE_CROSS_WORKSPACE'
    )
  }

  const threadId = threadIdFor(input.operationId)
  return Object.freeze({
    threadId,
    thread: createThread({
      threadId,
      authorAgentSessionId: author,
      // 专属 Session：目标此刻还不存在，由 client 在同一次 operation 里创建。
      targetAgentSessionId: '',
      workspacePath: input.targetWorkspacePath,
      body,
      operationId: input.operationId,
      createdAt: input.now
    }),
    launchPrompt: body
  })
}
