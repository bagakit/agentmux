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
  FileCode2,
  Globe2,
  GripVertical,
  MessagesSquare,
  Plus,
  Sparkles,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { BrowserPane } from './BrowserPane'
import { AgentProviderIcon } from './AgentProviderIcon'
import { ConfirmationDialog } from './ConfirmationDialog'
import { NewTabSurface } from './NewTabSurface'
import { PaneSplitMenu } from './PaneSplitMenu'
import { SessionPane } from './SessionPane'
import { StatusDot } from './StatusDot'
import { WorkbenchTabContextMenu } from './WorkbenchTabContextMenu'
import { WorkbenchTabStrip } from './WorkbenchTabStrip'
import { resolvePaneColumnEdgeZone } from '../lib/tab-drop-zone'
import { SplitRatioCommitter } from '../lib/split-ratio-commit'
import { tabIdsForCloseScope } from '../lib/workbench-tab-actions'
import { SurfaceSwitch, TopRowLeadingChrome } from './TopRowChrome'
import type {
  SplitDirection,
  TabGroup,
  TabGroupLayoutNode
} from '../lib/workbench-layout'
import type { WorkbenchRegionLayoutNode } from '../lib/workbench-view-layout'
import {
  activeWorkbenchSurface,
  documentKey,
  sessionIdsWithoutViewsAfterClosingTabs,
  titleWorkbenchSurface,
  workbenchSurfaces,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../lib/workbench-tabs'
import { canStopSessionRun, sessionTabTooltip } from '../lib/session-metadata'
import { copyableAgentSessionIdForTab } from '../lib/tab-control-handoff'
import { api } from '../lib/api'
import { useAppStore } from '../store'

const EditorPane = lazy(async () => {
  const module = await import('./EditorPane')
  return { default: module.EditorPane }
})

type DragTabData = { kind: 'tab'; tabId: string; groupId: string }
type DropData = DragTabData | { kind: 'pane'; groupId: string }
type SplitTarget = { groupId: string; direction: SplitDirection }

function tabLabel(tab: WorkbenchTab): string {
  const surface = titleWorkbenchSurface(tab)
  if (surface.kind === 'file') return surface.path.split('/').at(-1) ?? surface.path
  if (surface.kind === 'launcher') return 'New Tab'
  if (surface.kind === 'browser') {
    return surface.title && surface.title !== 'about:blank'
      ? surface.title
      : surface.url === 'about:blank' ? 'New Tab' : surface.url
  }
  return surface.sessionId
}

function DragPreview({ tab }: { tab: WorkbenchTab }) {
  return (
    <div className="tab-drag-preview">
      <GripVertical size={12} />
      <span>{tabLabel(tab)}</span>
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
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  const tabsById = useAppStore((state) => state.tabs)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const moveTabToNewGroup = useAppStore((state) => state.moveTabToNewGroup)
  const setTabMenuOpen = useAppStore((state) => state.setTabMenuOpen)
  const surface = titleWorkbenchSurface(tab)
  const session = surface.kind === 'agent' || surface.kind === 'terminal'
    ? sessions.find((item) => item.id === surface.sessionId)
    : null
  const copyableAgentSessionId = copyableAgentSessionIdForTab(tab)
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
        writeClipboardText={(text) => api.ui.writeClipboardText(text)}
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
      >
        <button
          ref={setNodeRef}
          type="button"
          data-workbench-tab-id={tab.id}
          className={`workbench-tab ${group.activeTabId === tab.id ? 'workbench-tab--active' : ''} ${
            isDragging ? 'workbench-tab--dragging' : ''
          }`}
          style={{ transform: CSS.Translate.toString(transform), transition }}
          title={session ? sessionTabTooltip(session) : tabLabel(tab)}
          onClick={() => activateTab(workspaceId, group.id, tab.id)}
          {...attributes}
          {...listeners}
        >
          {surface.kind === 'agent' || surface.kind === 'terminal' ? (
            session?.kind === 'agent' ? (
              <i className="workbench-tab__agent-mark"><AgentProviderIcon providerId={session.providerId} size={13} /><StatusDot status={session.status} /></i>
            ) : <SquareTerminal size={12} />
          ) : surface.kind === 'file' ? (
            <FileCode2 size={12} />
          ) : surface.kind === 'browser' ? (
            <Globe2 size={12} />
          ) : (
            <Sparkles size={12} />
          )}
          <span className="workbench-tab__label">{session?.label ?? tabLabel(tab)}</span>
          {dirty ? <i className="workbench-tab__dirty" aria-label="Unsaved" /> : null}
          <span
            role="button"
            tabIndex={0}
            className="workbench-tab__close"
            aria-label={`Close ${session?.label ?? tabLabel(tab)}`}
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
          : session?.label ?? tabLabel(tab)}
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
  interactiveResize
}: {
  surface: WorkbenchSurface
  tabId: string
  groupId: string
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
}) {
  if (surface.kind === 'agent' || surface.kind === 'terminal') {
    return (
      <SessionPane
        sessionId={surface.sessionId}
        surfaceKind={surface.kind}
        interactiveResize={interactiveResize}
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
        <EditorPane tabId={tabId} surface={surface} />
      </Suspense>
    )
  }
  if (surface.kind === 'browser') {
    return (
      <BrowserPane
        key={surface.browserId}
        tab={surface}
        visible={nativeSurfacesVisible}
      />
    )
  }
  return <NewTabSurface tabGroupId={groupId} tabId={tabId} regionId={surface.regionId} />
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
  const focusRegion = useAppStore((state) => state.focusRegion)
  const closeRegion = useAppStore((state) => state.closeRegion)
  const dirtyDocuments = useAppStore((state) => state.dirtyDocuments)
  const [confirmingClose, setConfirmingClose] = useState(false)
  if (node.type === 'leaf') {
    const surface = tab.regions[node.regionId]
    if (!surface) return null
    const canClose = Object.keys(tab.regions).length > 1
    const dirty = surface.kind === 'file' && Boolean(
      dirtyDocuments[documentKey(surface.workspaceId, surface.path)]
    )
    return (
      <section
        className={`workbench-region ${tab.layout.activeRegionId === node.regionId ? 'workbench-region--active' : ''}`}
        data-workbench-region-id={node.regionId}
        onPointerDown={() => focusRegion(tab.workspaceId, tab.id, node.regionId)}
      >
        <SurfaceContent
          surface={surface}
          tabId={tab.id}
          groupId={groupId}
          nativeSurfacesVisible={nativeSurfacesVisible}
          interactiveResize={interactiveResize}
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
              if (dirty) setConfirmingClose(true)
              else void closeRegion(tab.workspaceId, tab.id, node.regionId)
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
  splitTarget,
  nativeSurfacesVisible,
  interactiveResize,
  isRootLeaf
}: {
  group: TabGroup
  workspaceId: string
  splitTarget: SplitTarget | null
  nativeSurfacesVisible: boolean
  interactiveResize: boolean
  isRootLeaf?: boolean
}) {
  const tabsById = useAppStore((state) => state.tabs)
  const sessions = useAppStore((state) => state.sessions)
  const layout = useAppStore((state) => state.layouts[workspaceId])
  const focusTabGroup = useAppStore((state) => state.focusTabGroup)
  const activateTab = useAppStore((state) => state.activateTab)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const splitRegion = useAppStore((state) => state.splitRegion)
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
  const activeTab = tabs.find((tab) => tab.id === group.activeTabId) ?? null
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
      className={`pane-group ${isRootLeaf ? 'pane-group--root' : ''} ${layout?.activeGroupId === group.id ? 'pane-group--focused' : ''} ${
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
            onSplit={(direction) => {
              if (activeTab && activeSurface) {
                splitRegion(workspaceId, activeTab.id, activeSurface.regionId, direction)
              }
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
        {activeTab ? (
          <WorkbenchRegionNode
            node={activeTab.layout.root}
            nodePath=""
            tab={activeTab}
            groupId={group.id}
            nativeSurfacesVisible={nativeSurfacesVisible}
            interactiveResize={interactiveResize}
          />
        ) : (
          <NewTabSurface tabGroupId={group.id} />
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
  splitTarget,
  nativeSurfacesVisible,
  interactiveResize = false,
  isRootLeaf = false
}: {
  node: TabGroupLayoutNode
  nodePath: string
  workspaceId: string
  splitTarget: SplitTarget | null
  nativeSurfacesVisible: boolean
  interactiveResize?: boolean
  isRootLeaf?: boolean
}) {
  const layout = useAppStore((state) => state.layouts[workspaceId])
  if (node.type === 'leaf') {
    const group = layout?.groups.find((candidate) => candidate.id === node.groupId)
    return group ? (
      <PaneGroup
        group={group}
        workspaceId={workspaceId}
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
  splitTarget,
  nativeSurfacesVisible,
  interactiveResize
}: {
  node: Extract<TabGroupLayoutNode, { type: 'split' }>
  nodePath: string
  workspaceId: string
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
          splitTarget={splitTarget}
          nativeSurfacesVisible={nativeSurfacesVisible && !dragging}
          interactiveResize={terminalResizeSuspended}
        />
      </Panel>
    </PanelGroup>
  )
}

function dragPoint(event: DragMoveEvent): { x: number; y: number } | null {
  // 与 Orca 的 pointer lane 一样，Drop Zone 必须跟真实指针而不是 DragOverlay
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
  interactiveResize = false
}: {
  workspaceId: string
  interactiveResize?: boolean
}) {
  const layout = useAppStore((state) => state.layouts[workspaceId])
  const tabs = useAppStore((state) => state.tabs)
  const moveTab = useAppStore((state) => state.moveTab)
  const moveTabToNewGroup = useAppStore((state) => state.moveTabToNewGroup)
  const tabMenuOpen = useAppStore((state) => state.tabMenuOpen)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [activeDrag, setActiveDrag] = useState<DragTabData | null>(null)
  const [splitTarget, setSplitTarget] = useState<SplitTarget | null>(null)
  const activeTab = activeDrag ? tabs[activeDrag.tabId] : null

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
          splitTarget={splitTarget}
          nativeSurfacesVisible={activeDrag === null && !tabMenuOpen}
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
