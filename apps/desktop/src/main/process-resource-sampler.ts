import { execFile } from 'node:child_process'
import { app } from 'electron'
import {
  USAGE_SAMPLE_INTERVAL_MS,
  aggregateUsage,
  parseProcessTable,
  pruneSamples,
  rollUpSubtrees,
  type RunUsage,
  type UsageSample,
  type UsageSnapshot
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

export class ProcessResourceSampler {
  private readonly runPids = new Map<string, number>()
  private readonly samples = new Map<string, UsageSample[]>()
  private readonly subscribers = new Set<(snapshot: UsageSnapshot) => void>()
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private latest: UsageSnapshot | null = null
  private lastError: string | null = null
  /**
   * 「这次采样属于哪一段观察」。
   *
   * `ps` 是异步的，所以最后一个订阅者走的时候，可能正有一次采样在飞。它落地时会写
   * `samples` 与 `latest`——而那两样正是 `stop()` 刚清掉的，于是清空被静默撤销。实测过的
   * 后果：关闭前那一瞬的 95% 峰值被写回，两秒后重开面板显示 95，而真实当前是 3。CPU 是
   * 10 秒窗口取峰值，所以只要在窗口内重开就看得见这个不存在的尖峰。
   *
   * 用不着取消 `ps`（也取消不了）：只要让每次采样记住自己出发时的这个号，落地时对不上就
   * 整个丢弃。号在 `stop()` 里递增，所以「已经停了」和「停了又开」都对不上。
   */
  private generation = 0

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
  subscribe(onSample: (snapshot: UsageSnapshot) => void): () => void {
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
    // 递增之后，任何在途采样落地时都会发现自己属于上一段观察，从而不写回刚清掉的东西。
    this.generation += 1
  }

  /**
   * 采一次。
   *
   * 上一次还没回来时不再起第二个——`ps` 比采样周期慢时，定时器照常到点，没有这层去重，
   * 一台负载高的机器会越采越慢、越慢越堆，正好在用户最需要看资源的时候把机器压垮。
   */
  private async sampleOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runSample(this.generation).finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async runSample(generation: number): Promise<void> {
    const observedAt = this.now()
    let rows
    try {
      rows = parseProcessTable(await this.readTable())
      if (generation !== this.generation) return
      this.lastError = null
    } catch (cause) {
      if (generation !== this.generation) return
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
    const snapshot = this.latest
    if (!snapshot) return
    for (const subscriber of this.subscribers) subscriber(snapshot)
  }

  dispose(): void {
    this.stop()
    this.subscribers.clear()
    this.runPids.clear()
  }
}
