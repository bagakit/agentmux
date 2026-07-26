/**
 * 进程资源采样的纯逻辑：一次全主机扫描的输出，怎么变成"每个 run 的子树用了多少 CPU 与内存"。
 *
 * 为什么不为每个 Agent 单独起一次采样：开销随 Agent 数线性增长，十个 Agent 就是十次 `ps`。
 * 一次扫描拿到全表，再按 pid 在内存里归并，成本与 Agent 数无关。
 *
 * 为什么这一层是纯函数：难的是归并（子树、共享祖先、进程刚退出），不是起子进程。把归并
 * 与 `ps` 调用分开，就能在没有真实进程的情况下验证归并对不对。
 */

/** `ps -Ao pid,ppid,rss,pcpu` 的一行。rss 单位是 KiB，cpu 是百分比。 */
export type ProcessRow = {
  pid: number
  ppid: number
  rssKib: number
  cpuPercent: number
}

export type SubtreeUsage = {
  /** 这棵子树里的进程数，含根进程自己。 */
  processCount: number
  rssKib: number
  cpuPercent: number
}

/**
 * 解析 `ps -Ao pid,ppid,rss,pcpu` 的输出。
 *
 * 跳过表头与任何解析不出四个数字的行——`ps` 在进程正好退出时可能吐出残行，为一行坏数据
 * 让整次采样失败，比少算一个进程糟得多。
 */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const [pid, ppid, rssKib, cpuPercent] = [
      Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])
    ]
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    if (!Number.isFinite(rssKib) || !Number.isFinite(cpuPercent)) continue
    // 表头 "PID PPID RSS %CPU" 会在 Number() 处变成 NaN，因此不需要单独判断第一行。
    rows.push({ pid, ppid, rssKib, cpuPercent })
  }
  return rows
}

/**
 * 把全表按 pid 子树归并到各个 run 上。
 *
 * **共享祖先按 `roots` 的顺序只归第一个**。两个 run 的 pid 若恰好在同一条祖先链上（例如一个
 * 是另一个的子进程），把公共部分算两遍会让总和超过机器实际用量——一个虚高的数字比没有这个
 * 数字更糟。顺序即优先级：先注册的 run 拿走重叠部分。
 *
 * pid 不在表里（进程已退出）的 run 得到 `null`，而不是零——零会被读成"它在跑但没吃资源"。
 */
export function rollUpSubtrees(
  rows: readonly ProcessRow[],
  roots: readonly { key: string; pid: number }[]
): Map<string, SubtreeUsage | null> {
  const childrenByParent = new Map<number, number[]>()
  const byPid = new Map<number, ProcessRow>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    childrenByParent.set(row.ppid, [...(childrenByParent.get(row.ppid) ?? []), row.pid])
  }

  const claimed = new Set<number>()
  const result = new Map<string, SubtreeUsage | null>()
  for (const { key, pid } of roots) {
    if (!byPid.has(pid)) {
      result.set(key, null)
      continue
    }
    let processCount = 0
    let rssKib = 0
    let cpuPercent = 0
    // 显式栈而不是递归：进程树深度由系统决定，不该让它决定我们的调用栈深度。
    const stack = [pid]
    while (stack.length > 0) {
      const current = stack.pop()!
      // 已被前一个 root 认领的进程连同它的子树一起跳过——这就是"共享祖先只归第一个"。
      if (claimed.has(current)) continue
      const row = byPid.get(current)
      if (!row) continue
      claimed.add(current)
      processCount += 1
      rssKib += row.rssKib
      cpuPercent += row.cpuPercent
      stack.push(...(childrenByParent.get(current) ?? []))
    }
    // 根进程本身被前一个 root 认领掉时，这个 run 一个进程都没剩下——如实报"不可用"。
    result.set(key, processCount === 0 ? null : { processCount, rssKib, cpuPercent })
  }
  return result
}

/**
 * 采样周期、聚合窗口、聚合方式是三件事，分开定义。
 *
 * 把它们合成一个"刷新率"会同时定死三个不相干的取舍：采多密（开销）、看多长一段（可读性）、
 * 怎么把一段压成一个数（这段时间里什么才算这个指标的真相）。CPU 与内存对这三件事的答案
 * 本来就不同——CPU 是瞬时速率，抖动大，用户想知道的是"这十秒里它最凶的时候有多凶"；
 * 内存是一个水位，最近一次读数就是此刻的真相，取峰值反而会把一个早就释放掉的高点一直挂着。
 */
export type UsageAggregate = 'peak' | 'latest' | 'mean'

export type MetricSpec = {
  /** 聚合窗口：显示的数字概括的是最近这么长一段时间。 */
  windowMs: number
  aggregate: UsageAggregate
}

export const USAGE_METRIC_SPECS: { cpu: MetricSpec; rss: MetricSpec } = {
  // 用户口径：每秒采样，显示前 10 秒窗口的峰值。
  cpu: { windowMs: 10_000, aggregate: 'peak' },
  // 内存是水位不是速率，最近一次读数即真相；窗口只用于在采样断档时判定读数是否已过期。
  rss: { windowMs: 10_000, aggregate: 'latest' }
}

/**
 * 采样周期。
 *
 * 一次 `ps` 同时拿到 CPU 与内存，因此扫描按**最密的那个指标**的节奏走一次即可，各指标再
 * 用自己的窗口与方式聚合——不为每个指标各扫一次，那正是本模块要避免的开销。
 */
export const USAGE_SAMPLE_INTERVAL_MS = 1_000

export type UsageSample = {
  observedAt: number
  rssKib: number
  cpuPercent: number
}

function aggregateValues(values: readonly number[], how: UsageAggregate): number | null {
  if (values.length === 0) return null
  if (how === 'peak') return Math.max(...values)
  if (how === 'latest') return values[values.length - 1]!
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * 把一段采样压成要显示的两个数。
 *
 * 窗口外的样本被丢掉：面板关掉又打开时，旧样本描述的是另一段时间，用它算峰值会显示一个
 * 早已过去的高点。窗口内没有任何样本就报 `null`——"还不知道"与"是 0"必须能区分开。
 */
export function aggregateUsage(
  samples: readonly UsageSample[],
  now: number,
  specs: { cpu: MetricSpec; rss: MetricSpec } = USAGE_METRIC_SPECS
): { cpuPercent: number | null; rssKib: number | null } {
  const inWindow = (windowMs: number): UsageSample[] =>
    samples.filter((sample) => now - sample.observedAt <= windowMs)
  return {
    cpuPercent: aggregateValues(
      inWindow(specs.cpu.windowMs).map((sample) => sample.cpuPercent),
      specs.cpu.aggregate
    ),
    rssKib: aggregateValues(
      inWindow(specs.rss.windowMs).map((sample) => sample.rssKib),
      specs.rss.aggregate
    )
  }
}

/** 丢掉所有窗口外的样本。环形缓冲不必无限长——最长的那个窗口决定了要留多久。 */
export function pruneSamples(
  samples: readonly UsageSample[],
  now: number,
  specs: { cpu: MetricSpec; rss: MetricSpec } = USAGE_METRIC_SPECS
): UsageSample[] {
  const longest = Math.max(specs.cpu.windowMs, specs.rss.windowMs)
  return samples.filter((sample) => now - sample.observedAt <= longest)
}
