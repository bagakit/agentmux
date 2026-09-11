import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
import { browserOperatorForSession } from '../src/renderer/src/lib/browser-operator-identity'

/**
 * 「是哪个 Agent 在动我的浏览器」——轨迹条上这个问题的答案从哪来。
 *
 * 缺陷形态：调用点原先拼 `Agent ${agentSessionId}`，于是轨迹上是一串 UUID，providerId 从不设置，
 * 头像退化成通用图标。真实身份就在同一个作用域里（renderer 持有 sessions 投影），不是缺数据，
 * 是缺这一次解析。
 */

function session(fields: Record<string, unknown>): SessionSnapshot {
  return fields as unknown as SessionSnapshot
}

describe('browserOperatorForSession：操作者身份取自真实 Session', () => {
  const sessions = [
    session({ kind: 'agent', id: 's-1', label: 'Sonnet · agentmux', providerId: 'provider-a' }),
    session({ kind: 'agent', id: 's-2', label: 'Reviewer · docs', providerId: 'provider-b' }),
    session({ kind: 'terminal', id: 't-1', label: 'zsh' })
  ]

  it('取 Session 自己的 label，而不是用 id 拼一个名字', () => {
    // 这条就是用户报的那半——轨迹上应该看得出是谁。把实现改回 `Agent ${id}` 这条当场红。
    expect(browserOperatorForSession('s-1', sessions).name).toBe('Sonnet · agentmux')
  })

  it('带上 providerId，头像才画得出这个 Agent 的图标', () => {
    // 原先这个字段从不设置，于是头像一律是通用图标——两个 Agent 在轨迹上长得一模一样。
    expect(browserOperatorForSession('s-1', sessions).providerId).toBe('provider-a')
  })

  it('两个不同的 Session 解析出互不相同的身份', () => {
    // 钉死「确实在按 id 查」而不是「总返回第一个」：后者在只有一个 Agent 的开发环境下看起来完全正常。
    const first = browserOperatorForSession('s-1', sessions)
    const second = browserOperatorForSession('s-2', sessions)
    expect(first.name).not.toBe(second.name)
    expect(first.providerId).not.toBe(second.providerId)
  })

  it('id 原样带回，轨迹能连回那个 Session', () => {
    expect(browserOperatorForSession('s-2', sessions).id).toBe('s-2')
  })

  it('Session 找不到时退回 id，不编造名字', () => {
    // 缺席**不是**编个看起来像真名的字符串的理由。显示 id 会让人去查这是谁；
    // 显示 "Agent 7f3a9c2e" 会让人以为那就是它的名字。
    const operator = browserOperatorForSession('s-gone', sessions)
    expect(operator.name).toBe('s-gone')
    expect(operator.name).not.toContain('Agent ')
    expect(operator.providerId).toBeUndefined()
  })

  it('非 Agent 的 Session 不冒充 Agent 身份', () => {
    // 终端 Session 也在同一个列表里且 id 可能撞上。按 kind 判，不是按「找到了就用」。
    const operator = browserOperatorForSession('t-1', sessions)
    expect(operator.name).toBe('t-1')
    expect(operator.providerId).toBeUndefined()
  })

  it('providerId 缺席时那个键不在场，而不是在场为 undefined', () => {
    // `'providerId' in operator` 与 `operator.providerId ? …` 在「在场但为 undefined」时给出
    // 相反的答案。钉死缺席这一侧，下游两种写法都成立。
    const noProvider = [session({ kind: 'agent', id: 's-3', label: 'Nameless' })]
    expect('providerId' in browserOperatorForSession('s-3', noProvider)).toBe(false)
  })

  it('空列表不抛，退回 id', () => {
    expect(browserOperatorForSession('s-1', []).name).toBe('s-1')
  })
})
