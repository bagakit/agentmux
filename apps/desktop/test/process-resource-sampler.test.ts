import { describe, expect, it } from 'vitest'
import {
  USAGE_METRIC_SPECS,
  USAGE_SAMPLE_INTERVAL_MS,
  aggregateUsage,
  parseProcessTable,
  pruneSamples,
  rollUpSubtrees,
  type ProcessRow,
  type UsageSample
} from '../src/shared/process-usage.js'

/**
 * 归并的正确性。
 *
 * 这一层是纯函数，因此可以在没有真实进程的情况下把难的部分测透：子树、共享祖先、
 * 进程已退出。起子进程那一层另有断言（折叠零采样、in-flight 去重）。
 */

const TABLE = `  PID  PPID    RSS  %CPU
    1     0  17104   0.2
  100     1  10000   5.0
  101   100   2000   1.0
  102   100   3000   2.0
  103   101    500   0.5
  200     1   8000   4.0`

describe('parseProcessTable', () => {
  it('读出每一行的 pid/ppid/rss/cpu，跳过表头', () => {
    const rows = parseProcessTable(TABLE)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({ pid: 1, ppid: 0, rssKib: 17104, cpuPercent: 0.2 })
    expect(rows.find((row) => row.pid === 103))
      .toEqual({ pid: 103, ppid: 101, rssKib: 500, cpuPercent: 0.5 })
  })

  it('坏行被跳过，不让整次采样失败', () => {
    // ps 在进程正好退出时可能吐出残行；为一行坏数据丢掉整次采样，比少算一个进程糟得多。
    const rows = parseProcessTable('  PID  PPID    RSS  %CPU\n  1  0  100  0.1\ngarbage line\n  2  1\n  3  1  200  0.2')
    expect(rows.map((row) => row.pid)).toEqual([1, 3])
  })

  it('空输入得到空表，而不是抛错', () => {
    expect(parseProcessTable('')).toEqual([])
  })
})

describe('rollUpSubtrees', () => {
  const rows = parseProcessTable(TABLE)

  it('把整棵子树归到 run 上，含根进程自己', () => {
    const usage = rollUpSubtrees(rows, [{ key: 'run-a', pid: 100 }])
    // 100 + 101 + 102 + 103 = 4 个进程，15500 KiB，8.5%
    expect(usage.get('run-a')).toEqual({ processCount: 4, rssKib: 15500, cpuPercent: 8.5 })
  })

  it('两个不相干的 run 各算各的', () => {
    const usage = rollUpSubtrees(rows, [
      { key: 'run-a', pid: 100 },
      { key: 'run-b', pid: 200 }
    ])
    expect(usage.get('run-a')?.rssKib).toBe(15500)
    expect(usage.get('run-b')).toEqual({ processCount: 1, rssKib: 8000, cpuPercent: 4 })
  })

  it('共享祖先按注册顺序只归第一个，不重复计数', () => {
    // 101 在 100 的子树里。两个都算，101 那一支就会被数两遍，总和超过机器实际用量——
    // 一个虚高的数字比没有这个数字更糟。
    const usage = rollUpSubtrees(rows, [
      { key: 'outer', pid: 100 },
      { key: 'inner', pid: 101 }
    ])
    expect(usage.get('outer')?.processCount).toBe(4)
    // inner 的进程已被 outer 全部认领，它一个都没剩下——如实报不可用，不报 0。
    expect(usage.get('inner')).toBeNull()

    // 顺序反过来，先注册的那个拿走重叠部分。
    const reversed = rollUpSubtrees(rows, [
      { key: 'inner', pid: 101 },
      { key: 'outer', pid: 100 }
    ])
    expect(reversed.get('inner')).toEqual({ processCount: 2, rssKib: 2500, cpuPercent: 1.5 })
    // outer 剩下 100 与 102（101/103 已被 inner 认领）。
    expect(reversed.get('outer')).toEqual({ processCount: 2, rssKib: 13000, cpuPercent: 7 })

    // 无论顺序如何，两者之和都不超过整棵树的实际用量——这才是"不重复计数"的判据。
    const wholeTree = 10000 + 2000 + 3000 + 500
    for (const map of [usage, reversed]) {
      const total = [...map.values()].reduce((sum, entry) => sum + (entry?.rssKib ?? 0), 0)
      expect(total).toBe(wholeTree)
    }
  })

  it('pid 不在表里的 run 报不可用，而不是 0', () => {
    // 0 是一个会被读成真值的谎：用户会以为这个 Agent 在跑但不吃资源。
    const usage = rollUpSubtrees(rows, [{ key: 'gone', pid: 99999 }])
    expect(usage.get('gone')).toBeNull()
  })

  it('空表时每个 run 都是不可用', () => {
    const usage = rollUpSubtrees([], [{ key: 'a', pid: 1 }, { key: 'b', pid: 2 }])
    expect(usage.get('a')).toBeNull()
    expect(usage.get('b')).toBeNull()
  })

  it('进程树很深也不靠递归——不让系统决定我们的调用栈深度', () => {
    const deep: ProcessRow[] = [{ pid: 1, ppid: 0, rssKib: 1, cpuPercent: 0 }]
    for (let pid = 2; pid <= 20_000; pid += 1) {
      deep.push({ pid, ppid: pid - 1, rssKib: 1, cpuPercent: 0 })
    }
    const usage = rollUpSubtrees(deep, [{ key: 'deep', pid: 1 }])
    expect(usage.get('deep')?.processCount).toBe(20_000)
  })
})

/**
 * 采样周期、聚合窗口、聚合方式是三件事。
 *
 * 用户口径：CPU 每秒采样，显示前 10 秒窗口的峰值。把三者合成一个"刷新率"会同时定死三个
 * 不相干的取舍，且会强迫内存也用峰值——内存是水位不是速率，取峰值会把一个早就释放掉的
 * 高点一直挂在面板上。
 */
describe('聚合口径', () => {
  const now = 100_000
  const at = (msAgo: number, cpu: number, rss: number): UsageSample =>
    ({ observedAt: now - msAgo, cpuPercent: cpu, rssKib: rss })

  it('CPU 取窗口峰值，内存取最近一次——两个指标口径不同', () => {
    const samples = [at(9_000, 10, 500), at(5_000, 90, 800), at(1_000, 20, 600)]
    const { cpuPercent, rssKib } = aggregateUsage(samples, now)
    // 峰值：这十秒里它最凶的时候有多凶。
    expect(cpuPercent).toBe(90)
    // 水位：此刻是多少，不是这十秒的最高点。
    expect(rssKib).toBe(600)
  })

  it('窗口外的样本被丢掉，不让早已过去的高点一直挂着', () => {
    const stale = [at(30_000, 99, 9_999), at(2_000, 15, 400)]
    expect(aggregateUsage(stale, now)).toEqual({ cpuPercent: 15, rssKib: 400 })
  })

  it('窗口内没有样本时报 null——"还不知道"与"是 0"必须分得开', () => {
    expect(aggregateUsage([], now)).toEqual({ cpuPercent: null, rssKib: null })
    expect(aggregateUsage([at(60_000, 50, 100)], now)).toEqual({ cpuPercent: null, rssKib: null })
  })

  it('三个口径分别可配，不是一个写死的刷新率', () => {
    expect(USAGE_METRIC_SPECS.cpu).toEqual({ windowMs: 10_000, aggregate: 'peak' })
    expect(USAGE_METRIC_SPECS.rss.aggregate).toBe('latest')
    // 扫描按最密的指标走一次，各指标再用自己的窗口聚合——不为每个指标各扫一次。
    expect(USAGE_SAMPLE_INTERVAL_MS).toBe(1_000)
    expect(USAGE_SAMPLE_INTERVAL_MS).toBeLessThan(USAGE_METRIC_SPECS.cpu.windowMs)
  })

  it('聚合方式可替换，峰值不是硬编码', () => {
    const samples = [at(5_000, 10, 100), at(1_000, 30, 300)]
    const mean = aggregateUsage(samples, now, {
      cpu: { windowMs: 10_000, aggregate: 'mean' },
      rss: { windowMs: 10_000, aggregate: 'peak' }
    })
    expect(mean.cpuPercent).toBe(20)
    expect(mean.rssKib).toBe(300)
  })

  it('环形缓冲按最长窗口裁剪，不无限增长', () => {
    const samples = [at(30_000, 1, 1), at(11_000, 2, 2), at(9_000, 3, 3), at(0, 4, 4)]
    expect(pruneSamples(samples, now).map((sample) => sample.cpuPercent)).toEqual([3, 4])
  })
})
