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
  type TerminalWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'

export type PersistedWorkbench = {
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
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
  return (
    (surface.kind === 'agent' || surface.kind === 'terminal') &&
    surface.phase === 'attached'
  )
}

function sessionOnlyTab(tab: WorkbenchTab): WorkbenchTab | null {
  let next: WorkbenchTab | null = tab
  for (const surface of workbenchSurfaces(tab)) {
    if (sessionSurface(surface)) continue
    if (tab.topicId && surface.kind === 'launcher') continue
    // 文件面必须活过重启——它就是用户报的「重启后 tab 和分屏没了」的一半：一个纯 file tab 曾被整面剥成
    // 0 面（整 tab 消失），agent+file 分屏曾塌成单面。file 面本身只有 {regionId,kind,workspaceId,path}，
    // 没有运行时内容可剥，且 tab id 本就是 `file:${workspaceId}:${path}`——存 file 面与存路径是同一件事，
    // 分不开。path 原样保留（相对存相对、绝对存绝对，不 normalize/重写）。
    //
    // 为什么 file 留而 browser 的 url/title 不留：browser 面内嵌整个活体 BrowserSnapshot（url/title/
    // navigationId… 全是 required 运行时快照），浏览历史与文件路径是两类敏感度；且冷启动没有一条能把
    // 持久 browser 结构复活成可用空白页的生命周期（BrowserPane 的 restore 只在 released 态触发，冷启动
    // 可见 browser 是 released=false，restore/create 都不发），硬存结构标识只会 ship 一个死面板。故
    // browser 面仍整面剥离（沿用旧行为）。谁若日后以「过时的直接删」为由把下面这行 file 也一并剥掉，
    // 就会原样重犯这个 bug——这个机制不是冗余，删它=回归。
    if (surface.kind === 'file') continue
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
      const projected = sessionOnlyTab(tab)
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
      if (tab.topicId && surface.kind === 'launcher') continue
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
      if (
        surface.kind === 'file' &&
        config.workspaces.some((workspace) => workspace.id === surface.workspaceId)
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
}): PersistedWorkbench {
  if (!input.persisted) {
    return {
      tabs: {},
      layouts: Object.fromEntries(input.config.workspaces.map((workspace) => [
        workspace.id,
        createWorkspaceLayout(input.createTabGroupId())
      ]))
    }
  }

  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const tabs = Object.fromEntries(
    Object.values(input.persisted.tabs).flatMap((tab) => {
      const restored = restoreTab(
        input.config,
        sessions,
        tab,
        input.preserveUnknownSessionViews === true
      )
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
  return { tabs, layouts }
}
