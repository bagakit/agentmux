import { execFile } from 'node:child_process'
import { app } from 'electron'
import {
  USAGE_SAMPLE_INTERVAL_MS,
  aggregateUsage,
  parseProcessTable,
  pruneSamples,
  rollUpSubtrees,
  type UsageSample
} from '../shared/process-usage.js'

/**
 * 按需的进程资源采样器。
 *
 * 与 `resource-probe.ts` 职责不同，两者都要留着：那个是一次性验收探针（跑完写报告退出），
 * 这个是资源面板打开期间的常驻采样。把探针改造成常驻采样器会让"验收证据"与"产品功能"
 * 共用一条会随 UI 需求变形的代码路径。
 *
 * 首要约束是**折叠态零采样**：面板没打开时一次 `ps` 都不许发生。一个常驻的全主机轮询会让
 * 空闲窗口持续耗电，那是这个功能最容易犯也最难被发现的错——它不会让任何测试变红，只会让
 * 用户的电池变短。所以采样由订阅驱动：有人订阅才起定时器，最后一个订阅者走了就停。
 */

const PS_TIMEOUT_MS = 5_000

/** 注入点：测试喂预设的 `ps` 输出，不起真实子进程。 */
export type ProcessTableReader = () => Promise<string>

function readProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-Ao', 'pid,ppid,rss,pcpu'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: PS_TIMEOUT_MS
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/** 一个 run 现在吃多少资源。`null` 表示不可用（进程已退出、采样失败、还没采到）。 */
export type RunUsage = {
  runId: string
  processCount: number
  cpuPercent: number | null
  rssKib: number | null
}

export type UsageSnapshot = {
  observedAt: number
  runs: RunUsage[]
  /** Electron 自身进程，与 Agent 子树分开——混成一个数就没法回答"是谁在吃"。 */
  app: { processCount: number; rssKib: number } | null
  /** 采样失败时的原因。有它就说明下面的数字是旧的，不是此刻的。 */
  unavailable: string | null
}

export class ProcessResourceSampler {
  private readonly runPids = new Map<string, number>()
  private readonly samples = new Map<string, UsageSample[]>()
  private readonly subscribers = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private latest: UsageSnapshot | null = null
  private lastError: string | null = null

  constructor(
    private readonly readTable: ProcessTableReader = readProcessTable,
    private readonly now: () => number = Date.now,
    private readonly appMetrics: () => Electron.ProcessMetric[] = () => app.getAppMetrics()
  ) {}

  /**
   * 记下一个 run 的 pid。
   *
   * pid 来自 Core 已经在推的 `process-state` 事件，不新建第二份台账——这里只是把流过的事实
   * 留住，Core 仍是唯一来源。
   */
  trackRun(runId: string, pid: number | null): void {
    if (pid === null) this.forgetRun(runId)
    else this.runPids.set(runId, pid)
  }

  forgetRun(runId: string): void {
    this.runPids.delete(runId)
    this.samples.delete(runId)
  }

  /**
   * 开始采样，返回退订函数。没有订阅者时定时器不存在，因此折叠态零开销。
   */
  subscribe(onSample: () => void): () => void {
    this.subscribers.add(onSample)
    if (this.timer === null) {
      // 立刻采一次，否则面板要空等一个周期才有数。
      void this.sampleOnce()
      this.timer = setInterval(() => void this.sampleOnce(), USAGE_SAMPLE_INTERVAL_MS)
    }
    return () => {
      this.subscribers.delete(onSample)
      if (this.subscribers.size === 0) this.stop()
    }
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    // 样本一并丢掉：面板再打开时，旧样本描述的是另一段时间。
    this.samples.clear()
    this.latest = null
  }

  snapshot(): UsageSnapshot | null {
    return this.latest
  }

  /**
   * 采一次。
   *
   * 并发调用共享同一次进行中的采样——一次轮询风暴只产生一个子进程。没有这层去重，定时器与
   * 手动刷新撞在一起就会同时起两个 `ps`。
   */
  async sampleOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runSample().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async runSample(): Promise<void> {
    const observedAt = this.now()
    let rows
    try {
      rows = parseProcessTable(await this.readTable())
      this.lastError = null
    } catch (cause) {
      // 采样失败降级为"不可用"，不是 0——0 会被读成真值。上一次的数字保留但标记为过期。
      this.lastError = cause instanceof Error ? cause.message : String(cause)
      this.latest = {
        observedAt,
        runs: this.latest?.runs ?? [],
        app: this.latest?.app ?? null,
        unavailable: this.lastError
      }
      this.notify()
      return
    }

    const roots = [...this.runPids].map(([runId, pid]) => ({ key: runId, pid }))
    const usage = rollUpSubtrees(rows, roots)
    const runs: RunUsage[] = []
    for (const { key: runId } of roots) {
      const subtree = usage.get(runId) ?? null
      const history = this.samples.get(runId) ?? []
      const next = subtree
        ? pruneSamples([...history, {
            observedAt,
            rssKib: subtree.rssKib,
            cpuPercent: subtree.cpuPercent
          }], observedAt)
        : []
      this.samples.set(runId, next)
      const { cpuPercent, rssKib } = aggregateUsage(next, observedAt)
      runs.push({ runId, processCount: subtree?.processCount ?? 0, cpuPercent, rssKib })
    }

    let appUsage: UsageSnapshot['app'] = null
    try {
      const metrics = this.appMetrics()
      appUsage = {
        processCount: metrics.length,
        rssKib: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)
      }
    } catch {
      // Electron 自身指标拿不到不影响 Agent 子树那半边——如实留空即可。
      appUsage = null
    }

    this.latest = { observedAt, runs, app: appUsage, unavailable: null }
    this.notify()
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber()
  }

  dispose(): void {
    this.stop()
    this.subscribers.clear()
    this.runPids.clear()
  }
}
