import type { SessionSnapshot, UsageSnapshot } from '../../../shared/contracts'

/**
 * 把一次采样快照配上 Session 的名字，变成面板要显示的几行。
 *
 * 单独一层是因为难的部分不是渲染，而是**取不到数时说什么**：CPU 与内存各自可能为 null
 * （进程刚退出、采样失败、窗口内还没有样本），而 0 是一个会被读成真值的谎——用户会以为
 * 这个 Agent 在跑但不吃资源。所以 null 渲染成一个中性记号，绝不落成 0。
 */

export type UsagePanelRow = {
  key: string
  label: string
  cpuText: string
  rssText: string
  contextText: string
  stateText: string
}

/**
 * 面板打开期间才订阅采样；关闭时退订，并丢掉上一帧。
 *
 * 单独拎成一个函数是因为**它是这个功能最容易悄悄退化的一条**：把订阅挪到组件挂载、或者动一下
 * 依赖数组，代码看着都对、测试全绿，只有空闲窗口会一直起 `ps` 耗电。它写在 useEffect 里就没有
 * 任何断言够得着（这个仓库的测试用 renderToStaticMarkup，根本不跑 effect）。拎出来之后，
 * "关着就不订阅"和"关上要退订"两件事都能被直接断言。
 *
 * 关闭时把上一帧清掉，是因为再打开时它描述的是另一段时间，留着会先闪一个过期的数字。
 */
export function subscribeWhileOpen(
  open: boolean,
  subscribe: (listener: (snapshot: UsageSnapshot) => void) => () => void,
  onSnapshot: (snapshot: UsageSnapshot | null) => void
): (() => void) | undefined {
  if (!open) {
    onSnapshot(null)
    return undefined
  }
  return subscribe(onSnapshot)
}

/** 拿不到数时显示的记号。它读起来就是"不知道"，与"是 0"分得开。 */
const UNKNOWN = '—'

export function formatRss(rssKib: number | null): string {
  if (rssKib === null) return UNKNOWN
  // MiB 起步：Agent 进程动辄几百 MiB，用 KiB 显示会是一串没人读得下去的数字。
  const mib = rssKib / 1024
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`
  return `${Math.round(mib)} MiB`
}

export function formatCpu(cpuPercent: number | null): string {
  if (cpuPercent === null) return UNKNOWN
  // 一位小数足够：CPU 是抖的，第二位小数只是噪音在跳。
  return `${cpuPercent.toFixed(1)}%`
}

/**
 * 采样按 runId 归并，显示要按 Agent 的名字——这里做这次配对。
 *
 * 配不上名字的 run 仍然显示（用 runId 前缀兜底）：它确实在吃资源，藏起来会让面板上的数
 * 与机器实际用量对不上，而对不上时用户无从判断是哪一边错了。
 */
export function usagePanelRows(
  snapshot: UsageSnapshot | null,
  sessions: readonly SessionSnapshot[],
  now = Date.now()
): UsagePanelRow[] {
  if (!snapshot) return []
  const contextByRunId = new Map<string, { label: string; context: string; state: string }>()
  for (const session of sessions) {
    if (session.kind !== 'agent') continue
    const project = session.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? session.workspacePath
    const state = session.status.state
    const age = Math.max(0, Math.floor((now - session.updatedAt) / 1000))
    const idle = state === 'working' ? '' : age < 60 ? `${age}s idle` : age < 3600 ? `${Math.floor(age / 60)}m idle` : `${Math.floor(age / 3600)}h idle`
    contextByRunId.set(session.control.run.runId, { label: session.label, context: `${session.providerId} · ${project}`, state: idle || state })
  }
  return snapshot.runs.map((run) => ({
    key: run.runId,
    label: contextByRunId.get(run.runId)?.label ?? run.runId.slice(0, 8),
    cpuText: formatCpu(run.cpuPercent),
    rssText: formatRss(run.rssKib),
    contextText: contextByRunId.get(run.runId)?.context ?? 'Unknown project',
    stateText: contextByRunId.get(run.runId)?.state ?? 'unknown'
  }))
}
