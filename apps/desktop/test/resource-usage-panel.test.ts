import { describe, expect, it } from 'vitest'
import {
  formatCpu,
  formatRss,
  usagePanelRows
} from '../src/renderer/src/lib/resource-usage-panel.js'
import type {
  AgentTimelineItem,
  AgentTimelineSnapshot,
  SessionSnapshot,
  UsageSnapshot
} from '../src/shared/contracts.js'

/**
 * 面板显示层：数字怎么写，取不到时写什么，以及「最近在改什么」那一行的诚实退化。
 *
 * 关键的两条：
 *   1. null 与 0 必须分得开——0 会被读成"它在跑但不吃资源"这个真值。
 *   2. 时间轴按需拉取，多数行没有它。没有时不许编一行「activity」，更不许把裸状态重复成 activity——
 *      那会把"还没加载"伪装成"真的在做某事"（原则 11 class 3）。
 */

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    observedAt: 1_000,
    runs: [],
    app: null,
    unavailable: null,
    ...overrides
  }
}

function agent(id: string, runId: string, label: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    hostId: 'local',
    workspacePath: '/w',
    label,
    createdAt: 0,
    updatedAt: 0,
    processState: 'running',
    status: { state: 'working', observedAt: 0 },
    latestOutputBytes: 0,
    kind: 'agent',
    providerId: 'claude',
    executorId: 'claude-code',
    capabilities: {},
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId, hostId: 'local' } },
    ...over
  } as unknown as SessionSnapshot
}

function toolCall(over: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return {
    id: 't1',
    agentSessionId: 's1',
    kind: 'tool_call',
    status: 'complete',
    source: 'native-hook',
    createdAt: 0,
    updatedAt: 0,
    title: 'Edit',
    toolName: 'edit',
    toolInput: '{"file_path":"src/foo.ts"}',
    ...over
  }
}

function timeline(agentSessionId: string, items: AgentTimelineItem[]): Record<string, AgentTimelineSnapshot> {
  return { [agentSessionId]: { agentSessionId, revision: 1, items } }
}

describe('资源面板的读数', () => {
  it('拿不到数时显示中性记号，绝不落成 0', () => {
    // 0 是一个会被读成真值的谎。这条守的就是那件事。
    expect(formatCpu(null)).toBe('—')
    expect(formatRss(null)).toBe('—')
    expect(formatCpu(null)).not.toBe('0.0%')
    // 真的是 0 时照常显示 0——"不知道"与"确实是零"两边都要说得出来。
    expect(formatCpu(0)).toBe('0.0%')
    expect(formatRss(0)).toBe('0 MiB')
  })

  it('内存按量级换单位，不甩一串 KiB 给人读', () => {
    expect(formatRss(524_288)).toBe('512 MiB')
    expect(formatRss(2_097_152)).toBe('2.0 GiB')
  })

  it('CPU 只留一位小数——第二位是噪音在跳', () => {
    expect(formatCpu(12.34)).toBe('12.3%')
    expect(formatCpu(100)).toBe('100.0%')
  })
})

describe('把采样配上 Agent 的名字', () => {
  it('按 runId 配名字', () => {
    const rows = usagePanelRows(
      snapshot({ runs: [{ runId: 'run-1', processCount: 2, cpuPercent: 5, rssKib: 102_400 }] }),
      [agent('s1', 'run-1', 'Reviewer')]
    )
    expect(rows).toEqual([{ key: 'run-1', label: 'Reviewer', cpuText: '5.0%', rssText: '100 MiB', contextText: 'claude · w', stateText: 'working' }])
  })

  it('配不上名字的 run 仍然显示', () => {
    // 它确实在吃资源。藏起来会让面板上的数与机器实际用量对不上，而对不上时
    // 用户无从判断是哪一边错了。
    const rows = usagePanelRows(
      snapshot({ runs: [{ runId: 'orphan-abcdef123', processCount: 1, cpuPercent: 1, rssKib: 1024 }] }),
      []
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('orphan-a')
    // 没有 Session 就没有「最近在改什么」这层语义——绝不因此崩，也绝不编一行。
    expect(rows[0]!.activity).toBeUndefined()
  })

  it('没有快照时没有行——不拿空数组冒充"采到了但都是 0"', () => {
    expect(usagePanelRows(null, [agent('s1', 'run-1', 'Reviewer')])).toEqual([])
  })

  it('进程已退出的 run 两个读数都是中性记号', () => {
    const rows = usagePanelRows(
      snapshot({ runs: [{ runId: 'run-1', processCount: 0, cpuPercent: null, rssKib: null }] }),
      [agent('s1', 'run-1', 'Gone')]
    )
    expect(rows[0]).toEqual({ key: 'run-1', label: 'Gone', cpuText: '—', rssText: '—', contextText: 'claude · w', stateText: 'working' })
  })
})

describe('「最近在改什么」这一行的诚实退化', () => {
  it('有时间轴时，把最近一条 tool_call 翻成人话', () => {
    const rows = usagePanelRows(
      snapshot({ runs: [{ runId: 'run-1', processCount: 1, cpuPercent: 3, rssKib: 2048 }] }),
      [agent('s1', 'run-1', 'Reviewer')],
      { timelines: timeline('s1', [toolCall()]) }
    )
    // stepTitle 复用同一份派生：title + 最具识别性的参数。
    expect(rows[0]!.activity).toBe('Edit src/foo.ts')
  })

  it('没有时间轴的 working 行照常渲染，但绝不编一行 activity', () => {
    // 这是最常见的情形：时间轴按需拉取，多数 Session 此刻没有。空数组必须退回到只报状态，
    // 而不是把裸状态 'working' 重复成 activity——那会把"还没加载"伪装成"确实在做某事"。
    const rows = usagePanelRows(
      snapshot({ runs: [{ runId: 'run-1', processCount: 1, cpuPercent: 3, rssKib: 2048 }] }),
      [agent('s1', 'run-1', 'Reviewer')]
    )
    expect(rows[0]!.label).toBe('Reviewer')
    expect(rows[0]!.stateText).toBe('working')
    expect(rows[0]!.activity).toBeUndefined()
  })

  it('pendingInteraction 凌驾一切：卡在用户身上时那句就是 activity', () => {
    const rows = usagePanelRows(
      snapshot({ runs: [{ runId: 'run-1', processCount: 1, cpuPercent: 3, rssKib: 2048 }] }),
      [agent('s1', 'run-1', 'Reviewer', {
        status: { state: 'waiting', observedAt: 0 },
        pendingInteraction: { kind: 'permission', title: 'Allow edit to config.ts?' }
      } as Partial<SessionSnapshot>)],
      // 有没有时间轴都不影响——pending 排在最前。
      { timelines: timeline('s1', [toolCall()]) }
    )
    expect(rows[0]!.activity).toBe('Allow edit to config.ts?')
  })

  it('Run 已结束时，一条已完成的 tool_call 不再冒充"正在干"', () => {
    // 新旧判定：complete 的那条只在 Session 仍活跃时才算最近。done 的 Session 落回状态答案。
    const rows = usagePanelRows(
      snapshot({ runs: [{ runId: 'run-1', processCount: 0, cpuPercent: null, rssKib: null }] }),
      [agent('s1', 'run-1', 'Reviewer', { status: { state: 'done', observedAt: 0 } } as Partial<SessionSnapshot>)],
      { timelines: timeline('s1', [toolCall({ status: 'complete' })]) }
    )
    // done ≠ working，stateText 会是 idle 时长；activity 不该把那条历史编辑当现状。
    expect(rows[0]!.activity).toBeUndefined()
  })
})

