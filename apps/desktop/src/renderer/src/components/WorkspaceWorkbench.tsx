import { layoutForLogicalRegionFocus, logicalRegionId } from '../lib/region-focus'
import { ServiceWindowNotice } from './ServiceWindowNotice'
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
  Plus,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { sessionPresentationById } from '../lib/session-presentation'
import { recordForWorkbenchTab, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { BrowserPane } from './BrowserPane'
import { ConfirmationDialog } from './ConfirmationDialog'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { NewTabSurface } from './NewTabSurface'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { PaneSplitMenu } from './PaneSplitMenu'
import { RegionContextMenu } from './RegionContextMenu'
import {
  REGION_CLASS,
  paneGroupFocusClass,
  regionFocusExpression,
  type RegionFocusExpression
} from '../lib/region-focus'
import { activeTopicIdFromLayout, layoutForActiveTopic } from '../lib/scratch-topic-layout'
import { projectWorkbenchProjection, selectWorkbenchProjectionTab, sameWorkbenchProjectionSelection, workbenchProjectionSlotId, workbenchRegionProjectionSlotId, workbenchProjectionTabIds, workbenchProjectionZone, WorkbenchProjectionContext, type WorkbenchProjection } from '../lib/workbench-projection'
import { StableWorkbenchView } from './StableWorkbenchView'
import { workbenchDisplayTabs, workbenchDisplayReferenceMatches, workbenchDisplayOccurrenceAmbiguous } from '../lib/workbench-resource-display'
import { useWorkbenchRetainedRegionId, useWorkbenchBrowserPresentation, workbenchHomePresentationReferences, WorkbenchBrowserTargetsContext, workbenchBrowserStageHostId, type BrowserControlConfirmation, type WorkbenchViewTarget, type WorkbenchViewTargets } from '../lib/workbench-presentation'
import { opensContextMenuFromKeyboard } from '../lib/context-menu-key'
import { SessionPane } from './SessionPane'
import { SessionRegionHost } from './SessionRegionHost'
import { WorkbenchTabContextMenu } from './WorkbenchTabContextMenu'
import { WorkbenchTabMarks } from './WorkbenchTabMarks'
import { WorkbenchTabStrip } from './WorkbenchTabStrip'
import { resolvePaneColumnEdgeZone } from '../lib/tab-drop-zone'
import { SplitRatioCommitter } from '../lib/split-ratio-commit'
import { moveSessionViewMenu, regionSwapMenuEntries, tabIdsForCloseScope, workbenchSplitMenuEntries } from '../lib/workbench-tab-actions'
import { regionSurfaceLabel } from '../lib/region-display-name'
import { revealInFileManagerLabel } from '../lib/host-platform'
import { TopRowLeadingChrome } from './TopRowChrome'
import {
  groupIds,
  regionIds,
  clampSplitRatio,
  MIN_SPLIT_PERCENT,
  type SplitDirection,
  type TabGroup,
  type TabGroupLayoutNode,
  type WorkspaceLayout,
  type WorkbenchRegionLayoutNode
} from '@agentmux/layout'
import type { SessionSnapshot } from '../../../shared/contracts'
import { workbenchAgentFactsFor, workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import {
  activeWorkbenchSurface,
  agentDisplayName,
  documentKey,
  sessionIdsWithoutViewsAfterClosingTabs,
  titleWorkbenchSurface,
  workbenchSurfaces,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../lib/workbench-tabs'
import { assertUnreachableSurface, isSessionSurface } from '../lib/workbench-surface-kinds'
import { tabMarkAgentFactsFor, tabRegionSummary, workbenchTabMarks } from '../lib/workbench-tab-marks'
import { canStopSessionRun, sessionTabTooltip, surfaceTabTooltip } from '../lib/session-metadata'
import { addressableAgentSessionId, copyableAgentSessionIdForTab } from '../lib/tab-control-handoff'
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

const GitBranchDiffPane = lazy(async () => {
  const module = await import('./GitBranchDiffPane')
  return { default: module.GitBranchDiffPane }
})

const FileSurfaceView = lazy(async () => {
  const module = await import('./FileSurfaceView')
  return { default: module.FileSurfaceView }
})

type DragTabData = { kind: 'tab'; tabId: string; groupId: string }
type DropData = DragTabData | { kind: 'pane'; groupId: string }
type SplitTarget = { groupId: string; direction: SplitDirection }

function DragPreview({ tab }: { tab: WorkbenchTab }) {
  const sessions = useWorkbenchTabSessions(tab)
  const agentNames = useAppStore(useShallow((state) => recordForWorkbenchTab(state.agentNames, tab)))
  const timelines = useAppStore(useShallow((state) => recordForWorkbenchTab(state.timelines, tab)))
  const label = workbenchTabDisplayName(tab, sessions, agentNames, timelines)
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
  const projection = useContext(WorkbenchProjectionContext)
  const sessions = useWorkbenchTabSessions(tab)
  const agentNames = useAppStore(useShallow((state) => recordForWorkbenchTab(state.agentNames, tab)))
  const timelines = useAppStore(useShallow((state) => recordForWorkbenchTab(state.timelines, tab)))
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const renameTab = useAppStore((state) => state.renameTab)
  const renameAgent = useAppStore((state) => state.renameAgent)
  const moveTabToNewGroup = useAppStore((state) => state.moveTabToNewGroup)
  const arrangeTabRegions = useAppStore((state) => state.arrangeTabRegions)
  const config = useAppStore((state) => state.config)
  const localHome = useAppStore((state) => state.localHome)
  const moveSessionViewToWorkspace = useAppStore((state) => state.moveSessionViewToWorkspace)
  // 键盘 Cmd+W 在单 Region Tab 上关整张 Tab 的意图：窗口监听够不着这里的确认流，所以它只投一个意图，
  // 由目标 Tab（intent 的 tabId 命中自己）跑既有的 requestTabsClose——与鼠标点 X 同一条路，含未保存/在跑
  // Agent 的确认。跑完清掉意图。
  const closeTabRequest = useAppStore((state) => state.closeTabRequest)
  const clearCloseTabRequest = useAppStore((state) => state.clearCloseTabRequest)
  const reportError = useAppStore((state) => state.reportError)
  const surface = titleWorkbenchSurface(tab)
  const session = isSessionSurface(surface)
    ? sessions.find((item) => item.id === surface.sessionId)
    : null
  // 标签上画的标记序列：一张 Tab 可以含多个 Region，标签要画出它的种类构成，而不是只画标题那一个。
  // 「谁是 Agent」的判断在 `tabMarkAgentFactsFor` 里，不在这里——这个文件在 node 里 import 不了（经
  // api.ts 的一个 vite define），留在这里的任何取值判断都无法被测试执行到。这里只剩一句转发。
  const agentFactsFor = tabMarkAgentFactsFor(sessions, config?.executors, config?.appearance.agentAvatars)
  const marks = workbenchTabMarks(tab, agentFactsFor)
  // 标记簇在上限处截断且刻意不画 `+N`（标签宽度极紧）。折掉的种类改由 tooltip 兜住，两条 tooltip
  // 路径都取它——没有 Session 的多 Region Tab 同样需要（见 `surfaceTabTooltip`）。
  const regionSummary = tabRegionSummary(tab, agentFactsFor)
  // The one place a tab's shown name is decided: the naming SSOT chain, fed the Store's own facts. It is
  // NOT `session.label` — that is only the chain's lowest tier (Provider·Workspace), overridden by a user
  // rename, a single Agent's own name, or the multi-Agent family name.
  const displayName = workbenchTabDisplayName(tab, sessions, agentNames, timelines)
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
            home: localHome,
            copyPathsAsAbsolute: config?.copyPathsAsAbsolute,
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
    currentWorkspaceId: tab.workspaceId,
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
  const [displayTargets, setDisplayTargets] = useState<{
    displayWorkspaceId: string; groupId: string; label: string; linked: boolean
  }[]>([])
  const [bindingPending, setBindingPending] = useState(false)
  const [bindingMenuOpen, setBindingMenuOpen] = useState(false)
  // Inspect display metadata only when this menu opens; terminal output and unrelated tab renders
  // do not enumerate all layouts. A binding result refreshes the same controlled facts.
  function refreshDisplayTargets(): void {
    const state = useAppStore.getState()
    setDisplayTargets(Object.entries(state.layouts).flatMap(([displayWorkspaceId, layout]) => {
      const name = state.config?.workspaces.find(workspace => workspace.id === displayWorkspaceId)?.name ?? displayWorkspaceId
      return groupIds(layout.root).flatMap((groupId, index) => {
        const target = layout.groups.find(group => group.id === groupId)
        return target ? [{ displayWorkspaceId, groupId, label: `${name} · Group ${index + 1}`, linked: target.tabOrder.includes(tab.id) }] : []
      })
    }))
  }
  useEffect(() => {
    if (!bindingMenuOpen) return
    refreshDisplayTargets()
    return useAppStore.subscribe((state, previous) => {
      if (state.layouts !== previous.layouts || state.config !== previous.config) refreshDisplayTargets()
    })
    // This subscription exists only for the open menu and reads no Session/output facts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingMenuOpen, tab.id])
  async function changeDisplayBinding(displayWorkspaceId: string, groupId: string, linked: boolean): Promise<void> {
    if (bindingPending) return
    setBindingPending(true)
    try {
      await useAppStore.getState().setTabDisplayPlacement(tab.id, displayWorkspaceId, groupId, linked)
    } catch (error) {
      reportError(error)
    } finally {
      refreshDisplayTargets()
      setBindingPending(false)
    }
  }
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
    const tabsById = useAppStore.getState().tabs
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
    ).filter((id) => useAppStore.getState().sessions.find((item) => item.id === id)?.processState !== 'exited').length
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
        onArrange={(mode) => arrangeTabRegions(tab.workspaceId, tab.id, mode)}
        moveSessionViewTargets={moveSessionView.targets}
        onMoveSessionView={moveSessionView.onSelect}
        displayTargets={displayTargets}
        bindingPending={bindingPending}
        onOpenChange={(open) => { if (open) refreshDisplayTargets(); setBindingMenuOpen(open) }}
        onDisplayBindingChange={(displayWorkspaceId, groupId, linked) => void changeDisplayBinding(displayWorkspaceId, groupId, linked)}
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
          onClick={() => projection ? selectWorkbenchProjectionTab(projection, group.id, tab) : activateTab(workspaceId, group.id, tab.id)}
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
            title={`Close ${displayName}`}
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
  surfaceVisible,
  nativeSurfacesVisible,
  interactiveResize,
  headerPortalTargetId,
  focus,
  browserFrame,
  onBrowserInputSelected
}: {
  surface: WorkbenchSurface
  tabId: string
  groupId: string
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  headerPortalTargetId: string | null
  /** 这一格的焦点表达。只有 browser 那格真用得到（原生视图要让位），但由上游一次算好传下来。 */
  focus: RegionFocusExpression
  browserFrame?: ((content: ReactNode, target: WorkbenchViewTarget) => ReactNode) | undefined
  onBrowserInputSelected?: ((target: WorkbenchViewTarget) => void) | undefined
}) {
  const parked = useTerminalRegionParked(surface.regionId)
  const monacoReleased = useMonacoSurfaceReleased(surface.regionId)
  const browserReleased = useBrowserSurfaceReleased(surface.regionId)
  const browserPresentation = useWorkbenchBrowserPresentation()
  const browserTargets = useContext(WorkbenchBrowserTargetsContext)
  if (isSessionSurface(surface)) {
    return (
      <SessionPane
        sessionId={surface.sessionId}
        surfaceKind={surface.kind}
        interactiveResize={interactiveResize}
        visible={surfaceVisible}
        parked={parked}
        headerPortalTargetId={headerPortalTargetId}
        linkOrigin={{
          workspaceId: surface.workspaceId,
          tabGroupId: groupId,
          tabId,
          regionId: surface.regionId,
          sessionId: surface.sessionId
        }}
      />
    )
  }
  if (surface.kind === 'git-diff') {
    return (
      <Suspense fallback={<FullPageLoadingSurface scope="region" phase="loading" eyebrow="Git diff" title="Loading diff" detail="Bringing up the fixed commit comparison." />}>
        <GitBranchDiffPane surface={surface} released={monacoReleased} visible={surfaceVisible} />
      </Suspense>
    )
  }
  if (surface.kind === 'file') {
    return (
      <Suspense fallback={<FullPageLoadingSurface scope="region" phase="loading" eyebrow="File" title="Loading file" detail="Loading file content" />}>
        <FileSurfaceView tabId={tabId} surface={surface} released={monacoReleased} visible={surfaceVisible} />
      </Suspense>
    )
  }
  if (surface.kind === 'browser') {
    return (
      <BrowserPane key={surface.browserId}
        tab={surface}
        presentations={browserTargets.flatMap(target => target.reference?.tabId === tabId && (!target.projection || target.projection.entity.kind !== 'region' || target.projection.entity.regionId === surface.regionId)
          ? [{ occurrence: { presentationId: workbenchBrowserStageHostId(target, surface.regionId), location: { ...target.reference, regionId: surface.regionId } },
            stageHostId: workbenchBrowserStageHostId(target, surface.regionId), visible: target.visible !== false,
            active: target.active, yieldToFocusRing: focus.nativeViewYieldsToRing, target }] : [])}
        renderPresentationFrame={browserFrame}
        onPresentationInputSelected={onBrowserInputSelected}
        visible={nativeSurfacesVisible}
        released={browserReleased}
        yieldToFocusRing={focus.nativeViewYieldsToRing}
        presentationTargetId={browserPresentation.tabHostId}
        controlPanelOpen={browserPresentation.survey ? browserPresentation.controlsOpen : undefined}
        onControlConfirmation={browserPresentation.onBrowserControlConfirmation}
      />
    )
  }
  // Launcher, named rather than reached by falling through. A bare `return <NewTabSurface/>` tail would
  // render a sixth kind as an empty start page — the pane looks fine and does the wrong thing, with no
  // compile error. Naming the case lets `assertUnreachableSurface` refuse to type-check that day.
  if (surface.kind === 'launcher') {
    return (
      <NewTabSurface
        tabGroupId={groupId}
        tabId={tabId}
        regionId={surface.regionId}
        visible={surfaceVisible}
      />
    )
  }
  return assertUnreachableSurface(surface)
}

type RegionSwapTargets = Parameters<typeof regionSwapMenuEntries>[0]['regions']

function WorkbenchRegionTree(props: {
  tab: WorkbenchTab
  groupId: string
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  headerPortalTargetId: string | null
  regionTarget?: WorkbenchViewTarget | undefined
}) {
  const { tab } = props
  const sessions = useWorkbenchTabSessions(tab)
  const agentNames = useAppStore(useShallow((state) => recordForWorkbenchTab(state.agentNames, tab)))
  const timelines = useAppStore(useShallow((state) => recordForWorkbenchTab(state.timelines, tab)))
  const swapTargets = useMemo(() => {
    const agentFactsFor = workbenchAgentFactsFor(sessions, agentNames, timelines)
    return regionIds(tab.layout.root).flatMap((regionId) => {
      const region = tab.regions[regionId]
      if (!region) return []
      const facts = region.kind === 'agent' ? agentFactsFor(region.sessionId) : null
      return [{ regionId, label: facts ? agentDisplayName(facts) : regionSurfaceLabel(region, sessions) }]
    })
  }, [sessions, agentNames, timelines, tab.regions, tab.layout.root])
  return <WorkbenchRegionNode {...props} node={tab.layout.root} nodePath="" swapTargets={swapTargets} />
}

function WorkbenchRegionNode({
  node,
  nodePath,
  tab,
  swapTargets,
  groupId,
  surfaceVisible,
  nativeSurfacesVisible,
  interactiveResize,
  headerPortalTargetId = null,
  regionTarget
}: {
  node: WorkbenchRegionLayoutNode
  nodePath: string
  tab: WorkbenchTab
  swapTargets: RegionSwapTargets
  groupId: string
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  headerPortalTargetId?: string | null
  regionTarget?: WorkbenchViewTarget | undefined
}) {
  if (node.type === 'leaf') {
    return (
      <WorkbenchRegionLeaf
        node={node}
        tab={tab}
        swapTargets={swapTargets}
        groupId={groupId}
        surfaceVisible={surfaceVisible}
        nativeSurfacesVisible={nativeSurfacesVisible}
        interactiveResize={interactiveResize}
        headerPortalTargetId={headerPortalTargetId}
        regionTarget={regionTarget}
      />
    )
  }
  return (
    <WorkbenchRegionBranch
      node={node}
      nodePath={nodePath}
      tab={tab}
      swapTargets={swapTargets}
      groupId={groupId}
      surfaceVisible={surfaceVisible}
      nativeSurfacesVisible={nativeSurfacesVisible}
      interactiveResize={interactiveResize}
      regionTarget={regionTarget}
    />
  )
}

// 一格（leaf）单独成组件：消费键盘关格意图的 effect、以及「关这一格要不要确认」的决定，都得跑在组件顶层
// hook 里——它们够不着 node.type 分支之后。拆出来后这些 hook 无条件执行，套路同 WorkbenchRegionBranch。
type WorkbenchRegionLeafProps = Parameters<typeof WorkbenchRegionContent>[0] & { regionTarget?: WorkbenchViewTarget | undefined }
function WorkbenchRegionLeaf({ regionTarget, ...props }: WorkbenchRegionLeafProps) {
  const parent = useWorkbenchBrowserPresentation()
  const reference = regionTarget?.reference
  const scope = regionTarget?.projection
  const projected = scope?.entity.kind === 'region' && scope.entity.regionId === props.node.regionId &&
    reference?.regionId === props.node.regionId && reference.tabId === props.tab.id && reference.displayWorkspaceId === scope.displayWorkspaceId &&
    scope.catalog.locations.some(location => sameWorkbenchProjectionSelection(location, reference))
  const target = projected ? regionTarget : undefined
  const homeId = `${parent.tabHostId}:region:${props.node.regionId}`
  const visible = target ? target.visible !== false : props.surfaceVisible
  return <>
    <div id={homeId} className="workbench-region-slot" />
    <StableWorkbenchView kind="region" homeId={homeId} targetId={target?.hostId ?? null} active={target?.active ?? parent.active}
      retainedRegionId={target?.retainedRegionId ?? parent.retainedRegionId}
      survey={target ? target.surface === 'survey' : parent.survey} controlsOpen={target?.controlsOpen ?? parent.controlsOpen}
      onBrowserControlConfirmation={parent.onBrowserControlConfirmation} onSelectRegion={target?.onSelectRegion ?? parent.onSelectRegion}
      projection={target?.projection ?? parent.projection} reference={target?.reference ?? parent.reference}
      homeNotice={target && props.surfaceVisible ? <div role="status" className="workbench-restore-notice">This Region is shown in the selected presentation. Close that presentation to return it here.</div> : undefined}>
      <WorkbenchRegionContent {...props} surfaceVisible={visible} nativeSurfacesVisible={target ? visible : props.nativeSurfacesVisible}
        headerPortalTargetId={target?.headerPortalTargetId ?? props.headerPortalTargetId} />
    </StableWorkbenchView>
  </>
}

function WorkbenchRegionContent({
  node,
  tab,
  swapTargets,
  groupId,
  surfaceVisible,
  nativeSurfacesVisible,
  interactiveResize,
  headerPortalTargetId
}: {
  node: Extract<WorkbenchRegionLayoutNode, { type: 'leaf' }>
  tab: WorkbenchTab
  swapTargets: RegionSwapTargets
  groupId: string
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  headerPortalTargetId: string | null
}) {
  const browserPresentation = useWorkbenchBrowserPresentation()
  const focusRegion = useAppStore((state) => state.focusRegion)
  const retainedRegionId = useWorkbenchRetainedRegionId()
  const closeRegion = useAppStore((state) => state.closeRegion)
  const splitRegion = useAppStore((state) => state.splitRegion)
  const arrangeTabRegions = useAppStore((state) => state.arrangeTabRegions)
  const swapRegions = useAppStore((state) => state.swapRegions)
  const promoteRegionToTab = useAppStore((state) => state.promoteRegionToTab)
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
  const focus = regionFocusExpression(retainedRegionId ?? tab.layout.activeRegionId, node.regionId, regionCount)
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

  // 键盘打开这一格的右键菜单——补的是一个可达性缺口：纯键盘用户够不到右键，而 Radix 的 Trigger 只认
  // 真正的 `contextmenu` 事件，于是 promote / arrange 预设 / 均分 / move-to-workspace / split-left /
  // split-up 这些后端齐全的能力对纯键盘用户此前完全不可达。键盘流是「先用 Cmd+Alt+方向把焦点移到某格，
  // 再按 Shift+F10（或 Menu 键）」，所以这一格只需**可编程聚焦**、不必进 Tab 序——给整页每个分屏都塞
  // 一个 Tab 停靠点会把 Tab 序撑爆，而 Region 是容器不是控件。故 section 上是 `tabIndex={-1}`：
  // `element.focus()` 能聚焦、聚焦后能收到 keydown，但 Tab 键不会走到它。
  //
  // 命中就在**这一格自己**（event.currentTarget，即 Trigger 的 asChild 子元素）上合成一个 contextmenu
  // 事件，让 Radix 的 Trigger 按这一格的位置打开**同一个** RegionContextMenu——菜单里每一项一次性都拿到
  // 键盘路径，不必逐项补和弦（和弦已经很挤）。「这个键该不该开菜单」是纯谓词（opensContextMenuFromKeyboard，
  // 认 Shift+F10 与 Menu 键两种拼法；mac 上通行的是 Shift+F10）。本仓 renderToStaticMarkup 不跑 effect、
  // 也发不出 keydown，故这条接线由 AST 守（section 带 tabIndex/onKeyDown、handler 合成 contextmenu），
  // 判据本身由纯谓词层守。
  function openRegionMenuFromKeyboard(event: React.KeyboardEvent<HTMLElement>): void {
    if (!opensContextMenuFromKeyboard(event)) return
    event.preventDefault()
    const region = event.currentTarget
    const rect = region.getBoundingClientRect()
    region.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: rect.left,
      clientY: rect.top
    }))
  }

  const selectFrameRegion = (target?: WorkbenchViewTarget, floating = false): void => {
    if (target?.onSelectRegion) target.onSelectRegion(node.regionId)
    else if (!target && browserPresentation.onSelectRegion) browserPresentation.onSelectRegion(node.regionId)
    else if (!((target?.surface === 'survey' || !target && browserPresentation.survey) && surface?.kind === 'browser')) {
      const reference = target?.reference ?? browserPresentation.reference
      focusRegion(reference?.displayWorkspaceId ?? tab.workspaceId, tab.id, node.regionId,
        floating || target?.surface === 'mote' ? 'floating-pointer' : 'pointer', reference?.groupId)
    }
  }

  const renderFrame = (content: ReactNode, target?: WorkbenchViewTarget): ReactNode => (
    <RegionContextMenu
      regionId={node.regionId}
      // 只有承载 Agent 的一格才有语义身份可寻址。这个判定跟 Tab 级的唯一 Agent 判定同源
      // （tab-control-handoff 的 addressableAgentSessionId），所以第六种载 Agent 的 kind 只在那里声明一次。
      agentSessionId={addressableAgentSessionId(surface)}
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
        regions: swapTargets,
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
      // tabIndex={-1}：可编程聚焦但不进 Tab 序（理由见 openRegionMenuFromKeyboard 上方注释）。
      tabIndex={-1}
      onKeyDown={openRegionMenuFromKeyboard}
      onPointerDown={(event) => {
        // A Region portal keeps React ancestry. Survey browser input does not navigate Space;
        // the original floating pointer path still owns actual Mote/Agent/Terminal interaction.
        selectFrameRegion(target, Boolean(event.currentTarget.closest('[data-pmo-teams-topic-floating]')))
      }}
    >
      {content}
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

    </section>
    </RegionContextMenu>
  )
  return <>{renderFrame(
      <SessionRegionHost arrangement="columns" className="workbench-session-region-host">
        <SurfaceContent
          surface={surface}
          tabId={tab.id}
          groupId={groupId}
          surfaceVisible={surfaceVisible}
          nativeSurfacesVisible={nativeSurfacesVisible}
          interactiveResize={interactiveResize}
          headerPortalTargetId={headerPortalTargetId}
          focus={focus}
          browserFrame={renderFrame}
          onBrowserInputSelected={target => selectFrameRegion(target)}
        />
      </SessionRegionHost>
  )}
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
  </>
}

/** Thin leaf destinations: all actions/content remain with the original Region owner. */
function WorkbenchBrowserPresentationSlots({ tab, target, node }: { tab: WorkbenchTab; target: WorkbenchViewTarget; node: WorkbenchRegionLayoutNode }): ReactNode {
  if (node.type === 'leaf') return tab.regions[node.regionId]?.kind === 'browser'
    ? <div id={workbenchBrowserStageHostId(target, node.regionId)} className="workbench-region-slot" data-browser-occurrence-slot={node.regionId} />
    : <div role="status" className="workbench-restore-notice">This Region remains in its original work surface. Simultaneous live display is not available yet.</div>
  return <div className="workbench-browser-presentation-split" style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, flexDirection: node.direction === 'horizontal' ? 'row' : 'column' }}>
    <div style={{ display: 'flex', flex: node.ratio, minHeight: 0, minWidth: 0 }}><WorkbenchBrowserPresentationSlots tab={tab} target={target} node={node.first} /></div>
    <div style={{ display: 'flex', flex: 1 - node.ratio, minHeight: 0, minWidth: 0 }}><WorkbenchBrowserPresentationSlots tab={tab} target={target} node={node.second} /></div>
  </div>
}

/** Project the Store's accepted ratio into the existing PanelGroup, leaving drag commits with its owner. */
function usePersistedSplitLayout(ratio: number, dragging: boolean) {
  const groupRef = useRef<ImperativePanelGroupHandle>(null)
  useLayoutEffect(() => {
    if (dragging) return
    const group = groupRef.current
    if (!group) return
    const sizes = [ratio * 100, (1 - ratio) * 100]
    const current = group.getLayout()
    // The library rounds percentages; ignore only numerical dust in this visible projection.
    if (current.length === 2 && current.every((size, index) => Math.abs(size - sizes[index]!) < 1e-6)) return
    group.setLayout(sizes)
  }, [ratio, dragging])
  return groupRef
}

function WorkbenchRegionBranch({
  node,
  nodePath,
  tab,
  swapTargets,
  groupId,
  surfaceVisible,
  nativeSurfacesVisible,
  interactiveResize,
  regionTarget
}: {
  node: Extract<WorkbenchRegionLayoutNode, { type: 'split' }>
  nodePath: string
  tab: WorkbenchTab
  swapTargets: RegionSwapTargets
  groupId: string
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  regionTarget?: WorkbenchViewTarget | undefined
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
  const groupRef = usePersistedSplitLayout(node.ratio, dragging)
  return (
    <PanelGroup
      ref={groupRef}
      direction={node.direction}
      className="workbench-region-split"
      onLayout={(sizes) => committer.observeLayout(sizes)}
    >
      <Panel defaultSize={node.ratio * 100} minSize={MIN_SPLIT_PERCENT}>
        <WorkbenchRegionNode
          node={node.first}
          nodePath={nodePath ? `${nodePath}.first` : 'first'}
          tab={tab}
          swapTargets={swapTargets}
          groupId={groupId}
          surfaceVisible={surfaceVisible}
          nativeSurfacesVisible={nativeSurfacesVisible}
          interactiveResize={terminalResizeSuspended}
          regionTarget={regionTarget}
        />
      </Panel>
      <PanelResizeHandle
        className="workbench-region-resize-handle"
        onDragging={(active) => {
          committer.setDragging(active)
          setDragging(active)
        }}
      />
      <Panel defaultSize={(1 - node.ratio) * 100} minSize={MIN_SPLIT_PERCENT}>
        <WorkbenchRegionNode
          node={node.second}
          nodePath={nodePath ? `${nodePath}.second` : 'second'}
          tab={tab}
          swapTargets={swapTargets}
          groupId={groupId}
          surfaceVisible={surfaceVisible}
          nativeSurfacesVisible={nativeSurfacesVisible}
          interactiveResize={terminalResizeSuspended}
          regionTarget={regionTarget}
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
  surfaceVisible,
  nativeSurfacesVisible,
  interactiveResize,
  isRootLeaf,
  showWindowChrome = false,
  viewHostPrefix,
  onNewTab
}: {
  group: TabGroup
  workspaceId: string
  layout: WorkspaceLayout
  /** Unprojected layout keeps Topic-hidden tabs mounted while the projected layout drives chrome. */
  allLayout: WorkspaceLayout
  splitTarget: SplitTarget | null
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  isRootLeaf?: boolean
  showWindowChrome?: boolean
  viewHostPrefix: string
  onNewTab(groupId: string): void
}) {
  const projection = useContext(WorkbenchProjectionContext)
  const tabsById = useAppStore(useShallow((state) => projection
    ? Object.fromEntries(group.tabOrder.flatMap(id => state.tabs[id] ? [[id, state.tabs[id]!]] : []))
    : workbenchDisplayTabs(state.tabs, workspaceId, allLayout)))
  const focusTabGroup = useAppStore((state) => state.focusTabGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const splitRegion = useAppStore((state) => state.splitRegion)
  const arrangeTabRegions = useAppStore((state) => state.arrangeTabRegions)
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
  const emptySpaceSelection = useAppStore(state => showWindowChrome && workspaceId === SCRATCH_WORKSPACE_ID &&
    state.workbenchSpaceSelection?.workspaceId === workspaceId && state.workbenchSpaceSelection.topicId &&
    state.workbenchSpaceSelection.tabId === null ? state.workbenchSpaceSelection : null)
  const storedSpaceLayout = useAppStore(state => emptySpaceSelection ? state.layouts[workspaceId] : undefined)
  const { topics: spaceTopics } = useScratchTopics(emptySpaceSelection ? workspaceId : null)
  const emptySpaceTopic = spaceTopics?.find(topic => topic.id === emptySpaceSelection?.topicId && !topic.readError &&
    (topic.id === PMO_TEAMS_TOPIC_ID || topic.soul))
  const hasOriginalTopicTab = emptySpaceSelection && Object.values(tabsById).some(tab => tab.topicId === emptySpaceSelection.topicId)
  const showEmptySpace = emptySpaceSelection && !activeTab
  const retainedSpatialFocus = useAppStore(state => state.retainedSpatialFocus)
  const focusMoved = retainedSpatialFocus?.displayWorkspaceId === workspaceId && layout.activeGroupId === group.id &&
    (!activeTab || !activeTab.regions[retainedSpatialFocus.regionId])
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
  const activeRegionId = activeTab ? logicalRegionId(activeTab, projection?.selection.find(reference => reference.displayWorkspaceId === workspaceId && reference.groupId === group.id && reference.tabId === activeTab.id)?.regionId ?? retainedSpatialFocus?.regionId) : null
  const activeSurface = activeTab && activeRegionId ? activeTab.regions[activeRegionId] : null
  // Route through isSessionSurface (SSOT in workbench-surface-kinds.ts). This site was invisible
  // to the exhaustiveness guard for months because it read `.kind` off a nullable receiver
  // (`WorkbenchSurface | null` from the ternary above) — the assignability check the guard used
  // rejected nullable Surface variants. Guard widened in the same commit; this call site is the
  // first-listed offender it caught. A sixth session-bearing kind now fails at
  // `isSessionSurface`'s exhaustive switch instead of silently being excluded here.
  const activeRuntimeSession = useAppStore((state) => activeSurface && isSessionSurface(activeSurface)
    ? sessionPresentationById(state.sessions).get(activeSurface.sessionId) ?? null
    : null)
  const pendingStopSession = useAppStore((state) => pendingStopSessionId
    ? sessionPresentationById(state.sessions).get(pendingStopSessionId) ?? null
    : null)

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
      onPointerDown={() => projection ? activeTab && selectWorkbenchProjectionTab(projection, group.id, activeTab,
        projection.selection.find(reference => reference.displayWorkspaceId === workspaceId && reference.groupId === group.id && reference.tabId === activeTab.id)?.regionId)
        : focusTabGroup(workspaceId, group.id)}
    >
      <header className={`pane-tabbar ${isRootLeaf ? 'pane-tabbar--root' : ''} ${showWindowChrome ? 'pane-tabbar--chrome-owner' : ''}`}>
        {showWindowChrome ? (
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
            disabled={!activeTab || !activeSurface}
            regionCount={activeTab ? Object.keys(activeTab.regions).length : 0}
            onSplit={(direction) => {
              if (activeTab && activeSurface) {
                splitRegion(activeTab.workspaceId, activeTab.id, activeSurface.regionId, direction)
              }
            }}
            onArrange={(mode) => {
              if (activeTab) arrangeTabRegions(activeTab.workspaceId, activeTab.id, mode)
            }}
          />
          <button
            type="button"
            className="pane-action"
            onClick={() => onNewTab(group.id)}
            title="New tab"
          >
            <Plus size={13} />
          </button>
        </div>
      <div className="service-disclosure-home" data-workbench-moved-focus={focusMoved ? '' : undefined}>
        <ServiceWindowNotice disclosure={{ scope: JSON.stringify(['local:focus-moved', workspaceId, group.id]),
          id: 'focus-moved', occurrence: JSON.stringify(retainedSpatialFocus), cause: 'focused-region-moved', visible: surfaceVisible }}
          notice={focusMoved ? { kind: 'indeterminate', notice: {
          step: 'Focused Agent moved in the background',
          mode: 'The remaining Regions stay visible; no replacement Agent is selected.',
          restore: 'Choose a Region, a Tab, or a new Tab to change focus.'
        } } : null} />
      </div>
      </header>
      <div className="pane-body">
        {showEmptySpace ? storedSpaceLayout && emptySpaceTopic && !hasOriginalTopicTab ? <div className="pane-state" data-mote-empty-space={emptySpaceTopic.id}
          onPointerDown={event => event.stopPropagation()}>
          <span>{emptySpaceTopic.title}</span>
          <strong role="status">No Tab in this context</strong>
          <button type="button" className="small-button" aria-label="New Tab" title="New tab"
            onClick={() => onNewTab(group.id)}><Plus size={13} /> New Tab</button>
        </div> : <div role="status" className="workbench-restore-notice">Original context retained · Topic or Tab placement is still being confirmed · Reopen this context in Space to continue recovery</div> : null}
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
            <div id={workbenchProjectionSlotId(viewHostPrefix, { displayWorkspaceId: workspaceId, groupId: group.id, tabId: tab.id })}
              data-workbench-tab-id={tab.id} data-workbench-group-id={group.id} className="workbench-tab-slot">
              {projection && group.activeTabId === tab.id && projection.unsupportedTabIds.has(tab.id)
                ? <div role="status" className="workbench-restore-notice">This exact Tab is selected in more than one Group. Simultaneous live display is not available; its original content and references are kept.</div> : null}
              {!projection && tab.workspaceId !== workspaceId && group.activeTabId === tab.id && workbenchDisplayOccurrenceAmbiguous(layout, group.id, tab.id)
                ? <div role="status" className="workbench-restore-notice">Original Tab retained · Select this exact Group to display its existing View here.</div> : null}
            </div>
          </div>
        )) : !focusMoved && !showEmptySpace ? (
          projection ? <div role="status" className="workbench-restore-notice">Select a Tab in this Zone to display its original content.</div>
            : <NewTabSurface tabGroupId={group.id} visible={surfaceVisible} />
        ) : null}
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
  surfaceVisible,
  nativeSurfacesVisible,
  interactiveResize = false,
  isRootLeaf = false,
  showWindowChrome = false,
  viewHostPrefix,
  onNewTab
}: {
  node: TabGroupLayoutNode
  nodePath: string
  workspaceId: string
  layout: WorkspaceLayout
  allLayout: WorkspaceLayout
  splitTarget: SplitTarget | null
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize?: boolean
  isRootLeaf?: boolean
  showWindowChrome?: boolean
  viewHostPrefix: string
  onNewTab(groupId: string): void
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
        surfaceVisible={surfaceVisible}
        nativeSurfacesVisible={nativeSurfacesVisible}
        interactiveResize={interactiveResize}
        isRootLeaf={isRootLeaf}
        showWindowChrome={showWindowChrome}
        viewHostPrefix={viewHostPrefix}
        onNewTab={onNewTab}
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
      surfaceVisible={surfaceVisible}
      nativeSurfacesVisible={nativeSurfacesVisible}
      interactiveResize={interactiveResize}
      showWindowChrome={showWindowChrome}
      viewHostPrefix={viewHostPrefix}
      onNewTab={onNewTab}
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
  surfaceVisible,
  nativeSurfacesVisible,
  interactiveResize,
  showWindowChrome,
  viewHostPrefix,
  onNewTab
}: {
  node: Extract<TabGroupLayoutNode, { type: 'split' }>
  nodePath: string
  workspaceId: string
  layout: WorkspaceLayout
  allLayout: WorkspaceLayout
  splitTarget: SplitTarget | null
  surfaceVisible: boolean
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  showWindowChrome: boolean
  viewHostPrefix: string
  onNewTab(groupId: string): void
}) {
  const updateSplitRatio = useAppStore((state) => state.updateSplitRatio)
  const [dragging, setDragging] = useState(false)
  const terminalResizeSuspended = interactiveResize || dragging
  const commitRef = useRef((ratio: number) => updateSplitRatio(workspaceId, nodePath, ratio))
  commitRef.current = (ratio) => updateSplitRatio(workspaceId, nodePath, ratio)
  // 缺失 / 非有限 / 越界的比例只在这里判一次。`?? 0.5` 曾在本组件手抄四份，而它防的是「可能缺 ratio
  // 的历史持久化数据」——#552 坐实了那道防线接不住 NaN（`??` 只认 null/undefined），而 NaN 恰恰是
  // 上游归一化把缺失值算出来的东西。改成走 clampSplitRatio 后三种坏取值同一个出口，见它的注释。
  const ratio = clampSplitRatio(node.ratio)
  const committerRef = useRef<SplitRatioCommitter | null>(null)
  if (committerRef.current === null) {
    committerRef.current = new SplitRatioCommitter(ratio, (value) => commitRef.current(value))
  }
  const committer = committerRef.current
  committer.synchronizePersistedRatio(ratio)
  const groupRef = usePersistedSplitLayout(ratio, dragging)
  return (
    <PanelGroup
      ref={groupRef}
      direction={node.direction}
      className="pane-split"
      onLayout={(sizes) => committer.observeLayout(sizes)}
    >
      <Panel defaultSize={ratio * 100} minSize={MIN_SPLIT_PERCENT}>
        <SplitNode
          node={node.first}
          nodePath={nodePath ? `${nodePath}.first` : 'first'}
          workspaceId={workspaceId}
          layout={layout}
          allLayout={allLayout}
          splitTarget={splitTarget}
          surfaceVisible={surfaceVisible}
          nativeSurfacesVisible={nativeSurfacesVisible}
          interactiveResize={terminalResizeSuspended}
          showWindowChrome={showWindowChrome}
          viewHostPrefix={viewHostPrefix}
          onNewTab={onNewTab}
        />
      </Panel>
      <PanelResizeHandle
        className="pane-resize-handle"
        onDragging={(active) => {
          committer.setDragging(active)
          setDragging(active)
        }}
      />
      <Panel defaultSize={(1 - ratio) * 100} minSize={MIN_SPLIT_PERCENT}>
        <SplitNode
          node={node.second}
          nodePath={nodePath ? `${nodePath}.second` : 'second'}
          workspaceId={workspaceId}
          layout={layout}
          allLayout={allLayout}
          splitTarget={splitTarget}
          surfaceVisible={surfaceVisible}
          nativeSurfacesVisible={nativeSurfacesVisible}
          interactiveResize={terminalResizeSuspended}
          showWindowChrome={false}
          viewHostPrefix={viewHostPrefix}
          onNewTab={onNewTab}
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
  visible = true,
  topicId,
  topicIsolation = 'default',
  viewOwnership = 'owner',
  viewHostPrefix = 'workbench-tab-slot',
  viewTargets,
  onBrowserControlConfirmation,
  projectionTabId,
  onTabSelect,
  projection
}: {
  workspaceId: string
  interactiveResize?: boolean
  /** Optional explicit Topic projection used by product-owned surfaces such as PMO teams topic. */
  topicId?: string
  topicIsolation?: 'default' | 'bound-only'
  /**
   * Whether this window-level Workbench slot is currently on screen. The slot stays mounted while
   * false so SessionPane/xterm/ctxmux attachments survive Workspace navigation; native surfaces use
   * this seam to stop fit/bounds work until the slot is visible again.
  */
  visible?: boolean
  /** Projection chrome supplies slots; the window registry remains the single View owner. */
  viewOwnership?: 'owner' | 'projection'
  viewHostPrefix?: string
  /** Explicit visible destinations move existing Tab contents without mounting another tree. */
  viewTargets?: WorkbenchViewTargets | undefined
  onBrowserControlConfirmation?: BrowserControlConfirmation | undefined
  /** Select within projection chrome without changing the durable main workface. */
  projectionTabId?: string | undefined
  /** Explicit navigation inside this projection may retain its own selected Tab. */
  onTabSelect?: ((tabId: string) => void) | undefined
  /** Controlled exact Zone projection; the original workface keeps entity/content ownership. */
  projection?: WorkbenchProjection | undefined
}) {
  const workbenchRef = useRef<HTMLDivElement>(null)
  const projectionEntity = projection?.entity
  const projectionKey = projectionEntity ? `${projection?.presentationId}:${projectionEntity.kind}:${projectionEntity.kind === 'zone' ? projectionEntity.zoneId : projectionEntity.kind === 'tab' ? projectionEntity.tabId : projectionEntity.regionId}` : null
  const [projectionActiveGroupId, setProjectionActiveGroupId] = useState<string | null>(null)
  useEffect(() => setProjectionActiveGroupId(null), [projectionKey])
  const effectiveViewHostPrefix = projection ? `${projection.presentationId}-slot` : viewHostPrefix
  const storedLayout = useAppStore((state) => state.layouts[workspaceId])
  const retainedLayout = useRef(storedLayout)
  if (storedLayout) retainedLayout.current = storedLayout
  const residentLayout = storedLayout ?? retainedLayout.current
  const projectedMemberIds = useMemo(() => projection ? workbenchProjectionTabIds(projection) : null, [projection?.entity, projection?.catalog])
  const tabs = useAppStore(useShallow((state) => projection
    ? Object.fromEntries([...projectedMemberIds ?? []].flatMap(id => state.tabs[id] ? [[id, state.tabs[id]!]] : []))
    : workbenchDisplayTabs(state.tabs, workspaceId, residentLayout)))
  const ordinaryDisplayIds = useMemo(() => [...new Set(Object.values(tabs).flatMap(tab =>
    tab.workspaceId === workspaceId && viewTargets?.[tab.id] ? viewTargets[tab.id]!.flatMap(target => target.surface === 'space' && target.reference ? [target.reference.displayWorkspaceId] : []) : []))], [tabs, viewTargets, workspaceId])
  const ordinaryLayouts = useAppStore(useShallow(state => Object.fromEntries(ordinaryDisplayIds.map(id => [id, state.layouts[id]]))))
  // 切 Topic 就像切 Branch：换掉那一组 Tab。layout 仍只有一份，这里只是一次投影。
  // 当前 Topic 从活动 Tab 的绑定派生，而不是读一个只有面板点击会写的字段——否则从别的路径
  // 进入 Topic（点 Tab、会话恢复、Board 跳转）时它是空的，投影整个不发生。
  const retainedSpatialFocus = useAppStore(state => state.retainedSpatialFocus)
  const zoneLayout = useMemo(() => projection ? projectWorkbenchProjection(residentLayout, tabs, projection, projectionActiveGroupId) : null,
    [residentLayout, tabs, projection, projectionActiveGroupId])
  const projectionContext = useMemo(() => projection && zoneLayout
    ? { ...projection, unsupportedTabIds: new Set([...zoneLayout.unsupportedTabIds, ...zoneLayout.layout?.groups.flatMap(group => {
        const tabId = group.activeTabId
        if (!tabId || !viewTargets?.[tabId]) return []
        const slotId = projection.entity.kind === 'region'
          ? workbenchRegionProjectionSlotId(effectiveViewHostPrefix, { displayWorkspaceId: workspaceId, groupId: group.id, tabId, regionId: projection.entity.regionId })
          : workbenchProjectionSlotId(effectiveViewHostPrefix, { displayWorkspaceId: workspaceId, groupId: group.id, tabId })
        return viewTargets[tabId]!.some(target => target.hostId === slotId) ? [] : [tabId]
      }) ?? []]),
      onSelect: (reference: Parameters<WorkbenchProjection['onSelect']>[0]) => { setProjectionActiveGroupId(reference.groupId); projection.onSelect(reference) } } : null, [projection, zoneLayout, viewTargets, effectiveViewHostPrefix, workspaceId])
  const layout = useMemo(
    () => zoneLayout ? zoneLayout.layout : residentLayout
      ? layoutForLogicalRegionFocus(layoutForActiveTopic(residentLayout, tabs, topicId ?? (retainedSpatialFocus?.displayWorkspaceId === workspaceId ? retainedSpatialFocus.topicId : undefined) ?? activeTopicIdFromLayout(residentLayout, tabs), topicIsolation !== 'bound-only', projectionTabId), tabs, retainedSpatialFocus?.displayWorkspaceId === workspaceId ? retainedSpatialFocus : null)
      : residentLayout,
    [zoneLayout, residentLayout, tabs, topicId, topicIsolation, projectionTabId, retainedSpatialFocus, workspaceId]
  )
  const moveTab = useAppStore((state) => state.moveTab)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const moveTabToNewGroup = useAppStore((state) => state.moveTabToNewGroup)
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

  // Owner lookup grows with this workspace's actual Tab memberships, never Tabs × groups.
  const ownerByTab = useMemo(() => {
    const owners = new Map<string, string>()
    for (const group of residentLayout?.groups ?? []) for (const id of group.tabOrder) owners.set(id, group.id)
    return owners
  }, [residentLayout?.groups])
  const homeReferences = useMemo(() => workbenchHomePresentationReferences(storedLayout, workspaceId, tabs), [storedLayout, workspaceId, tabs])
  const retainedOwners = useRef(new Map<string, string>())
  for (const [id, groupId] of ownerByTab) retainedOwners.current.set(id, groupId)
  for (const id of retainedOwners.current.keys()) if (!tabs[id]) retainedOwners.current.delete(id)

  useEffect(() => {
    const element = workbenchRef.current
    if (!element || !visible || !onTabSelect || projection) return
    // Retained View contents arrive through a portal owned by another Workbench.
    // Native events follow the visible DOM host, so both Tab clicks and a Region
    // focus inside that moved View identify the projection the person selected.
    const select = (event: Event): void => {
      if (!(event.target instanceof Element)) return
      const tabElement = event.target.closest<HTMLElement>('[data-workbench-tab-id]')
      if (event.type === 'focusin' && tabElement?.matches('button')) return
      const tabId = tabElement?.dataset.workbenchTabId
      // Header actions have their own navigation owner. They cannot choose a
      // View by borrowing the durable main workface's active Tab after a click.
      if (!tabId) return
      queueMicrotask(() => {
        if (!element.isConnected) return
        const state = useAppStore.getState()
        const tab = state.tabs[tabId]
        if (tab && tab.workspaceId === workspaceId && (!topicId || tab.topicId === topicId)) onTabSelect(tab.id)
      })
    }
    element.addEventListener('click', select)
    element.addEventListener('focusin', select)
    return () => {
      element.removeEventListener('click', select)
      element.removeEventListener('focusin', select)
    }
  }, [visible, onTabSelect, workspaceId, topicId, layout, projection])

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
    // 这个下标是在**用户看到的**（已按 Topic 投影的）tabOrder 上算的。store 的 moveTab 负责把它
    // 翻译回未投影的存储坐标——两套坐标只要落点前有一张别的 Topic 的 Tab 就分家（#556）。
    const visibleTargetIndex =
      over.kind === 'tab'
        ? Math.max(0, targetGroup.tabOrder.indexOf(over.tabId))
        : targetGroup.tabOrder.length
    moveTab(workspaceId, drag.tabId, drag.groupId, targetGroupId, visibleTargetIndex)
  }

  function newTab(groupId: string): void {
    if (projection) {
      const zone = workbenchProjectionZone(projection)
      const state = useAppStore.getState()
      if (!zone) {
        state.reportError(new Error('The exact Zone resource Group is unavailable here. Existing content is kept; create its Tab from the original resource workface.'))
        return
      }
      const tabId = openLauncher({ workspaceId: zone.workspaceId, displayWorkspaceId: projection.displayWorkspaceId, tabGroupId: groupId, zoneId: zone.zoneId, reveal: false })
      const tab = tabId ? useAppStore.getState().tabs[tabId] : undefined
      if (tab) projection.onSelect({ displayWorkspaceId: workspaceId, groupId, tabId: tab.id, regionId: tab.layout.activeRegionId })
      return
    }
    const projectedTopicId = topicId ?? (layout ? activeTopicIdFromLayout(layout, tabs) : undefined)
    const tabId = openLauncher({ workspaceId, tabGroupId: groupId,
      ...(projectedTopicId ? { topicId: projectedTopicId } : {}), reveal: viewOwnership === 'owner' })
    if (tabId) onTabSelect?.(tabId)
  }

  if (viewOwnership === 'projection' && !projectionTabId && !projection) {
    return <div ref={workbenchRef} className="workspace-workbench" data-workbench-pending-owner>
      {layout ? <div className="pane-state">
        <strong role="status">No Tab in this context</strong>
        <button type="button" className="small-button" aria-label="New Tab" title="New tab"
          onClick={() => newTab(layout.activeGroupId)}><Plus size={13} /> New Tab</button>
      </div> : <div role="status" className="workbench-restore-notice">Original context retained · Workspace layout is still restoring</div>}
    </div>
  }
  const projectedTab = projectionTabId ? tabs[projectionTabId] : undefined
  if (viewOwnership === 'projection' && !projection && projectionTabId && (!projectedTab || projectedTab.workspaceId !== workspaceId ||
    topicId && projectedTab.topicId !== topicId || !ownerByTab.has(projectionTabId))) {
    return <div ref={workbenchRef} className="workspace-workbench">
      <div role="status" className="workbench-restore-notice">Original Tab retained · Its placement in this context is not available · Reopen this context in Space to continue recovery</div>
      <div id={`${viewHostPrefix}:${projectionTabId}`} data-workbench-tab-id={projectionTabId} className="workbench-tab-slot" />
    </div>
  }
  const projectionNotice = zoneLayout?.issues.length ? <ServiceWindowNotice
    notice={{ kind: 'indeterminate', notice: { step: 'Original work surface retained', mode: zoneLayout.issues.join(' '),
      restore: 'Select a Tab in its Group, or reopen the original work surface in Space.' } }} /> : null
  if (!layout && viewOwnership !== 'owner') return projection ? <div className="workspace-workbench" data-workbench-pending-owner>{projectionNotice}</div> : null
  if (layout && viewOwnership === 'projection' && projection?.entity.kind === 'region') {
    const reference = projection.selection.length === 1 ? projection.selection[0] : undefined
    const confirmed = reference && reference.regionId === projection.entity.regionId && reference.displayWorkspaceId === workspaceId &&
      tabs[reference.tabId]?.regions[reference.regionId] && layout.groups.some(group => group.id === reference.groupId && group.activeTabId === reference.tabId) &&
      !projectionContext?.unsupportedTabIds.has(reference.tabId)
    return <WorkbenchProjectionContext.Provider value={projectionContext}>
      <div ref={workbenchRef} className="workspace-workbench">
        {projectionNotice}
        {confirmed ? <div id={workbenchRegionProjectionSlotId(effectiveViewHostPrefix, reference)}
          data-workbench-tab-id={reference.tabId} data-workbench-group-id={reference.groupId} className="workbench-region-slot" />
          : <div role="status" className="workbench-restore-notice">The exact Region occurrence is not confirmed here. Its content and reference are kept; choose its original location.</div>}
      </div>
    </WorkbenchProjectionContext.Provider>
  }
  // Tab-level callers supply their own title band. The original View owner still
  // holds the Region tree; this exact slot does not recreate its Group chrome.
  if (layout && viewOwnership === 'projection' && projection?.entity.kind === 'tab') {
    const reference = projection.selection.length === 1 ? projection.selection[0] : undefined
    const group = reference && layout.groups.find(group => group.id === reference.groupId)
    const tab = tabs[projection.entity.tabId]
    const confirmed = reference && tab && reference.displayWorkspaceId === workspaceId &&
      reference.tabId === tab.id && group?.activeTabId === tab.id &&
      !projectionContext?.unsupportedTabIds.has(tab.id)
    return <WorkbenchProjectionContext.Provider value={projectionContext}>
      <div ref={workbenchRef} className="workspace-workbench">
        {projectionNotice}
        {confirmed ? <div id={workbenchProjectionSlotId(effectiveViewHostPrefix, reference)}
          data-workbench-tab-id={tab.id} data-workbench-group-id={reference.groupId} className="workbench-tab-slot" />
          : <div role="status" className="workbench-restore-notice">The exact Tab occurrence is not confirmed here. Its content and reference are kept; choose its original location.</div>}
      </div>
    </WorkbenchProjectionContext.Provider>
  }
  // 单 Pane 与分屏都让 Tabbar 从窗口顶边开始；分屏只把一次必要的全局 chrome 传给首个 Pane。
  const rootIsLeaf = layout?.root.type === 'leaf'
  const workbench = (
    <WorkbenchProjectionContext.Provider value={projectionContext}>
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
      <div ref={workbenchRef} className={`workspace-workbench ${rootIsLeaf ? 'workspace-workbench--merged' : ''}`}>
        {projectionNotice}
        {!storedLayout && residentLayout && !projection ? <div role="status" className="workbench-restore-notice">Original work surface retained · Display layout is still restoring</div> : null}
        {layout ? <SplitNode
          node={layout.root}
          nodePath=""
          workspaceId={workspaceId}
          layout={layout}
          allLayout={viewOwnership === 'owner' ? storedLayout ?? layout : layout}
          splitTarget={splitTarget}
          surfaceVisible={visible}
          nativeSurfacesVisible={visible && activeDrag === null}
          interactiveResize={interactiveResize}
          isRootLeaf={rootIsLeaf}
          showWindowChrome={viewOwnership === 'owner'}
          viewHostPrefix={effectiveViewHostPrefix}
          onNewTab={newTab}
        /> : <div role="status" className="workbench-restore-notice">Original Tab retained · Workspace layout is still restoring</div>}
      </div>
      {viewOwnership === 'owner' && Object.values(tabs).filter(tab => tab.workspaceId === workspaceId).map(tab => {
        const targets = viewTargets?.[tab.id] ?? []
        const browserOnly = Object.values(tab.regions).length > 0 && Object.values(tab.regions).every(region => region.kind === 'browser')
        const projection = (browserOnly ? targets.find(target => target.surface === 'space') : undefined) ??
          [...targets].reverse().find(target => target.visible !== false && target.surface !== 'space') ?? targets.find(target => target.visible !== false) ??
          [...targets].reverse().find(target => target.surface !== 'space') ?? targets[0]
        const reference = projection?.reference
        const ordinaryLayout = reference ? ordinaryLayouts[reference.displayWorkspaceId] : undefined
        const confirmedDisplayGroup = reference?.tabId === tab.id && tab.regions[reference.regionId] &&
          (projection?.surface === 'space' ? workbenchDisplayReferenceMatches(ordinaryLayout, reference)
            : projection?.projection?.catalog.locations.some(location => sameWorkbenchProjectionSelection(location, reference)))
          ? reference.groupId : undefined
        if (confirmedDisplayGroup) retainedOwners.current.set(tab.id, confirmedDisplayGroup)
        const originalOwnerId = ownerByTab.get(tab.id) ?? retainedOwners.current.get(tab.id)
        const ownerId = projection?.surface === 'space' && confirmedDisplayGroup ? confirmedDisplayGroup : originalOwnerId ?? confirmedDisplayGroup
        const projectedGroup = ownerId ? groupById.get(ownerId) : undefined
        const regionTarget = projection?.projection?.entity.kind === 'region' ? projection : undefined
        const tabProjection = regionTarget ? undefined : projection
        const targetId = tabProjection?.hostId ?? null
        const homeId = homeReferences.get(tab.id) ? workbenchProjectionSlotId(viewHostPrefix, homeReferences.get(tab.id)!) : `${viewHostPrefix}:${tab.id}`
        const primaryHostId = targetId ?? homeId
        const tabVisible = (targetId !== null && (tabProjection?.surface ? tabProjection.visible === true : true)) || (targetId === null && visible && projectedGroup?.activeTabId === tab.id)
        return <WorkbenchBrowserTargetsContext.Provider key={tab.id} value={targets}>
        {targets.filter(target => target.hostId !== primaryHostId && target.reference).map(target =>
          <StableWorkbenchView key={target.hostId} homeId={`${target.hostId}:parked`} targetId={target.hostId}
            active={target.active} retainedRegionId={target.reference!.regionId} reference={target.reference}>
            <WorkbenchBrowserPresentationSlots tab={tab} target={target} node={target.projection?.entity.kind === 'region' ? { type: 'leaf', regionId: target.projection.entity.regionId } : tab.layout.root} />
          </StableWorkbenchView>)}
        <StableWorkbenchView homeId={homeId} targetId={targetId}
          active={tabProjection?.active ?? true}
          survey={tabProjection?.surface === 'survey'} controlsOpen={tabProjection?.controlsOpen ?? false}
          onBrowserControlConfirmation={onBrowserControlConfirmation}
          homeNotice={tabProjection && tabProjection.surface !== 'space' && visible && projectedGroup?.activeTabId === tab.id ? <div data-workbench-borrowed-view-notice>
            <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
              step: tabProjection.surface === 'focus' ? 'Selected View is in Focus' : tabProjection.surface === 'survey' ? 'Selected View is in Survey' : 'Selected View is in Mote',
              mode: tabProjection.surface === 'focus' || tabProjection.surface === 'survey'
                ? 'This Tab is selected here. Its original View remains in the named presentation.'
                : 'This Tab is selected here. Its original View remains in the floating window.',
              restore: tabProjection.surface === 'focus' ? 'Close Focus workspace to return this View to Space.'
                : tabProjection.surface === 'survey' ? 'Return to Space to see the original View.' : 'Close Mote to return this View to Space.'
            } }} />
          </div> : undefined}
          onSelectRegion={tabProjection?.onSelectRegion}
          projection={tabProjection?.projection}
          reference={targetId === null ? homeReferences.get(tab.id) ?? undefined : projection?.reference}
          retainedRegionId={tabProjection?.retainedRegionId ?? (targetId === null && retainedSpatialFocus?.tabId === tab.id ? retainedSpatialFocus.regionId : null)}>
          {originalOwnerId && !confirmedDisplayGroup && (!storedLayout || !ownerByTab.has(tab.id)) ? <div role="status" className="workbench-restore-notice">Original Tab retained · Workspace layout is still restoring</div> : null}
          {ownerId ? <WorkbenchRegionTree
            tab={tab} groupId={ownerId} regionTarget={regionTarget}
            headerPortalTargetId={projection?.surface === 'focus' && targetId && storedLayout && ownerByTab.has(tab.id) &&
              tab.layout.root.type === 'leaf' && tab.regions[tab.layout.root.regionId]?.kind === 'agent'
              ? projection?.headerPortalTargetId ?? `${targetId}-header` : null}
            surfaceVisible={tabVisible}
            nativeSurfacesVisible={tabVisible && activeDrag === null}
            interactiveResize={interactiveResize}
          /> : <FullPageLoadingSurface scope="region" phase="loading" eyebrow="Focus" title="Restoring Tab layout" detail="The original Tab is retained while its workspace layout is restored." />}
        </StableWorkbenchView>
        </WorkbenchBrowserTargetsContext.Provider>
      })}
      <DragOverlay dropAnimation={null}>
        {activeTab ? <DragPreview tab={activeTab} /> : null}
      </DragOverlay>
    </DndContext>
    </WorkbenchProjectionContext.Provider>
  )
  return workbench
}
