import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { AgentTimelineItem, SessionSnapshot } from '../src/shared/contracts.js'
import { projectActivityRow } from '../src/renderer/src/lib/project-activity-row.js'

// 项目活动菜单里每个 Agent 行的**编辑规则**：哪种 Session 显示哪些字段。这里钉的是决策，不是 markup——
// 一个「卡在你身上」的行与一个「安静干活」的行必须形状不同（不同的 attention 分级 + 不同的尾随事实），
// 缺时间轴的行仍要产出一句人话，缺 turnUsage 时绝不显示 0%。now 作形参传入，测试不依赖真实时钟。

const NOW = 1_000_000

function agent(spec: {
  state?: AgentDisplayState
  detail?: string
  observedAt?: number
  context?: { usedTokens: number; capacityTokens: number }
  pending?: unknown
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
      source: 'native-hook',
      observedAt: spec.observedAt ?? NOW,
      ...(spec.detail ? { detail: spec.detail } : {})
    },
    latestOutputBytes: 0,
    ...(spec.pending ? { pendingInteraction: spec.pending } : {}),
    ...(spec.context ? { turnUsage: { outputTokens: 1, inputTokens: 1, totalTokens: 2, observedAt: NOW, context: spec.context } } : {}),
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'a1', run: { runId: 'run-a1' } }
  } as unknown as SessionSnapshot
}

const EDIT: AgentTimelineItem = {
  id: 't-edit', agentSessionId: 'a1', kind: 'tool_call', status: 'streaming',
  source: 'native-hook', createdAt: 1, updatedAt: 1,
  title: 'Edit', toolName: 'Edit', toolInput: JSON.stringify({ file_path: '/repo/x.ts' })
} as AgentTimelineItem

describe('projectActivityRow — 分级：blocked 与 working 的行形状不同', () => {
  it('needs-you（等你回答）：amber 描色，尾随「等了你多久」而非它在忙什么', () => {
    const row = projectActivityRow(agent({ state: 'waiting', observedAt: NOW - 90_000 }), [], NOW)
    expect(row.attention).toBe('needs-you')
    expect(row.meta).toBe('waiting 1m')
  })

  it('blocked 同属 needs-you：也描 amber、也尾随等待时长', () => {
    const row = projectActivityRow(agent({ state: 'blocked', observedAt: NOW - 5_000 }), [], NOW)
    expect(row.attention).toBe('needs-you')
    expect(row.meta).toBe('waiting 5s')
  })

  it('working（安静干活）：不描色（attention=null），尾随的是它在忙什么的次要事实，不是等待时长', () => {
    const row = projectActivityRow(agent({ state: 'working', observedAt: NOW - 90_000 }), [], NOW)
    // 关键对比：与上面 needs-you 那两行**形状不同**——中性色，且尾随绝不是 "waiting …"。
    expect(row.attention).toBeNull()
    expect(row.meta).toBe('active now')
    expect(row.meta).not.toContain('waiting')
  })

  it('error：red 描色，尾随「多久以前」，不是 " idle"（它不是闲着，是坏了）', () => {
    const row = projectActivityRow(agent({ state: 'error', observedAt: NOW - 3_600_000 }), [], NOW)
    expect(row.attention).toBe('error')
    expect(row.meta).toBe('1h ago')
    expect(row.meta).not.toContain('idle')
  })
})

describe('projectActivityRow — working 行的上下文压力（turnUsage 三态，绝不塌成 0）', () => {
  it('报了用量：尾随 ctx N%', () => {
    const row = projectActivityRow(agent({ state: 'working', context: { usedTokens: 30, capacityTokens: 100 } }), [], NOW)
    expect(row.meta).toBe('ctx 30%')
  })

  it('没有 turnUsage：显示 active now，绝不显示 ctx 0%', () => {
    const row = projectActivityRow(agent({ state: 'working' }), [], NOW)
    expect(row.meta).toBe('active now')
    expect(row.meta).not.toContain('%')
    expect(row.meta).not.toContain('0')
  })

  it('容量为 0（不可算）：退回 active now，不编一个 0%', () => {
    const row = projectActivityRow(agent({ state: 'working', context: { usedTokens: 10, capacityTokens: 0 } }), [], NOW)
    expect(row.meta).toBe('active now')
  })
})

describe('projectActivityRow — 主句与降级行（原则 11 class 3）', () => {
  it('有时间轴：主句取最近的 tool_call（在改什么）', () => {
    const row = projectActivityRow(agent({ state: 'working' }), [EDIT], NOW)
    expect(row.reason).toBe('Edit /repo/x.ts')
  })

  it('缺时间轴（常态）：仍产出基于状态的一句人话，绝不空串、绝不谎报 Idle', () => {
    const row = projectActivityRow(agent({ state: 'working', detail: 'crunching numbers' }), [], NOW)
    expect(row.reason).toBe('crunching numbers')
    expect(row.reason).not.toBe('')
    expect(row.reason.toLowerCase()).not.toContain('idle')
    // 降级行的形状仍完整：中性色 + 一段尾随，与富信息行视觉一致，不会一行富两行秃。
    expect(row.attention).toBeNull()
    expect(row.meta).not.toBeNull()
  })

  it('idle/done 类：尾随空闲时长', () => {
    const row = projectActivityRow(agent({ state: 'done', observedAt: NOW - 120_000 }), [], NOW)
    expect(row.attention).toBeNull()
    expect(row.meta).toBe('2m idle')
  })

  it('needs-you 优先于 tool_call：卡在用户身上时主句是那条请求，不是最近的编辑', () => {
    const row = projectActivityRow(
      agent({ state: 'blocked', pending: { kind: 'permission', title: 'Allow Bash?' } }),
      [EDIT],
      NOW
    )
    expect(row.reason).toBe('Allow Bash?')
    expect(row.attention).toBe('needs-you')
  })
})
