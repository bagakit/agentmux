import { describe, expect, it } from 'vitest'
import {
  formatCpu,
  formatRss,
  usagePanelRows
} from '../src/renderer/src/lib/resource-usage-panel.js'
import type { SessionSnapshot, UsageSnapshot } from '../src/shared/contracts.js'

/**
 * 面板显示层：数字怎么写，取不到时写什么。
 *
 * 关键的一条是 null 与 0 必须分得开——0 会被读成"它在跑但不吃资源"这个真值。
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

function agent(id: string, runId: string, label: string): SessionSnapshot {
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
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId, hostId: 'local' } }
  } as unknown as SessionSnapshot
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
