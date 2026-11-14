import { useMoteSpace } from './MoteSpaceFrame'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { WorkspaceCollaboration } from './WorkspaceCollaboration'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { WorkspaceAgentGroup, WorkspaceAgentRow } from './WorkspaceAgentRow'
import { createFocusContextIdentitySelector, focusContextIdentityKey } from '../lib/focus-context-identity'
import { createFocusGoalLinksSelector, focusGoalCardKey } from '../lib/focus-goal-links'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { useShallow } from 'zustand/react/shallow'
import { createWorkspaceAgentContextsSelector, retainedFocusContext, FOCUS_BUCKETS, focusNeutralGroupSummary, type FocusBucket } from '../lib/focus-context'
import { useFocusHistorySources, type FocusHistoryCatalogue } from '../lib/focus-history-sources'
import { retainedWorkspaceAgentEntry, workspaceAgentGroups, workspaceAgentRetiredSources } from '../lib/workspace-agent-arrangement'
import { useWorkspaceAgentLinks } from '../lib/workspace-agent-relations'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { gitWorkspaceKey } from '../features/git/history/GitHistoryContext'
import type {
  SessionSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import {
  contentSlotPresentation,
  resolveWorkspaceTools,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { mergeWorkspaceAgentSubsetOrder, workspaceAgentOrderKey } from '../lib/workspace-agent-order'
import { createWorkspaceAgentListSelector, workspaceAgentListMembers } from '../lib/workspace-agent-scope'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { formatSessionAddress } from '../lib/agent-address'
import { useWorkspaceAgentClose } from './WorkspaceAgentSelection'
import { agentRegionExecution, agentRegionLocationsKnown, useAppStore } from '../store'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { WorkspaceFilesTool } from './WorkspaceFilesTool'
import { WorkspaceGitTool } from './WorkspaceGitTool'
import { useWorkspaceZoneContext } from '../lib/workspace-zone-context'
import { folderInventoryWorkspace } from '../lib/zone-worktree-observation'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { SemanticIcon } from './semantic-icons'

const ThemeObjectRepositoryIcon = semanticIconComponent('object.repository')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeNavigationFocusIcon = semanticIconComponent('navigation.focus')
const ThemeObjectTopicIcon = semanticIconComponent('object.topic')
const ThemeActionCreateAgentIcon = semanticIconComponent('action.create-agent')
const ThemeObjectBranchIcon = semanticIconComponent('object.branch')


type ToolDefinition<T extends string> = {
  id: T
  label: string
  description: string
  icon: typeof ThemeObjectRepositoryIcon
}

const WORKSPACE_TOOL_META: Record<WorkspaceTool, Omit<ToolDefinition<WorkspaceTool>, 'id'>> = {
  'files-branches': { label: 'Files + Zones', description: 'Browse files and continue a Zone workface', icon: ThemeObjectRepositoryIcon },
  agents: { label: 'Agents', description: 'Find Agents that remain available after their Tab closes', icon: ThemeObjectAgentIcon },
  git: { label: 'Git', description: 'Review changes, branches and repository history', icon: ThemeObjectBranchIcon }
}

const AGENT_GROUP_LABELS: Record<FocusBucket, string> = { attention: 'Needs You', working: 'Working', results: 'Results', idle: 'Idle / Unknown' }
const NO_AGENT_ORDER: readonly string[] = []

// Row callbacks outlive a list render; retain only its selection updater.
function createWorkspaceSelectionToggle(setSelected: Dispatch<SetStateAction<ReadonlySet<string>>>) {
  return (key: string) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
}

export const WorkspaceAgentsTool = memo(function WorkspaceAgentsTool(props: Parameters<typeof WorkspaceAgentsContent>[0]) {
  return <WorkspaceAgentsContent {...props} />
})
const WorkspaceAgentsContent = memo(function WorkspaceAgentsContent({
  workspace,
  sessions,
  onOpen
}: {
  workspace: WorkspaceRecord
  sessions?: readonly SessionSnapshot[]
  onOpen(sessionId: string): void
}) {
  const project = useMemo(() => createWorkspaceAgentListSelector(agentRegionExecution), [])
  const active = useWorkbenchPresentationActive()
  const history = useFocusHistorySources(active)
  const sources = useMemo(() => new Map(history.sources.map(source => [JSON.stringify([source.hostId, source.agentSessionId]), source])), [history.sources])
  const select = useCallback((state: ReturnType<typeof useAppStore.getState>) => project(state, workspace, sessions, sources), [project, workspace, sessions, sources])
  const list = useAppStore(select)
  return <WorkspaceAgentListView key={list.key} workspace={workspace} list={list} history={history} onOpen={onOpen} />
})

type WorkspaceAgentList = ReturnType<ReturnType<typeof createWorkspaceAgentListSelector>>
const WorkspaceAgentListView = memo(function WorkspaceAgentListView({ workspace, list, history, onOpen }: {
  workspace: WorkspaceRecord
  list: WorkspaceAgentList
  history: FocusHistoryCatalogue
  onOpen(sessionId: string): void
}) {
  const topics = useAppStore(useShallow(state => scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)))
  const scoped = list.sessions
  const closedSources = useMemo(() => {
    const members = new Set(list.members.map(member => JSON.stringify([member.subject.hostId, member.subject.agentSessionId])))
    return new Map([...workspaceAgentRetiredSources(scoped, history.sources)].filter(([key]) => members.has(key)))
  }, [scoped, history.sources, list.members])
  const entries = useMemo(() => [...scoped.filter(session => !closedSources.has(workspaceAgentOrderKey(session))), ...[...closedSources.values()].map(retainedWorkspaceAgentEntry)], [scoped, closedSources])
  const timelines = useAppStore(useShallow(state => Object.fromEntries(scoped.map(session => [session.id, state.timelines[session.id]]))))
  const names = useAppStore(useShallow(state => Object.fromEntries(entries.map(session => [session.id, state.agentNames[session.id]]))))
  const manualOrder = useAppStore(state => Object.hasOwn(state.workspaceAgentOrder, workspace.id) ? state.workspaceAgentOrder[workspace.id]! : NO_AGENT_ORDER)
  const setOrder = useAppStore(state => state.setWorkspaceAgentOrder)
  const active = useWorkbenchPresentationActive()
  const relations = useWorkspaceAgentLinks(entries, active)
  const groups = useMemo(() => workspaceAgentGroups(entries, manualOrder, relations.links), [entries, manualOrder, relations.links])
  const contextSelector = useMemo(createWorkspaceAgentContextsSelector, [])
  const projected = useMemo(() => contextSelector(scoped, timelines, names, workspace, topics), [contextSelector, scoped, timelines, names, workspace, topics])
  const contexts = useMemo(() => {
    const byKey = new Map(projected.map(context => [focusContextIdentityKey(context.hostId, context.id), context]))
    return groups.flatMap(group => group.members.flatMap(({ session }) => {
      const source = closedSources.get(workspaceAgentOrderKey(session))
      const context = source ? retainedFocusContext(source, names[source.agentSessionId]) : byKey.get(focusContextIdentityKey(session.hostId, session.id))
      return context ? [context] : []
    }))
  }, [projected, groups, closedSources, names])
  const goalSelector = useMemo(createFocusGoalLinksSelector, [])
  const goalLinks = useAppStore(state => goalSelector({ demands: state.demands, sessions: scoped }, active))
  const config = useAppStore(state => state.config), tabs = useAppStore(state => state.tabs), layouts = useAppStore(state => state.layouts)
  const catalog = useAppStore(workbenchSelectionCatalog), identitySelector = useMemo(createFocusContextIdentitySelector, [])
  const locationsKnown = useAppStore(agentRegionLocationsKnown)
  const identityTabs = workbenchNavigationTabs(tabs)
  const identities = useMemo(() => identitySelector(catalog, identityTabs, contexts, config, layouts, agentRegionExecution, locationsKnown),
    [identitySelector, catalog, identityTabs, contexts, config?.executors, config?.appearance.agentAvatars, config?.workspaces, layouts, locationsKnown])
  const openFocus = useAppStore(state => state.setMainSurface)
  const count = contexts.length - closedSources.size
  const [filter, setFilter] = useState<'all' | FocusBucket>('all')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [resuming, setResuming] = useState<ReadonlySet<string>>(() => new Set())
  const resumeIntents = useRef(new Map<string, { operationId: string; attempted: boolean }>())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const close = useWorkspaceAgentClose()
  useEffect(() => {
    if (!close.results.length) return
    const completed = new Set(close.results.filter(result => result.completed).map(result => JSON.stringify([result.target.control.hostId, result.target.control.agentSessionId])))
    setSelected(previous => new Set([...previous].filter(key => !completed.has(key))))
  }, [close.results])
  const openContexts = contexts.filter(context => !closedSources.has(workspaceAgentOrderKey(context)))
  const visible = contexts.filter(context => closedSources.has(workspaceAgentOrderKey(context)) ? includeClosed : filter === 'all' || context.bucket === filter)
  const visibleKeys = new Set(visible.map(workspaceAgentOrderKey))
  const visibleGroups = groups.filter(group => group.members.some(({ session }) => visibleKeys.has(workspaceAgentOrderKey(session))))
  const contextByKey = new Map(contexts.map(context => [workspaceAgentOrderKey(context), context]))
  const chosen = contexts.filter(context => selected.has(workspaceAgentOrderKey(context)))
  const unavailableSelected = selected.size - chosen.length
  const hiddenSelected = chosen.filter(context => !visibleKeys.has(workspaceAgentOrderKey(context))).length
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const toggle = useMemo(() => createWorkspaceSelectionToggle(setSelected), [setSelected])
  useEffect(() => { setSelected(new Set()); setSelecting(false); setFilter('all'); setNotice('') }, [workspace.id])
  async function reorder(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return
    const keys = groups.map(group => group.key)
    const from = keys.indexOf(String(event.active.id)), to = keys.indexOf(String(event.over.id))
    if (from < 0 || to < 0) return
    setSaving(true)
    try {
      const state = useAppStore.getState()
      const members = workspaceAgentListMembers(state, workspace, agentRegionExecution)
      const order = state.workspaceAgentOrder[workspace.id] ?? NO_AGENT_ORDER
      const subset = groups.flatMap(group => group.members.map(({ session }) => workspaceAgentOrderKey(session)))
      const reordered = arrayMove(groups, from, to).flatMap(group => group.members.map(({ session }) => workspaceAgentOrderKey(session)))
      const result = await setOrder(workspace.id, mergeWorkspaceAgentSubsetOrder([...members, ...entries], order, subset, reordered))
      setNotice(result.issues.map(issue => issue.message).join(' · '))
    } catch (error) { setNotice(`Order save unconfirmed. ${error instanceof Error ? error.message : String(error)}`) }
    finally { setSaving(false) }
  }
  async function resume(key: string) {
    const source = closedSources.get(key)
    if (!source || resuming.has(key)) return
    if (source.retiredAt === undefined || source.pendingReopen && !source.pendingReopen.operationId) {
      setNotice('The original retirement or pending restore correlation is unconfirmed. Refresh this same Session; no new restore was sent.')
      history.refresh(); return
    }
    const intent = resumeIntents.current.get(key) ?? { operationId: source.pendingReopen?.operationId ?? crypto.randomUUID(), attempted: Boolean(source.pendingReopen) }
    resumeIntents.current.set(key, intent)
    setResuming(previous => new Set([...previous, key]))
    const original = useAppStore.getState()
    const reveal = () => {
      const current = useAppStore.getState()
      return mounted.current && current.mainSurface === original.mainSurface && current.workspaceTool === original.workspaceTool &&
        current.activeWorkspaceId === original.activeWorkspaceId && current.workbenchSpaceSelection === original.workbenchSpaceSelection
    }
    try {
      const observeOnly = intent.attempted
      intent.attempted = true
      await useAppStore.getState().reopenRetiredSession(source, intent.operationId, observeOnly, reveal)
      resumeIntents.current.delete(key); history.refresh()
    } catch (error) {
      if (error instanceof Error && 'controlFailure' in error && (error.controlFailure as { disposition?: unknown } | undefined)?.disposition === 'not_applied') {
        resumeIntents.current.delete(key); history.refresh()
      }
      setNotice(`Original restore ${intent.operationId} is unconfirmed. ${error instanceof Error ? error.message : String(error)} Check this same restore; the Session and history are kept.`)
    } finally { setResuming(previous => { const next = new Set(previous); next.delete(key); return next }) }
  }
  async function copySelected() {
    if (chosen.some(context => !context.control && !closedSources.has(workspaceAgentOrderKey(context)))) { setNotice('Original Agent identity is unobserved. Selection is kept; refresh the list before copying Agent links.'); return }
    const text = chosen.map(context => `${context.name}\n${formatSessionAddress(context.control?.agentSessionId ?? context.id)}`).join('\n\n')
    const copied = await copyTextToClipboard(text, error => setNotice(`Copy failed. ${error instanceof Error ? error.message : String(error)}`))
    if (copied) setNotice(`Copied ${chosen.length} titles + Agent links.`)
  }

  return (
    <section className="workspace-agents-tool">
      <div className="workspace-agents-tool__top">
        <header className="workspace-agents-tool__header" data-selecting={selecting}>
          {selecting ? <span className="workspace-agents-tool__selection" role="status">
            <strong>{chosen.length} selected</strong>
            {hiddenSelected || unavailableSelected ? <small>{hiddenSelected ? `${hiddenSelected} hidden by filter` : ''}{hiddenSelected && unavailableSelected ? ' · ' : ''}{unavailableSelected ? `${unavailableSelected} original selection unavailable` : ''}</small> : null}
          </span> : <div className="workspace-agents-tool__identity">
            <strong title={list.title}>{list.title}</strong>
            <span title={`${count} Agents · ${manualOrder.length ? 'Manual order' : 'Startup order'} · Drag or use the move handle keyboard controls to reorder`} aria-label={`${count} Agents · ${manualOrder.length ? 'Manual order' : 'Startup order'}`}>{count}</span>
          </div>}
          <div className="workspace-agents-tool__actions" role="group" aria-label={selecting ? 'Selected Agent actions' : 'Agent list actions'}>
            {!selecting ? <WorkspaceCollaboration /> : null}
            {!selecting ? <button type="button" className="workspace-agents-tool__focus" aria-label="View in Focus" title="View in Focus" onClick={() => openFocus('agents')}><ThemeNavigationFocusIcon size={15} aria-hidden="true" /></button> : null}
            {selecting ? <>
              <button type="button" aria-label="Select visible Agents" title="Select visible Agents" onClick={() => setSelected(previous => new Set([...previous, ...visible.map(workspaceAgentOrderKey)]))}><SemanticIcon name="object.criteria" size={15} /></button>
              <button type="button" aria-label="Clear selection" title="Clear selection" onClick={() => setSelected(new Set())}><SemanticIcon name="action.clear-list" size={15} /></button>
              <span className="workspace-agents-tool__action-divider" aria-hidden="true" />
              <button type="button" aria-label="Copy titles + Agent links" title="Copy titles + Agent links" disabled={!chosen.length} onClick={() => { void copySelected() }}><SemanticIcon name="action.copy" size={15} /></button>
              <button type="button" className="workspace-agents-tool__close" aria-label="Close Agents" title="Close selected open Agents · Review current Runs before stopping" disabled={!chosen.some(context => !closedSources.has(workspaceAgentOrderKey(context)))} onClick={() => close.requestClose(chosen.filter(context => !closedSources.has(workspaceAgentOrderKey(context))))}><SemanticIcon name="action.stop" size={15} /></button>
            </> : null}
            <button type="button" aria-label={selecting ? 'Done selecting' : 'Select Agents'} title={selecting ? 'Done selecting' : 'Select Agents'} aria-pressed={selecting} onClick={() => { setSelecting(value => !value); setSelected(new Set()) }}><SemanticIcon name={selecting ? 'action.close' : 'object.criteria'} size={15} /></button>
          </div>
        </header>
        <div className="workspace-agents-tool__filters" role="group" aria-label="Filter Agents by state">
          <button type="button" data-agent-filter="all" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <b>{count}</b></button>
          {FOCUS_BUCKETS.map(bucket => <button key={bucket} type="button" data-agent-filter={bucket} aria-pressed={filter === bucket} onClick={() => setFilter(bucket)}>
            <SemanticIcon name={bucket === 'attention' ? 'status.needs-input' : bucket === 'working' ? 'status.working' : bucket === 'results' ? 'status.completed' : 'status.idle'} size={12} />
            {bucket === 'idle' ? focusNeutralGroupSummary(openContexts.filter(context => context.bucket === bucket)).label : AGENT_GROUP_LABELS[bucket]}
            <b>{openContexts.filter(context => context.bucket === bucket).length}</b>
          </button>)}
          <label className="workspace-agents-tool__closed"><input type="checkbox" checked={includeClosed} onChange={event => setIncludeClosed(event.target.checked)} />+ Closed <b>{closedSources.size}</b></label>
        </div>
        {list.issue || notice || history.error || relations.issue ? <p className="workspace-agents-tool__notice" role="status">{[list.issue, notice, history.error, relations.issue].filter(Boolean).join(' · ')} <button type="button" onClick={() => { history.refresh(); relations.refresh() }}>Refresh</button></p> : null}
      </div>
      <div className="workspace-agents-tool__scroll">
        {contexts.length === 0 ? (
          <div className="workspace-agents-tool__empty">
            <ThemeObjectAgentIcon size={18} />
            <strong>No Agents here</strong>
            <span>Use + to start an Agent. Choose “Keep Session” on close to leave it running here.</span>
          </div>
        ) : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => { void reorder(event) }}>
          <SortableContext items={visibleGroups.map(group => group.key)} strategy={verticalListSortingStrategy}>
            <div className="workspace-agent-list" aria-label="Space Agents">
              {visibleGroups.map(group => <WorkspaceAgentGroup key={group.key} groupKey={group.key} disabled={saving}>{move => group.members.filter(({ session }) => visibleKeys.has(workspaceAgentOrderKey(session))).map(({ session, depth }, index) => {
                const key = workspaceAgentOrderKey(session), context = contextByKey.get(key)!, closed = closedSources.has(key)
                return <WorkspaceAgentRow key={key} context={context} depth={depth} move={index === 0 ? move : undefined}
                  onOpen={closed ? () => { void resume(key) } : onOpen} onResume={closed ? () => { void resume(key) } : undefined} resuming={resuming.has(key)}
                  selected={selected.has(key)} selecting={selecting} disabled={saving} onToggle={toggle}
                  goalLinks={goalLinks.get(focusGoalCardKey(context.hostId, context.id))} identity={identities.get(focusContextIdentityKey(context.hostId, context.id))} />
              })}</WorkspaceAgentGroup>)}
            </div>
          </SortableContext>
        </DndContext>}
        {contexts.length > 0 && visible.length === 0 ? <p className="workspace-agents-tool__empty">No Agents in this state.{closedSources.size && !includeClosed ? ' Select + Closed to restore a saved Session.' : ''}</p> : null}
        {close.results.length ? <section className="workspace-agents-tool__results" aria-label="Agent close results" role="status">
          <header><strong>Close results</strong><button type="button" onClick={close.clearResults}>Dismiss</button></header>
          {close.results.map(result => <p key={JSON.stringify([result.target.control.hostId, result.target.control.agentSessionId, result.target.control.run.runId, result.target.operationId])} data-completed={result.completed}><strong>{result.target.name}</strong>
            <small>{result.target.control.hostId} · {result.target.control.agentSessionId} · Run {result.target.control.run.runId}</small><span>{result.message}</span></p>)}
        </section> : null}
      </div>
      {close.dialog}
    </section>
  )
})

function WorkspaceGitSlot({ workspace, visible }: { workspace: WorkspaceRecord; visible: boolean }) {
  const context = useWorkspaceZoneContext(workspace)
  const workspaces = useAppStore(state => state.config?.workspaces)
  const inventoryWorkspace = useMemo(() => folderInventoryWorkspace(context.spaceId, workspaces), [context.spaceId, workspaces])
  const view = useAppStore(state => state.workspaceGitView)
  const [retained, setRetained] = useState<WorkspaceRecord[]>([])
  // Branches manages the Folder repository inventory. Changes/History keep the selected exact resource.
  const resource = view === 'branches' ? inventoryWorkspace ?? context.resource ?? workspace : context.resource
  useEffect(() => {
    if (visible && resource) setRetained(previous => previous.some(value => gitWorkspaceKey(value) === gitWorkspaceKey(resource)) ? previous : [...previous, resource])
  }, [resource, visible])
  const resources = visible && resource ? [...retained.filter(value => gitWorkspaceKey(value) !== gitWorkspaceKey(resource)), resource] : retained
  return <>
    {resources.map(value => {
      const active = Boolean(resource && gitWorkspaceKey(value) === gitWorkspaceKey(resource))
      return <div className="workspace-tool-slot" hidden={!active} key={gitWorkspaceKey(value)}>
        <WorkspaceGitTool workspace={value} inventoryWorkspace={inventoryWorkspace} visible={visible && active} />
      </div>
    })}
    {!resource ? <div className="surface-inline-error" role="status">{context.issue}</div> : null}
  </>
}

export function SurfaceToolDock({
  workspace,
  visible = true
}: {
  workspace: WorkspaceRecord | undefined
  visible?: boolean
}) {
  const moteSpace = useMoteSpace()
  const presentation = useSpaceContentPresentation()
  const workspaceTool = useAppStore((state) => state.workspaceTool)
  const preferredProjects = useAppStore((state) => state.projectRailOpen)
  const projectRailOpen = useContext(WindowSidebarLayoutContext)?.projectRailOpen ?? preferredProjects
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const layout = useAppStore((state) => workspace ? state.layouts[workspace.id] : undefined)
  const openLauncher = useAppStore((state) => state.openLauncher)
  const selectSession = useAppStore((state) => state.selectSession)
  const fileEditingProbe = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-file-editing-report') === '1'
  // Scratch is a wiki-first workspace: the content slot keeps its `files-branches` role but is
  // re-skinned as `Files + Topics` (see contentSlotPresentation), so the tool set never diverges
  // and the global workspaceTool is never mutated.
  const isScratch = Boolean(workspace && isScratchWorkspaceId(workspace.id))
  const moteScope = useMoteWorkfaceScope(workspace?.id, undefined, visible)
  const [lastFolder, setLastFolder] = useState<WorkspaceRecord | null>(workspace && !isScratch && !moteScope ? workspace : null)
  useEffect(() => { if (workspace && !isScratch && !moteScope) setLastFolder(workspace) }, [workspace, isScratch, moteScope])
  const gitWorkspace = workspace && !isScratch && !moteScope ? workspace : lastFolder
  const { tools: workspaceToolIds, effective: effectiveWorkspaceTool } = resolveWorkspaceTools({
    workspaceTool,
    isScratch,
    moteScope
  })
  const contentSlot = contentSlotPresentation(isScratch, moteScope)
  const tools: ToolDefinition<WorkspaceTool>[] = workspaceToolIds.map((id) => {
        const meta = WORKSPACE_TOOL_META[id]
        // Re-skin the content slot for Scratch without changing its enum id.
        if (id === 'files-branches' && (isScratch || moteScope)) {
          return { id, ...meta, label: contentSlot.label,
            description: moteScope ? 'Browse this Mote’s profile, ideas and materials' : 'Browse the topic wiki and collaborators', icon: ThemeObjectTopicIcon }
        }
        return { id, ...meta }
      })
  const selectedTool = fileEditingProbe ? 'files-branches' : effectiveWorkspaceTool
  const activePaneId = layout?.activeGroupId
  const showTools = !(moteScope && presentation?.expanded)
  return (
    <aside className="surface-tool-panel" data-tools-header={showTools} aria-label="Space tools">
      <header hidden={!showTools} className={`surface-tool-activitybar surface-tool-activitybar--space ${projectRailOpen ? '' : 'surface-tool-activitybar--compact-chrome'}`}>
        {!projectRailOpen && !moteSpace ? <SidebarToggleChrome /> : null}
        <nav aria-label="Space tool selection">
          <LiquidSelectionSurface selected={selectedTool} active={visible} targetAttribute="data-space-tool" />
          {tools.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.id}
                type="button"
                className={selectedTool === tool.id ? 'selected' : ''}
                data-space-tool={tool.id}
                aria-label={tool.label}
                aria-pressed={selectedTool === tool.id}
                title={`${tool.label} — ${tool.description}`}
                onClick={() => {
                  setWorkspaceTool(tool.id)
                }}
              >
                <Icon size={15} />
              </button>
            )
          })}
        </nav>
        {selectedTool === 'agents' && workspace && layout ? (
          <button
            type="button"
            className="surface-tool-create icon-button"
            aria-label="New Agent"
            title="New Agent — choose an Executor"
            onClick={() => openLauncher({ workspaceId: workspace.id, ...(activePaneId ? { tabGroupId: activePaneId } : {}), reveal: true })}
          >
            <ThemeActionCreateAgentIcon size={15} />
          </button>
        ) : null}
      </header>
      <div className="surface-tool-content">
        {workspace ? (
          <div className="workspace-tool-slot" hidden={selectedTool !== 'files-branches'}>
            <WorkspaceFilesTool workspace={workspace} isScratch={isScratch} visible={visible && selectedTool === 'files-branches'} />
          </div>
        ) : null}
        {gitWorkspace ? (
          <div className="workspace-tool-slot" hidden={selectedTool !== 'git' || isScratch || Boolean(moteScope)}>
            <WorkspaceGitSlot workspace={gitWorkspace} visible={visible && selectedTool === 'git' && !isScratch && !moteScope} />
          </div>
        ) : null}
        {visible && effectiveWorkspaceTool === 'agents' && workspace ? (
          <WorkspaceAgentsTool
            key={workspace.id}
            workspace={workspace}
            onOpen={(sessionId) => selectSession(sessionId, activePaneId)}
          />
        ) : null}
      </div>
    </aside>
  )
}
