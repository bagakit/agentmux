import { describe, expect, it } from 'vitest'
import {
  hashAgentCapability,
  issueAgentCapability
} from '../src/agent-capability.js'
import { planDiscussion } from '../src/agent-discussion.js'

// P0 的竖切：受管 Agent A 用一次 operation 创建专属 Agent B 并投递首条消息。
// 这里只测"决定要做什么"这一半（纯函数），真正的创建由 client 执行——
// 那样每一条失败态都能离线证明，不必起进程。

const raw = issueAgentCapability()
const binding = {
  agentSessionId: 'agent-a',
  workspacePath: '/repo',
  runId: 'run-1',
  capabilityHash: hashAgentCapability(raw)
}

function plan(overrides: Partial<Parameters<typeof planDiscussion>[0]> = {}) {
  return planDiscussion({
    capability: raw,
    binding,
    currentRunId: 'run-1',
    targetWorkspacePath: '/repo',
    body: 'please review the parser',
    operationId: 'op-1',
    now: 1000,
    ...overrides
  })
}

describe('author 由 Core 解析，不由调用方声称', () => {
  it('凭证对上时，首条消息的 author 是那个 Agent', () => {
    expect(plan().thread.messages[0]!.authorAgentSessionId).toBe('agent-a')
  })

  it('伪造凭证发不出消息', () => {
    expect(() => plan({ capability: issueAgentCapability() }))
      .toThrowError(expect.objectContaining({ code: 'AGENT_CAPABILITY_INVALID' }))
  })

  it('旧 Run 的凭证重放发不出消息', () => {
    expect(() => plan({ currentRunId: 'run-2' }))
      .toThrowError(expect.objectContaining({ code: 'AGENT_CAPABILITY_STALE_RUN' }))
  })

  it('凭证尚未激活时报 not-ready', () => {
    expect(() => plan({ binding: { ...binding, runId: null } }))
      .toThrowError(expect.objectContaining({ code: 'AGENT_CAPABILITY_NOT_READY' }))
  })
})

describe('首条消息经启动 Prompt 投递', () => {
  it('把消息正文作为目标 Agent 的启动 Prompt', () => {
    // 启动 Prompt 只是首条账本消息的 transport；账本才是消息真相。
    expect(plan().launchPrompt).toBe('please review the parser')
  })

  it('空正文发不出去——没有内容的消息不构成一次 Discussion', () => {
    expect(() => plan({ body: '   ' }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_PROMPT' }))
  })

  it('Delivery 起始于 queued：还没有任何送达证据', () => {
    expect(plan().thread.delivery.state).toBe('queued')
  })
})

describe('跨 Workspace 默认拒绝', () => {
  it('目标不在同一个 Workspace 时拒绝', () => {
    // P0 只允许同一 Workspace 内的显式授权 source 与 target。
    expect(() => plan({ targetWorkspacePath: '/elsewhere' }))
      .toThrowError(expect.objectContaining({ code: 'AGENT_MESSAGE_CROSS_WORKSPACE' }))
  })
})

describe('幂等：同一次 operation 只算一次', () => {
  it('相同 operation id 产出相同的 Thread 身份', () => {
    // 重试不该再建一个 Thread、也不该重复注入 Prompt。
    expect(plan().thread.threadId).toBe(plan().threadId)
    expect(plan().thread.operationId).toBe('op-1')
  })

  it('不同 operation id 是不同的 Thread', () => {
    expect(plan().thread.threadId).not.toBe(plan({ operationId: 'op-2' }).thread.threadId)
  })
})
