import { describe, expect, it } from 'vitest'
import { agentUsageDisplay, formatTokenCount } from '../src/renderer/src/lib/agent-usage'
import type { SessionSnapshot } from '../src/shared/contracts'
import type { AgentCapabilities } from '@agentmux/core'

// 守显示侧对三种真值的判别：真实数 / 声明但还没数 / 根本不报。任何一种塌成 0 都是这个 task 要防的谎。

function agentSession(
  overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>>
): Extract<SessionSnapshot, { kind: 'agent' }> {
  const capabilities: AgentCapabilities = {
    terminal: true,
    timeline: 'complete-events',
    permission: 'respond',
    providerResume: true,
    replyCorrelation: 'none'
  }
  return {
    id: 'a1',
    kind: 'agent',
    providerId: 'claude',
    executorId: 'claude',
    capabilities,
    hostId: 'local',
    workspacePath: '/w',
    label: 'Agent',
    createdAt: 0,
    updatedAt: 0,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 0 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'a1', run: { runId: 'r1' } },
    ...overrides
  }
}

describe('formatTokenCount', () => {
  it('keeps small counts exact and abbreviates larger ones', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(987)).toBe('987')
    expect(formatTokenCount(1200)).toBe('1.2k')
    expect(formatTokenCount(12432)).toBe('12k')
    expect(formatTokenCount(1_200_000)).toBe('1.2M')
  })

  it('pins every abbreviation switch point (an off-by-one in the thresholds must go red)', () => {
    // 每个分档边界都钉死，否则 `< 1000` 改成 `<= 1000`、`k >= 10` 改成 `k > 10`、`< 1_000_000`
    // 改成 `<= 1_000_000` 这类 off-by-one 会悄悄溜过——展示的是错的位数却没测发红。
    expect(formatTokenCount(999)).toBe('999') // 仍是裸数字
    expect(formatTokenCount(1000)).toBe('1.0k') // 进入 k 档，留一位小数
    expect(formatTokenCount(9999)).toBe('10.0k') // 9.999k 四舍五入到 10.0k（仍是一位小数档）
    expect(formatTokenCount(10000)).toBe('10k') // 到 10k 起不留小数
    expect(formatTokenCount(999999)).toBe('1000k') // 仍在 k 档（< 1_000_000）
    expect(formatTokenCount(1_000_000)).toBe('1.0M') // 进入 M 档
  })
})

describe('agentUsageDisplay', () => {
  it('shows the real last-turn output tokens when the provider reports usage', () => {
    const display = agentUsageDisplay(agentSession({
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, replyCorrelation: 'none',
        usage: { kind: 'native-transcript', transcriptFormat: 'claude-jsonl' }
      },
      turnUsage: { inputTokens: 2, outputTokens: 5, totalTokens: 7, observedAt: 1234 }
    }))
    expect(display.kind).toBe('tokens')
    // 显示的是真实 output token，不是任何 /s；title 说清是"最近一 turn"并逐项钉住 in/out/total，
    // 这样把 title 里任一项写错字段（例如 in 显示成 total）都会发红。
    expect(display.text).toBe('5 tok')
    expect(display.title).toContain('Last turn')
    expect(display.title).toContain('in 2')
    expect(display.title).toContain('out 5')
    expect(display.title).toContain('total 7')
  })

  it('says "no token usage" — never 0 — when the provider does not declare usage', () => {
    const display = agentUsageDisplay(agentSession({ providerId: 'grok', turnUsage: undefined }))
    expect(display.kind).toBe('unsupported')
    expect(display.text).toBe('no token usage')
    // 关键的反谎断言：不报用量的 Provider 绝不显示 0。
    expect(display.text).not.toContain('0')
    expect(display.title).toContain('does not report token usage')
  })

  it('shows an unknown marker — never 0 — before the first turn completes', () => {
    const display = agentUsageDisplay(agentSession({
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: true, replyCorrelation: 'none',
        usage: { kind: 'native-transcript', transcriptFormat: 'claude-jsonl' }
      },
      turnUsage: undefined
    }))
    expect(display.kind).toBe('awaiting')
    expect(display.text).not.toContain('0')
    expect(display.text).toBe('—')
  })
})
