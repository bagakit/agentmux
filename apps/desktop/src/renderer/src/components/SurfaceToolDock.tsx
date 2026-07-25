import {
  Activity,
  ArrowUpRight,
  BellRing,
  Bookmark,
  Bot,
  CheckCircle2,
  Columns3,
  FolderOpen,
  FolderGit2,
  Globe2,
  History,
  LoaderCircle,
  MessageSquarePlus,
  NotebookText,
  Pencil,
  Plus,
  RadioTower
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import {
  SCRATCH_TOPIC_TITLE_MAX_LENGTH,
  workspaceOwnsSessionPath
} from '../../../shared/scratch-topics'
import type { MainSurface } from '../store'
import {
  contentSlotPresentation,
  resolveWorkspaceTools,
  workspaceAgentGroups,
  type WorkspaceAgentGroupId,
  type WorkspaceTool
} from '../lib/surface-tool-dock'
import { sessionBoardColumn } from '../lib/project-board'
import { projectWorkspaces } from '../lib/workspace-projects'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { BranchesPanel } from './BranchesPanel'
import { FileExplorer, type FileExplorerRevealRequest } from './FileExplorer'
import { StatusDot } from './StatusDot'
import { SidebarToggleChrome } from './TopRowChrome'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

type ToolDefinition<T extends string> = {
  id: T
  label: string
  description: string
  icon: typeof FolderGit2
}

const WORKSPACE_TOOL_META: Record<WorkspaceTool, Omit<ToolDefinition<WorkspaceTool>, 'id'>> = {
  'files-branches': { label: 'Files + Branches', description: 'Browse the selected worktree', icon: FolderGit2 },
  agents: { label: 'Agents', description: 'Find Agents that remain available after their Tab closes', icon: Bot },
  'browser-favorites': { label: 'Browser Favorites', description: 'Open a browser in the focused pane', icon: Bookmark }
}

const BOARD_TOOL: ToolDefinition<'branch-board'> = {
  id: 'branch-board',
  label: 'Branch Board',
  description: 'Inspect project Branches by run status',
  icon: Columns3
}

function ToolActionSurface({
  icon,
  eyebrow,
  title,
  description,
  actionLabel,
  busy,
  onAction,
  children
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
  actionLabel: string
  busy?: boolean
  onAction: () => void
  children?: ReactNode
}) {
  return (
    <section className="surface-tool-action-surface">
      <div className="surface-tool-action-surface__icon">{icon}</div>
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="primary-button" type="button" disabled={busy} onClick={onAction}>
        {busy ? <LoaderCircle className="spin" size={14} /> : icon}
        {busy ? 'Opening…' : actionLabel}
      </button>
      {children}
    </section>
  )
}

function WorkspaceFilesTool({
  workspace,
  isScratch
}: {
  workspace: WorkspaceRecord
  isScratch: boolean
}) {
  const presentation = contentSlotPresentation(isScratch)
  const [explorerRevealRequest, setExplorerRevealRequest] = useState<FileExplorerRevealRequest>()
  const explorerRevealRequestId = useRef(0)

  function revealDirectoryInExplorer(path: string): void {
    explorerRevealRequestId.current += 1
    setExplorerRevealRequest({
      workspaceId: workspace.id,
      path,
      requestId: explorerRevealRequestId.current
    })
  }

  return (
    <div className="workspace-tool-explorer">
      <div className="workspace-tool-context">
        <span>
          <strong>{workspace.name}</strong>
          <small>{isScratch ? 'Topic wiki' : (workspace.branch ?? workspace.path)}</small>
        </span>
        {workspace.hostId !== 'local' ? (
          <em><RadioTower size={11} /> {workspace.hostId}</em>
        ) : null}
      </div>
      <PanelGroup
        direction="vertical"
        className="workspace-tools-split"
        key={presentation.showTopics ? 'content-slot-topics' : 'content-slot-branches'}
      >
        <Panel defaultSize={presentation.fileTreeDefaultSize} minSize={presentation.fileTreeMinSize}>
          <FileExplorer revealRequest={explorerRevealRequest} />
        </Panel>
        <PanelResizeHandle className="workspace-tools-resize-handle" />
        <Panel defaultSize={100 - presentation.fileTreeDefaultSize} minSize={20}>
          {presentation.showTopics ? (
            <WorkspaceTopicsPanel
              workspace={workspace}
              onRevealDirectory={revealDirectoryInExplorer}
            />
          ) : (
            <BranchesPanel workspace={workspace} />
          )}
        </Panel>
      </PanelGroup>
    </div>
  )
}

function WorkspaceTopicsPanel({
  workspace,
  onRevealDirectory
}: {
  workspace: WorkspaceRecord
  onRevealDirectory(path: string): void
}) {
  const layout = useAppStore((state) => state.layouts[workspace.id])
  const activeTabId = layout?.groups.find((group) => group.id === layout.activeGroupId)?.activeTabId
  const topicId = useAppStore((state) => activeTabId ? state.tabs[activeTabId]?.topicId : undefined)
  const fileRevision = useAppStore((state) => state.workspaceFileRevisions[workspace.id] ?? 0)
  const createScratchTopic = useAppStore((state) => state.createScratchTopic)
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const renameScratchTopic = useAppStore((state) => state.renameScratchTopic)
  const [topics, setTopics] = useState<ScratchTopicSnapshot[] | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const currentTopic = topics?.find((topic) => topic.id === topicId)
  const compact = topics === null || topics.length > 0

  useEffect(() => {
    let active = true
    setError(null)
    void api.scratch.listTopics(workspace.id).then((snapshots) => {
      if (active) setTopics(snapshots)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [fileRevision, workspace.id])

  async function createTopic(): Promise<void> {
    if (pending) return
    setPending('create')
    setError(null)
    try {
      const created = await createScratchTopic()
      setTopics((current) => {
        const next = [...(current ?? []).filter((topic) => topic.id !== created.id), created]
        return next.sort((left, right) =>
          left.directoryPath < right.directoryPath ? -1 : left.directoryPath > right.directoryPath ? 1 : 0
        )
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  async function openTopic(nextTopicId: string): Promise<void> {
    if (pending) return
    setPending(nextTopicId)
    setError(null)
    try {
      await openScratchTopic(nextTopicId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  function beginRename(topic: ScratchTopicSnapshot): void {
    if (pending) return
    setError(null)
    setEditingTopicId(topic.id)
    setEditTitle(topic.title)
  }

  function cancelRename(): void {
    setEditingTopicId(null)
    setEditTitle('')
  }

  async function commitRename(topic: ScratchTopicSnapshot): Promise<void> {
    const title = editTitle.trim()
    if (pending) return
    if (!title) {
      setError('Scratch Topic title cannot be empty')
      return
    }
    if (title === topic.title) {
      cancelRename()
      return
    }
    const pendingId = `rename:${topic.id}`
    setPending(pendingId)
    setError(null)
    try {
      const renamed = await renameScratchTopic(topic.id, title)
      setTopics((current) => current?.map((entry) => entry.id === renamed.id ? renamed : entry) ?? null)
      cancelRename()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className={`surface-tool-summary workspace-topics-panel workspace-topics-panel--${compact ? 'index' : 'empty'}`}>
      {compact ? (
        <header className="workspace-topic-index-header">
          <span>
            <NotebookText size={14} />
            <strong>Topics</strong>
            {topics ? <em>{topics.length}</em> : null}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="Create new Topic"
            title="Create new Topic"
            disabled={pending !== null || topics === null}
            onClick={() => void createTopic()}
          >
            {topics === null || pending === 'create'
              ? <LoaderCircle className="spin" size={13} />
              : <Plus size={14} />}
          </button>
        </header>
      ) : (
        <>
          <div className="surface-tool-summary__icon"><NotebookText size={18} /></div>
          <div className="eyebrow">Topics</div>
          <h2>No Topics yet</h2>
          <p>A Topic is a real shared directory for a goal, outcomes, references, and collaborating Agents.</p>
          <button className="primary-button" type="button" disabled={pending !== null} onClick={() => void createTopic()}>
            {pending === 'create' ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
            {pending === 'create' ? 'Creating…' : 'Create new Topic'}
          </button>
        </>
      )}
      {topics && topics.length > 0 ? (
        <div className="workspace-topic-list" aria-label="Scratch Topics">
          {topics.map((topic) => {
            const isCurrent = topic.id === currentTopic?.id
            const editing = editingTopicId === topic.id
            return (
              <div className={`workspace-topic-item${isCurrent ? ' current' : ''}`} key={topic.id}>
                {editing ? (
                  <form
                    className="workspace-topic-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void commitRename(topic)
                    }}
                  >
                    <Pencil size={13} />
                    <input
                      autoFocus
                      aria-label={`Rename ${topic.title}`}
                      value={editTitle}
                      maxLength={SCRATCH_TOPIC_TITLE_MAX_LENGTH}
                      onChange={(event) => setEditTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRename()
                        }
                      }}
                    />
                  </form>
                ) : (
                  <button
                    className="workspace-topic-entry"
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void openTopic(topic.id)}
                  >
                    {pending === topic.id ? <LoaderCircle className="spin" size={14} /> : <NotebookText size={14} />}
                    <span>
                      <span className="workspace-topic-title-line">
                        <strong>{topic.title}</strong>
                        {isCurrent ? <em>Current</em> : null}
                      </span>
                      <small>
                        <span>{topic.summary || topic.directoryPath}</span>
                        <em>{topic.collaborators.length} {topic.collaborators.length === 1 ? 'agent' : 'agents'}</em>
                      </small>
                    </span>
                  </button>
                )}
                <button
                  className="icon-button workspace-topic-rename"
                  type="button"
                  aria-label={`Rename ${topic.title}`}
                  title="Rename Topic"
                  disabled={pending !== null}
                  onClick={() => editing ? cancelRename() : beginRename(topic)}
                >
                  {pending === `rename:${topic.id}`
                    ? <LoaderCircle className="spin" size={12} />
                    : <Pencil size={12} />}
                </button>
                <button
                  className="icon-button workspace-topic-reveal"
                  type="button"
                  aria-label={`Show ${topic.title} directory in Explorer`}
                  title="Show Topic in Explorer"
                  disabled={pending !== null}
                  onClick={() => onRevealDirectory(topic.directoryPath)}
                >
                  <FolderOpen size={13} />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
      {error ? <div className="new-tab-error" role="alert">{error}</div> : null}
    </section>
  )
}

const AGENT_GROUP_META: Record<WorkspaceAgentGroupId, {
  label: string
  description: string
  icon: typeof Activity
}> = {
  working: { label: 'Working', description: 'Running now', icon: Activity },
  'needs-you': { label: 'Needs You', description: 'Waiting or blocked', icon: BellRing },
  recent: { label: 'Recent', description: 'Finished Agents', icon: History }
}

function formatAgentAge(timestamp: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function WorkspaceAgentsTool({
  workspace,
  sessions,
  onOpen
}: {
  workspace: WorkspaceRecord
  sessions: readonly SessionSnapshot[]
  onOpen(sessionId: string): void
}) {
  const groups = workspaceAgentGroups(sessions, workspace)
  const count = groups.reduce((total, group) => total + group.sessions.length, 0)

  return (
    <section className="workspace-agents-tool">
      <div className="workspace-tool-context">
        <span>
          <strong>{workspace.name}</strong>
          <small>Agent Sessions</small>
        </span>
        <em>{count}</em>
      </div>
      <div className="workspace-agents-tool__scroll">
        <p className="workspace-agents-tool__hint">Agents kept during Tab close remain available here.</p>
        {count === 0 ? (
          <div className="workspace-agents-tool__empty">
            <Bot size={18} />
            <strong>No Agents in this workspace</strong>
            <span>Start one from a new Tab. Choose “Keep Session” on close to leave it running here.</span>
          </div>
        ) : groups.map((group) => {
          if (group.sessions.length === 0) return null
          const meta = AGENT_GROUP_META[group.id]
          const Icon = meta.icon
          return (
            <section className="workspace-agent-group" key={group.id}>
              <header>
                <span><Icon size={11} /><strong>{meta.label}</strong><small>{meta.description}</small></span>
                <em>{group.sessions.length}</em>
              </header>
              <div>
                {group.sessions.map((session) => (
                  <button
                    type="button"
                    className="workspace-agent-row"
                    key={session.id}
                    title={`Open or focus ${session.label}`}
                    onClick={() => onOpen(session.id)}
                  >
                    <span className="workspace-agent-row__mark">
                      <AgentProviderIcon providerId={session.providerId} size={15} />
                      <StatusDot status={session.status} />
                    </span>
                    <span className="workspace-agent-row__identity">
                      <strong>{session.label}</strong>
                      <small>{agentProviderLabel(session.providerId)} · {session.status.state}</small>
                    </span>
                    <time title={new Date(session.updatedAt).toLocaleString()}>{formatAgentAge(session.updatedAt)}</time>
                    <ArrowUpRight size={11} />
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}

function BoardToolSummary({
  projectName,
  hostId,
  workspaceCount,
  workingCount,
  needsYouCount,
  doneCount
}: {
  projectName: string
  hostId: string
  workspaceCount: number
  workingCount: number
  needsYouCount: number
  doneCount: number
}) {
  return (
    <section className="surface-tool-summary">
      <div className="surface-tool-summary__icon"><Columns3 size={18} /></div>
      <div className="eyebrow">Project board</div>
      <h2>Branch × status</h2>
      <p>{projectName} uses Branches as rows and run state as columns. Inbox lives in the board itself.</p>
      <div className="board-tool-context">
        <span><RadioTower size={12} /> {hostId === 'local' ? 'This Mac' : hostId}</span>
        <em>{workspaceCount} worktree{workspaceCount === 1 ? '' : 's'}</em>
      </div>
      <div className="board-tool-legend">
        <div><MessageSquarePlus size={13} /><span><strong>Inbox</strong><small>Start a Branch discussion</small></span><em>Open</em></div>
        <div><Activity size={13} /><span><strong>Working</strong><small>Running now</small></span><em>{workingCount}</em></div>
        <div><BellRing size={13} /><span><strong>Needs You</strong><small>Waiting or blocked</small></span><em>{needsYouCount}</em></div>
        <div><CheckCircle2 size={13} /><span><strong>Done</strong><small>Completed runs</small></span><em>{doneCount}</em></div>
      </div>
    </section>
  )
}

export function SurfaceToolDock({
  surface,
  workspace
}: {
  surface: MainSurface
  workspace: WorkspaceRecord | undefined
}) {
  const workspaceTool = useAppStore((state) => state.workspaceTool)
  const projectRailOpen = useAppStore((state) => state.projectRailOpen)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const layout = useAppStore((state) => workspace ? state.layouts[workspace.id] : undefined)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const selectSession = useAppStore((state) => state.selectSession)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const [startingBrowser, setStartingBrowser] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBoard = surface === 'board'
  // Scratch is a wiki-first workspace: the content slot keeps its `files-branches` role but is
  // re-skinned as `Files + Topics` (see contentSlotPresentation), so the tool set never diverges
  // and the global workspaceTool is never mutated.
  const isScratch = Boolean(workspace && isScratchWorkspaceId(workspace.id))
  const { tools: workspaceToolIds, effective: effectiveWorkspaceTool } = resolveWorkspaceTools({
    workspaceTool,
    isScratch
  })
  const contentSlot = contentSlotPresentation(isScratch)
  const tools: ToolDefinition<string>[] = isBoard
    ? [BOARD_TOOL]
    : workspaceToolIds.map((id) => {
        const meta = WORKSPACE_TOOL_META[id]
        // Re-skin the content slot for Scratch without changing its enum id.
        if (id === 'files-branches' && isScratch) {
          return { id, ...meta, label: contentSlot.label, description: 'Browse the topic wiki and collaborators', icon: NotebookText }
        }
        return { id, ...meta }
      })
  const selectedTool = isBoard ? BOARD_TOOL.id : effectiveWorkspaceTool
  const activePaneId = layout?.activeGroupId
  const project = workspace
    ? projectWorkspaces(config?.workspaces ?? []).find((candidate) =>
        candidate.workspaces.some((item) => item.id === workspace.id)
      )
    : null
  const workspaceCount = project?.workspaces.length ?? 0
  const projectSessions = sessions.filter((session) =>
    Boolean(project?.workspaces.some((item) => workspaceOwnsSessionPath(item, session)))
  )
  const runCounts = { working: 0, 'needs-you': 0, done: 0 }
  for (const session of projectSessions) runCounts[sessionBoardColumn(session)] += 1

  async function openBrowser(): Promise<void> {
    if (!activePaneId || startingBrowser) return
    setStartingBrowser(true)
    setError(null)
    try {
      await createBrowser(activePaneId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStartingBrowser(false)
    }
  }

  return (
    <aside className="surface-tool-panel" aria-label={`${isBoard ? 'Board' : 'Workspace'} tools`}>
      <header className={`surface-tool-activitybar ${projectRailOpen ? '' : 'surface-tool-activitybar--compact-chrome'}`}>
        {!projectRailOpen ? <SidebarToggleChrome /> : null}
        <nav aria-label={`${isBoard ? 'Board' : 'Workspace'} tool selection`}>
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
                  if (!isBoard) setWorkspaceTool(tool.id as WorkspaceTool)
                }}
              >
                <Icon size={15} />
              </button>
            )
          })}
        </nav>
        <span>{tools.find((tool) => tool.id === selectedTool)?.label}</span>
      </header>
      <div className="surface-tool-content">
        {!isBoard && effectiveWorkspaceTool === 'files-branches' && workspace ? (
          <WorkspaceFilesTool workspace={workspace} isScratch={isScratch} />
        ) : null}
        {!isBoard && effectiveWorkspaceTool === 'agents' && workspace ? (
          <WorkspaceAgentsTool
            workspace={workspace}
            sessions={sessions}
            onOpen={(sessionId) => selectSession(sessionId, activePaneId)}
          />
        ) : null}
        {!isBoard && effectiveWorkspaceTool === 'browser-favorites' && workspace ? (
          <ToolActionSurface
            icon={<Globe2 size={17} />}
            eyebrow="Browser Favorites"
            title="Open a browser tab"
            description="The browser remains owned by Electron Main and opens in the focused Universal Pane."
            actionLabel="New Browser"
            busy={startingBrowser}
            onAction={() => void openBrowser()}
          >
            <div className="surface-tool-unavailable">
              <Bookmark size={15} />
              <span><strong>No saved favorites</strong><small>Favorite persistence is not available in this build.</small></span>
              <em>Unavailable</em>
            </div>
          </ToolActionSurface>
        ) : null}
        {isBoard && project ? (
          <BoardToolSummary
            projectName={project.name}
            hostId={project.hostId}
            workspaceCount={workspaceCount}
            workingCount={runCounts.working}
            needsYouCount={runCounts['needs-you']}
            doneCount={runCounts.done}
          />
        ) : null}
        {error ? <div className="surface-tool-error" role="alert">{error}</div> : null}
      </div>
    </aside>
  )
}
