import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { WorkspaceCollaboration } from './WorkspaceCollaboration'
import { WorkspaceAgentRow } from './WorkspaceAgentRow'
import { createFocusContextIdentitySelector, focusContextIdentityKey } from '../lib/focus-context-identity'
import { createFocusGoalLinksSelector, focusGoalCardKey } from '../lib/focus-goal-links'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { useShallow } from 'zustand/react/shallow'
import { createWorkspaceAgentContextsSelector, FOCUS_BUCKETS, focusNeutralGroupSummary, type FocusBucket } from '../lib/focus-context'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { gitWorkspaceKey } from '../features/git/history/GitHistoryContext'
import type {
  SessionSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import {
  contentSlotPresentation,
  resolveWorkspaceTools,
  createWorkspaceAgentSessionsSelector,
  workspaceAgentSessions,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { orderedWorkspaceAgents, workspaceAgentOrderKey } from '../lib/workspace-agent-order'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { formatSessionAddress } from '../lib/agent-address'
import { useWorkspaceAgentClose } from './WorkspaceAgentSelection'
import { agentRegionExecution, useAppStore } from '../store'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { WorkspaceFilesTool } from './WorkspaceFilesTool'
import { WorkspaceGitTool } from './WorkspaceGitTool'
import { useWorkspaceZoneContext } from '../lib/workspace-zone-context'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { SemanticIcon } from './semantic-icons'

const ThemeObjectRepositoryIcon = semanticIconComponent('object.repository')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
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

export const WorkspaceAgentsTool = memo(function WorkspaceAgentsTool({
  workspace,
  sessions,
  onOpen
}: {
  workspace: WorkspaceRecord
  sessions: readonly SessionSnapshot[]
  onOpen(sessionId: string): void
}) {
  const topics = useAppStore(useShallow(state => scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)))
  const scoped = useMemo(() => workspaceAgentSessions(sessions, workspace, topics), [sessions, workspace, topics])
  const timelines = useAppStore(useShallow(state => Object.fromEntries(scoped.map(session => [session.id, state.timelines[session.id]]))))
  const names = useAppStore(useShallow(state => Object.fromEntries(scoped.map(session => [session.id, state.agentNames[session.id]]))))
  const manualOrder = useAppStore(state => Object.hasOwn(state.workspaceAgentOrder, workspace.id) ? state.workspaceAgentOrder[workspace.id]! : NO_AGENT_ORDER)
  const setOrder = useAppStore(state => state.setWorkspaceAgentOrder)
  const orderedSessions = useMemo(() => orderedWorkspaceAgents(scoped, manualOrder), [scoped, manualOrder])
  const contextSelector = useMemo(createWorkspaceAgentContextsSelector, [])
  const projected = useMemo(() => contextSelector(scoped, timelines, names, workspace, topics), [contextSelector, scoped, timelines, names, workspace, topics])
  const contexts = useMemo(() => {
    const byKey = new Map(projected.map(context => [focusContextIdentityKey(context.hostId, context.id), context]))
    return orderedSessions.flatMap(session => { const context = byKey.get(focusContextIdentityKey(session.hostId, session.id)); return context ? [context] : [] })
  }, [projected, orderedSessions])
  const active = useWorkbenchPresentationActive()
  const goalSelector = useMemo(createFocusGoalLinksSelector, [])
  const goalLinks = useAppStore(state => goalSelector({ demands: state.demands, sessions: scoped }, active))
  const config = useAppStore(state => state.config), tabs = useAppStore(state => state.tabs), layouts = useAppStore(state => state.layouts)
  const catalog = useAppStore(workbenchSelectionCatalog), identitySelector = useMemo(createFocusContextIdentitySelector, [])
  const identityTabs = workbenchNavigationTabs(tabs)
  const identities = useMemo(() => identitySelector(catalog, identityTabs, contexts, config, layouts, agentRegionExecution),
    [identitySelector, catalog, identityTabs, contexts, config?.executors, config?.appearance.agentAvatars, config?.workspaces, layouts])
  const openFocus = useAppStore(state => state.setMainSurface)
  const count = contexts.length
  const [filter, setFilter] = useState<'all' | FocusBucket>('all')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const close = useWorkspaceAgentClose()
  useEffect(() => {
    if (!close.results.length) return
    const completed = new Set(close.results.filter(result => result.completed).map(result => JSON.stringify([result.target.control.hostId, result.target.control.agentSessionId])))
    setSelected(previous => new Set([...previous].filter(key => !completed.has(key))))
  }, [close.results])
  const visible = contexts.filter(context => filter === 'all' || context.bucket === filter)
  const chosen = contexts.filter(context => selected.has(workspaceAgentOrderKey(context)))
  const unavailableSelected = selected.size - chosen.length
  const hiddenSelected = chosen.filter(context => filter !== 'all' && context.bucket !== filter).length
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const toggle = useCallback((key: string) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  }), [])
  useEffect(() => { setSelected(new Set()); setSelecting(false); setFilter('all'); setNotice('') }, [workspace.id])
  async function reorder(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return
    const keys = contexts.map(workspaceAgentOrderKey)
    const from = keys.indexOf(String(event.active.id)), to = keys.indexOf(String(event.over.id))
    if (from < 0 || to < 0) return
    setSaving(true)
    try {
      const result = await setOrder(workspace.id, arrayMove(keys, from, to))
      setNotice(result.issues.map(issue => issue.message).join(' · '))
    } catch (error) { setNotice(`Order save unconfirmed. ${error instanceof Error ? error.message : String(error)}`) }
    finally { setSaving(false) }
  }
  async function copySelected() {
    if (chosen.some(context => !context.control)) { setNotice('Original Agent identity is unobserved. Selection is kept; refresh the list before copying Agent links.'); return }
    const text = chosen.map(context => `${context.name}\n${formatSessionAddress(context.control!.agentSessionId)}`).join('\n\n')
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
            <strong title={workspace.name}>{workspace.name}</strong>
            <span title={`${count} Agents · ${manualOrder.length ? 'Manual order' : 'Startup order'} · Drag or use the move handle keyboard controls to reorder`} aria-label={`${count} Agents · ${manualOrder.length ? 'Manual order' : 'Startup order'}`}>{count}</span>
          </div>}
          <div className="workspace-agents-tool__actions" role="group" aria-label={selecting ? 'Selected Agent actions' : 'Agent list actions'}>
            {!selecting ? <WorkspaceCollaboration workspaceId={workspace.id} /> : null}
            {!selecting ? <button type="button" className="workspace-agents-tool__focus" aria-label="去 Focus 中查看" title="View in Focus" onClick={() => openFocus('agents')}><ThemeActionOpenExternalIcon size={15} aria-hidden="true" /></button> : null}
            {selecting ? <>
              <button type="button" aria-label="Select visible Agents" title="Select visible Agents" disabled={close.busy} onClick={() => setSelected(previous => new Set([...previous, ...visible.map(workspaceAgentOrderKey)]))}><SemanticIcon name="object.criteria" size={15} /></button>
              <button type="button" aria-label="Clear selection" title="Clear selection" disabled={close.busy} onClick={() => setSelected(new Set())}><SemanticIcon name="action.clear-list" size={15} /></button>
              <span className="workspace-agents-tool__action-divider" aria-hidden="true" />
              <button type="button" aria-label="Copy titles + Agent links" title="Copy titles + Agent links" disabled={!chosen.length || close.busy} onClick={() => { void copySelected() }}><SemanticIcon name="action.copy" size={15} /></button>
              <button type="button" className="workspace-agents-tool__close" aria-label="Close Agents" title="Close Agents · Review current Runs before stopping" disabled={!chosen.length || close.busy} onClick={() => close.requestClose(chosen)}><SemanticIcon name="action.stop" size={15} /></button>
            </> : null}
            <button type="button" aria-label={selecting ? 'Done selecting' : 'Select Agents'} title={selecting ? 'Done selecting' : 'Select Agents'} aria-pressed={selecting} disabled={close.busy} onClick={() => { setSelecting(value => !value); setSelected(new Set()) }}><SemanticIcon name={selecting ? 'action.close' : 'object.criteria'} size={15} /></button>
          </div>
        </header>
        <div className="workspace-agents-tool__filters" role="group" aria-label="Filter Agents by state">
          <button type="button" data-agent-filter="all" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <b>{count}</b></button>
          {FOCUS_BUCKETS.map(bucket => <button key={bucket} type="button" data-agent-filter={bucket} aria-pressed={filter === bucket} onClick={() => setFilter(bucket)}>
            <SemanticIcon name={bucket === 'attention' ? 'status.needs-input' : bucket === 'working' ? 'status.working' : bucket === 'results' ? 'status.completed' : 'status.idle'} size={12} />
            {bucket === 'idle' ? focusNeutralGroupSummary(contexts.filter(context => context.bucket === bucket)).label : AGENT_GROUP_LABELS[bucket]}
            <b>{contexts.filter(context => context.bucket === bucket).length}</b>
          </button>)}
        </div>
        {notice ? <p className="workspace-agents-tool__notice" role="status">{notice}</p> : null}
      </div>
      <div className="workspace-agents-tool__scroll">
        {count === 0 ? (
          <div className="workspace-agents-tool__empty">
            <ThemeObjectAgentIcon size={18} />
            <strong>No Agents in this workspace</strong>
            <span>Use + to start an Agent. Choose “Keep Session” on close to leave it running here.</span>
          </div>
        ) : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => { void reorder(event) }}>
          <SortableContext items={visible.map(workspaceAgentOrderKey)} strategy={verticalListSortingStrategy}>
            <div className="workspace-agent-list" aria-label="Space Agents">
              {visible.map(context => <WorkspaceAgentRow key={workspaceAgentOrderKey(context)} context={context} onOpen={onOpen}
                selected={selected.has(workspaceAgentOrderKey(context))} selecting={selecting} disabled={saving || close.busy} onToggle={toggle}
                goalLinks={goalLinks.get(focusGoalCardKey(context.hostId, context.id))} identity={identities.get(focusContextIdentityKey(context.hostId, context.id))} />)}
            </div>
          </SortableContext>
        </DndContext>}
        {count > 0 && visible.length === 0 ? <p className="workspace-agents-tool__empty">No Agents in this state.</p> : null}
        {close.results.length ? <section className="workspace-agents-tool__results" aria-label="Agent close results" role="status">
          <header><strong>Close results</strong><button type="button" onClick={close.clearResults}>Dismiss</button></header>
          {close.results.map(result => <p key={JSON.stringify([result.target.control.hostId, result.target.control.agentSessionId])} data-completed={result.completed}><strong>{result.target.name}</strong>
            <small>{result.target.control.hostId} · {result.target.control.agentSessionId} · Run {result.target.control.run.runId}</small><span>{result.message}</span></p>)}
        </section> : null}
      </div>
      {close.dialog}
    </section>
  )
})

function ConnectedWorkspaceAgentsTool({ workspace, onOpen }: {
  workspace: WorkspaceRecord
  onOpen(sessionId: string): void
}) {
  const selectMembers = useMemo(createWorkspaceAgentSessionsSelector, [])
  const sessions = useAppStore(state => selectMembers(state.sessions, workspace, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots)))
  return <WorkspaceAgentsTool workspace={workspace} sessions={sessions} onOpen={onOpen} />
}

function WorkspaceGitSlot({ workspace, visible }: { workspace: WorkspaceRecord; visible: boolean }) {
  const context = useWorkspaceZoneContext(workspace)
  const [retained, setRetained] = useState<WorkspaceRecord[]>([])
  const resource = context.resource
  useEffect(() => {
    if (visible && resource) setRetained(previous => previous.some(value => gitWorkspaceKey(value) === gitWorkspaceKey(resource)) ? previous : [...previous, resource])
  }, [resource, visible])
  const resources = visible && resource ? [...retained.filter(value => gitWorkspaceKey(value) !== gitWorkspaceKey(resource)), resource] : retained
  return <>
    {resources.map(value => {
      const active = Boolean(resource && gitWorkspaceKey(value) === gitWorkspaceKey(resource))
      return <div className="workspace-tool-slot" hidden={!active} key={gitWorkspaceKey(value)}>
        <WorkspaceGitTool workspace={value} visible={visible && active} />
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
  return (
    <aside className="surface-tool-panel" aria-label="Space tools">
      <header className={`surface-tool-activitybar surface-tool-activitybar--space ${projectRailOpen ? '' : 'surface-tool-activitybar--compact-chrome'}`}>
        {!projectRailOpen ? <SidebarToggleChrome /> : null}
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
          <ConnectedWorkspaceAgentsTool
            key={workspace.id}
            workspace={workspace}
            onOpen={(sessionId) => selectSession(sessionId, activePaneId)}
          />
        ) : null}
      </div>
    </aside>
  )
}
