import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'

/**
 * Agent invocation capability：一条消息的 author 由谁说了算。
 *
 * 公开的 `AGENTMUX_AGENT_SESSION_ID` 只是上下文提示——它就在环境变量里，改一下就能冒充另一个
 * Agent，因此**不能**用来认证 author。Core 在受管 Agent 启动时签发一枚不透明凭证，
 * 只持久化它的 hash；调用方把 raw 交回来，Core 比对后才认定"这句话是谁说的"。
 *
 * 形状沿用仓库既有的 hook token（`randomBytes(32).toString('base64url')`），但更严一档：
 * hook token 是明文持久化、仅在公开投影里剥离，而这里**只存 hash**。
 */

/** 签发一枚新凭证。raw 只在受管进程的环境里存在，绝不进 argv、日志、Timeline、receipt。 */
export function issueAgentCapability(): string {
  return randomBytes(32).toString('base64url')
}

/** 只有 hash 会落盘。沿用仓库既有的 sha256/base64url 写法。 */
export function hashAgentCapability(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url')
}

/** Core 持有的绑定事实。`runId` 为 null 表示已签发但尚未随 Run 激活。 */
export type AgentCapabilityBinding = {
  readonly agentSessionId: string
  readonly workspacePath: string
  readonly runId: string | null
  readonly capabilityHash: string
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  // 长度不同直接判否——timingSafeEqual 要求等长，且长度本身不是秘密。
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 解析一条消息的 author，失败一律关闭。
 *
 * 三种失败必须可区分：**尚未激活**（再等等）、**凭证不对**（你不是你说的那个人）、
 * **旧 Run 重放**（凭证曾经有效，但那个 Run 已经被换掉了）。把它们混成一个笼统错误，
 * 调用方就只能猜该重试还是该放弃。
 */
export function resolveCapabilityAuthor(
  raw: string,
  binding: AgentCapabilityBinding,
  currentRunId: string
): string {
  if (!raw.trim()) {
    throw new AgentMuxError(
      'This operation requires an Agent invocation capability.',
      'AGENT_CAPABILITY_INVALID'
    )
  }
  if (!sameHash(hashAgentCapability(raw), binding.capabilityHash)) {
    throw new AgentMuxError('Agent invocation capability is not valid.', 'AGENT_CAPABILITY_INVALID')
  }
  // 顺序要紧：先证明凭证属实，再谈它是否还活着——否则会把"猜错的凭证"泄露成"时机不对"。
  if (binding.runId === null) {
    throw new AgentMuxError(
      'Agent invocation capability is not active yet.',
      'AGENT_CAPABILITY_NOT_READY'
    )
  }
  if (binding.runId !== currentRunId) {
    throw new AgentMuxError(
      'Agent invocation capability belongs to a replaced Run.',
      'AGENT_CAPABILITY_STALE_RUN'
    )
  }
  return binding.agentSessionId
}
