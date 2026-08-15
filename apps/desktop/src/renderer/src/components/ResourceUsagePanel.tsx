import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from './HoverDropdownMenu'
import { ChevronUp, Cpu } from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import type { UsageSnapshot } from '../../../shared/contracts'
import { formatRss, subscribeWhileOpen, usagePanelRows, type UsagePanelRow } from '../lib/resource-usage-panel'
import { workspaceForSession } from '../lib/workbench-tabs'

// 状态栏上的资源面板。
//
// **折叠态零开销是这个组件的首要约束**：订阅只在面板打开时存在，关闭即退订，主进程那边
// 因此一次 `ps` 都不起。一个常驻的全主机轮询不会让任何测试变红，只会让空闲窗口持续耗电——
// 所以采样的生命周期绑在这个 effect 上，而不是绑在组件挂载上。
//
// 数字的口径见 `shared/process-usage.ts`：CPU 每秒采样、显示 10 秒窗口的峰值（它是瞬时速率，
// 用户想知道的是"最凶的时候有多凶"），内存取最近一次读数（它是水位，取峰值会把早已释放的
// 高点一直挂着）。

function UsageRow({ row }: { row: UsagePanelRow }) {
  return (
    <div className="resource-usage__row">
      <span className="resource-usage__identity">
        <strong className="resource-usage__name">{row.label}</strong>
        <small className="resource-usage__context">{row.contextText} · {row.stateText}</small>
        {/* 「最近在改什么」：只在比裸状态更具体时才由 usagePanelRows 填上，缺席就不占行——
            自成一行而非续接到 context 后面，是因为三段挤一行在面板宽度下必然折行、读不成句。 */}
        {row.activity ? <small className="resource-usage__activity">{row.activity}</small> : null}
      </span>
      {/* 拿不到就留空，不填 0——0 会被读成"它在跑但不吃资源"这个真值。 */}
      <span className="resource-usage__metric">{row.cpuText}</span>
      <span className="resource-usage__metric">{row.rssText}</span>
    </div>
  )
}

export function ResourceUsagePanel() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const sessions = useAppStore((state) => state.sessions)
  // 时间轴是 store 里那份实时数据：启动时拉全、之后由事件流持续补齐（store.ts 的 onEvent →
  // agent-timeline）。所以打开面板**不需要**触发一轮重拉——数据本就在手，读它即可。
  const timelines = useAppStore((state) => state.timelines)
  // 每个 Session 的仓根，用来把「最近在改什么」里的绝对路径缩成相对路径。必须逐个解：这张面板一次
  // 列出所有 Run，它们分属不同仓库，没有「当前那个根」可用。走 workspaceForSession 这个共用谓词。
  const config = useAppStore((state) => state.config)
  const workspaceRoots = useMemo(() => {
    const roots: Record<string, string> = {}
    for (const session of sessions) {
      const path = workspaceForSession(config ?? null, session)?.path
      if (path) roots[session.id] = path
    }
    return roots
  }, [config, sessions])

  useEffect(
    () => subscribeWhileOpen(open, api.resourceUsage.subscribe, setSnapshot),
    [open]
  )

  const rows = usagePanelRows(snapshot, sessions, timelines, undefined, workspaceRoots)
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          className="agent-status-bar__segment agent-status-bar__segment--action"
          type="button"
          aria-label="Show CPU and memory use per agent"
          title="CPU and memory use"
        >
          <Cpu size={11} aria-hidden="true" />
          <ChevronUp size={10} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Presence-managed：这里的动画必须限定在 [data-state='open']，否则关闭时会等一个
            永远不会来的 animationend。见 presence-exit-animation.test.ts。 */}
        <DropdownMenu.Content
          className="resource-usage"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <div className="resource-usage__heading">
            <span>CPU · Memory</span>
            {/* 采样失败时如实说，不把旧数字当此刻的。 */}
            {snapshot?.unavailable ? (
              <span className="resource-usage__unavailable">unavailable</span>
            ) : null}
          </div>
          <div className="resource-usage__list">
            {rows.length === 0 ? (
              <div className="resource-usage__empty">
                {snapshot ? 'No agent processes' : 'Sampling…'}
              </div>
            ) : (
              rows.map((row) => <UsageRow key={row.key} row={row} />)
            )}
          </div>
          {snapshot?.app ? (
            <div className="resource-usage__app">
              {/* Electron 自己单独一行：混进 Agent 的数里就没法回答"是谁在吃"。 */}
              <span className="resource-usage__name">AgentMux</span>
              <span className="resource-usage__metric">{snapshot.app.processCount} proc</span>
              <span className="resource-usage__metric">{formatRss(snapshot.app.rssKib)}</span>
            </div>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
