/**
 * `working` 状态的衰减判定——纯函数，与渲染、定时器解耦。
 *
 * 要害不在「能不能算出到点了」，而在**衰减的边界与诚实**：只有 `working` 会因静默被证伪，其余状态
 * （waiting/blocked 是静止声明、done/error 是结论、starting/running/… 本就不是在干活的声明）静默都
 * 与之相容，绝不能被删；落点必须是中性的 `unknown`，不许伪造成 done/error。这里守的正是这些边。
 *
 * 阈值 15 分钟的理由不在此断言其具体数值（那会把测试变成抄常量），而由「远高过一次长构建/长测试」
 * 这条性质来守：见「长命令期间的健康 Agent 不被误降级」用例。
 */

import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../src/types.js'
import {
  DECAYED_SEMANTIC_STATE,
  msUntilSemanticStatusStale,
  semanticStatusStale
} from '../src/agent-status-freshness.js'

const STALE_AFTER_MS = 15 * 60_000

function status(state: AgentStatus['state'], observedAt: number): Pick<AgentStatus, 'state' | 'observedAt'> {
  return { state, observedAt }
}

describe('working 状态在无新证据时会衰减', () => {
  it('静默超过阈值的 working 判为陈旧', () => {
    expect(semanticStatusStale(status('working', 0), STALE_AFTER_MS + 1)).toBe(true)
  })

  it('恰好到点即算陈旧（>= 而非 >，免得定时器取整落在线上时空转）', () => {
    expect(semanticStatusStale(status('working', 0), STALE_AFTER_MS)).toBe(true)
  })

  it('还没到点的 working 不判陈旧', () => {
    expect(semanticStatusStale(status('working', 0), STALE_AFTER_MS - 1)).toBe(false)
  })
})

describe('衰减落到中性/未知，不伪造成 done 或 error', () => {
  it('衰减落点是 unknown——我们确实不知道它现在怎么样', () => {
    // 这条钉死落点的诚实性：改成 'done'/'error' 都是编造一个没观察到的结论，必须变红。
    expect(DECAYED_SEMANTIC_STATE).toBe('unknown')
    expect(DECAYED_SEMANTIC_STATE).not.toBe('done')
    expect(DECAYED_SEMANTIC_STATE).not.toBe('error')
  })
})

describe('不把「停下来等你/已出结论」的状态误删', () => {
  it('waiting 永不衰减——它是静止声明，静默与之相容', () => {
    expect(semanticStatusStale(status('waiting', 0), STALE_AFTER_MS * 100)).toBe(false)
    expect(msUntilSemanticStatusStale(status('waiting', 0), 0)).toBe(0)
  })

  it('blocked 永不衰减', () => {
    expect(semanticStatusStale(status('blocked', 0), STALE_AFTER_MS * 100)).toBe(false)
  })

  it('done/error 是结论，永不衰减——删掉就是抹掉真实发生过的结果', () => {
    expect(semanticStatusStale(status('done', 0), STALE_AFTER_MS * 100)).toBe(false)
    expect(semanticStatusStale(status('error', 0), STALE_AFTER_MS * 100)).toBe(false)
  })

  it('running/starting/disconnected/exited 本就不是在干活的声明，不衰减', () => {
    for (const state of ['running', 'starting', 'disconnected', 'exited'] as const) {
      expect(semanticStatusStale(status(state, 0), STALE_AFTER_MS * 100)).toBe(false)
    }
  })
})

describe('有新证据到达时正常刷新，不误降活着的 Agent', () => {
  it('阈值内的每一次刷新都把定时器排到满额——活着的 Agent 够不到衰减', () => {
    // observedAt 每被一次新 hook 事件抬高，msUntil 就重回满额；只要刷新间隔 < 阈值就永远不陈旧。
    const observedAt = 1_000_000
    const now = observedAt + 5 // 一次新证据刚落地
    expect(semanticStatusStale(status('working', observedAt), now)).toBe(false)
    expect(msUntilSemanticStatusStale(status('working', observedAt), now)).toBe(STALE_AFTER_MS - 5)
  })

  it('一条正跑长命令、几分钟不出 hook 的健康 Agent 不被误降级', () => {
    // 一次长构建/长测试期间没有任何 hook 事件；阈值必须明确高过这个上界。取一个宽裕的 5 分钟静默：
    // 若阈值被拍成一个「几分钟」的小数，这条会红——它守的是「远高过一次工具调用上界」这条性质。
    const fiveMinutesQuiet = 5 * 60_000
    expect(semanticStatusStale(status('working', 0), fiveMinutesQuiet)).toBe(false)
  })
})

describe('msUntilSemanticStatusStale 给定时器算延时', () => {
  it('working 刚落地时返回满额 TTL', () => {
    expect(msUntilSemanticStatusStale(status('working', 0), 0)).toBe(STALE_AFTER_MS)
  })

  it('已过阈值则为 0（无需再等，立即可衰减）', () => {
    expect(msUntilSemanticStatusStale(status('working', 0), STALE_AFTER_MS + 10)).toBe(0)
  })

  it('不可衰减的状态一律返回 0', () => {
    expect(msUntilSemanticStatusStale(status('waiting', 0), 0)).toBe(0)
    expect(msUntilSemanticStatusStale(status('done', 0), 0)).toBe(0)
  })
})
