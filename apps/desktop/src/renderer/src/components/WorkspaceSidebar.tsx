import { Pin, Plus, RadioTower } from 'lucide-react'
import { useMemo } from 'react'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { projectRailNavigation, workspaceProjectId } from '../lib/workspace-projects'
import { rowAttention, rowAttentionLabel } from '../lib/row-attention'
import { workingAgentCount } from '../lib/project-board'
import { useAppStore } from '../store'
import type { SettingsSectionId } from './SettingsPanel'
import { BrandIcon } from './BrandIcon'
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
  const scratchWorkingAgentCount = scratch
    ? workingAgentCount(sessions.filter((session) => workspaceOwnsSessionPath(scratch, session)))
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
            aria-label={[
              'Scratch',
              ...(scratchWorkingAgentCount > 0
                ? [`${scratchWorkingAgentCount} ${scratchWorkingAgentCount === 1 ? 'Agent is' : 'Agents are'} running`]
                : [])
            ].join(' · ')}
            title={scratch.path}
            onClick={() => void selectWorkspace(scratch.id)}
          >
            <span className="project-rail-row__icon scratch-workspace-row__icon"><BrandIcon size={16} /></span>
            <span className="project-rail-row__identity scratch-workspace-row__identity">
              <strong>Scratch</strong>
            </span>
            <span
              className="scratch-workspace-row__meta"
              title={`Pinned workspace · ${scratchSessionCount} ${scratchSessionCount === 1 ? 'session' : 'sessions'}`}
            >
              {scratchWorkingAgentCount > 0 ? (
                <span
                  className="project-rail-row__activity status status--working"
                  aria-hidden="true"
                  title={`${scratchWorkingAgentCount} ${scratchWorkingAgentCount === 1 ? 'Agent is' : 'Agents are'} running`}
                >
                  <span className="status__dot" />
                </span>
              ) : null}
              {/* Pin is the one thing that distinguishes this row from every other — it stays.
                  The number beside it follows the same rule as the project rows: it counts running
                  Agents and disappears at zero, rather than showing a session total nobody asked for. */}
              <Pin size={10} />
              {scratchWorkingAgentCount > 0 ? <span>{scratchWorkingAgentCount}</span> : null}
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
          const runningAgentCount = workingAgentCount(projectSessions)
          const runningLabel = runningAgentCount > 0
            ? `${runningAgentCount} ${runningAgentCount === 1 ? 'Agent is' : 'Agents are'} running`
            : null
          const rowStateLabel = [runningLabel, attentionLabel].filter(Boolean).join(' · ')
          // One badge, one number, and it is the number for whatever the row is currently signalling.
          // Attention outranks running because the CSS recolours THIS badge and hangs the `?`/`!` glyph
          // on it — hiding it whenever nothing is working would take the needs-you signal down with it,
          // which is the exact gap the rollup was built to close.
          const railBadge = attention.category ? attention.count : runningAgentCount || null
          // Everything the row stopped showing still has to be answerable, so it lands here.
          const countTitle = [
            `${project.workspaces.length} ${project.workspaces.length === 1 ? 'worktree' : 'worktrees'}`,
            `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`,
            ...(rowStateLabel ? [rowStateLabel] : [])
          ].join(' · ')
          const active = project.id === activeProjectId
          const preferred = active
            ? activeWorkspaceId
            : project.preferredWorkspaceId
          return (
            <button
              key={project.id}
              className={`project-rail-row ${active ? 'project-rail-row--active' : ''}`}
              title={rowStateLabel ? `${project.repoPath} · ${rowStateLabel}` : project.repoPath}
              aria-label={rowStateLabel ? `${project.name} · ${rowStateLabel}` : project.name}
              data-workspace-id={preferred ?? undefined}
              {...(attention.category ? { 'data-attention': attention.category } : {})}
              {...(runningAgentCount > 0 ? { 'data-running': 'true' } : {})}
              onClick={() => {
                if (!preferred) return
                const keepBoardOpen = mainSurface === 'board'
                void selectWorkspace(preferred).then(() => {
                  if (keepBoardOpen) setMainSurface('board')
                })
              }}
            >
              <span className="project-rail-row__identity">
                <strong>{project.name}</strong>
                {/* Host only earns a slot when it is NOT this machine. `This Mac` on every row is a
                    column of identical metadata — it distinguishes nothing and costs the title its
                    width (same rule as the identical leading icons, 控件语言). */}
                {project.hostId !== 'local' ? (
                  <small><RadioTower size={9} /> {project.hostId}</small>
                ) : null}
              </span>
              <span
                className="project-rail-row__activity status status--working"
                aria-hidden="true"
                title={runningLabel ?? undefined}
              >
                {runningAgentCount > 0 ? <span className="status__dot" /> : null}
              </span>
              {/* The badge answers "is anyone working in there right now" — so it counts running
                  Agents, not worktrees. A worktree count is repository structure; it answers a
                  different question and reads as a column of `1`s. It keeps its place in the
                  tooltip, where low-frequency facts belong (身份归属). Zero renders nothing at
                  all: a badge that is always the same number carries no information. */}
              {railBadge !== null ? (
                <span className="project-rail-row__count" title={countTitle}>
                  {railBadge}
                </span>
              ) : null}
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
