import { FolderGit2, Plus, RadioTower } from 'lucide-react'
import { useMemo } from 'react'
import { api } from '../lib/api'
import { projectWorkspaces, workspaceProjectId } from '../lib/workspace-projects'
import { useAppStore } from '../store'
import { BrandIcon } from './BrandIcon'

export function WorkspaceSidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const setConfig = useAppStore((state) => state.setConfig)
  const projects = useMemo(() => projectWorkspaces(config?.workspaces ?? []), [config?.workspaces])
  const activeWorkspace = config?.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const activeProjectId = activeWorkspace ? workspaceProjectId(activeWorkspace) : null

  async function chooseFolder(): Promise<void> {
    const workspace = await api.workspaces.chooseLocalFolder()
    if (!workspace || !config) return
    setConfig({ ...config, workspaces: [...config.workspaces, workspace] })
    await selectWorkspace(workspace.id)
  }

  return (
    <aside className="sidebar project-rail">
      <div className="sidebar__brand">
        <span className="brand-mark"><BrandIcon size={18} /></span>
        <span>AgentMux</span>
        <span className="brand-version">alpha</span>
      </div>
      <div className="sidebar__section-heading">
        <span>Projects</span>
        <button className="icon-button" onClick={() => void chooseFolder()} title="Add project folder"><Plus size={15} /></button>
      </div>
      <nav className="project-list" aria-label="Projects">
        {projects.map((project) => {
          const sessionCount = sessions.filter((session) =>
            project.workspaces.some(
              (workspace) => workspace.hostId === session.hostId && workspace.path === session.workspacePath
            )
          ).length
          const active = project.id === activeProjectId
          const preferred = active
            ? activeWorkspaceId
            : project.preferredWorkspaceId
          return (
            <button
              key={project.id}
              className={`project-rail-row ${active ? 'project-rail-row--active' : ''}`}
              title={project.repoPath}
              onClick={() => {
                if (!preferred) return
                const keepBoardOpen = mainSurface === 'board'
                void selectWorkspace(preferred).then(() => {
                  if (keepBoardOpen) setMainSurface('board')
                })
              }}
            >
              <span className="project-rail-row__icon"><FolderGit2 size={15} /></span>
              <span className="project-rail-row__identity">
                <strong>{project.name}</strong>
                <small>{project.hostId === 'local' ? 'This Mac' : <><RadioTower size={9} /> {project.hostId}</>}</small>
              </span>
              <span className="project-rail-row__count" title={`${project.workspaces.length} workspaces · ${sessionCount} sessions`}>
                {project.workspaces.length}
              </span>
            </button>
          )
        })}
        {projects.length === 0 ? (
          <div className="workspace-list__empty"><strong>No projects yet</strong><span>Add a local folder, then manage its branches and worktrees from the navigator.</span><button className="small-button" onClick={() => void chooseFolder()}><Plus size={12} /> Add project</button></div>
        ) : null}
      </nav>
      <div className="sidebar__bottom">
        <button className="sidebar-action" onClick={onOpenSettings}>Settings & hosts</button>
      </div>
    </aside>
  )
}
