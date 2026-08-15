import { describe, expect, it, vi } from 'vitest'
import {
  USAGE_METRIC_SPECS,
  USAGE_SAMPLE_INTERVAL_MS,
  aggregateUsage,
  parseProcessTable,
  pruneSamples,
  rollUpSubtrees,
  type ProcessRow,
  type UsageSample,
  type UsageSnapshot
} from '../src/shared/process-usage.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'

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

  // 上面那些坏行（`garbage line` 一段、`2 1` 两段）全被 `parts.length < 4` 挡掉，永远走不到
  // 数值有限性那道判断。真正危险的残行是"四段齐全、pid/ppid 合法、但 rss/cpu 非数"——`ps` 在
  // 进程正好退出时就会吐这种。它一旦漏进来，会以 NaN 混进子树累加，一路灌到面板显示 NaN。
  // 因此下面两条各盯 `||` 的一侧，且断言落在整条链的终点（rollUp→aggregate）而不只是"被跳过"，
  // 这样即便有人日后把 skip 那行挪走，NaN 也逃不过对汇总数字的检查。
  it('rss 非数的残行不把 NaN 灌进内存汇总（|| 左侧：rssKib）', () => {
    // 100 是根，101 是它的子进程但 rss 是 `x`（四段、pid/ppid 合法、rss 非数）。
    const rows = parseProcessTable('  PID  PPID    RSS  %CPU\n  100     1  10000   5.0\n  101   100      x   2.0')
    const subtree = rollUpSubtrees(rows, [{ key: 'run-a', pid: 100 }]).get('run-a')
    // 好行必须还在——守卫退化成"整批都丢"也不许算过。
    expect(subtree).not.toBeNull()
    expect(subtree?.processCount).toBe(1)
    // 走到面板的那一步：坏行漏进来则 10000 + NaN = NaN，这里钉死为好行独有的 10000。
    const panel = aggregateUsage(
      [{ observedAt: 0, rssKib: subtree!.rssKib, cpuPercent: subtree!.cpuPercent }],
      0
    )
    expect(panel.rssKib).toBe(10000)
  })

  it('cpu 非数的残行不把 NaN 灌进 CPU 汇总（|| 右侧：cpuPercent）', () => {
    // 102 是 100 的子进程但 cpu 是 `z`（四段、pid/ppid 合法、rss 合法、只有 cpu 非数）——
    // 单盯 rss 那侧的守卫会放它过去。
    const rows = parseProcessTable('  PID  PPID    RSS  %CPU\n  100     1  10000   5.0\n  102   100   3000   z')
    const subtree = rollUpSubtrees(rows, [{ key: 'run-a', pid: 100 }]).get('run-a')
    expect(subtree).not.toBeNull()
    expect(subtree?.processCount).toBe(1)
    // 坏行漏进来则 5 + NaN = NaN；峰值聚合 Math.max(NaN) 也是 NaN，一路到面板。钉死为 5。
    const panel = aggregateUsage(
      [{ observedAt: 0, rssKib: subtree!.rssKib, cpuPercent: subtree!.cpuPercent }],
      0
    )
    expect(panel.cpuPercent).toBe(5)
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

/**
 * 采样器本身：什么时候采、采几次、采不到时说什么。
 *
 * 全部注入假的 `ps` 读取器，不起真实子进程——真实进程会让断言依赖机器当时的负载，
 * 那种测试红起来没人知道是代码坏了还是机器忙。
 */
describe('ProcessResourceSampler', () => {
  const TABLE_TEXT = `  PID  PPID    RSS  %CPU
    1     0  17104   0.2
  100     1  10000   5.0
  101   100   2000   1.0`

  function harness(options: { table?: () => Promise<string> } = {}) {
    let now = 1_000_000
    const readTable = vi.fn(options.table ?? (async () => TABLE_TEXT))
    const sampler = new ProcessResourceSampler(
      readTable,
      () => now,
      () => [{ memory: { workingSetSize: 4096 } }] as Electron.ProcessMetric[]
    )
    // 全部经由 subscribe 观察，因为那是产品唯一的读取口（ipc.ts:359）。给测试单开一个
    // `snapshot()` 取数口，等于让断言走一条用户永远不走的路——那条路完好，产品那条坏了，
    // 测试照样绿。
    const seen: UsageSnapshot[] = []
    const watch = () => sampler.subscribe((snapshot) => { seen.push(snapshot) })
    const latest = () => seen.at(-1) ?? null
    return { readTable, sampler, seen, watch, latest, advance: (ms: number) => { now += ms } }
  }

  it('没有订阅者时一次采样都不发生——折叠态零开销', async () => {
    // 首要约束。一个常驻的全主机 ps 轮询不会让任何测试变红，只会让空闲窗口持续耗电，
    // 所以这件事必须由一条显式断言守住。
    vi.useFakeTimers()
    try {
      const { readTable, sampler, seen } = harness()
      sampler.trackRun('run-a', 100)
      // 把时间推得远远超过采样周期：真有常驻定时器，这里必然已经采过很多次。
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS * 20)
      expect(readTable).not.toHaveBeenCalled()
      expect(seen).toEqual([])
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('最后一个订阅者离开后停止采样，不留下孤儿定时器', async () => {
    vi.useFakeTimers()
    try {
      const { readTable, sampler, watch } = harness()
      sampler.trackRun('run-a', 100)
      const stopA = watch()
      const stopB = watch()
      await vi.advanceTimersByTimeAsync(0)
      const whileOpen = readTable.mock.calls.length
      expect(whileOpen).toBeGreaterThan(0)

      // 只走一个订阅者：另一个还在看，采样必须继续。
      stopA()
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS * 2)
      expect(readTable.mock.calls.length).toBeGreaterThan(whileOpen)

      const whenClosed = readTable.mock.calls.length
      stopB()
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS * 5)
      expect(readTable.mock.calls.length).toBe(whenClosed)
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('上一次还没回来时不再起第二个 ps——慢 ps 不会堆出一片子进程', async () => {
    // 真实的并发来源就是这个：`ps` 比采样周期慢，定时器照常到点。没有去重，一台负载高的
    // 机器会越采越慢、越慢越堆，正好在用户最需要看资源的时候把机器压垮。
    vi.useFakeTimers()
    try {
      let release: (value: string) => void = () => {}
      const { readTable, sampler, watch } = harness({
        table: () => new Promise<string>((resolve) => { release = resolve })
      })
      sampler.trackRun('run-a', 100)
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      expect(readTable).toHaveBeenCalledTimes(1)

      // 卡住不放，让定时器空转好几个周期。
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS * 5)
      expect(readTable).toHaveBeenCalledTimes(1)

      // 放行之后，下一个周期照常再采——去重只作用于"同时进行中"的那一批，
      // 否则面板会永远停在第一帧。
      release(TABLE_TEXT)
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS)
      expect(readTable.mock.calls.length).toBeGreaterThan(1)
      release(TABLE_TEXT)
      stop()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('采样失败降级为不可用，而不是崩溃或报 0', async () => {
    vi.useFakeTimers()
    try {
      const { sampler, watch, latest } = harness({
        table: async () => { throw new Error('ps timed out') }
      })
      sampler.trackRun('run-a', 100)
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest()?.unavailable).toContain('ps timed out')
      // 第一次采样就失败时 `runs` 保留的是"上一次"，而上一次不存在，所以它是空的
      // （`process-resource-sampler.ts:138` 的 `this.latest?.runs ?? []`）。这是正确行为：
      // 没有过任何数字，就一个都不报，而不是报一排 0。
      expect(latest()?.runs).toEqual([])
      stop()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('采样失败后保留上一次的数字并标记过期——不是把它们改写成 0', async () => {
    // 上一条测的是"从来没成功过"那一支（runs 空）。这一条才是注释里那句「0 会被读成'它在跑但
    // 不吃资源'这个真值，比没有这个数字更糟」真正说的情形：**先有过数字，然后采样挂了**。
    // 这一支此前没有任何判据——上一条那句 `runs.every(cpuPercent !== 0)` 遍历的是空数组，恒真。
    vi.useFakeTimers()
    try {
      let fail = false
      const { sampler, watch, latest } = harness({
        table: async () => {
          if (fail) throw new Error('ps timed out')
          return TABLE_TEXT
        }
      })
      sampler.trackRun('run-a', 100)
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      // 前提自检：先真的采到了一条带数字的样本，否则下面全是空话。
      expect(latest()?.unavailable).toBeNull()
      expect(latest()?.runs.map((run) => run.runId)).toEqual(['run-a'])

      fail = true
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS)

      expect(latest()?.unavailable).toContain('ps timed out')
      // 那条 run 还在，数字还是上一次那批——没有被改写成 0。
      expect(latest()?.runs.map((run) => run.runId)).toEqual(['run-a'])
      expect(latest()?.runs.every((run) => run.cpuPercent !== 0)).toBe(true)
      stop()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pid 已消失的 run 报不可用，Electron 自身指标单独分桶', async () => {
    vi.useFakeTimers()
    try {
      const { sampler, watch, latest } = harness()
      sampler.trackRun('gone', 99999)
      sampler.trackRun('run-a', 100)
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest()?.runs.find((run) => run.runId === 'gone')?.rssKib).toBeNull()
      expect(latest()?.runs.find((run) => run.runId === 'run-a')?.rssKib).toBe(12_000)
      // 混成一个数就没法回答"是谁在吃"。
      expect(latest()?.app).toEqual({ processCount: 1, rssKib: 4096 })
      stop()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgetRun 之后不再为它采样，也不留旧样本', async () => {
    vi.useFakeTimers()
    try {
      const { sampler, watch, latest } = harness()
      sampler.trackRun('run-a', 100)
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest()?.runs).toHaveLength(1)
      sampler.forgetRun('run-a')
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS)
      expect(latest()?.runs).toHaveLength(0)
      stop()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('面板重开时不拿旧样本充数', async () => {
    vi.useFakeTimers()
    try {
      // 关键是**很快**重开：隔 60 秒重开，旧样本早被聚合窗口滤掉了，这条断言就白写了——
      // 真正会出错的是关掉两秒又打开，此时旧样本还在 10 秒窗口内，若没被丢掉，
      // 面板会把关闭之前的那个峰值当成"此刻"显示出来。
      let cpu = '90.0'
      const { sampler, watch, latest, advance } = harness({
        table: async () => `  PID  PPID    RSS  %CPU\n  100     1  10000  ${cpu}`
      })
      sampler.trackRun('run-a', 100)
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest()?.runs[0]?.cpuPercent).toBe(90)
      stop()

      // 关闭期间那个进程安静下来了，但我们没在采——中间发生过什么并不知道。
      cpu = '3.0'
      advance(2_000)
      const reopened = watch()
      await vi.advanceTimersByTimeAsync(0)
      // 显示的必须是重开后新采到的 3%，而不是关闭前留下的 90% 峰值。
      expect(latest()?.runs[0]?.cpuPercent).toBe(3)
      reopened()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // 上面那条测不到下面这个洞：它的 `ps` 立刻返回，采样在关闭之前就已经落地了。真正会出错的
  // 是**关闭时还有一次采样在飞**——`stop()` 清掉 `samples` 与 `latest`，而那次采样醒来后照写，
  // 于是清空被静默撤销。两条各盯 `runSample` 的一个写回出口（成功一侧、降级一侧）；只守一侧
  // 的话另一侧照旧把上一段观察的事实递给重开的面板。
  const tableWithCpu = (cpu: string) => `  PID  PPID    RSS  %CPU\n  100     1  10000  ${cpu}`

  it('关闭时在途的采样落地后不许写回——否则重开的面板会显示一个不存在的尖峰', async () => {
    vi.useFakeTimers()
    try {
      let release: (value: string) => void = () => {}
      const { sampler, watch, seen, latest, advance } = harness({
        table: () => new Promise<string>((resolve) => { release = resolve })
      })
      sampler.trackRun('run-a', 100)

      // 面板打开，第一次采样落地：安静基线 5%。
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      release(tableWithCpu('5.0'))
      await vi.advanceTimersByTimeAsync(0)
      expect(latest()?.runs[0]?.cpuPercent).toBe(5)

      // 下一个周期起了第二次采样，它还在飞的时候用户关掉了面板。
      advance(USAGE_SAMPLE_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS)
      stop()

      // 两秒后重开。那次采样仍在飞，而 `inFlight` 去重让重开不会另起一次，所以它正是重开后
      // 第一个落地的结果——这个顺序不是构造出来的巧合，是这段代码固有的。
      advance(2_000)
      const reopened = watch()
      const beforeStaleLands = seen.length
      release(tableWithCpu('95.0'))
      await vi.advanceTimersByTimeAsync(0)

      // 事实一：属于上一段观察的结果一次都不许递给重开的面板。
      expect(seen.slice(beforeStaleLands)).toEqual([])

      // 事实二：它也不许留在样本里。CPU 是 10 秒窗口取峰值，关掉两秒又打开时那个 95 还在窗口
      // 内，留下来就会被当成"此刻最凶的时候"显示出来——一个从未发生过的尖峰。
      advance(USAGE_SAMPLE_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS)
      release(tableWithCpu('3.0'))
      await vi.advanceTimersByTimeAsync(0)
      expect(latest()?.runs[0]?.cpuPercent).toBe(3)

      reopened()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('关闭时在途的采样失败落地后不许把重开的面板画成不可用', async () => {
    vi.useFakeTimers()
    try {
      let release: (value: string) => void = () => {}
      let fail: (error: Error) => void = () => {}
      const { sampler, watch, seen, advance } = harness({
        table: () => new Promise<string>((resolve, reject) => { release = resolve; fail = reject })
      })
      sampler.trackRun('run-a', 100)
      const stop = watch()
      await vi.advanceTimersByTimeAsync(0)
      release(tableWithCpu('5.0'))
      await vi.advanceTimersByTimeAsync(0)

      // 同样是第二次采样在飞的时候关掉，再重开。
      advance(USAGE_SAMPLE_INTERVAL_MS)
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS)
      stop()
      advance(2_000)
      const reopened = watch()
      const beforeStaleLands = seen.length

      // 这次它是超时失败。`ps` 的超时是 5 秒，比"关掉再打开"长得多，所以先关后失败是常态而非边角。
      fail(new Error('ps timed out'))
      await vi.advanceTimersByTimeAsync(0)

      // 上一段观察里的失败不是这一段的事实。少了这道判断，重开的面板会立刻挂出一条与当前观察
      // 无关的"资源数据不可用"，而当前这段其实什么都还没采。
      expect(seen.slice(beforeStaleLands)).toEqual([])

      reopened()
      sampler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 之后定时器不再走——退出时不留后台采样', async () => {
    // RuntimeController.dispose 会调它。漏掉这一步，应用退出后采样定时器还在跑。
    vi.useFakeTimers()
    try {
      const { readTable, sampler, watch } = harness()
      sampler.trackRun('run-a', 100)
      watch()
      await vi.advanceTimersByTimeAsync(0)
      const before = readTable.mock.calls.length
      expect(before).toBeGreaterThan(0)
      sampler.dispose()
      await vi.advanceTimersByTimeAsync(USAGE_SAMPLE_INTERVAL_MS * 5)
      expect(readTable.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
