import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  MessagesSquare,
  Plus,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { BrowserPane } from './BrowserPane'
import { agentProviderLabel } from './AgentProviderIcon'
import { ConfirmationDialog } from './ConfirmationDialog'
import { NewTabSurface } from './NewTabSurface'
import { PaneSplitMenu } from './PaneSplitMenu'
import { RegionContextMenu } from './RegionContextMenu'
import {
  REGION_CLASS,
  paneGroupFocusClass,
  regionFocusExpression,
  type RegionFocusExpression
} from '../lib/region-focus'
import { activeTopicIdFromLayout, layoutForActiveTopic } from '../lib/scratch-topic-layout'
import { SessionPane } from './SessionPane'
import { WorkbenchTabContextMenu } from './WorkbenchTabContextMenu'
import { WorkbenchTabMarks } from './WorkbenchTabMarks'
import { WorkbenchTabStrip } from './WorkbenchTabStrip'
import { resolvePaneColumnEdgeZone } from '../lib/tab-drop-zone'
import { SplitRatioCommitter } from '../lib/split-ratio-commit'
import { moveSessionViewMenu, regionSwapMenuEntries, tabIdsForCloseScope, workbenchSplitMenuEntries } from '../lib/workbench-tab-actions'
import { revealInFileManagerLabel } from '../lib/host-platform'
import { SurfaceSwitch, TopRowLeadingChrome } from './TopRowChrome'
import { groupIds } from '../lib/workbench-layout'
import type {
  SplitDirection,
  TabGroup,
  TabGroupLayoutNode,
  WorkspaceLayout
} from '../lib/workbench-layout'
import { regionIds } from '../lib/workbench-view-layout'
import type { WorkbenchRegionLayoutNode } from '../lib/workbench-view-layout'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import {
  activeWorkbenchSurface,
  agentDisplayName,
  documentKey,
  firstPromptFromTimeline,
  sessionIdsWithoutViewsAfterClosingTabs,
  tabDisplayName,
  titleWorkbenchSurface,
  workbenchSurfaces,
  type AgentNameFacts,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../lib/workbench-tabs'
import { tabMarkAgentFactsFor, tabRegionSummary, workbenchTabMarks } from '../lib/workbench-tab-marks'
import { canStopSessionRun, sessionTabTooltip, surfaceTabTooltip } from '../lib/session-metadata'
import { copyableAgentSessionIdForTab } from '../lib/tab-control-handoff'
import { handleTopicRenameKeyDown } from '../lib/topic-rename'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { useTerminalRegionParked } from '../lib/terminal-cold-parking-coordinator'
import {
  useBrowserSurfaceReleased,
  useMonacoSurfaceReleased
} from '../lib/surface-memory-budget-coordinator'
import { DESKTOP_SESSION_ATTRIBUTE } from '../../../shared/desktop-actions'

const EditorPane = lazy(async () => {
  const module = await import('./EditorPane')
  return { default: module.EditorPane }
})

type DragTabData = { kind: 'tab'; tabId: string; groupId: string }
type DropData = DragTabData | { kind: 'pane'; groupId: string }
type SplitTarget = { groupId: string; direction: SplitDirection }

function tabSurfaceFallback(tab: WorkbenchTab, sessions: readonly SessionSnapshot[]): string {
  const surface = titleWorkbenchSurface(tab)
  if (surface.kind === 'file') return surface.path.split('/').at(-1) ?? surface.path
  if (surface.kind === 'launcher') return 'New Tab'
  if (surface.kind === 'browser') {
    return surface.title && surface.title !== 'about:blank'
      ? surface.title
      : surface.url === 'about:blank' ? 'New Tab' : surface.url
  }
  // Agent/terminal title surface: the Provider·Workspace fact is the session's own label (built once in
  // Main), used verbatim as the chain's lowest tier — the renderer never re-derives that string.
  const session = sessions.find((item) => item.id === surface.sessionId)
  return session?.label ?? surface.sessionId
}

/**
 * 一格在换位菜单里显示的名字（#471）。按表面种类给一个人能认出的短名——文件名（basename）/ 会话
 * label（Agent 与终端都用 `session.label`，即 Provider·Workspace 那条兜底层，不是解析后的显示名；
 * 终端另有常量 "Terminal"）/ 浏览器标题，无标题时退回完整 URL / "New Tab"。这只是给用户指认「和哪一格
 * 换」用的标签，不进任何寻址 key，所以不必是 SSOT 显示名链的产物；与 `tabSurfaceFallback` 取名口径一致
 * 即可。同名多格的区分（编号）由 `regionSwapMenuEntries` 统一做，不在这里。
 */
function regionSurfaceLabel(surface: WorkbenchSurface, sessions: readonly SessionSnapshot[]): string {
  if (surface.kind === 'file') return surface.path.split('/').at(-1) ?? surface.path
  if (surface.kind === 'launcher') return 'New Tab'
  if (surface.kind === 'browser') {
    if (surface.title && surface.title !== 'about:blank') return surface.title
    return surface.url === 'about:blank' ? 'New Tab' : surface.url
  }
  if (surface.kind === 'terminal') return 'Terminal'
  const session = sessions.find((item) => item.id === surface.sessionId)
  return session?.label ?? surface.sessionId
}

/**
 * The renderer-side seam that feeds the naming SSOT chain: it turns a Store's Session projection into the
 * per-Agent facts `tabDisplayName`/`agentDisplayName` consume. Every fact here already lives in the Store
 * — user rename (`agentNames`), first prompt (`timelines`), the Provider·Workspace label (`session.label`)
 * — so no second source of truth is introduced.
 */
function makeAgentFactsFor(
  sessions: readonly SessionSnapshot[],
  agentNames: Record<string, string>,
  timelines: Record<string, AgentTimelineSnapshot>
): (sessionId: string) => AgentNameFacts | null {
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  return (sessionId) => {
    const session = sessionById.get(sessionId)
    if (!session || session.kind !== 'agent') return null
    return {
      userName: agentNames[sessionId],
      firstPrompt: firstPromptFromTimeline(timelines[sessionId]),
      fallbackLabel: session.label,
      providerLabel: agentProviderLabel(session.providerId)
    }
  }
}

function DragPreview({ tab }: { tab: WorkbenchTab }) {
  const sessions = useAppStore((state) => state.sessions)
  const agentNames = useAppStore((state) => state.agentNames)
  const timelines = useAppStore((state) => state.timelines)
  const label = tabDisplayName({
    tab,
    fallback: tabSurfaceFallback(tab, sessions),
    agentFactsFor: makeAgentFactsFor(sessions, agentNames, timelines)
  })
  return (
    <div className="tab-drag-preview">
      <GripVertical size={12} />
      <span>{label}</span>
    </div>
  )
}

function SortableWorkbenchTab({
  tab,
  group,
  workspaceId
}: {
  tab: WorkbenchTab
  group: TabGroup
  workspaceId: string
}) {
  const sessions = useAppStore((state) => state.sessions)
  const agentNames = useAppStore((state) => state.agentNames)
  const timelines = useAppStore((state) => state.timelines)
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  const tabsById = useAppStore((state) => state.tabs)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const renameTab = useAppStore((state) => state.renameTab)
  const renameAgent = useAppStore((state) => state.renameAgent)
  const moveTabToNewGroup = useAppStore((state) => state.moveTabToNewGroup)
  const arrangeTabRegions = useAppStore((state) => state.arrangeTabRegions)
  const setTabMenuOpen = useAppStore((state) => state.setTabMenuOpen)
  const config = useAppStore((state) => state.config)
  const moveSessionViewToWorkspace = useAppStore((state) => state.moveSessionViewToWorkspace)
  // 键盘 Cmd+W 在单 Region Tab 上关整张 Tab 的意图：窗口监听够不着这里的确认流，所以它只投一个意图，
  // 由目标 Tab（intent 的 tabId 命中自己）跑既有的 requestTabsClose——与鼠标点 X 同一条路，含未保存/在跑
  // Agent 的确认。跑完清掉意图。
  const closeTabRequest = useAppStore((state) => state.closeTabRequest)
  const clearCloseTabRequest = useAppStore((state) => state.clearCloseTabRequest)
  const reportError = useAppStore((state) => state.reportError)
  const surface = titleWorkbenchSurface(tab)
  const session = surface.kind === 'agent' || surface.kind === 'terminal'
    ? sessions.find((item) => item.id === surface.sessionId)
    : null
  // 标签上画的标记序列：一张 Tab 可以含多个 Region，标签要画出它的种类构成，而不是只画标题那一个。
  // 「谁是 Agent」的判断在 `tabMarkAgentFactsFor` 里，不在这里——这个文件在 node 里 import 不了（经
  // api.ts 的一个 vite define），留在这里的任何取值判断都无法被测试执行到。这里只剩一句转发。
  const agentFactsFor = tabMarkAgentFactsFor(sessions)
  const marks = workbenchTabMarks(tab, agentFactsFor)
  // 标记簇在上限处截断且刻意不画 `+N`（标签宽度极紧）。折掉的种类改由 tooltip 兜住，两条 tooltip
  // 路径都取它——没有 Session 的多 Region Tab 同样需要（见 `surfaceTabTooltip`）。
  const regionSummary = tabRegionSummary(tab, agentFactsFor)
  // The one place a tab's shown name is decided: the naming SSOT chain, fed the Store's own facts. It is
  // NOT `session.label` — that is only the chain's lowest tier (Provider·Workspace), overridden by a user
  // rename, a single Agent's own name, or the multi-Agent family name.
  const displayName = tabDisplayName({
    tab,
    fallback: tabSurfaceFallback(tab, sessions),
    agentFactsFor: makeAgentFactsFor(sessions, agentNames, timelines)
  })
  const copyableAgentSessionId = copyableAgentSessionIdForTab(tab)
  // 文件 Tab 才有路径复制与「在文件管理器中显示」；其余类型缺席，那三项整组不出现。workspaceRoot 用于把
  // 相对 path 接成绝对路径（走共用的 formatPathsForCopy 出口）；reveal 走 FileExplorer 同一条 api.files.reveal。
  const fileActions =
    surface.kind === 'file'
      ? (() => {
          const workspace = config?.workspaces.find((candidate) => candidate.id === surface.workspaceId)
          if (!workspace || workspace.hostId !== 'local') return undefined
          return {
            path: surface.path,
            workspaceRoot: workspace.path,
            revealLabel: revealInFileManagerLabel(),
            onReveal: async () => {
              try {
                await api.files.reveal(surface.workspaceId, surface.path)
              } catch (error) {
                reportError(error)
              }
            }
          }
        })()
      : undefined
  // Only a Session projection can be moved, and only the Region actually carrying it. A file or
  // launcher View has no Session identity to relocate, so it offers no destinations at all. The
  // destinations and the click action come from ONE decision in the lib — see moveSessionViewMenu
  // for the two mutations that survived when the component judged this twice on its own.
  const moveSessionView = moveSessionViewMenu({
    surface,
    workspaces: config?.workspaces ?? [],
    currentWorkspaceId: workspaceId,
    move: moveSessionViewToWorkspace
  })
  const dirty =
    surface.kind === 'file'
      ? Boolean(dirtyDocuments[documentKey(surface.workspaceId, surface.path)])
      : false
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    data: { kind: 'tab', tabId: tab.id, groupId: group.id } satisfies DragTabData
  })
  const [pendingClose, setPendingClose] = useState<{
    tabIds: string[]
    dirtyCount: number
    agentSessionCount: number
  } | null>(null)
  const [closing, setClosing] = useState(false)
  // Inline rename reuses the topic-row pattern: a right-click menu entry flips the tab into an input, no
  // second menu infrastructure. `rename` says which name this edit targets so one input serves both.
  const [rename, setRename] = useState<{ target: 'tab' | 'agent'; value: string } | null>(null)

  async function closeTabs(
    tabIds: readonly string[],
    keepAgentSessions = false
  ): Promise<boolean> {
    for (const tabId of tabIds) {
      if (!await closeTab(workspaceId, group.id, tabId, { keepAgentSessions })) return false
    }
    return true
  }

  async function requestTabsClose(tabIds: readonly string[]): Promise<void> {
    const currentTabIds = tabIds.filter((tabId) => group.tabOrder.includes(tabId))
    if (currentTabIds.length === 0 || closing) return
    const dirtyCount = new Set(currentTabIds.flatMap((tabId) => {
      const candidate = tabsById[tabId]
      if (!candidate) return []
      return workbenchSurfaces(candidate).flatMap((candidateSurface) => (
        candidateSurface.kind === 'file' && dirtyDocuments[
          documentKey(candidateSurface.workspaceId, candidateSurface.path)
        ]
          ? [documentKey(candidateSurface.workspaceId, candidateSurface.path)]
          : []
      ))
    })).size
    const agentSessionCount = sessionIdsWithoutViewsAfterClosingTabs(
      tabsById,
      currentTabIds,
      'agent'
    ).length
    if (dirtyCount > 0 || agentSessionCount > 0) {
      setPendingClose({ tabIds: currentTabIds, dirtyCount, agentSessionCount })
      return
    }
    setClosing(true)
    try {
      await closeTabs(currentTabIds)
    } finally {
      setClosing(false)
    }
  }

  async function requestClose(event: React.MouseEvent): Promise<void> {
    event.stopPropagation()
    await requestTabsClose([tab.id])
  }

  // 消费键盘关 Tab 意图：只有意图点名的这张 Tab 才响应，跑既有的确认流，然后清掉意图。effect 里读 store
  // 派发出的意图对象；本仓库 renderToStaticMarkup 不跑 effect，所以这条接线的断言在 store 层（意图被投出/
  // 清除）与判定层（dispatchWorkbenchCommand 单格时调 requestCloseTab）各自守，见对应测试。
  useEffect(() => {
    if (
      !closeTabRequest ||
      closeTabRequest.tabId !== tab.id ||
      closeTabRequest.workspaceId !== workspaceId ||
      closeTabRequest.tabGroupId !== group.id
    ) return
    const nonce = closeTabRequest.nonce
    clearCloseTabRequest(nonce)
    void requestTabsClose([tab.id])
    // requestTabsClose 是每次渲染新建的闭包，不进依赖；只由意图对象驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeTabRequest, tab.id, workspaceId, group.id, clearCloseTabRequest])

  async function confirmClose(keepAgentSessions = false): Promise<void> {
    if (closing || !pendingClose) return
    setClosing(true)
    try {
      if (await closeTabs(pendingClose.tabIds, keepAgentSessions)) setPendingClose(null)
    } finally {
      setClosing(false)
    }
  }

  const tabsToLeft = tabIdsForCloseScope(group.tabOrder, tab.id, 'left')
  const tabsToRight = tabIdsForCloseScope(group.tabOrder, tab.id, 'right')
  const otherTabs = tabIdsForCloseScope(group.tabOrder, tab.id, 'others')

  function beginRename(target: 'tab' | 'agent'): void {
    // Seed the input with the CURRENT shown name, so an edit refines rather than starts blank. For a
    // tab that is still on the derived strategy, `tab.name` is empty and the field seeds from displayName.
    const seed = target === 'tab' ? (tab.name ?? displayName) : displayName
    setRename({ target, value: seed })
  }

  function commitRename(): void {
    if (!rename) return
    const value = rename.value.trim()
    if (rename.target === 'tab') renameTab(tab.id, value.length > 0 ? value : null)
    else if (copyableAgentSessionId) renameAgent(copyableAgentSessionId, value.length > 0 ? value : null)
    setRename(null)
  }

  return (
    <>
      <WorkbenchTabContextMenu
        canCloseOthers={otherTabs.length > 0}
        canCloseLeft={tabsToLeft.length > 0}
        canCloseRight={tabsToRight.length > 0}
        canMoveToNewGroup={group.tabOrder.length > 1}
        onOpenChange={setTabMenuOpen}
        tabId={tab.id}
        copyableAgentSessionId={copyableAgentSessionId}
        {...(fileActions ? { fileActions } : {})}
        writeClipboardText={async (text) => {
          await copyTextToClipboard(text, reportError)
        }}
        onRenameTab={() => beginRename('tab')}
        {...(copyableAgentSessionId ? { onRenameAgent: () => beginRename('agent') } : {})}
        onClose={() => void requestTabsClose([tab.id])}
        onCloseOthers={() => void requestTabsClose(otherTabs)}
        onCloseLeft={() => void requestTabsClose(tabsToLeft)}
        onCloseRight={() => void requestTabsClose(tabsToRight)}
        onMoveToNewGroup={(direction) => moveTabToNewGroup(
          workspaceId,
          tab.id,
          group.id,
          group.id,
          direction
        )}
        // 重排的是**这张**被右键点中的 Tab，不是当前活动的那张——非活动 Tab 上右键时，
        // 用活动 Tab 的格数会按错的容量过滤预设（列出摆不成的档，或藏掉摆得成的档）。
        regionCount={Object.keys(tab.regions).length}
        onArrange={(preset) => arrangeTabRegions(workspaceId, tab.id, preset)}
        moveSessionViewTargets={moveSessionView.targets}
        onMoveSessionView={moveSessionView.onSelect}
      >
        <button
          ref={setNodeRef}
          type="button"
          data-workbench-tab-id={tab.id}
          className={`workbench-tab ${group.activeTabId === tab.id ? 'workbench-tab--active' : ''} ${
            isDragging ? 'workbench-tab--dragging' : ''
          }`}
          {...(session ? { [DESKTOP_SESSION_ATTRIBUTE]: session.id } : {})}
          style={{ transform: CSS.Translate.toString(transform), transition }}
          title={
            session
              ? sessionTabTooltip(session, displayName, regionSummary)
              : surfaceTabTooltip(displayName, regionSummary)
          }
          onClick={() => activateTab(workspaceId, group.id, tab.id)}
          {...attributes}
          {...listeners}
        >
          <WorkbenchTabMarks marks={marks} />
          {rename ? (
            <input
              autoFocus
              className="workbench-tab__rename"
              aria-label={rename.target === 'tab' ? 'Rename tab' : 'Rename agent'}
              value={rename.value}
              onChange={(event) => setRename({ target: rename.target, value: event.target.value })}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitRename()
                  return
                }
                // 与 Topic 行同一套：拦下每个键不让拖拽 sensor 吞掉空格/方向键；Escape 取消。
                handleTopicRenameKeyDown(event, { cancel: () => setRename(null) })
              }}
            />
          ) : (
            <span className="workbench-tab__label">{displayName}</span>
          )}
          {dirty ? <i className="workbench-tab__dirty" aria-label="Unsaved" /> : null}
          <span
            role="button"
            tabIndex={0}
            className="workbench-tab__close"
            aria-label={`Close ${displayName}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => void requestClose(event)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') void requestClose(event as never)
            }}
          >
            <X size={11} />
          </span>
        </button>
      </WorkbenchTabContextMenu>
      <ConfirmationDialog
        open={pendingClose !== null}
        title={pendingClose?.agentSessionCount
          ? pendingClose.agentSessionCount > 1
            ? `Stop ${pendingClose.agentSessionCount} Agent Sessions?`
            : 'Stop Agent Session?'
          : 'Discard unsaved changes?'}
        description={pendingClose?.agentSessionCount
          ? `Closing the last View stops ${pendingClose.agentSessionCount > 1 ? 'these Agent Runs' : 'this Agent Run'} by default. Keeping ${pendingClose.agentSessionCount > 1 ? 'the Sessions' : 'the Session'} leaves ${pendingClose.agentSessionCount > 1 ? 'them' : 'it'} running in the background.${pendingClose.dirtyCount ? ' Unsaved editor changes will be discarded.' : ''}`
          : pendingClose && pendingClose.tabIds.length > 1
            ? 'Closing these tabs will discard changes that have not been saved.'
            : 'Closing this editor tab will discard changes that have not been saved.'}
        subject={pendingClose && pendingClose.tabIds.length > 1
          ? [
              `${pendingClose.tabIds.length} tabs`,
              pendingClose.agentSessionCount ? `${pendingClose.agentSessionCount} Agent Sessions` : null,
              pendingClose.dirtyCount ? `${pendingClose.dirtyCount} unsaved` : null
            ].filter(Boolean).join(' · ')
          : displayName}
        confirmLabel={pendingClose?.agentSessionCount ? 'Stop & Close' : 'Discard & Close'}
        {...(pendingClose?.agentSessionCount
          ? {
              secondaryLabel: pendingClose.agentSessionCount > 1
                ? 'Keep Sessions & Close'
                : 'Keep Session & Close',
              onSecondary: () => void confirmClose(true)
            }
          : {})}
        busy={closing}
        onCancel={() => !closing && setPendingClose(null)}
        onConfirm={() => void confirmClose()}
      />
    </>
  )
}

function SurfaceContent({
  surface,
  tabId,
  groupId,
  nativeSurfacesVisible,
  interactiveResize,
  focus
}: {
  surface: WorkbenchSurface
  tabId: string
  groupId: string
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  /** 这一格的焦点表达。只有 browser 那格真用得到（原生视图要让位），但由上游一次算好传下来。 */
  focus: RegionFocusExpression
}) {
  const parked = useTerminalRegionParked(surface.regionId)
  const monacoReleased = useMonacoSurfaceReleased(surface.regionId)
  const browserReleased = useBrowserSurfaceReleased(surface.regionId)
  if (surface.kind === 'agent' || surface.kind === 'terminal') {
    return (
      <SessionPane
        sessionId={surface.sessionId}
        surfaceKind={surface.kind}
        interactiveResize={interactiveResize}
        visible={nativeSurfacesVisible}
        parked={parked}
        linkOrigin={{
          workspaceId: surface.workspaceId,
          tabGroupId: groupId,
          tabId,
          regionId: surface.regionId
        }}
      />
    )
  }
  if (surface.kind === 'file') {
    return (
      <Suspense fallback={<section className="pane-state"><strong>Loading editor…</strong></section>}>
        <EditorPane tabId={tabId} surface={surface} released={monacoReleased} />
      </Suspense>
    )
  }
  if (surface.kind === 'browser') {
    return (
      <BrowserPane
        key={surface.browserId}
        tab={surface}
        visible={nativeSurfacesVisible}
        released={browserReleased}
        yieldToFocusRing={focus.nativeViewYieldsToRing}
      />
    )
  }
  return (
    <NewTabSurface
      tabGroupId={groupId}
      tabId={tabId}
      regionId={surface.regionId}
      visible={nativeSurfacesVisible}
    />
  )
}

function WorkbenchRegionNode({
  node,
  nodePath,
  tab,
  groupId,
  nativeSurfacesVisible,
  interactiveResize
}: {
  node: WorkbenchRegionLayoutNode
  nodePath: string
  tab: WorkbenchTab
  groupId: string
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
}) {
  if (node.type === 'leaf') {
    return (
      <WorkbenchRegionLeaf
        node={node}
        tab={tab}
        groupId={groupId}
        nativeSurfacesVisible={nativeSurfacesVisible}
        interactiveResize={interactiveResize}
      />
    )
  }
  return (
    <WorkbenchRegionBranch
      node={node}
      nodePath={nodePath}
      tab={tab}
      groupId={groupId}
      nativeSurfacesVisible={nativeSurfacesVisible}
      interactiveResize={interactiveResize}
    />
  )
}

// 一格（leaf）单独成组件：消费键盘关格意图的 effect、以及「关这一格要不要确认」的决定，都得跑在组件顶层
// hook 里——它们够不着 node.type 分支之后。拆出来后这些 hook 无条件执行，套路同 WorkbenchRegionBranch。
function WorkbenchRegionLeaf({
  node,
  tab,
  groupId,
  nativeSurfacesVisible,
  interactiveResize
}: {
  node: Extract<WorkbenchRegionLayoutNode, { type: 'leaf' }>
  tab: WorkbenchTab
  groupId: string
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
}) {
  const focusRegion = useAppStore((state) => state.focusRegion)
  const closeRegion = useAppStore((state) => state.closeRegion)
  const splitRegion = useAppStore((state) => state.splitRegion)
  const arrangeTabRegions = useAppStore((state) => state.arrangeTabRegions)
  const swapRegions = useAppStore((state) => state.swapRegions)
  const promoteRegionToTab = useAppStore((state) => state.promoteRegionToTab)
  const sessions = useAppStore((state) => state.sessions)
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  const closeRegionRequest = useAppStore((state) => state.closeRegionRequest)
  const clearCloseRegionRequest = useAppStore((state) => state.clearCloseRegionRequest)
  const reportError = useAppStore((state) => state.reportError)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const surface = tab.regions[node.regionId]
  const regionCount = Object.keys(tab.regions).length
  // 焦点是**一次**判定，两个消费者：CSS 类名（画环）与原生视图的让位量（browser 那格要按环宽内缩，
  // 否则窗口级层把环的三边物理盖掉）。见 region-focus.ts——分开各算一次时未聚焦的 browser 区
  // 也内缩，露出底下深色成了一圈无环的黑边。
  // 候选数一起喂进去：只有一格时环不表达任何选择，画出来就是整个界面镶一圈绿边。
  const focus = regionFocusExpression(tab.layout.activeRegionId, node.regionId, regionCount)
  const canClose = regionCount > 1
  const dirty = surface?.kind === 'file' && Boolean(
    dirtyDocuments[documentKey(surface.workspaceId, surface.path)]
  )

  // 关这一格的唯一决定出口：脏就先弹「未保存确认」，否则直接关。鼠标点 X 与键盘 Cmd+W（经 requestCloseRegion
  // 意图落到这里）都走它——「关这一格要不要确认」只此一处判定，键盘不会再像从前那样绕开脏检查静默丢改动。
  function requestRegionClose(): void {
    if (dirty) setConfirmingClose(true)
    else void closeRegion(tab.workspaceId, tab.id, node.regionId)
  }

  // 消费键盘关格意图：只有意图点名的这张 Tab 的这一格才响应，跑与 X 相同的决定，然后清掉意图。本仓库
  // renderToStaticMarkup 不跑 effect，所以这条接线的断言在 store 层（意图投出/清除）与判定层
  // （dispatchWorkbenchCommand 多格时调 requestCloseRegion）各自守，见对应测试。
  useEffect(() => {
    if (
      !closeRegionRequest ||
      closeRegionRequest.tabId !== tab.id ||
      closeRegionRequest.workspaceId !== tab.workspaceId ||
      closeRegionRequest.regionId !== node.regionId
    ) return
    clearCloseRegionRequest(closeRegionRequest.nonce)
    requestRegionClose()
    // requestRegionClose 每次渲染新建，不进依赖；只由意图对象驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeRegionRequest, tab.id, tab.workspaceId, node.regionId, clearCloseRegionRequest])

  if (!surface) return null
  return (
    <RegionContextMenu
      regionId={node.regionId}
      // 只有承载 Agent 的一格才有语义身份可寻址。
      agentSessionId={surface.kind === 'agent' ? surface.sessionId : null}
      writeClipboardText={async (text) => {
        await copyTextToClipboard(text, reportError)
      }}
      // 分屏落在**右键点中的这一格**上，不是「当前聚焦的那一格」。这正是这个菜单存在的理由
      // （见 RegionContextMenu 顶部注释）：Tab 条上那个 Split 下拉只能拿 activeSurface，于是
      // 想切旁边那一格时它切错格；这里 regionId 由右键事件本身给定，没有推断。
      splitMenu={workbenchSplitMenuEntries({
        regionCount,
        split: (direction) => splitRegion(tab.workspaceId, tab.id, node.regionId, direction),
        arrange: (preset) => arrangeTabRegions(tab.workspaceId, tab.id, preset)
      })}
      // 换位同样落在**右键点中的这一格**：swapMenu 列出这张 Tab 里除本格外的每一格，点了把两格
      // 在既有布局里对调（见 regionSwapMenuEntries 与 store.swapRegions）。只有一格时它自然为空，
      // 整节以缺席表达。regions 按 regionIds（布局叶子的左→右 / 上→下 视觉顺序）喂进去，而非
      // Object.values 的插入顺序——这样同名多格的编号（Terminal 1 / 2…）与用户眼里的位置对得上。
      swapMenu={regionSwapMenuEntries({
        regionId: node.regionId,
        regions: regionIds(tab.layout.root).flatMap((regionId) => {
          const region = tab.regions[regionId]
          return region ? [{ regionId, label: regionSurfaceLabel(region, sessions) }] : []
        }),
        swap: (a, b) => swapRegions(tab.workspaceId, tab.id, a, b)
      })}
      // 「单独变成一个 tab」（#487）：把右键点中的这一格从本 Tab 摘出、单独成为一张新 Tab。只在多格时
      // 提供——只剩一格的 Tab 促升无意义（它已经就是一张 Tab），那时不传，菜单里这一项整段缺席。回调
      // 已把「哪一格」闭包进去，与分屏 / 换位同样落在右键点中的这一格上，没有推断。
      promote={
        regionCount > 1
          ? () => promoteRegionToTab(tab.workspaceId, tab.id, node.regionId)
          : undefined
      }
    >
    <section
      className={`${REGION_CLASS} ${focus.className}`}
      data-workbench-region-id={node.regionId}
      onPointerDown={() => focusRegion(tab.workspaceId, tab.id, node.regionId)}
    >
      <SurfaceContent
        surface={surface}
        tabId={tab.id}
        groupId={groupId}
        nativeSurfacesVisible={nativeSurfacesVisible}
        interactiveResize={interactiveResize}
        focus={focus}
      />
      {canClose ? (
        <button
          type="button"
          className="workbench-region__close"
          title="Close split"
          aria-label="Close split"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            requestRegionClose()
          }}
        >
          <X size={12} />
        </button>
      ) : null}
      <ConfirmationDialog
        open={confirmingClose}
        title="Discard unsaved changes?"
        description="Closing this split will discard changes that have not been saved."
        subject={surface.kind === 'file' ? surface.path : 'Split'}
        confirmLabel="Discard & Close"
        onCancel={() => setConfirmingClose(false)}
        onConfirm={() => {
          setConfirmingClose(false)
          void closeRegion(tab.workspaceId, tab.id, node.regionId)
        }}
      />
    </section>
    </RegionContextMenu>
  )
}

function WorkbenchRegionBranch({
  node,
  nodePath,
  tab,
  groupId,
  nativeSurfacesVisible,
  interactiveResize
}: {
  node: Extract<WorkbenchRegionLayoutNode, { type: 'split' }>
  nodePath: string
  tab: WorkbenchTab
  groupId: string
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
}) {
  const updateRegionSplitRatio = useAppStore((state) => state.updateRegionSplitRatio)
  const [dragging, setDragging] = useState(false)
  const terminalResizeSuspended = interactiveResize || dragging
  const commitRef = useRef((ratio: number) => (
    updateRegionSplitRatio(tab.workspaceId, tab.id, nodePath, ratio)
  ))
  commitRef.current = (ratio) => updateRegionSplitRatio(tab.workspaceId, tab.id, nodePath, ratio)
  const committerRef = useRef<SplitRatioCommitter | null>(null)
  if (committerRef.current === null) {
    committerRef.current = new SplitRatioCommitter(node.ratio, (ratio) => commitRef.current(ratio))
  }
  const committer = committerRef.current
  committer.synchronizePersistedRatio(node.ratio)
  return (
    <PanelGroup
      direction={node.direction}
      className="workbench-region-split"
      onLayout={(sizes) => committer.observeLayout(sizes)}
    >
      <Panel defaultSize={node.ratio * 100} minSize={15}>
        <WorkbenchRegionNode
          node={node.first}
          nodePath={nodePath ? `${nodePath}.first` : 'first'}
          tab={tab}
          groupId={groupId}
          nativeSurfacesVisible={nativeSurfacesVisible && !dragging}
          interactiveResize={terminalResizeSuspended}
        />
      </Panel>
      <PanelResizeHandle
        className="workbench-region-resize-handle"
        onDragging={(active) => {
          committer.setDragging(active)
          setDragging(active)
        }}
      />
      <Panel defaultSize={(1 - node.ratio) * 100} minSize={15}>
        <WorkbenchRegionNode
          node={node.second}
          nodePath={nodePath ? `${nodePath}.second` : 'second'}
          tab={tab}
          groupId={groupId}
          nativeSurfacesVisible={nativeSurfacesVisible && !dragging}
          interactiveResize={terminalResizeSuspended}
        />
      </Panel>
    </PanelGroup>
  )
}

function PaneGroup({
  group,
  workspaceId,
  layout,
  allLayout,
  splitTarget,
  nativeSurfacesVisible,
  interactiveResize,
  isRootLeaf
}: {
  group: TabGroup
  workspaceId: string
  layout: WorkspaceLayout
  /** Unprojected layout keeps Topic-hidden tabs mounted while the projected layout drives chrome. */
  allLayout: WorkspaceLayout
  splitTarget: SplitTarget | null
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  isRootLeaf?: boolean
}) {
  const tabsById = useAppStore((state) => state.tabs)
  const sessions = useAppStore((state) => state.sessions)
  const focusTabGroup = useAppStore((state) => state.focusTabGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const splitRegion = useAppStore((state) => state.splitRegion)
  const arrangeTabRegions = useAppStore((state) => state.arrangeTabRegions)
  const setTabMenuOpen = useAppStore((state) => state.setTabMenuOpen)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const viewModes = useAppStore((state) => state.viewModes)
  const stopSession = useAppStore((state) => state.stopSession)
  const [pendingStopSessionId, setPendingStopSessionId] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const { setNodeRef, isOver } = useDroppable({
    id: `pane:${group.id}`,
    data: { kind: 'pane', groupId: group.id } satisfies DropData
  })
  const tabs = group.tabOrder.flatMap((id) => (tabsById[id] ? [tabsById[id]] : []))
  const allGroup = allLayout.groups.find((candidate) => candidate.id === group.id)
  const bodyTabs = (allGroup?.tabOrder ?? group.tabOrder).flatMap((id) => (
    tabsById[id] ? [tabsById[id]] : []
  ))
  const activeTab = tabs.find((tab) => tab.id === group.activeTabId) ?? null
  // Pane 组的焦点环同样只在「有得选」时才有内容：不分屏时唯一那组铺满整个工作区且恒等于
  // activeGroupId，画出来就是整个界面镶一圈绿边（用户原话：「整个界面也有」）。
  //
  // 候选数取分屏树里的叶子数，不取 `layout.groups.length`：那张表里可以躺着**不在树里**的分组
  // （#312 的浮层形态），而它们不经这里渲染、屏幕上不是候选。数错了这个数就等于按一个看不见的
  // 东西决定看得见的环。
  const paneGroupFocus = paneGroupFocusClass(
    layout.activeGroupId,
    group.id,
    groupIds(layout.root).length
  )
  const activeSurface = activeTab ? activeWorkbenchSurface(activeTab) : null
  const activeRuntimeSession =
    activeSurface?.kind === 'agent' || activeSurface?.kind === 'terminal'
      ? sessions.find((session) => session.id === activeSurface.sessionId)
      : null
  const activeAgentSession = activeRuntimeSession?.kind === 'agent' ? activeRuntimeSession : null
  const activeMode = activeAgentSession ? (viewModes[activeAgentSession.id] ?? 'terminal') : null
  const pendingStopSession = pendingStopSessionId
    ? sessions.find((session) => session.id === pendingStopSessionId) ?? null
    : null

  async function confirmStop(): Promise<void> {
    if (!pendingStopSessionId || stopping) return
    const sessionId = pendingStopSessionId
    setStopping(true)
    try {
      await stopSession(sessionId)
    } finally {
      setStopping(false)
      setPendingStopSessionId(null)
    }
  }

  return (
    <section
      ref={setNodeRef}
      className={`pane-group ${isRootLeaf ? 'pane-group--root' : ''} ${paneGroupFocus} ${
        isOver ? 'pane-group--drop-over' : ''
      }`}
      data-pane-group-id={group.id}
      onPointerDown={() => focusTabGroup(workspaceId, group.id)}
    >
      <header className={`pane-tabbar ${isRootLeaf ? 'pane-tabbar--root' : ''}`}>
        {isRootLeaf ? (
          <TopRowLeadingChrome />
        ) : null}
        <SortableContext items={group.tabOrder} strategy={horizontalListSortingStrategy}>
          <WorkbenchTabStrip activeTabId={group.activeTabId} tabIds={group.tabOrder}>
            {tabs.map((tab) => (
              <SortableWorkbenchTab
                key={tab.id}
                tab={tab}
                group={group}
                workspaceId={workspaceId}
              />
            ))}
          </WorkbenchTabStrip>
        </SortableContext>
        <div className="pane-tabbar__actions">
          {activeAgentSession ? (
            <div className="pane-view-toggle" aria-label="Agent view">
              <button
                type="button"
                className={activeMode === 'terminal' ? 'selected' : ''}
                title="Terminal"
                onClick={() => setViewMode(activeAgentSession.id, 'terminal')}
              >
                <SquareTerminal size={12} />
              </button>
              <button
                type="button"
                className={activeMode === 'activity' ? 'selected' : ''}
                title="Activity"
                onClick={() => setViewMode(activeAgentSession.id, 'activity')}
              >
                <MessagesSquare size={12} />
              </button>
            </div>
          ) : null}
          {activeRuntimeSession && canStopSessionRun(activeRuntimeSession) ? (
            <button
              type="button"
              className="pane-action pane-action--stop"
              title="Stop Run"
              aria-label={`Stop Run ${activeRuntimeSession.label}`}
              onClick={() => setPendingStopSessionId(activeRuntimeSession.id)}
            >
              <Square size={12} />
            </button>
          ) : null}
          <PaneSplitMenu
            onOpenChange={setTabMenuOpen}
            disabled={!activeTab || !activeSurface}
            regionCount={activeTab ? Object.keys(activeTab.regions).length : 0}
            onSplit={(direction) => {
              if (activeTab && activeSurface) {
                splitRegion(workspaceId, activeTab.id, activeSurface.regionId, direction)
              }
            }}
            onArrange={(preset) => {
              if (activeTab) arrangeTabRegions(workspaceId, activeTab.id, preset)
            }}
          />
          <button
            type="button"
            className="pane-action"
            onClick={() => openLauncher(group.id)}
            title="New tab"
          >
            <Plus size={13} />
          </button>
        </div>
        {isRootLeaf ? (
          <div className="pane-tabbar__chrome pane-tabbar__chrome--trailing">
            <SurfaceSwitch />
          </div>
        ) : null}
      </header>
      <div className="pane-body">
        {/* 每个 Tab 都留在 DOM 里，不活动的靠 CSS 隐藏。
            此前这里只挂 activeTab，"不可见"实现为"不渲染"——切走即卸载整棵子树，xterm 实例
            随之销毁；切回时 TerminalView 的 hydrating 从 true 起步，必然重放全部 scrollback，
            于是每一次切 Tab / 切 Topic 都亮一遍 "Restoring terminal…"。
            实例活着就没有东西需要恢复，所以修法在保住实例，而不是把重放做快。
            隐藏格必须 absolute 定位：留在文档流里的隐藏子树仍会参与布局，把活动格挤变形。 */}
        {bodyTabs.length > 0 ? bodyTabs.map((tab) => (
          <div
            className="pane-body__region"
            key={tab.id}
            // display:none 会让隐藏格测不到尺寸；这里用 visibility+inert，几何仍在，
            // 切回时不需要重新 fit 一次才显示对的行列数。
            data-active={tab.id === group.activeTabId ? 'true' : 'false'}
            // 隐藏的格子退出可交互树：它仍在 DOM 里，但不该被 Tab 键走到、不该被搜索命中。
            inert={tab.id !== group.activeTabId}
          >
            <WorkbenchRegionNode
              node={tab.layout.root}
              nodePath=""
              tab={tab}
              groupId={group.id}
              // 隐藏的格子里，原生表面与终端一律停工：不 fit、不 resize、不渲染。
              // 保住实例的前提是它闲着不花钱，否则开十个 Tab 就是十份持续开销。
              nativeSurfacesVisible={nativeSurfacesVisible && tab.id === group.activeTabId}
              interactiveResize={interactiveResize}
            />
          </div>
        )) : (
          <NewTabSurface tabGroupId={group.id} visible={nativeSurfacesVisible} />
        )}
      </div>
      <ConfirmationDialog
        open={pendingStopSessionId !== null}
        title={`Stop this ${pendingStopSession?.kind === 'terminal' ? 'terminal' : 'agent'} Run?`}
        description="This immediately stops the underlying Run for every open View."
        subject={pendingStopSession?.label ?? 'Run'}
        confirmLabel="Stop Run"
        busy={stopping}
        onCancel={() => !stopping && setPendingStopSessionId(null)}
        onConfirm={() => void confirmStop()}
      />
      {splitTarget?.groupId === group.id ? (
        <div className={`pane-drop-overlay pane-drop-overlay--${splitTarget.direction}`}>
          <span>New split</span>
        </div>
      ) : null}
    </section>
  )
}

function SplitNode({
  node,
  nodePath,
  workspaceId,
  layout,
  allLayout,
  splitTarget,
  nativeSurfacesVisible,
  interactiveResize = false,
  isRootLeaf = false
}: {
  node: TabGroupLayoutNode
  nodePath: string
  workspaceId: string
  layout: WorkspaceLayout
  allLayout: WorkspaceLayout
  splitTarget: SplitTarget | null
  nativeSurfacesVisible: boolean
  interactiveResize?: boolean
  isRootLeaf?: boolean
}) {
  if (node.type === 'leaf') {
    const group = layout.groups.find((candidate) => candidate.id === node.groupId)
    return group ? (
      <PaneGroup
        group={group}
        workspaceId={workspaceId}
        layout={layout}
        allLayout={allLayout}
        splitTarget={splitTarget}
        nativeSurfacesVisible={nativeSurfacesVisible}
        interactiveResize={interactiveResize}
        isRootLeaf={isRootLeaf}
      />
    ) : null
  }
  return (
    <SplitBranch
      node={node}
      nodePath={nodePath}
      workspaceId={workspaceId}
      layout={layout}
      allLayout={allLayout}
      splitTarget={splitTarget}
      nativeSurfacesVisible={nativeSurfacesVisible}
      interactiveResize={interactiveResize}
    />
  )
}

function SplitBranch({
  node,
  nodePath,
  workspaceId,
  layout,
  allLayout,
  splitTarget,
  nativeSurfacesVisible,
  interactiveResize
}: {
  node: Extract<TabGroupLayoutNode, { type: 'split' }>
  nodePath: string
  workspaceId: string
  layout: WorkspaceLayout
  allLayout: WorkspaceLayout
  splitTarget: SplitTarget | null
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
}) {
  const updateSplitRatio = useAppStore((state) => state.updateSplitRatio)
  const [dragging, setDragging] = useState(false)
  const terminalResizeSuspended = interactiveResize || dragging
  const commitRef = useRef((ratio: number) => updateSplitRatio(workspaceId, nodePath, ratio))
  commitRef.current = (ratio) => updateSplitRatio(workspaceId, nodePath, ratio)
  const committerRef = useRef<SplitRatioCommitter | null>(null)
  if (committerRef.current === null) {
    committerRef.current = new SplitRatioCommitter(
      node.ratio ?? 0.5,
      (ratio) => commitRef.current(ratio)
    )
  }
  const committer = committerRef.current
  committer.synchronizePersistedRatio(node.ratio ?? 0.5)
  return (
    <PanelGroup
      direction={node.direction}
      className="pane-split"
      onLayout={(sizes) => committer.observeLayout(sizes)}
    >
      <Panel defaultSize={(node.ratio ?? 0.5) * 100} minSize={15}>
        <SplitNode
          node={node.first}
          nodePath={nodePath ? `${nodePath}.first` : 'first'}
          workspaceId={workspaceId}
          layout={layout}
          allLayout={allLayout}
          splitTarget={splitTarget}
          nativeSurfacesVisible={nativeSurfacesVisible && !dragging}
          interactiveResize={terminalResizeSuspended}
        />
      </Panel>
      <PanelResizeHandle
        className="pane-resize-handle"
        onDragging={(active) => {
          committer.setDragging(active)
          setDragging(active)
        }}
      />
      <Panel defaultSize={(1 - (node.ratio ?? 0.5)) * 100} minSize={15}>
        <SplitNode
          node={node.second}
          nodePath={nodePath ? `${nodePath}.second` : 'second'}
          workspaceId={workspaceId}
          layout={layout}
          allLayout={allLayout}
          splitTarget={splitTarget}
          nativeSurfacesVisible={nativeSurfacesVisible && !dragging}
          interactiveResize={terminalResizeSuspended}
        />
      </Panel>
    </PanelGroup>
  )
}

function dragPoint(event: DragMoveEvent): { x: number; y: number } | null {
  // 与常见 tab 拖拽实现的 pointer lane 一样，Drop Zone 必须跟真实指针而不是 DragOverlay
  // 的中心点；从 Tab 边缘起拖时两者会相差半个 Tab，最右侧因此可能越出 viewport。
  const activator = event.activatorEvent
  if (activator instanceof PointerEvent || activator instanceof MouseEvent) {
    return { x: activator.clientX + event.delta.x, y: activator.clientY + event.delta.y }
  }
  return null
}

function splitTargetAtPoint(point: { x: number; y: number }): SplitTarget | null {
  const pane = document
    .elementsFromPoint(point.x, point.y)
    .map((element) => element.closest<HTMLElement>('[data-pane-group-id]'))
    .find(Boolean)
  if (!pane) return null
  const rect = pane.getBoundingClientRect()
  const direction = resolvePaneColumnEdgeZone(rect, point)
  return direction ? { groupId: pane.dataset.paneGroupId!, direction } : null
}

export function WorkspaceWorkbench({
  workspaceId,
  interactiveResize = false,
  visible = true
}: {
  workspaceId: string
  interactiveResize?: boolean
  /**
   * Whether this window-level Workbench slot is currently on screen. The slot stays mounted while
   * false so SessionPane/xterm/ctxmux attachments survive Workspace navigation; native surfaces use
   * this seam to stop fit/bounds work until the slot is visible again.
   */
  visible?: boolean
}) {
  const storedLayout = useAppStore((state) => state.layouts[workspaceId])
  const tabs = useAppStore((state) => state.tabs)
  // 切 Topic 就像切 Branch：换掉那一组 Tab。layout 仍只有一份，这里只是一次投影。
  // 当前 Topic 从活动 Tab 的绑定派生，而不是读一个只有面板点击会写的字段——否则从别的路径
  // 进入 Topic（点 Tab、会话恢复、Board 跳转）时它是空的，投影整个不发生。
  const layout = useMemo(
    () => storedLayout
      ? layoutForActiveTopic(storedLayout, tabs, activeTopicIdFromLayout(storedLayout, tabs))
      : storedLayout,
    [storedLayout, tabs]
  )
  const moveTab = useAppStore((state) => state.moveTab)
  const moveTabToNewGroup = useAppStore((state) => state.moveTabToNewGroup)
  const tabMenuOpen = useAppStore((state) => state.tabMenuOpen)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [activeDrag, setActiveDrag] = useState<DragTabData | null>(null)
  const [splitTarget, setSplitTarget] = useState<SplitTarget | null>(null)
  const activeTab = activeDrag ? tabs[activeDrag.tabId] : null

  // A Workspace switch can happen while a drag is in flight (for example through a keyboard command).
  // The parked DndContext must not retain a DragOverlay or finish the gesture against a stale layout
  // when this Workbench becomes visible again.
  useEffect(() => {
    if (visible) return
    setActiveDrag(null)
    setSplitTarget(null)
  }, [visible])

  const groupById = useMemo(
    () => new Map(layout?.groups.map((group) => [group.id, group]) ?? []),
    [layout?.groups]
  )

  function onDragStart(event: DragStartEvent): void {
    const data = event.active.data.current as DragTabData | undefined
    if (data?.kind === 'tab') setActiveDrag(data)
  }

  function onDragMove(event: DragMoveEvent): void {
    const point = dragPoint(event)
    setSplitTarget(point ? splitTargetAtPoint(point) : null)
  }

  function onDragEnd(event: DragEndEvent): void {
    const drag = activeDrag
    const target = splitTarget
    setActiveDrag(null)
    setSplitTarget(null)
    if (!drag) return
    if (target) {
      moveTabToNewGroup(workspaceId, drag.tabId, drag.groupId, target.groupId, target.direction)
      return
    }
    const over = event.over?.data.current as DropData | undefined
    if (!over) return
    const targetGroupId = over.groupId
    const targetGroup = groupById.get(targetGroupId)
    if (!targetGroup) return
    const targetIndex =
      over.kind === 'tab'
        ? Math.max(0, targetGroup.tabOrder.indexOf(over.tabId))
        : targetGroup.tabOrder.length
    moveTab(workspaceId, drag.tabId, drag.groupId, targetGroupId, targetIndex)
  }

  if (!layout) return null
  // MERGE：不分屏时把全局 chrome 注入唯一 pane 的 tabbar（root tabbar）；
  // 分屏时 tabbar 无法承载全局 chrome，改在 SplitNode 上方渲染一条惰性 chromeline
  // （无 tab、无 data-pane-group-id，对 pointerWithin 完全透明，不影响 DnD 命中）。
  const rootIsLeaf = layout.root.type === 'leaf'
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveDrag(null)
        setSplitTarget(null)
      }}
      autoScroll={false}
    >
      <div className={`workspace-workbench ${rootIsLeaf ? 'workspace-workbench--merged' : ''}`}>
        {rootIsLeaf ? null : (
          <div className="workbench-chromeline">
            <TopRowLeadingChrome />
            <SurfaceSwitch />
          </div>
        )}
        <SplitNode
          node={layout.root}
          nodePath=""
          workspaceId={workspaceId}
          layout={layout}
          allLayout={storedLayout ?? layout}
          splitTarget={splitTarget}
          nativeSurfacesVisible={visible && activeDrag === null && !tabMenuOpen}
          interactiveResize={interactiveResize}
          isRootLeaf={rootIsLeaf}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTab ? <DragPreview tab={activeTab} /> : null}
      </DragOverlay>
    </DndContext>
  )
}
