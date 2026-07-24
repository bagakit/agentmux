import {
  Bookmark,
  Columns3,
  FolderGit2,
  Globe2,
  Inbox,
  LoaderCircle,
  RadioTower,
  SquareTerminal
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { MainSurface } from '../store'
import type { BoardTool, WorkspaceTool } from '../lib/surface-tool-dock'
import { ATTENTION_SESSION_STATES } from '../lib/project-board'
import { projectWorkspaces } from '../lib/workspace-projects'
import { useAppStore } from '../store'
import { BranchesPanel } from './BranchesPanel'
import { FileExplorer } from './FileExplorer'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'

type ToolDefinition<T extends string> = {
  id: T
  label: string
  description: string
  icon: typeof FolderGit2
}

const WORKSPACE_TOOLS: ToolDefinition<WorkspaceTool>[] = [
  { id: 'files-branches', label: 'Files + Branches', description: 'Browse the selected worktree', icon: FolderGit2 },
  { id: 'browser-favorites', label: 'Browser Favorites', description: 'Open a browser in the focused pane', icon: Bookmark },
  { id: 'terminal-shortcuts', label: 'Terminal Shortcuts', description: 'Start a terminal in the focused pane', icon: SquareTerminal }
]

const BOARD_TOOLS: ToolDefinition<BoardTool>[] = [
  { id: 'branch-lanes', label: 'Branch Lanes', description: 'View project work by status', icon: Columns3 },
  { id: 'inbox', label: 'Inbox', description: 'Review project attention items', icon: Inbox }
]

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

function WorkspaceFilesTool({ workspace }: { workspace: WorkspaceRecord }) {
  return (
    <div className="workspace-tool-explorer">
      <div className="workspace-tool-context">
        <FolderGit2 size={15} />
        <span>
          <strong>{workspace.name}</strong>
          <small>{workspace.branch ?? workspace.path}</small>
        </span>
        {workspace.hostId !== 'local' ? (
          <em><RadioTower size={11} /> {workspace.hostId}</em>
        ) : null}
      </div>
      <PanelGroup direction="vertical" className="workspace-tools-split">
        <Panel defaultSize={68} minSize={34}>
          <FileExplorer />
        </Panel>
        <PanelResizeHandle className="workspace-tools-resize-handle" />
        <Panel defaultSize={32} minSize={20}>
          <BranchesPanel workspace={workspace} />
        </Panel>
      </PanelGroup>
    </div>
  )
}

function BoardToolSummary({
  tool,
  workspaceCount,
  attentionCount
}: {
  tool: BoardTool
  workspaceCount: number
  attentionCount: number
}) {
  const isInbox = tool === 'inbox'
  const Icon = isInbox ? Inbox : Columns3
  return (
    <section className="surface-tool-summary">
      <div className="surface-tool-summary__icon"><Icon size={18} /></div>
      <div className="eyebrow">Board tool</div>
      <h2>{isInbox ? 'Inbox' : 'Branch lanes'}</h2>
      <p>
        {isInbox
          ? `${attentionCount} live attention item${attentionCount === 1 ? '' : 's'} from this Project. Select one in the main board to focus its Session.`
          : `${workspaceCount} registered worktree${workspaceCount === 1 ? '' : 's'} contribute Runs to the Project's Git Branch lanes.`}
      </p>
      <div className="surface-tool-unavailable">
        <Icon size={15} />
        <span>
          <strong>{isInbox ? (attentionCount > 0 ? 'Action needed' : 'All caught up') : 'Git-owned lanes'}</strong>
          <small>{isInbox ? 'Derived from live Session state; no duplicate persistence.' : 'Agent status is Run metadata, never the lane identity.'}</small>
        </span>
        <em>{isInbox ? attentionCount : 'Live'}</em>
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
  const boardTool = useAppStore((state) => state.boardTool)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const setBoardTool = useAppStore((state) => state.setBoardTool)
  const layout = useAppStore((state) => workspace ? state.layouts[workspace.id] : undefined)
  const launchTerminal = useAppStore((state) => state.launchTerminal)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const [starting, setStarting] = useState<'browser' | 'terminal' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isBoard = surface === 'board'
  const tools = isBoard ? BOARD_TOOLS : WORKSPACE_TOOLS
  const selectedTool = isBoard ? boardTool : workspaceTool
  const activePaneId = layout?.activeGroupId
  const project = workspace
    ? projectWorkspaces(config?.workspaces ?? []).find((candidate) =>
        candidate.workspaces.some((item) => item.id === workspace.id)
      )
    : null
  const workspaceCount = project?.workspaces.length ?? 0
  const attentionCount = sessions.filter((session) =>
    ATTENTION_SESSION_STATES.has(session.status.state) &&
    Boolean(project?.workspaces.some((item) =>
      item.hostId === session.hostId && item.path === session.workspacePath
    ))
  ).length

  async function open(kind: 'browser' | 'terminal'): Promise<void> {
    if (!activePaneId || starting) return
    setStarting(kind)
    setError(null)
    try {
      if (kind === 'browser') await createBrowser(activePaneId)
      else await launchTerminal(activePaneId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(null)
    }
  }

  return (
    <aside className="surface-tool-panel" aria-label={`${isBoard ? 'Board' : 'Workspace'} tools`}>
      <header className="surface-tool-activitybar">
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
                  if (isBoard) setBoardTool(tool.id as BoardTool)
                  else setWorkspaceTool(tool.id as WorkspaceTool)
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
        {!isBoard && workspaceTool === 'files-branches' && workspace ? (
          <WorkspaceFilesTool workspace={workspace} />
        ) : null}
        {!isBoard && workspaceTool === 'browser-favorites' && workspace ? (
          <ToolActionSurface
            icon={<Globe2 size={17} />}
            eyebrow="Browser Favorites"
            title="Open a browser tab"
            description="The browser remains owned by Electron Main and opens in the focused Universal Pane."
            actionLabel="New Browser"
            busy={starting === 'browser'}
            onAction={() => void open('browser')}
          >
            <div className="surface-tool-unavailable">
              <Bookmark size={15} />
              <span><strong>No saved favorites</strong><small>Favorite persistence is not available in this build.</small></span>
              <em>Unavailable</em>
            </div>
          </ToolActionSurface>
        ) : null}
        {!isBoard && workspaceTool === 'terminal-shortcuts' && workspace ? (
          <ToolActionSurface
            icon={<SquareTerminal size={17} />}
            eyebrow="Terminal Shortcuts"
            title={`Shell in ${workspace.name}`}
            description="Starts the existing core-owned terminal lifecycle on this workspace host."
            actionLabel="Open Terminal"
            busy={starting === 'terminal'}
            onAction={() => void open('terminal')}
          >
            <div className="surface-tool-unavailable">
              <SquareTerminal size={15} />
              <span><strong>No saved shortcuts</strong><small>Shortcut persistence is not available in this build.</small></span>
              <em>Unavailable</em>
            </div>
          </ToolActionSurface>
        ) : null}
        {isBoard ? <BoardToolSummary tool={boardTool} workspaceCount={workspaceCount} attentionCount={attentionCount} /> : null}
        {error ? <div className="surface-tool-error" role="alert">{error}</div> : null}
      </div>
    </aside>
  )
}
