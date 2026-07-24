import { ChevronRight, FolderGit2, GitBranchPlus, Plus, RadioTower } from 'lucide-react'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { StatusDot } from './StatusDot'
import { BrandIcon } from './BrandIcon'

export function WorkspaceSidebar({
  onOpenSettings,
  onCreateWorktree
}: {
  onOpenSettings: () => void
  onCreateWorktree: () => void
}) {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const activeSessionId = useAppStore((state) => state.activeSessionId)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const selectSession = useAppStore((state) => state.selectSession)
  const setConfig = useAppStore((state) => state.setConfig)

  async function chooseFolder(): Promise<void> {
    const workspace = await api.workspaces.chooseLocalFolder()
    if (!workspace || !config) return
    setConfig({ ...config, workspaces: [...config.workspaces, workspace] })
    await selectWorkspace(workspace.id)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="brand-mark"><BrandIcon size={18} /></span>
        <span>AgentMux</span>
        <span className="brand-version">alpha</span>
      </div>
      <div className="sidebar__section-heading">
        <span>Workspaces</span>
        <div className="sidebar__heading-actions">
          <button className="icon-button" onClick={onCreateWorktree} title="Create worktree"><GitBranchPlus size={14} /></button>
          <button className="icon-button" onClick={() => void chooseFolder()} title="Add local folder"><Plus size={15} /></button>
        </div>
      </div>
      <nav className="workspace-list">
        {config?.workspaces.map((workspace) => {
          const workspaceSessions = sessions.filter(
            (session) => session.hostId === workspace.hostId && session.workspacePath === workspace.path
          )
          const active = workspace.id === activeWorkspaceId
          return (
            <div className={`workspace-row ${active ? 'workspace-row--active' : ''}`} key={workspace.id}>
              <button className="workspace-row__button" onClick={() => void selectWorkspace(workspace.id)}>
                <ChevronRight size={13} className={active ? 'chevron chevron--open' : 'chevron'} />
                <FolderGit2 size={15} />
                <span className="workspace-row__label">{workspace.name}</span>
                {workspace.hostId !== 'local' ? <RadioTower size={12} className="remote-glyph" /> : null}
              </button>
              {active ? (
                <div className="session-list">
                  {workspaceSessions.map((session) => (
                    <button
                      key={session.id}
                      className={`session-row ${activeSessionId === session.id ? 'session-row--active' : ''}`}
                      onClick={() => selectSession(session.id)}
                    >
                      <StatusDot status={session.status} />
                      <span>{session.label}</span>
                    </button>
                  ))}
                  {workspaceSessions.length === 0 ? <div className="session-list__empty">No agents yet</div> : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </nav>
      <div className="sidebar__bottom">
        <button className="sidebar-action" onClick={onOpenSettings}>Settings & hosts</button>
      </div>
    </aside>
  )
}
