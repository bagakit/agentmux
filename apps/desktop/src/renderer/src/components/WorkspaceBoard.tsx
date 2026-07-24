import { FolderGit2, GitBranch, RadioTower, TerminalSquare } from 'lucide-react'
import type { AgentSessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { StatusDot } from './StatusDot'

type LaneId = 'active' | 'waiting' | 'complete' | 'idle'

const LANES: { id: LaneId; label: string; description: string }[] = [
  { id: 'active', label: 'Active', description: 'Starting, running, or working' },
  { id: 'waiting', label: 'Needs attention', description: 'Waiting, blocked, or failed' },
  { id: 'complete', label: 'Complete', description: 'Done or exited sessions' },
  { id: 'idle', label: 'Idle', description: 'No agent session' }
]

function laneFor(sessions: AgentSessionSnapshot[]): LaneId {
  if (sessions.some((item) => ['waiting', 'blocked', 'error'].includes(item.status.state))) return 'waiting'
  if (sessions.some((item) => ['starting', 'running', 'working'].includes(item.status.state))) return 'active'
  if (sessions.length > 0) return 'complete'
  return 'idle'
}

function sessionsFor(workspace: WorkspaceRecord, sessions: AgentSessionSnapshot[]): AgentSessionSnapshot[] {
  return sessions.filter((session) => session.hostId === workspace.hostId && session.workspacePath === workspace.path)
}

export function WorkspaceBoard({ onCreateWorktree }: { onCreateWorktree: () => void }) {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const workspaces = config?.workspaces ?? []

  return (
    <section className="board">
      <header className="board__header">
        <div><div className="eyebrow">Workspace overview</div><h1>Agent board</h1><p>Each card is host-scoped and grouped by its most actionable agent state.</p></div>
        <button className="primary-button" onClick={onCreateWorktree}><FolderGit2 size={14} /> New worktree</button>
      </header>
      <div className="board__lanes">
        {LANES.map((lane) => {
          const items = workspaces.filter((workspace) => laneFor(sessionsFor(workspace, sessions)) === lane.id)
          return (
            <section className="board-lane" key={lane.id}>
              <header><div><strong>{lane.label}</strong><span>{lane.description}</span></div><span className="lane-count">{items.length}</span></header>
              <div className="board-lane__cards">
                {items.map((workspace) => {
                  const workspaceSessions = sessionsFor(workspace, sessions)
                  return (
                    <button className="workspace-card" key={workspace.id} onClick={() => void selectWorkspace(workspace.id)}>
                      <div className="workspace-card__heading">
                        <span className="workspace-card__icon"><FolderGit2 size={15} /></span>
                        <div><strong>{workspace.name}</strong><span>{workspace.kind}</span></div>
                        {workspace.hostId !== 'local' ? <RadioTower size={13} className="remote-glyph" /> : null}
                      </div>
                      <div className="workspace-card__evidence">
                        {workspace.branch ? <span><GitBranch size={12} />{workspace.branch}</span> : null}
                        <span title={workspace.path}><TerminalSquare size={12} />{workspace.path}</span>
                      </div>
                      <div className="workspace-card__sessions">
                        {workspaceSessions.map((session) => (
                          <span key={session.id}><StatusDot status={session.status} /><b>{session.agentId}</b><small>{session.status.state} · {session.status.source}</small></span>
                        ))}
                        {workspaceSessions.length === 0 ? <em>Ready for a new tmux agent</em> : null}
                      </div>
                    </button>
                  )
                })}
                {items.length === 0 ? <div className="board-lane__empty">No workspaces</div> : null}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}
