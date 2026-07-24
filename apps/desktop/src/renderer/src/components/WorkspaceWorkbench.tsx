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
  Bot,
  FileCode2,
  Globe2,
  GripVertical,
  MessagesSquare,
  Plus,
  Sparkles,
  SquareTerminal,
  X
} from 'lucide-react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { BrowserPane } from './BrowserPane'
import { ConfirmationDialog } from './ConfirmationDialog'
import { NewTabSurface } from './NewTabSurface'
import { SessionPane } from './SessionPane'
import { StatusDot } from './StatusDot'
import { resolvePaneColumnEdgeZone } from '../lib/tab-drop-zone'
import type {
  SplitDirection,
  TabGroup,
  TabGroupLayoutNode
} from '../lib/workbench-layout'
import { documentKey, type WorkbenchTab } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

const EditorPane = lazy(async () => {
  const module = await import('./EditorPane')
  return { default: module.EditorPane }
})

type DragTabData = { kind: 'tab'; tabId: string; groupId: string }
type DropData = DragTabData | { kind: 'pane'; groupId: string }
type SplitTarget = { groupId: string; direction: SplitDirection }

function tabLabel(tab: WorkbenchTab): string {
  if (tab.kind === 'file') return tab.path.split('/').at(-1) ?? tab.path
  if (tab.kind === 'launcher') return 'New Tab'
  if (tab.kind === 'browser') {
    return tab.title && tab.title !== 'about:blank'
      ? tab.title
      : tab.url === 'about:blank' ? 'New Tab' : tab.url
  }
  return tab.sessionId
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
  const activateTab = useAppStore((state) => state.activateTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const session = tab.kind === 'agent' || tab.kind === 'terminal'
    ? sessions.find((item) => item.id === tab.sessionId)
    : null
  const dirty =
    tab.kind === 'file'
      ? Boolean(dirtyDocuments[documentKey(tab.workspaceId, tab.path)])
      : false
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    data: { kind: 'tab', tabId: tab.id, groupId: group.id } satisfies DragTabData
  })
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [closing, setClosing] = useState(false)

  async function requestClose(event: React.MouseEvent): Promise<void> {
    event.stopPropagation()
    if (dirty) {
      setConfirmingClose(true)
      return
    }
    await closeTab(workspaceId, group.id, tab.id)
  }

  async function confirmClose(): Promise<void> {
    if (closing) return
    setClosing(true)
    await closeTab(workspaceId, group.id, tab.id)
    setClosing(false)
    setConfirmingClose(false)
  }

  return (
    <>
      <button
        ref={setNodeRef}
        type="button"
        className={`workbench-tab ${group.activeTabId === tab.id ? 'workbench-tab--active' : ''} ${
          isDragging ? 'workbench-tab--dragging' : ''
        }`}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onClick={() => activateTab(workspaceId, group.id, tab.id)}
        {...attributes}
        {...listeners}
      >
        {tab.kind === 'agent' || tab.kind === 'terminal' ? (
          session ? <StatusDot status={session.status} /> : tab.kind === 'terminal' ? <SquareTerminal size={12} /> : <Bot size={12} />
        ) : tab.kind === 'file' ? (
          <FileCode2 size={12} />
        ) : tab.kind === 'browser' ? (
          <Globe2 size={12} />
        ) : (
          <Sparkles size={12} />
        )}
        <span>{session?.label ?? tabLabel(tab)}</span>
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
      <ConfirmationDialog
        open={confirmingClose}
        title="Discard unsaved changes?"
        description="Closing this editor tab will discard changes that have not been saved."
        subject={session?.label ?? tabLabel(tab)}
        confirmLabel="Discard & Close"
        busy={closing}
        onCancel={() => !closing && setConfirmingClose(false)}
        onConfirm={() => void confirmClose()}
      />
    </>
  )
}

function PaneContent({
  tab,
  groupId,
  nativeSurfacesVisible
}: {
  tab: WorkbenchTab | null
  groupId: string
  nativeSurfacesVisible: boolean
}) {
  if (!tab) return <NewTabSurface paneId={groupId} />
  if (tab.kind === 'agent' || tab.kind === 'terminal') return <SessionPane sessionId={tab.sessionId} />
  if (tab.kind === 'file') {
    return (
      <Suspense fallback={<section className="pane-state"><strong>Loading editor…</strong></section>}>
        <EditorPane tabId={tab.id} />
      </Suspense>
    )
  }
  if (tab.kind === 'browser') return <BrowserPane tab={tab} visible={nativeSurfacesVisible} />
  return <NewTabSurface paneId={groupId} tabId={tab.id} />
}

function PaneGroup({
  group,
  workspaceId,
  splitTarget,
  nativeSurfacesVisible
}: {
  group: TabGroup
  workspaceId: string
  splitTarget: SplitTarget | null
  nativeSurfacesVisible: boolean
}) {
  const tabsById = useAppStore((state) => state.tabs)
  const sessions = useAppStore((state) => state.sessions)
  const layout = useAppStore((state) => state.layouts[workspaceId])
  const focusPane = useAppStore((state) => state.focusPane)
  const activateTab = useAppStore((state) => state.activateTab)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const setViewMode = useAppStore((state) => state.setViewMode)
  const viewModes = useAppStore((state) => state.viewModes)
  const { setNodeRef, isOver } = useDroppable({
    id: `pane:${group.id}`,
    data: { kind: 'pane', groupId: group.id } satisfies DropData
  })
  const tabs = group.tabOrder.flatMap((id) => (tabsById[id] ? [tabsById[id]] : []))
  const activeTab = tabs.find((tab) => tab.id === group.activeTabId) ?? null
  const activeSession =
    activeTab?.kind === 'agent'
      ? sessions.find((session) => session.id === activeTab.sessionId)
      : null
  const activeMode = activeSession ? (viewModes[activeSession.id] ?? 'terminal') : null

  return (
    <section
      ref={setNodeRef}
      className={`pane-group ${layout?.activeGroupId === group.id ? 'pane-group--focused' : ''} ${
        isOver ? 'pane-group--drop-over' : ''
      }`}
      data-pane-group-id={group.id}
      onPointerDown={() => focusPane(workspaceId, group.id)}
    >
      <header className="pane-tabbar">
        <SortableContext items={group.tabOrder} strategy={horizontalListSortingStrategy}>
          <div className="pane-tabbar__tabs">
            {tabs.map((tab) => (
              <SortableWorkbenchTab
                key={tab.id}
                tab={tab}
                group={group}
                workspaceId={workspaceId}
              />
            ))}
          </div>
        </SortableContext>
        <div className="pane-tabbar__actions">
          {activeSession ? (
            <div className="pane-view-toggle" aria-label="Agent view">
              <button
                type="button"
                className={activeMode === 'terminal' ? 'selected' : ''}
                title="Terminal"
                onClick={() => setViewMode(activeSession.id, 'terminal')}
              >
                <SquareTerminal size={12} />
              </button>
              <button
                type="button"
                className={activeMode === 'conversation' ? 'selected' : ''}
                title="Activity"
                onClick={() => setViewMode(activeSession.id, 'conversation')}
              >
                <MessagesSquare size={12} />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="pane-action"
            onClick={() => openLauncher(group.id)}
            title="New tab"
          >
            <Plus size={13} />
          </button>
        </div>
      </header>
      <div className="pane-body">
        <PaneContent tab={activeTab} groupId={group.id} nativeSurfacesVisible={nativeSurfacesVisible} />
      </div>
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
  nativeSurfacesVisible
}: {
  node: TabGroupLayoutNode
  nodePath: string
  workspaceId: string
  splitTarget: SplitTarget | null
  nativeSurfacesVisible: boolean
}) {
  const layout = useAppStore((state) => state.layouts[workspaceId])
  const updateSplitRatio = useAppStore((state) => state.updateSplitRatio)
  if (node.type === 'leaf') {
    const group = layout?.groups.find((candidate) => candidate.id === node.groupId)
    return group ? (
      <PaneGroup group={group} workspaceId={workspaceId} splitTarget={splitTarget} nativeSurfacesVisible={nativeSurfacesVisible} />
    ) : null
  }
  return (
    <PanelGroup
      direction={node.direction}
      className="pane-split"
      onLayout={(sizes) => {
        const firstSize = sizes[0]
        if (firstSize === undefined) return
        const ratio = firstSize / 100
        if (Math.abs(ratio - (node.ratio ?? 0.5)) > 0.005) {
          updateSplitRatio(workspaceId, nodePath, ratio)
        }
      }}
    >
      <Panel defaultSize={(node.ratio ?? 0.5) * 100} minSize={15}>
        <SplitNode
          node={node.first}
          nodePath={nodePath ? `${nodePath}.first` : 'first'}
          workspaceId={workspaceId}
          splitTarget={splitTarget}
          nativeSurfacesVisible={nativeSurfacesVisible}
        />
      </Panel>
      <PanelResizeHandle className="pane-resize-handle" />
      <Panel defaultSize={(1 - (node.ratio ?? 0.5)) * 100} minSize={15}>
        <SplitNode
          node={node.second}
          nodePath={nodePath ? `${nodePath}.second` : 'second'}
          workspaceId={workspaceId}
          splitTarget={splitTarget}
          nativeSurfacesVisible={nativeSurfacesVisible}
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

export function WorkspaceWorkbench({ workspaceId }: { workspaceId: string }) {
  const layout = useAppStore((state) => state.layouts[workspaceId])
  const tabs = useAppStore((state) => state.tabs)
  const moveTab = useAppStore((state) => state.moveTab)
  const splitTab = useAppStore((state) => state.splitTab)
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
      splitTab(workspaceId, drag.tabId, drag.groupId, target.groupId, target.direction)
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
      <div className="workspace-workbench">
        <SplitNode
          node={layout.root}
          nodePath=""
          workspaceId={workspaceId}
          splitTarget={splitTarget}
          nativeSurfacesVisible={activeDrag === null}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTab ? <DragPreview tab={activeTab} /> : null}
      </DragOverlay>
    </DndContext>
  )
}
