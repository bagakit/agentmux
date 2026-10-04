import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { AgentContextContent } from './AgentContextContent'
import { useShallow } from 'zustand/react/shallow'
import { agentContextForSession, FOCUS_COLUMNS, groupFocusContexts, focusNeutralGroupSummary, type FocusColumn } from '../lib/focus-context'
import {
  ArrowUpRight,
  Bot,
  FolderGit2,
  NotebookText,
  Plus
} from 'lucide-react'
import { memo, useContext, useMemo } from 'react'
import type {
  SessionSnapshot,
  WorkspaceRecord
} from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import {
  contentSlotPresentation,
  resolveWorkspaceTools,
  workspaceAgentSessions,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { CONTEXT_PRESSURE_HINT, contextPressure, contextUsedPercent } from '../lib/agent-usage'
import { useAppStore } from '../store'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { WorkspaceFilesTool } from './WorkspaceFilesTool'
import { scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { SidebarToggleChrome, WindowSidebarLayoutContext } from './TopRowChrome'

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
