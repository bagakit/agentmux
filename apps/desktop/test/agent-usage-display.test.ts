import { describe, expect, it } from 'vitest'
import { agentUsageDisplay, contextPressure, formatTokenCount } from '../src/renderer/src/lib/agent-usage'
import { RISK_TIERS } from '@agentmux/core/risk-tier'
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

describe('contextPressure：什么时候该提醒「这个 Agent 快满了」', () => {
  // 这一组守的是**门槛判定**本身。接线（名册行有没有真的调它）在 agent-roster.test.ts 里另守一道；
  // 两者互相够不着——判定全对而没人调，与有人调但判定是假的，是两种不同的缺陷。

  it('答不上来就不标记，绝不当成"安全"', () => {
    // 这是本组最要紧的一条：把「没报用量」画成一个绿色的安全标记，是拿沉默冒充好消息。
    // null 进 null 出——不知道就是不知道，不是一个档位。
    expect(contextPressure(null)).toBeNull()
  })

  it('还早的时候不标记——不是发一枚"安全"徽章', () => {
    // 给每一行都挂标记，等于把真正快满的那两行埋进噪音。低于门槛的正确答案是「什么都不画」。
    expect(contextPressure(0)).toBeNull()
    expect(contextPressure(12)).toBeNull()
    expect(contextPressure(69)).toBeNull()
  })

  it('70 进 caution，90 进 danger，且门槛是闭区间', () => {
    // 边界取闭区间（>=）而不是开区间：69 不标、70 标，是这两个数字的全部含义。
    // 若哪天有人改成 >，这两条会红——那正是「门槛整体挪了一格」的信号。
    expect(contextPressure(69)).toBeNull()
    expect(contextPressure(70)).toBe('caution')
    expect(contextPressure(89)).toBe('caution')
    expect(contextPressure(90)).toBe('danger')
    expect(contextPressure(100)).toBe('danger')
  })

  it('两档必须彼此可区分——把 danger 折成 caution 的改动要在这里红', () => {
    // 只验单点时，「两档返回同一个值」照样全绿。所以显式要求它们不等。
    expect(contextPressure(95)).not.toBe(contextPressure(75))
  })

  it('档位名取自共享的风险词汇，不是本地自造的颜色名', () => {
    // 逻辑层出现 'amber'/'red' 就是把 CSS 的事搬进了判定：同一行上的授权标记已经用 RISK_TIERS
    // 这套词（caution/danger → CSS 里各自上色），压力若另造一套，换主题时必然漏掉一套。
    // 判据是「返回值确实是 RISK_TIERS 的成员」，而不是「字符串长得像」。
    for (const percent of [75, 95]) {
      expect(RISK_TIERS).toContain(contextPressure(percent))
    }
  })
})
