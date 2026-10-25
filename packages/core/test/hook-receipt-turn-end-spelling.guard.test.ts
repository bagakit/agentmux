import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'

const TURN_END_RAW_NAMES = ['fixtureFinished', 'fixture_failed']

function sessionWithReceipt(eventName: string, withCursor: boolean): unknown {
  return {
    kind: 'agent' as const,
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: fixturePath("tmp/work"),
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',

    createdAt: 100,
    updatedAt: 200,
    hookReceipt: {
      id: 'receipt-1',
      providerId: 'codex',
      agentSessionId: 'semantic-1',
      run: { runId: 'daemon-1' },
      eventName,
      lifecycleEvent: eventName === 'PostToolUse' ? 'tool-use-end' : 'turn-end',
      observedAt: 200,
      ...(withCursor ? { outputCursorBytes: 128 } : {})
    }
  }
}

describe('携带输出光标的回执按 canonical 收尾事件判定', () => {
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
