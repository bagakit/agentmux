import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { TopicNavigationPanel } from './TopicNavigationPanel'
import { TopicKnowledgeCapture } from './TopicKnowledgeEditor'
import { selectedKnowledgeSources } from '../lib/topic-knowledge-actions'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath, scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { directoryIdentity } from '../../../shared/space-addresses'
import { isKnowledgeTopicInBindings } from '../../../shared/topic-categories'
import { MoteDetailsPanel } from './MoteDetailsPanel'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { AgentContextContent } from './AgentContextContent'
import { useShallow } from 'zustand/react/shallow'
import { agentContextForSession, FOCUS_COLUMNS, groupFocusContexts, focusNeutralGroupSummary, type FocusColumn } from '../lib/focus-context'
import { useMoteWorkfaceScope } from '../lib/mote-workface'
import { useMoteMaterialsActions } from '../lib/mote-materials-actions'
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  NotebookText,
  Plus,
  RadioTower,
  RefreshCw
} from 'lucide-react'
import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  SessionSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import {
  contentSlotPresentation,
  resolveExplorerCollapsed,
  resolveWorkspaceTools,
  workspaceAgentSessions,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { CONTEXT_PRESSURE_HINT, contextPressure, contextUsedPercent } from '../lib/agent-usage'
import { useAppStore } from '../store'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useGitHistory } from '../hooks/useGitHistory'
import { BranchesPanel } from './BranchesPanel'
import { ChangesPanel } from './ChangesPanel'
import { GitHistoryPanel } from './GitHistoryPanel'
import { LiquidSelectionSurface } from './settings/LiquidSelectionSurface'
import { FileExplorer, type FileExplorerRevealRequest } from './FileExplorer'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

type ToolDefinition<T extends string> = {
  id: T
  label: string
  description: string
  icon: typeof FolderGit2
}

const WORKSPACE_TOOL_META: Record<WorkspaceTool, Omit<ToolDefinition<WorkspaceTool>, 'id'>> = {
  'files-branches': { label: 'Files + Branches', description: 'Browse the selected worktree', icon: FolderGit2 },
  agents: { label: 'Agents', description: 'Find Agents that remain available after their Tab closes', icon: Bot }
}

export function WorkspaceFilesTool({
  workspace,
  isScratch,
  visible,
  topicId,
  onOpenPath,
  onOpenTerminal,
  reference
}: {
  workspace: WorkspaceRecord
  isScratch: boolean
  visible: boolean
  topicId?: string | undefined
  reference?: WorkbenchProjectionSelection | null | undefined
  onOpenPath?: ((path: string) => Promise<unknown>) | undefined
  onOpenTerminal?: ((path: string) => Promise<unknown>) | undefined
}) {
  const mote = useMoteWorkfaceScope(workspace.id, topicId)
  const choice = useAppStore(state => state.workbenchSpaceSelection?.workspaceId === workspace.id ? state.workbenchSpaceSelection : null)
  const scratch = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID))
  const { topics: knownTopics } = useScratchTopics(scratch?.id ?? null)
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const selectedTopicId = topicId ?? choice?.topicId
  const knowledgeTopic = !mote && selectedTopicId ? knownTopics?.find(topic => topic.id === selectedTopicId && isKnowledgeTopicInBindings(topic, bindings)) : undefined
  const topicRoot = knowledgeTopic && scratch ? scratchTopicLogicalPath(scratch, knowledgeTopic) : null
  const canCollectKnowledge = !mote && (!selectedTopicId || Boolean(knowledgeTopic && topicRoot !== null))
  const categories = useAppStore(state => state.topicCategories)
  const category = !mote ? categories.find(category => category.spaceId === choice?.spaceId) : undefined
  // Retain the requested Category even while its description is unavailable.
  const categorySpaceId = !mote && choice?.spaceId && choice.spaceId !== directoryIdentity(workspace.hostId, workspace.path) ? choice.spaceId : undefined
  const [capture, setCapture] = useState<ReturnType<typeof selectedKnowledgeSources>>(null)
  const materials = useMoteMaterialsActions(mote)
  const [createFileRequest, setCreateFileRequest] = useState<{ requestId: number; parentPath: string }>()
  const presentation = contentSlotPresentation(isScratch)
  const displayPath = usePathDisplay()
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null)
  const explorerCollapsedOverride = useAppStore((state) => state.explorerCollapsed[workspace.id])
  const setExplorerCollapsed = useAppStore((state) => state.setExplorerCollapsed)
  // 解析一次、读写复用：折叠态既决定渲染哪一支（读），又是 toggle 写入的取反基准（写）。分开算两次
  // 就是本仓踩过的「读的 key 与写的 key 漂移」——所以这里只有这一个 const，写入点直接取反它。
  const collapsed = resolveExplorerCollapsed(explorerCollapsedOverride, presentation.explorerCollapsedByDefault)
  const [explorerRevealRequest, setExplorerRevealRequest] = useState<FileExplorerRevealRequest>()
  const explorerRevealRequestId = useRef(0)
  // The content slot's bottom half is Branches by default (unchanged behavior); a real project can
  // switch it to Source Control changes. Scratch never shows this — it renders Topics instead.
  const [bottomView, setBottomView] = useState<'branches' | 'changes' | 'history'>('branches')
  // Completed pages survive a file-tree split or collapse in their original owner.
  const history = useGitHistory(workspace, visible && !presentation.showTopics && !mote && bottomView === 'history')

  function revealDirectoryInExplorer(path: string): void {
    explorerRevealRequestId.current += 1
    setExplorerRevealRequest({
      workspaceId: workspace.id,
      path,
      requestId: explorerRevealRequestId.current
    })
  }

  const bottomHalf = mote ? <MoteDetailsPanel key={mote.topic.id} scope={mote} reference={reference}
    onOpenPath={onOpenPath ?? materials.open} onCreateNote={() => {
      setExplorerCollapsed(workspace.id, false)
      setCreateFileRequest({ requestId: ++explorerRevealRequestId.current, parentPath: mote.rootPath })
    }} /> : presentation.showTopics ? (
    <TopicNavigationPanel workspace={workspace} topic={knowledgeTopic} selectedTopicId={selectedTopicId}
      topics={knownTopics ?? []} categorySpaceId={categorySpaceId} visible={visible} onRevealDirectory={revealDirectoryInExplorer} />
  ) : (
    <div className="content-slot-source-control">
      <div className="source-control-switch" role="tablist" aria-label="Source control view" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const index = tabs.indexOf(event.target as HTMLButtonElement)
        if (index < 0 || tabs.length === 0) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        tabs[next]!.focus()
        tabs[next]!.click()
      }}>
        <LiquidSelectionSurface selected={bottomView} active={visible} targetAttribute="data-git-view" />
        <button
          type="button"
          role="tab"
          data-git-view="branches"
          aria-selected={bottomView === 'branches'}
          tabIndex={bottomView === 'branches' ? 0 : -1}
          className={bottomView === 'branches' ? 'selected' : ''}
          onClick={() => setBottomView('branches')}
        >
          Branches
        </button>
        <button
          type="button"
          role="tab"
          data-git-view="changes"
          aria-selected={bottomView === 'changes'}
          tabIndex={bottomView === 'changes' ? 0 : -1}
          className={bottomView === 'changes' ? 'selected' : ''}
          onClick={() => setBottomView('changes')}
        >
          Changes
        </button>
        <button
          type="button"
          role="tab"
          data-git-view="history"
          aria-selected={bottomView === 'history'}
          tabIndex={bottomView === 'history' ? 0 : -1}
          className={bottomView === 'history' ? 'selected' : ''}
          onClick={() => setBottomView('history')}
        >
          History
        </button>
      </div>
      {bottomView === 'branches' && <BranchesPanel workspace={workspace} />}
      {bottomView === 'changes' && <ChangesPanel workspace={workspace} />}
      <div className="source-control-history" hidden={bottomView !== 'history'}>
        <GitHistoryPanel workspace={workspace} history={history} />
      </div>
    </div>
  )

  return (
    <div className="workspace-tool-explorer">
      <TopicKnowledgeCapture target={capture} onClose={() => setCapture(null)} />
      <div className="workspace-tool-context workspace-tool-context--collapsible workspace-tool-context--explorer">
        <button
          type="button"
          className="workspace-tool-context__toggle"
          // Explorer 的折叠总归一个 chevron 控件，沿用左栏分组头那套（chevron 朝下＝展开、朝右＝收起，
          // aria-expanded 跟着真实状态）。它常驻在这条 context bar 上而不是塞进 FileExplorer 自己的
          // header：折叠后 FileExplorer 根本不渲染，把 toggle 放进它就再也收不回来。
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show file tree' : 'Hide file tree'}
          title={collapsed ? 'Show file tree' : 'Hide file tree'}
          onClick={() => setExplorerCollapsed(workspace.id, !collapsed)}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <span title={displayPath(workspace.path, workspace.hostId)}>
          <strong>{mote ? mote.topic.title : category?.title ?? knowledgeTopic?.title ?? workspace.name}</strong>
          {!mote && (isScratch || workspace.branch) ? <small>{isScratch ? 'Knowledge' : workspace.branch}</small> : null}
        </span>
        {workspace.hostId !== 'local' ? (
          <em><RadioTower size={11} /> {workspace.hostId}</em>
        ) : null}
        <div className="workspace-tool-context__actions">
          {canCollectKnowledge ? <button type="button" className="icon-button" aria-label="Collect sources in a knowledge topic" title="Collect sources in a knowledge topic" onClick={() => { try { const target = selectedKnowledgeSources(workspace.id); if (target) setCapture(target); else throw new Error('Choose a file, page or discussion to collect its reference in a knowledge topic.') } catch (error) { useAppStore.getState().reportError(error) } }}><NotebookText size={13} /></button> : null}
          <div ref={setToolbarTarget} />
        </div>
      </div>
      {collapsed ? (
        // 折叠＝没有可切分的第二块，所以整块直接由 bottomHalf 占满，不渲染 PanelGroup / 把手（见评审
        // §2.3.1：折叠态不进 react-resizable-panels，否则折叠状态会有 store 与库两个源）。「可拖但无意义
        // 的死把手」因此不可能存在——把手根本没被渲染。
        <div className="workspace-tools-collapsed">{bottomHalf}</div>
      ) : (
        <PanelGroup
          direction="vertical"
          className="workspace-tools-split"
          key={presentation.showTopics ? 'content-slot-topics' : 'content-slot-branches'}
        >
          <Panel defaultSize={presentation.fileTreeDefaultSize} minSize={presentation.fileTreeMinSize}>
            {selectedTopicId && !mote && topicRoot === null ? <div className="surface-inline-error" role="status">The selected object's file root is not confirmed. Its original workface is kept.
              {scratch ? <button type="button" className="icon-button" aria-label="Retry directory discovery" title="Retry directory discovery" onClick={() => void useAppStore.getState().refreshScratchTopics(scratch.id, true)}><RefreshCw size={13} /></button> : null}</div> :
              <FileExplorer key={workspace.id + (mote?.topic.id ?? '')} revealRequest={explorerRevealRequest} toolbarTarget={toolbarTarget}
                workspaceId={workspace.id} rootPath={mote ? mote.rootPath : topicRoot ?? ''}
                rootLabel={mote ? mote.topic.title : knowledgeTopic?.title ?? workspace.name} createRequest={createFileRequest} onCreateRequestHandled={() => setCreateFileRequest(undefined)}
                onOpenPath={mote ? onOpenPath ?? materials.open : onOpenPath} onOpenTerminal={mote ? onOpenTerminal ?? materials.terminal : onOpenTerminal} />}
          </Panel>
          <PanelResizeHandle className="workspace-tools-resize-handle" />
          <Panel defaultSize={100 - presentation.fileTreeDefaultSize} minSize={20}>
            {bottomHalf}
          </Panel>
        </PanelGroup>
      )}
    </div>
  )
}

const AGENT_GROUP_LABELS: Record<FocusColumn, string> = { attention: 'Needs You', working: 'Working', results: 'Results', idle: 'Idle / Unknown', disconnected: 'Disconnected' }

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
  const percentById = useMemo(() => Object.fromEntries(scoped.map(session => [session.id, contextUsedPercent(session.turnUsage?.context)])), [scoped])
  const groups = useMemo(() => groupFocusContexts(scoped.map(session => agentContextForSession(session, timelines[session.id], names[session.id], workspace,
    scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath, topics))).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))), [scoped, timelines, names, workspace, topics])
  const openFocus = useAppStore(state => state.setMainSurface)
  const count = scoped.length

  return (
    <section className="workspace-agents-tool">
      <div className="workspace-tool-context">
        <span>
          <strong>{workspace.name}</strong>
        </span>
        <em>{count}</em>
        <button type="button" className="workspace-agents-tool__focus" onClick={() => openFocus('agents')}><ArrowUpRight size={12} aria-hidden="true" />去 Focus 中查看</button>
      </div>
      <div className="workspace-agents-tool__scroll">
        {count === 0 ? (
          <div className="workspace-agents-tool__empty">
            <Bot size={18} />
            <strong>No Agents in this workspace</strong>
            <span>Use + to start an Agent. Choose “Keep Session” on close to leave it running here.</span>
          </div>
        ) : FOCUS_COLUMNS.map((column) => {
          const contexts = groups[column]
          if (contexts.length === 0) return null
          const label = column === 'idle' ? focusNeutralGroupSummary(contexts).label : AGENT_GROUP_LABELS[column]
          return (
            <section className="workspace-agent-group" key={column}>
              <header>
                <strong>{label}</strong><em>{contexts.length}</em>
              </header>
              <div>
                {contexts.map((context) => {
                  // Preserve the existing usage thresholds and hints, including Idle Agents.
                  const percent = percentById[context.id] ?? null
                  const pressure = contextPressure(percent)
                  return (
                  <button
                    type="button"
                    className="workspace-agent-row focus-context"
                    key={context.id}
                    data-session-id={context.id} data-state={context.state} data-bucket={context.bucket}
                    title={`${context.name} · ${context.stateLabel}\n${context.detail}\n${context.lastActivityAt === null ? 'Activity time unknown' : `Last active ${new Date(context.lastActivityAt).toLocaleString()}`}\nOpen in Space`}
                    aria-label={`${context.name} · ${context.stateLabel} · Open in Space`}
                    onClick={() => onOpen(context.id)}
                  >
                    <AgentContextContent context={context} metadata={<span className="workspace-agent-row__metadata">
                        {/* 够上门槛才出现，且文案说的是下一步不是颜色名——沿用花名册那枚 data-pressure
                            标记（CSS 在 agent-panels.css），逻辑层不出现颜色。缺席即正常。 */}
                        {pressure ? (
                          <span
                            className="agent-roster__pressure"
                            data-pressure={pressure}
                            title={`Context window ${percent}% full — ${CONTEXT_PRESSURE_HINT[pressure]}`}
                          >
                            {percent}%
                          </span>
                        ) : null}
                      {context.lastActivityAt === null ? <span title="Activity time unknown">—</span> : <time dateTime={new Date(context.lastActivityAt).toISOString()} title={`Last active ${new Date(context.lastActivityAt).toLocaleString()}`}>{new Date(context.lastActivityAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>}
                    </span>} />
                    <ArrowUpRight className="focus-context__open" size={11} aria-hidden="true" />
                  </button>
                  )
                })}
              </div>
            </section>
          )
        })}
        <button type="button" className="workspace-agents-tool__focus workspace-agents-tool__focus--footer" onClick={() => openFocus('agents')}>去 Focus 关注 <ArrowUpRight size={12} aria-hidden="true" /></button>
      </div>
    </section>
  )
})

function ConnectedWorkspaceAgentsTool({ workspace, onOpen }: {
  workspace: WorkspaceRecord
  onOpen(sessionId: string): void
}) {
  const sessions = useAppStore(useShallow(state => workspaceAgentSessions(state.sessions, workspace, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))))
  return <WorkspaceAgentsTool workspace={workspace} sessions={sessions} onOpen={onOpen} />
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
  const { tools: workspaceToolIds, effective: effectiveWorkspaceTool } = resolveWorkspaceTools({
    workspaceTool,
    isScratch
  })
  const contentSlot = contentSlotPresentation(isScratch)
  const tools: ToolDefinition<WorkspaceTool>[] = workspaceToolIds.map((id) => {
        const meta = WORKSPACE_TOOL_META[id]
        // Re-skin the content slot for Scratch without changing its enum id.
        if (id === 'files-branches' && isScratch) {
          return { id, ...meta, label: contentSlot.label, description: 'Browse the topic wiki and collaborators', icon: NotebookText }
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
          {tools.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.id}
                type="button"
                className={selectedTool === tool.id ? 'selected' : ''}
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
            <Plus size={15} />
          </button>
        ) : null}
      </header>
      <div className="surface-tool-content">
        {selectedTool === 'files-branches' && workspace ? (
          <WorkspaceFilesTool workspace={workspace} isScratch={isScratch} visible={visible} />
        ) : null}
        {visible && effectiveWorkspaceTool === 'agents' && workspace ? (
          <ConnectedWorkspaceAgentsTool
            workspace={workspace}
            onOpen={(sessionId) => selectSession(sessionId, activePaneId)}
          />
        ) : null}
      </div>
    </aside>
  )
}
