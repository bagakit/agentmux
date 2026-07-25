import { FolderGit2, Pin, Plus, RadioTower, Sparkles } from 'lucide-react'
import { useMemo } from 'react'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { projectRailNavigation, workspaceProjectId } from '../lib/workspace-projects'
import { rowAttention, rowAttentionLabel } from '../lib/row-attention'
import { useAppStore } from '../store'
import type { SettingsSectionId } from './SettingsPanel'
import { ProjectRailToolbar } from './ProjectRailToolbar'
import { SidebarToggleChrome } from './TopRowChrome'

export function WorkspaceSidebar({
  onOpenSettings
}: {
  onOpenSettings: (section: SettingsSectionId) => void
}) {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const setConfig = useAppStore((state) => state.setConfig)
  const navigation = useMemo(
    () => projectRailNavigation(config?.workspaces ?? []),
    [config?.workspaces]
  )
  const { scratch, projects } = navigation
  const activeWorkspace = config?.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const activeProjectId = activeWorkspace && activeWorkspace.id !== scratch?.id
    ? workspaceProjectId(activeWorkspace)
    : null
  const scratchSessionCount = scratch
    ? sessions.filter((session) => workspaceOwnsSessionPath(scratch, session)).length
    : 0

  async function chooseFolder(): Promise<void> {
    const workspace = await api.workspaces.chooseLocalFolder()
    if (!workspace || !config) return
    setConfig({ ...config, workspaces: [...config.workspaces, workspace] })
    await selectWorkspace(workspace.id)
  }

  return (
    <aside className="sidebar project-rail">
      <header className="project-rail-titlebar">
        <SidebarToggleChrome />
      </header>
      {scratch ? (
        <div className="scratch-workspace-slot">
          <button
            className={`project-rail-row scratch-workspace-row ${activeWorkspaceId === scratch.id ? 'project-rail-row--active' : ''}`}
            aria-current={activeWorkspaceId === scratch.id ? 'page' : undefined}
            title={scratch.path}
            onClick={() => void selectWorkspace(scratch.id)}
          >
            <span className="project-rail-row__icon scratch-workspace-row__icon"><Sparkles size={15} /></span>
            <span className="project-rail-row__identity scratch-workspace-row__identity">
              <strong>Scratch</strong>
              <small>Unscoped workspace</small>
            </span>
            <span
              className="scratch-workspace-row__meta"
              title={`Pinned workspace · ${scratchSessionCount} sessions`}
            >
              <Pin size={10} />
              <span>{scratchSessionCount}</span>
            </span>
          </button>
        </div>
      ) : null}
      <div className="sidebar__section-heading">
        <span>Projects</span>
        <button className="icon-button" onClick={() => void chooseFolder()} title="Add project folder"><Plus size={15} /></button>
      </div>
      <nav className="project-list" aria-label="Projects">
        {projects.map((project) => {
          const projectSessions = sessions.filter((session) =>
            project.workspaces.some((workspace) => workspaceOwnsSessionPath(workspace, session))
          )
          const sessionCount = projectSessions.length
          // Rolled up from the same Session projection the window bar and the tab dots read, so a
          // collapsed project can no longer hide an Agent that is waiting on you.
          const attention = rowAttention(projectSessions)
          const attentionLabel = rowAttentionLabel(attention)
          const active = project.id === activeProjectId
          const preferred = active
            ? activeWorkspaceId
            : project.preferredWorkspaceId
          return (
            <button
              key={project.id}
              className={`project-rail-row ${active ? 'project-rail-row--active' : ''}`}
              title={attentionLabel ? `${project.repoPath} · ${attentionLabel}` : project.repoPath}
              {...(attentionLabel ? { 'aria-label': `${project.name} · ${attentionLabel}` } : {})}
              {...(attention.category ? { 'data-attention': attention.category } : {})}
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
      <ProjectRailToolbar onOpenSettings={onOpenSettings} />
    </aside>
  )
}
