import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import {
  DECAYED_SEMANTIC_STATE,
  agentDisplayState,
  msUntilSemanticStatusStale
} from '@agentmux/core/agent-status'
import type { AgentTimelineItem, SessionSnapshot } from '../src/shared/contracts.js'
import { projectActivityRow } from '../src/renderer/src/lib/project-activity-row.js'
import { sessionBoardColumn } from '../src/renderer/src/lib/project-board.js'

// 一个 15 分钟没人听到的 Agent 不该在活动菜单里读作 "active now"。
//
// 由来：core 的衰减把静默超阈值的 `working` 落成显示态 `running`（仍在 Board 的 working 列，
// observedAt 原样保留——衰减是对旧观察的重新解读，不是新观察）。project-activity-row 的 working 臂
// 此前对整个 working 列一律尾随 `active now`（报得出用量时是 `ctx N%`），于是那个 running 被说成
// "active now"——系统先算出了真相（"不知道"），又用一句安抚话盖掉。这与 dc77127c 修的状态点是同一
// 族缺陷：机制对、最后那句标签撒谎。
//
// 这里钉的是**性质**，不是抄来的字面量：
//   1. 阈值从 core 的 `msUntilSemanticStatusStale` 反推（刚落地的 working 的满额 TTL 就是那个窗口），
//      所以它跟着 SSOT 走、不会与被测常量一起漂成恒真。
//   2. 陈旧的那条 Session 用的正是**衰减产物**——`agentDisplayState(DECAYED_SEMANTIC_STATE)`，即
//      renderer 里真正会到达显示层的那个 `running`，不是手写一个 'running' 字面量。
//   3. 计数不许因此改：这条 Session 仍在 `sessionBoardColumn` 的 working 列。显示层只改文案、不另判
//      一次"在跑吗"，working-count-convergence 的收敛因此不变。

const NOW = 100_000_000
// 刚落地的 working 的满额 TTL === 新鲜度窗口。取自 core，不抄 15*60_000。
const STALE_WINDOW = msUntilSemanticStatusStale({ state: 'working', observedAt: 0 }, 0)
// renderer 真正会遇到的"陈旧 working"长什么样：衰减落点 unknown → 显示态 running。
const DECAYED_STATE: AgentDisplayState = agentDisplayState(DECAYED_SEMANTIC_STATE)

function agent(spec: {
  state?: AgentDisplayState
  observedAt?: number
  context?: { usedTokens: number; capacityTokens: number }
} = {}): SessionSnapshot {
  return {
    id: 'a1',
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    label: 'Agent a1',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: {
      state: spec.state ?? 'working',
      //衰减保留 source 不变；显示层不靠 source 判新鲜度，只靠 observedAt。
      source: 'native-hook',
      observedAt: spec.observedAt ?? NOW
    },
    latestOutputBytes: 0,
    ...(spec.context
      ? { turnUsage: { outputTokens: 1, inputTokens: 1, totalTokens: 2, observedAt: NOW, context: spec.context } }
      : {}),
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'a1', run: { runId: 'run-a1' } }
  } as unknown as SessionSnapshot
}

const NO_TIMELINE: readonly AgentTimelineItem[] = []

describe('projectActivityRow — 陈旧的 working 不再谎称 active now', () => {
  it('自检：衰减产物是 running 且落在 working 列（否则下面测的不是真实到达显示层的那条）', () => {
    expect(DECAYED_STATE).toBe('running')
    expect(sessionBoardColumn(agent({ state: DECAYED_STATE }))).toBe('working')
    // 阈值锚点确实是分钟量级，不是 0（否则"陈旧"恒真、"新鲜"用例失去意义）。
    expect(STALE_WINDOW).toBeGreaterThan(60_000)
  })

  it('证据超过新鲜度窗口：尾随「上次活动在多久以前」，绝不是 active now', () => {
    const row = projectActivityRow(
      agent({ state: DECAYED_STATE, observedAt: NOW - STALE_WINDOW }),
      NO_TIMELINE,
      NOW
    )
    expect(row.meta).not.toBe('active now')
    expect(row.meta).not.toContain('active now')
    // 说的是「上次」这件过去时的事，且带一个相对时长（与 needs-you/error 两臂同一个 elapsed 口径）。
    expect(row.meta).toMatch(/last active \d+[smh]/)
  })

  it('刚差 1ms 到窗口：仍算新鲜，照旧 active now（边界不早退一格）', () => {
    const row = projectActivityRow(
      agent({ state: DECAYED_STATE, observedAt: NOW - (STALE_WINDOW - 1) }),
      NO_TIMELINE,
      NOW
    )
    expect(row.meta).toBe('active now')
  })

  it('新鲜的 working 不受影响：报不出用量仍 active now', () => {
    const row = projectActivityRow(agent({ state: 'working', observedAt: NOW - 90_000 }), NO_TIMELINE, NOW)
    expect(row.meta).toBe('active now')
  })

  it('新鲜且报了用量：仍尾随 ctx N%，新鲜度不吃掉上下文压力', () => {
    const row = projectActivityRow(
      agent({ state: 'working', observedAt: NOW - 90_000, context: { usedTokens: 30, capacityTokens: 100 } }),
      NO_TIMELINE,
      NOW
    )
    expect(row.meta).toBe('ctx 30%')
  })

  it('陈旧压过用量：一条 15 分钟没人听到的 Agent，即便还挂着旧用量也不谎称 ctx N%', () => {
    // observedAt 陈旧意味着那条用量也是陈旧一 turn 的；"上次活动多久以前"比一个旧的 ctx% 更诚实。
    const row = projectActivityRow(
      agent({ state: DECAYED_STATE, observedAt: NOW - STALE_WINDOW, context: { usedTokens: 30, capacityTokens: 100 } }),
      NO_TIMELINE,
      NOW
    )
    expect(row.meta).toMatch(/last active \d+[smh]/)
    expect(row.meta).not.toContain('ctx')
  })

  it('收敛不变：陈旧的这条仍在 Board 的 working 列——显示层只改文案，不改归属', () => {
    // working-count-convergence 结构性地要求每个"在跑吗"判定都走 sessionBoardColumn。本修改没有制造
    // 第三个判据：这条 Session 的列归属与它是否陈旧无关。
    const stale = agent({ state: DECAYED_STATE, observedAt: NOW - STALE_WINDOW })
    expect(sessionBoardColumn(stale)).toBe('working')
  })
})
