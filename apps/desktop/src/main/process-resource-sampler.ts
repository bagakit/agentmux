import { execFile } from 'node:child_process'
import { app } from 'electron'
import {
  USAGE_SAMPLE_INTERVAL_MS,
  aggregateUsage,
  parseProcessTable,
  pruneSamples,
  rollUpSubtrees,
  type RunUsage,
  type AppUsage,
  type AppProcessRole,
  type MainResourceOwnerCounts,
  type RuntimeUsage,
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

export type ProcessResourceObservationSources = {
  observeRuntime(): Promise<RuntimeUsage[]>
  processOwners(): { rendererPids: readonly number[]; browserPids: readonly number[] }
  mainOwners(): MainResourceOwnerCounts
}

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
  private observationSources: ProcessResourceObservationSources | null = null
  private runtime: RuntimeUsage[] | null = null
  private runtimeUnavailable: string | null = null
  private runtimeInFlight: Promise<void> | null = null
  private readonly appProcesses = new Set<string>()
  private readonly appSamples = new Map<string, UsageSample[]>()
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

  /** Wire the existing Main owners once; none of these readers run while the panel is closed. */
  setObservationSources(sources: ProcessResourceObservationSources): () => void {
    this.observationSources = sources
    return () => {
      if (this.observationSources === sources) this.observationSources = null
    }
  }

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
      void this.observeRuntime(this.generation)
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
    this.runtime = null
    this.runtimeUnavailable = null
    this.appProcesses.clear()
    this.appSamples.clear()
    // 递增之后，任何在途采样落地时都会发现自己属于上一段观察，从而不写回刚清掉的东西。
    this.generation += 1
  }

  private observeRuntime(generation: number): void {
    if (this.runtimeInFlight) return
    this.runtimeInFlight = this.runRuntimeObservation(generation).finally(() => {
      this.runtimeInFlight = null
      // Close/reopen invalidates the old reading, but cannot cancel its I/O. Only the
      // currently open generation gets a new read after it settles; no queue of old opens.
      if (generation !== this.generation && this.subscribers.size > 0) this.observeRuntime(this.generation)
    })
  }

  private async runRuntimeObservation(generation: number): Promise<void> {
    try {
      if (!this.observationSources) throw new Error('Runtime resource observation is not connected')
      const runtime = await this.observationSources.observeRuntime()
      if (generation !== this.generation) return
      this.runtime = runtime
      this.runtimeUnavailable = null
    } catch (error) {
      if (generation !== this.generation) return
      this.runtimeUnavailable = error instanceof Error ? error.message : String(error)
    }
    if (this.latest) {
      this.latest = { ...this.latest, runtime: this.runtime, runtimeUnavailable: this.runtimeUnavailable }
      this.notify()
    }
  }

  private sampleApp(observedAt: number): AppUsage {
    try {
      const metrics = [...new Map(this.appMetrics().map((metric) => [metric.pid, metric])).values()]
      const owners = this.observationSources?.processOwners()
      const rendererPids = new Set(owners?.rendererPids ?? [])
      const browserPids = new Set(owners?.browserPids ?? [])
      const roleFor = (metric: Electron.ProcessMetric): AppProcessRole => {
        switch (metric.type) {
          // Electron calls its Main process "Browser"; embedded Browser pages are "Tab".
          case 'Browser': return 'main'
          case 'GPU': return 'gpu'
          case 'Utility': return 'utility'
          case 'Tab':
            // A shared process cannot truthfully be assigned exclusively to either surface.
            if (rendererPids.has(metric.pid) && browserPids.has(metric.pid)) return 'other'
            if (rendererPids.has(metric.pid)) return 'renderer'
            if (browserPids.has(metric.pid)) return 'browser'
            return 'other'
          default: return 'other'
        }
      }
      const roles: AppProcessRole[] = ['main', 'renderer', 'browser', 'gpu', 'utility', 'other']
      const groups = roles.map((role) => {
        const owned = metrics.filter((metric) => roleFor(metric) === role)
        const rssKib = owned.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)
        return {
          role,
          processCount: owned.length,
          rssKib,
          cpuPercent: owned.length === 0 ? 0 : this.appCpu(role, owned, observedAt, rssKib)
        }
      })
      const rssKib = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)
      const cpuPercent = metrics.length === 0 ? 0 : this.appCpu('total', metrics, observedAt, rssKib)
      this.appProcesses.clear()
      for (const metric of metrics) this.appProcesses.add(`${metric.pid}:${metric.creationTime}`)
      return { processCount: metrics.length, rssKib, cpuPercent, groups, unavailable: null }
    } catch (error) {
      return {
        processCount: this.latest?.app?.processCount ?? null,
        rssKib: this.latest?.app?.rssKib ?? null,
        cpuPercent: this.latest?.app?.cpuPercent ?? null,
        groups: this.latest?.app?.groups ?? [],
        unavailable: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private appCpu(key: string, metrics: readonly Electron.ProcessMetric[], observedAt: number, rssKib: number): number | null {
    // Electron's first reading is 0 without an interval. A new/reused PID must warm up again.
    if (metrics.some((metric) => !this.appProcesses.has(`${metric.pid}:${metric.creationTime}`))) return null
    const next = pruneSamples([...(this.appSamples.get(key) ?? []), {
      observedAt,
      rssKib,
      cpuPercent: metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0)
    }], observedAt)
    this.appSamples.set(key, next)
    return aggregateUsage(next, observedAt).cpuPercent
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
    let rows = null
    let unavailable: string | null = null
    try {
      rows = parseProcessTable(await this.readTable())
      if (generation !== this.generation) return
    } catch (cause) {
      if (generation !== this.generation) return
      // 采样失败降级为"不可用"，不是 0——0 会被读成真值。上一次的数字保留但标记为过期。
      unavailable = cause instanceof Error ? cause.message : String(cause)
    }

    const roots = [...this.runPids].map(([runId, pid]) => ({ key: runId, pid }))
    const usage = rows ? rollUpSubtrees(rows, roots) : null
    const runs: RunUsage[] = usage ? [] : this.latest?.runs ?? []
    for (const { key: runId, pid } of usage ? roots : []) {
      const subtree = usage!.get(runId) ?? null
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
      runs.push({
        runId,
        rootPid: pid,
        processCount: subtree?.processCount ?? null,
        rootRssKib: subtree?.rootRssKib ?? null,
        descendantsRssKib: subtree?.descendantsRssKib ?? null,
        descendantProcessCount: subtree?.descendantProcessCount ?? null,
        cpuPercent,
        rssKib
      })
    }

    this.latest = {
      observedAt,
      runs,
      app: this.sampleApp(observedAt),
      runtime: this.runtime,
      runtimeUnavailable: this.runtimeUnavailable,
      mainOwners: this.observationSources?.mainOwners() ?? null,
      unavailable
    }
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
    this.observationSources = null
  }
}
