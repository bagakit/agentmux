import { describe, expect, it } from 'vitest'
import { rawEventNamesForLifecycle } from '../src/agent-hook-event.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'

/**
 * 守「携带权威输出光标的收尾回执，按 canonical 生命周期判，不按原始拼法」。
 *
 * 缺陷：这道守卫原本写成 `eventName !== 'Stop'`，而收尾事件不止一种拼法——`StopFailure`（以及别家
 * Provider 的收尾方言）在 canonical 表里同样归一到 `turn-end`（agent-hook-event.ts）。client 摄入侧
 * 对收尾事件一律取 `kernel.status()` 的光标（client.ts:3662），于是一条**合法**的 StopFailure 回执
 * 带着光标走到这里，被字面比较当成伪造，整条 hook 落盘失败。
 *
 * 后果不是少一条日志：`native-stop` 是 readiness epoch 的**唯一**续期来源（client.ts:3701，另一个
 * 来源 `initial-composer` 一个 run 只发一次）。回执被拒 ⇒ epoch 不续 ⇒ 该 run 之后每一次发送都撞
 * `AGENT_PROMPT_READINESS_CONSUMED`，永久失能。也就是说：agent 只要有一轮是异常收尾的，它就再也
 * 收不到消息了。
 *
 * 判据从 SSOT 反查（`rawEventNamesForLifecycle('turn-end')`）而不是手抄一份拼法清单——手抄的那份
 * 会和表漂移，而漂移的方向恰好就是这个缺陷本身。
 */

const TURN_END_RAW_NAMES = rawEventNamesForLifecycle('turn-end')
const SECOND_SPELLINGS = TURN_END_RAW_NAMES.filter((name) => name !== 'Stop')

function sessionWithReceipt(eventName: string, withCursor: boolean): unknown {
  return {
    kind: 'agent' as const,
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 12,
    createdAt: 100,
    updatedAt: 200,
    hookReceipt: {
      id: 'receipt-1',
      providerId: 'codex',
      agentSessionId: 'semantic-1',
      run: { runId: 'daemon-1' },
      eventName,
      observedAt: 200,
      ...(withCursor ? { outputCursorBytes: 128 } : {})
    }
  }
}

describe('携带输出光标的回执按 canonical 收尾事件判定', () => {
  it('canonical 表里确实存在 Stop 以外的收尾拼法（否则本文件是空扫）', () => {
    expect(TURN_END_RAW_NAMES).toContain('Stop')
    expect(SECOND_SPELLINGS.length).toBeGreaterThan(0)
  })

  it.each(TURN_END_RAW_NAMES)('%s 带光标落盘被接受（合法回执不被当成伪造）', (eventName) => {
    // 承重的那一半：把实现折回 `eventName !== 'Stop'`，`StopFailure` 这一档立刻红。
    const normalized = normalizeStoredAgentSession(sessionWithReceipt(eventName, true))
    expect(normalized.hookReceipt?.outputCursorBytes).toBe(128)
  })

  it('非收尾事件带光标仍被拒——防伪造那一侧没有被放宽', () => {
    // 另一半：判据不能宽到认下一切。mid-turn 的字节位置当边界会让 composer 就绪判定
    // 把上一轮的提示符认成这一轮的。
    expect(() => normalizeStoredAgentSession(sessionWithReceipt('PostToolUse', true)))
      .toThrow(/authoritative output cursor/)
  })

  it('非收尾事件不带光标照常落盘（拒的是光标，不是事件）', () => {
    expect(normalizeStoredAgentSession(sessionWithReceipt('PostToolUse', false)).hookReceipt?.eventName)
      .toBe('PostToolUse')
  })
})
