import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import {
  activateTab,
  addTab,
  createWorkspaceLayout,
  findGroupForTab,
  removeTab,
  type WorkspaceLayout
} from './workbench-layout'
import {
  removeWorkbenchRegion,
  workbenchSurfaces,
  type AgentWorkbenchSurface,
  type FileWorkbenchSurface,
  type TerminalWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { closeWorkbenchRegion, regionIds } from './workbench-view-layout'
import { assertUnreachableSurface, isSessionSurface } from './workbench-surface-kinds'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'

export type PersistedWorkbench = {
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
}

/**
 * 一张持久化 Tab 上「树 ↔ regions 表」不一致的抢救结果。空数组/false 表示那一类没发生。
 */
export type PersistedTabRepair = {
  tabId: string
  /** regions 表里有、树里没有的死记录（永远画不到，也永远回收不掉）。 */
  droppedGhostRegionIds: string[]
  /** 树里有、regions 表里没有的孤儿叶（画成 null，看不见也关不掉）。 */
  droppedOrphanLeafIds: string[]
  /** 两侧毫无交集 → 这张 Tab 整体不可救，只能丢弃。 */
  discardedTab: boolean
}

/**
 * 把一张**持久化读回来的** Tab 的两种 Region 表示强行拉回一致，绝不抛出。
 *
 * 为什么这一步必须存在：`assertRegionInvariant`（workbench-tabs.ts）是无条件 throw 的生产断言，
 * 而 `removeWorkbenchRegion` 在两个持久化入口上都会被调用（`sessionOnlyTab` 与 `restoreTab`）。
 * localStorage 里的内容是**用户数据**：这道断言是本轮才装上的，此前发货的版本没有任何 reducer 守着
 * 这条不变量，所以磁盘上完全可能已经躺着一张漂移的 Tab。若不先抢救，那条断言会在
 *   - `restorePersistedWorkbench`（启动恢复）→ 启动路径抛出，整个 Workbench 落回空白；
 *   - `projectPersistedWorkbench`（zustand `partialize`，**每次写入都跑**）→ 在 `set()` 里抛出，
 *     把任意一次用户操作变成崩溃，且此后再也写不进去。
 * 两条都实测抛过（探针：树 [r1]、表 [r1,r2]，两个入口同一条消息）。**修法必须落在边界上，
 * 不能把断言削成 dev-only**——削掉它就等于把守卫从唯一真正需要它的环境（生产）里拿走。
 *
 * 取交集，不取任何一侧为准：两个方向的多余项在界面上**都不可达**（表里的死记录画不到、树里的孤儿叶
 * 画成 null），所以「只留两侧都认的」是唯一在用户可见效果上无损的答案。交集为空则这张 Tab 没有一格
 * 可画，整张丢弃。
 *
 * 这不是兼容层：它不认识任何版本号，也不随版本增长；它修的是一条**恒定**的结构不变量，
 * 而该不变量今后由生产断言在每个变更点就地守住。响亮性由两处提供——启动恢复把抢救结果汇报成可见告警
 * （见 `restorePersistedWorkbench` 的 `repairs`），以及 reducer 侧那条无条件断言在**改动发生的那一处**
 * 立刻炸掉。写入路径（partialize）刻意只抢救不抛：在那里抛会把持久化写入本身变成崩溃。
 */
function reconcilePersistedTab(
  tab: WorkbenchTab
): { tab: WorkbenchTab | null; repair: PersistedTabRepair | null } {
  const tree = regionIds(tab.layout.root)
  const treeIds = new Set(tree)
  const mapIds = new Set(Object.keys(tab.regions))
  const ghosts = [...mapIds].filter((id) => !treeIds.has(id))
  const orphans = tree.filter((id) => !mapIds.has(id))
  if (ghosts.length === 0 && orphans.length === 0) return { tab, repair: null }

  const kept = tree.filter((id) => mapIds.has(id))
  if (kept.length === 0) {
    return {
      tab: null,
      repair: {
        tabId: tab.id,
        droppedGhostRegionIds: ghosts,
        droppedOrphanLeafIds: orphans,
        discardedTab: true
      }
    }
  }

  // 逐个摘掉孤儿叶。`closeWorkbenchRegion` 在只剩一叶时拒绝动手，而 kept 非空保证了每次摘除都还有
  // 至少一片留存叶，故每一步都能落地；它同时负责把落在被摘叶上的焦点交给兄弟。
  let layout = tab.layout
  for (const orphanId of orphans) layout = closeWorkbenchRegion(layout, orphanId)
  const regions = Object.fromEntries(
    Object.entries(tab.regions).filter(([regionId]) => !ghosts.includes(regionId))
  )
  // 焦点与标题格必须落在留存集合上。activeRegionId 由 closeWorkbenchRegion 维护，但持久化数据也可能
  // 一开始就指向一个树里根本没有的格，所以这里不假设、直接兜到读序首格。
  const remaining = regionIds(layout.root)
  const activeRegionId = remaining.includes(layout.activeRegionId)
    ? layout.activeRegionId
    : remaining[0]!
  return {
    tab: {
      ...tab,
      layout: { ...layout, activeRegionId },
      titleRegionId: remaining.includes(tab.titleRegionId) ? tab.titleRegionId : activeRegionId,
      regions
    },
    repair: {
      tabId: tab.id,
      droppedGhostRegionIds: ghosts,
      droppedOrphanLeafIds: orphans,
      discardedTab: false
    }
  }
}

/** 抢救结果的用户向措辞。只在真的动过东西时产出一句。 */
export function describePersistedTabRepairs(repairs: readonly PersistedTabRepair[]): string | null {
  if (repairs.length === 0) return null
  const discarded = repairs.filter((repair) => repair.discardedTab).length
  const trimmed = repairs.length - discarded
  const parts = [
    ...(discarded > 0 ? [`${discarded} unusable tab${discarded === 1 ? '' : 's'} discarded`] : []),
    ...(trimmed > 0 ? [`${trimmed} tab${trimmed === 1 ? '' : 's'} repaired`] : [])
  ]
  return `Saved layout contained inconsistent split panes: ${parts.join(', ')}.`
}

export function persistedAgentSessionIds(
  persisted: PersistedWorkbench | null
): Set<string> {
  return new Set(persisted ? Object.values(persisted.tabs).flatMap((tab) => (
    workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'agent' && surface.phase === 'attached' ? [surface.sessionId] : []
    ))
  )) : [])
}

type SessionWorkbenchSurface = AgentWorkbenchSurface | TerminalWorkbenchSurface

function sessionSurface(surface: WorkbenchSurface): surface is SessionWorkbenchSurface {
  // `isSessionSurface` is the SSOT for "agent-or-terminal"; the phase gate stays here because only an
  // ATTACHED view carries a stable identity worth persisting/restoring. Keeping the kind half in one
  // place means a future session-bearing kind is enrolled once (in `isSessionSurface`) rather than
  // being silently excluded by this copy.
  return isSessionSurface(surface) && surface.phase === 'attached'
}

/**
 * Does a NON-attached-session surface survive the persistence round-trip? This is the one decision
 * that used to be a silent fall-through: a kind absent from the keep-list was dropped, so a new
 * surface kind would be lost across restart with nothing going red. The switch is exhaustive via
 * `assertUnreachableSurface`, so a 6th kind cannot compile until someone decides — here, in one place
 * — whether it survives. A `Record<kind, boolean>` would not fit: `file` and `launcher` are not
 * constant, they depend on `fileSurvives`/`hasTopic`, and the launching-session leak below needs a
 * real case, not a table cell.
 *
 * Note the `agent`/`terminal` case: `sessionSurface` is a kind-based predicate whose body also gates
 * on phase, so a LAUNCHING agent/terminal fails it and reaches this classifier even though the caller
 * has narrowed the static type to file|launcher|browser. Taking the full `WorkbenchSurface` here (not
 * the narrowed remainder) makes that runtime leak an explicit, handled case instead of an
 * `assertUnreachableSurface` throw — a launching view has no run to keep, so it is dropped, exactly as
 * before this was made exhaustive.
 */
function persistedSurfaceSurvives(
  surface: WorkbenchSurface,
  ctx: { hasTopic: boolean; fileSurvives: (surface: FileWorkbenchSurface) => boolean }
): boolean {
  switch (surface.kind) {
    case 'agent':
    case 'terminal':
      return false
    case 'launcher':
      return ctx.hasTopic
    case 'file':
      return ctx.fileSurvives(surface)
    case 'browser':
      // browser 面内嵌整个活体 BrowserSnapshot（url/title/navigationId… 全是 required 运行时快照），
      // 浏览历史与文件路径是两类敏感度；且冷启动没有一条能把持久 browser 结构复活成可用空白页的生命周期
      // （BrowserPane 的 restore 只在 released 态触发，冷启动可见 browser 是 released=false，restore/
      // create 都不发），硬存结构标识只会 ship 一个死面板。故 browser 面整面剥离。
      return false
    default:
      return assertUnreachableSurface(surface)
  }
}

function sessionOnlyTab(tab: WorkbenchTab): WorkbenchTab | null {
  let next: WorkbenchTab | null = tab
  for (const surface of workbenchSurfaces(tab)) {
    if (sessionSurface(surface)) continue
    // 文件面必须活过重启——它就是用户报的「重启后 tab 和分屏没了」的一半：一个纯 file tab 曾被整面剥成
    // 0 面（整 tab 消失），agent+file 分屏曾塌成单面。file 面本身只有 {regionId,kind,workspaceId,path}，
    // 没有运行时内容可剥，且 tab id 本就是 `file:${workspaceId}:${path}`——存 file 面与存路径是同一件事，
    // 分不开。path 原样保留（相对存相对、绝对存绝对，不 normalize/重写）。谁若日后以「过时的直接删」为由
    // 把下面这条 file→存 一并删掉，就会原样重犯这个 bug——这个机制不是冗余，删它=回归。
    if (persistedSurfaceSurvives(surface, { hasTopic: Boolean(tab.topicId), fileSurvives: () => true })) {
      continue
    }
    next = next ? removeWorkbenchRegion(next, surface.regionId) : null
  }
  return next
}

function keepTabsInLayout(
  layout: WorkspaceLayout,
  tabIds: ReadonlySet<string>
): WorkspaceLayout {
  let next = layout
  for (const group of layout.groups) {
    for (const tabId of group.tabOrder) {
      if (!tabIds.has(tabId)) next = removeTab(next, group.id, tabId)
    }
  }
  return next
}

function addTabWithoutStealingFocus(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout {
  const activeTabId = layout.groups.find((group) => group.id === groupId)?.activeTabId
  const next = addTab(layout, groupId, tabId)
  return activeTabId ? activateTab(next, groupId, activeTabId) : next
}

export function projectPersistedWorkbench(input: PersistedWorkbench): PersistedWorkbench {
  const tabs = Object.fromEntries(
    Object.values(input.tabs).flatMap((tab) => {
      // 先抢救再投影：`sessionOnlyTab` 会调 `removeWorkbenchRegion`，而它尾部那条无条件断言
      // 对一张已漂移的 Tab 会抛——这里是 zustand 的 `partialize`，抛出即让**每一次写入**变成崩溃。
      const reconciled = reconcilePersistedTab(tab).tab
      const projected = reconciled ? sessionOnlyTab(reconciled) : null
      return projected ? [[projected.id, projected]] : []
    })
  )
  const tabIds = new Set(Object.keys(tabs))
  const layouts = Object.fromEntries(
    Object.entries(input.layouts).map(([workspaceId, layout]) => [
      workspaceId,
      keepTabsInLayout(layout, tabIds)
    ])
  )
  return { tabs, layouts }
}

function sessionBelongsToWorkspace(
  config: AppConfig,
  session: SessionSnapshot,
  workspaceId: string
): boolean {
  const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId)
  return Boolean(
    workspace && workspaceOwnsSessionPath(workspace, session)
  )
}

function restoreTab(
  config: AppConfig,
  sessions: ReadonlyMap<string, SessionSnapshot>,
  tab: WorkbenchTab,
  preserveUnknownSessionViews = false
): WorkbenchTab | null {
  let next: WorkbenchTab | null = tab
  for (const surface of workbenchSurfaces(tab)) {
    if (!sessionSurface(surface)) {
      // 一个文件面在其 workspace 仍被配置时生还，原样保留（含 path）。文件是否还在磁盘上不在这里判：
      // 本函数是纯 presentation 投影，无磁盘/无 IPC——stat 会把同步启动恢复变成异步，且新增一个与 Core/
      // 主进程并存的文件存在性真相源（违反 SSOT）。
      //
      // 代价是这里交出一个没有文档的面，所以必须有人在它上屏时把文档装上，否则 tab 在、点开报「不可用」
      // ——看起来像文件坏了。那个人是 `EditorPane`：它缺文档就调 `attachPersistedFileDocument`
      // （store 侧 `loadPersistedFileDocument` → `reduceDocumentAttached`）。「文件已删」也在那条路上
      // 惰性表达（`reduceDocumentLoadFailed` 记 `documentIssues.deleted`），与「打开着的文件被删」
      // 同一条既有失败态。**留下这一行而不接那个加载入口，等于把一个整 tab 消失的 bug 换成一个更难
      // 诊断的 bug。**
      //
      // 关键：这里绝不能退回旧的 `return null`——那会把整 tab 连同存活的 agent 面一起毙掉（正是用户报的
      // 「分屏没了」）。越界面只删该 Region，让 removeWorkbenchRegion 走与 session 面完全同一条收敛出口。
      // survive 判据经 `persistedSurfaceSurvives`（同一张 SSOT 表），file 面额外要求其 workspace 仍在配置里。
      if (
        persistedSurfaceSurvives(surface, {
          hasTopic: Boolean(tab.topicId),
          fileSurvives: (file) =>
            config.workspaces.some((workspace) => workspace.id === file.workspaceId)
        })
      ) continue
      next = next ? removeWorkbenchRegion(next, surface.regionId) : null
      continue
    }
    const session = sessions.get(surface.sessionId)
    // A Runtime snapshot can be temporarily unavailable while the persisted presentation is still
    // perfectly usable. Keep the exact Region identity in that narrow fail-open state; Core remains
    // the owner of whether the Session/Run exists and SessionPane will show its neutral connecting
    // state until a later canonical snapshot arrives. Never apply this to a successful snapshot: a
    // known missing or mismatched Session must still be removed by the normal verified restore path.
    if (
      preserveUnknownSessionViews &&
      !session &&
      config.workspaces.some((workspace) => workspace.id === tab.workspaceId) &&
      surface.workspaceId === tab.workspaceId
    ) continue
    if (
      session?.kind === surface.kind &&
      sessionBelongsToWorkspace(config, session, tab.workspaceId)
    ) continue
    next = next ? removeWorkbenchRegion(next, surface.regionId) : null
  }
  return next
}

export function restorePersistedWorkbench(input: {
  config: AppConfig
  sessions: readonly SessionSnapshot[]
  persisted: PersistedWorkbench | null
  createTabGroupId(): string
  /**
   * Keep session Regions whose identities could not be checked because the Runtime snapshot failed.
   * This is a one-shot presentation projection, not a second Session truth source; callers should
   * set it only for an explicitly rejected snapshot and let the next canonical snapshot reconcile it.
   */
  preserveUnknownSessionViews?: boolean
}): PersistedWorkbench & { repairs: PersistedTabRepair[] } {
  if (!input.persisted) {
    return {
      tabs: {},
      layouts: Object.fromEntries(input.config.workspaces.map((workspace) => [
        workspace.id,
        createWorkspaceLayout(input.createTabGroupId())
      ])),
      repairs: []
    }
  }

  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const repairs: PersistedTabRepair[] = []
  const tabs = Object.fromEntries(
    Object.values(input.persisted.tabs).flatMap((tab) => {
      // 抢救先于恢复：`restoreTab` 会调 `removeWorkbenchRegion`，其尾部无条件断言对一张已漂移的
      // Tab 会抛，而这里在启动路径上——抛出即整个 Workbench 落回空白（正是 #59/#60 那个 bug 的形状）。
      const { tab: reconciled, repair } = reconcilePersistedTab(tab)
      if (repair) repairs.push(repair)
      const restored = reconciled
        ? restoreTab(
            input.config,
            sessions,
            reconciled,
            input.preserveUnknownSessionViews === true
          )
        : null
      return restored ? [[restored.id, restored]] : []
    })
  )
  const layouts: Record<string, WorkspaceLayout> = {}
  for (const workspace of input.config.workspaces) {
    const workspaceTabIds = new Set(
      Object.values(tabs)
        .filter((tab) => tab.workspaceId === workspace.id)
        .map((tab) => tab.id)
    )
    let layout = input.persisted.layouts[workspace.id]
      ? keepTabsInLayout(input.persisted.layouts[workspace.id]!, workspaceTabIds)
      : createWorkspaceLayout(input.createTabGroupId())
    for (const tabId of workspaceTabIds) {
      if (!findGroupForTab(layout, tabId)) {
        layout = addTabWithoutStealingFocus(layout, layout.activeGroupId, tabId)
      }
    }
    layouts[workspace.id] = layout
  }
  return { tabs, layouts, repairs }
}
