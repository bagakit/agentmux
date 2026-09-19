import { ProjectIcon } from './ProjectIcon'
import { ProjectActivity } from './ProjectActivity'
import { ChevronDown, ChevronRight, Folders, Pin, Plus, RadioTower, Rows2, Rows3, Rows4, Search, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, Fragment, type CSSProperties, type ReactNode } from 'react'
import { SCRATCH_WORKSPACE_ID, workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { PROJECT_RAIL_DENSITY_DEFAULT, type ProjectRailDensity } from '../../../shared/contracts'
import { api } from '../lib/api'
import {
  projectGroupKey,
  projectRailNavigation,
  projectRailTree,
  PROJECT_RAIL_MAX_DEPTH,
  removeProjectWorkspaces,
  railGroupAddress,
  workspaceProjectId,
  type ProjectRailGroup,
  type ProjectRailNode
} from '../lib/workspace-projects'
import { rowAttention, rowAttentionLabel } from '../lib/row-attention'
import { idleAgentCount, producingAgentCount, workingAgentCount } from '../lib/project-board'
import { useAppStore } from '../store'
import { SpaceTopicsTree } from './SpaceTopicsTree'
import { SpaceCreateMenu } from './SpaceCreateMenu'
import { WorkspaceRowContextMenu } from './WorkspaceRowContextMenu'
import { ConfirmationDialog } from './ConfirmationDialog'
import { SidebarToggleChrome } from './TopRowChrome'
import { activityContextsForWorkspaces } from '../lib/activity-groups'
import { matchesSpaceQuery, navigateSpaceTree } from '../lib/space-tree-navigation'

function projectCollapseKey(id: string): string { return `project:${id}` }
function isPathInside(inner: string, outer: string): boolean {
  const root = outer.replace(/[\\/]+$/, '')
  return inner.startsWith(`${root}/`) || inner.startsWith(`${root}\\`)
}

export function WorkspaceSidebar() {
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const collapsedProjectGroups = useAppStore((state) => state.collapsedProjectGroups)
  const toggleProjectGroup = useAppStore((state) => state.toggleProjectGroup)
  const pinnedItems = useAppStore((state) => state.pinnedItems)
  const reportError = useAppStore((state) => state.reportError)
  const [removeRequest, setRemoveRequest] = useState<ReturnType<typeof projectRailNavigation>['projects'][number] | null>(null)
  const [removing, setRemoving] = useState(false)
  const [query, setQuery] = useState('')
  const filtering = Boolean(query.trim())
  const treeRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const savedScroll = useRef(0)
  const restoreScroll = useRef(false)
  function changeQuery(value: string): void {
    if (!filtering && value.trim()) savedScroll.current = treeRef.current?.scrollTop ?? 0
    if (filtering && !value.trim()) restoreScroll.current = true
    setQuery(value)
  }
  useLayoutEffect(() => {
    if (!filtering && restoreScroll.current && treeRef.current) {
      treeRef.current.scrollTop = savedScroll.current
      restoreScroll.current = false
    }
  }, [filtering])
  const navigation = useMemo(
    () => projectRailNavigation(config?.workspaces ?? []),
    [config?.workspaces]
  )
  const { scratch, projects } = navigation
  const groups = useMemo(() => projectRailTree(projects), [projects])
  const projectNodes = useMemo(() => groups.flatMap((group) => group.nodes), [groups])
  const shownGroups = useMemo(() => groups.map((group) => {
    if (!filtering) return group
    const hits = group.nodes.filter(({ project }) => matchesSpaceQuery(
      query, 'Folders', group.label ?? undefined, group.groupPath ?? undefined,
      project.name, project.repoPath, project.hostId,
      ...project.workspaces.flatMap((workspace) => [workspace.name, workspace.path, workspace.branch])
    ))
    return { ...group, nodes: group.nodes.filter(({ project }) => hits.some(({ project: hit }) => hit.id === project.id || (hit.hostId === project.hostId && isPathInside(hit.repoPath, project.repoPath)))) }
  }).filter((group) => group.nodes.length > 0), [groups, filtering, query])
  const foldersCollapsed = !filtering && collapsedProjectGroups['space:folders'] === true

  function projectHasChildren(projectId: string): boolean {
    const parent = projectNodes.find((node) => node.project.id === projectId)?.project
    return Boolean(parent && projectNodes.some((node) => node.project.id !== projectId && node.project.hostId === parent.hostId && isPathInside(node.project.repoPath, parent.repoPath)))
  }

  function isProjectHidden(projectId: string): boolean {
    const node = projectNodes.find((item) => item.project.id === projectId)
    if (!node) return false
    return projectNodes.some((ancestor) => ancestor.project.id !== projectId && ancestor.project.hostId === node.project.hostId && isPathInside(node.project.repoPath, ancestor.project.repoPath) && collapsedProjectGroups[projectCollapseKey(ancestor.project.id)] === true)
  }
  const activeWorkspace = config?.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  // 密度是看法不是数据：缺席即默认档，读处一律 `?? 'default'`，不改树结构/归属/选中/滚动位置。
  const railDensity: ProjectRailDensity = config?.projectRailDensity ?? PROJECT_RAIL_DENSITY_DEFAULT
  const nextDensity: ProjectRailDensity = railDensity === 'default'
    ? 'compact'
    : railDensity === 'compact'
      ? 'dense'
      : 'default'
  const densityControlLabel = nextDensity === 'compact'
    ? 'Use compact project spacing'
    : nextDensity === 'dense'
      ? 'Use extra compact project spacing'
      : 'Use default project spacing'
  const densityTitle = nextDensity === 'compact'
    ? 'Compact spacing'
    : nextDensity === 'dense'
      ? 'Extra compact spacing'
      : 'Default spacing'
  async function toggleDensity(): Promise<void> {
    if (!config) return
    // 走 api.config.save 而非只改内存：这一档 durable，重启后仍是用户选的那一档。
    try {
      await api.config.save({ ...config, projectRailDensity: nextDensity }, config)
    } catch (error) {
      reportError(error)
    }
  }
  const activeProjectId = activeWorkspace && activeWorkspace.id !== scratch?.id
    ? workspaceProjectId(activeWorkspace)
    : null

  const chooseFolder = useAppStore((state) => state.openProjectFolder)

  async function confirmRemoveProject(): Promise<void> {
    if (!removeRequest || !config || removing) return
    setRemoving(true)
    try {
      const saved = await api.config.save({
        ...config,
        workspaces: removeProjectWorkspaces(config.workspaces, removeRequest)
      }, config)

      if (activeProjectId === removeRequest.id) {
        const fallback = saved.workspaces.find((workspace) => workspace.id === scratch?.id) ?? saved.workspaces[0]
        if (fallback) await selectWorkspace(fallback.id)
      }
      setRemoveRequest(null)
    } catch (error) {
      reportError(error)
    } finally {
      setRemoving(false)
    }
  }

  // Pinned Topics / Branches hang as smaller sibling rows right after their parent (Scratch or the
  // owning Project), one --rail-depth deeper — the single indent mechanism the rail already uses
  // (see the depth spread in projectRow). Emitted from the pin list alone; the pinned id is enough
  // to label the row, so no branch fetch enters the rail. Zero pins in a scope → nothing at all
  // (no empty container, no heading). Rendered inside projectRow / the Scratch slot, so a collapsed
  // group never reaches this code and cannot leak its children.
  function pinnedChildRows(
    scope: string,
    depth: number,
    resolve: (id: string) => { label: string; targetId: string | undefined; onSelect?: () => void }
  ): ReactNode {
    const ids = pinnedItems[scope] ?? []
    if (ids.length === 0) return null
    return ids.map((id) => {
      const { label, targetId, onSelect } = resolve(id)
      const branchPin = scope !== SCRATCH_WORKSPACE_ID
      const row = (
        <button
          type="button"
          className="project-rail-row project-rail-row--pinned-child"
          data-space-nav={`pin:${scope}:${id}`}
          data-space-parent={scope}
          aria-label={label}
          title={label}
          style={{ '--rail-depth': depth } as CSSProperties}
          onClick={() => {
            if (onSelect) onSelect()
            else if (targetId) void selectWorkspace(targetId)
          }}
        >
          {branchPin ? <span className="project-rail-row__icon" aria-hidden="true" /> : null}
          <span className="project-rail-row__identity"><strong>{label}</strong></span>
        </button>
      )
      return (
        <div className="project-rail-entry project-rail-entry--pinned" key={`${scope}:${id}`} style={{ '--rail-depth': depth } as CSSProperties}>
          {branchPin ? (
            <div className="project-rail-row-shell" style={{ '--rail-depth': depth } as CSSProperties}>
              <span className="project-rail-row__collapse-spacer" aria-hidden="true" />
              {row}
            </div>
          ) : row}
        </div>
      )
    })
  }

  function projectRow({ project, depth }: ProjectRailNode) {
    if (!filtering && isProjectHidden(project.id)) return null
    const parent = projectNodes.filter((node) => node.project.hostId === project.hostId && isPathInside(project.repoPath, node.project.repoPath)).sort((a, b) => b.project.repoPath.length - a.project.repoPath.length)[0]?.project
    const group = groups.find((item) => item.nodes.some((node) => node.project.id === project.id))
    const parentKey = parent?.id ?? (group ? projectGroupKey(group) : null) ?? 'space:folders'
    const hasChildren = projectHasChildren(project.id)
    const collapsed = !filtering && collapsedProjectGroups[projectCollapseKey(project.id)] === true
    const projectSessions = sessions.filter((session) =>
      project.workspaces.some((workspace) => workspaceOwnsSessionPath(workspace, session))
    )
    const sessionCount = projectSessions.length
    // Rolled up from the same Session projection the window bar and the tab dots read, so a
    // collapsed project can no longer hide an Agent that is waiting on you.
    const attention = rowAttention(projectSessions)
    const attentionLabel = rowAttentionLabel(attention)
    const producingCount = producingAgentCount(projectSessions)
    const workingLabel = producingCount > 0
      ? `${producingCount} ${producingCount === 1 ? 'Agent is' : 'Agents are'} working`
      : null
    const idleCount = idleAgentCount(projectSessions)
    const idleLabel = idleCount > 0 ? `${idleCount} idle` : null
    const rowStateLabel = [workingLabel, idleLabel, attentionLabel].filter(Boolean).join(' · ')
    const countTitle = [
      `${project.workspaces.length} ${project.workspaces.length === 1 ? 'worktree' : 'worktrees'}`,
      `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`,
      ...(rowStateLabel ? [rowStateLabel] : [])
    ].join(' · ')
    const active = project.id === activeProjectId
    const preferred = active
      ? activeWorkspaceId
      : project.preferredWorkspaceId
    // 复制分支名只对 git worktree 有意义：一个聚合了多个 worktree 的 folder 项目本身没有单一分支。
    // 取被这一行选中的那个 workspace 的 branch，没有就不给这一项。
    const preferredWorkspace = project.workspaces.find((workspace) => workspace.id === preferred)
    const branch = preferredWorkspace?.branch ?? null
    const row = (
      <div className="project-rail-row-shell" style={{ '--rail-depth': depth } as CSSProperties}>
      {hasChildren ? <button
        type="button"
        className="project-rail-row__collapse"
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}`}
        aria-expanded={!collapsed}
        data-space-disclosure
        disabled={filtering}
        onClick={(event) => { event.stopPropagation(); toggleProjectGroup(projectCollapseKey(project.id)) }}
      >{collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</button> : <span className="project-rail-row__collapse-spacer" aria-hidden="true" />}
      <button
        className={`project-rail-row ${active ? 'project-rail-row--active' : ''}`}
        title={`${project.repoPath} · ${countTitle}`}
        aria-label={rowStateLabel ? `${project.name} · ${rowStateLabel}` : project.name}
        aria-current={active ? 'page' : undefined}
        data-space-nav={project.id}
        data-space-parent={parentKey}
        data-space-expanded={hasChildren && !filtering ? !collapsed : undefined}
        data-workspace-id={preferred ?? undefined}
        {...(active ? { 'data-active-workspace-id': activeWorkspaceId } : {})}
        // 缩进只表达"这个 Project 在上一个 Project 的目录里"。深度走自定义属性而不是内联
        // padding：具体几像素归样式表（密度合同《Project Rail Nesting Indent》），这里只报层数。
        {...(depth > 0 ? { style: { '--rail-depth': depth } as CSSProperties } : {})}
        {...(workingAgentCount(projectSessions) > 0 ? { 'data-running': 'true' } : {})}
        onClick={() => {
          if (!preferred) return
          const keepBoardOpen = mainSurface === 'board'
          void selectWorkspace(preferred).then(() => {
            if (keepBoardOpen) setMainSurface('board')
          })
        }}
      >
        <ProjectIcon workspaceId={project.preferredWorkspaceId} name={project.name} />
        <span className="project-rail-row__identity">
          <strong>{project.name}</strong>
          {/* Host only earns a slot when it is NOT this machine. `This Mac` on every row is a
              column of identical metadata — it distinguishes nothing and costs the title its
              width (same rule as the identical leading icons, 控件语言). */}
          {project.hostId !== 'local' ? (
            <small><RadioTower size={9} /> {project.hostId}</small>
          ) : null}
        </span>
      </button>
      </div>
    )
    return (
      <Fragment key={project.id}>
        <WorkspaceRowContextMenu
          path={project.repoPath}
          branch={branch}
          isLocal={project.hostId === 'local'}
          workspaceId={preferred ?? project.preferredWorkspaceId}
          onRemove={() => setRemoveRequest(project)}
        >
          <div className="project-rail-entry" data-space-entry>{row}<ProjectActivity compact sessions={projectSessions} contexts={activityContextsForWorkspaces(project.workspaces)} /></div>
        </WorkspaceRowContextMenu>
        {/* Branch pins key by workspaceProjectId(workspace) — which is exactly project.id (see
            projectWorkspaces). The pinned branch name labels the row; navigation prefers the
            worktree carrying that branch (in-scope data, no fetch), else the project's preferred
            workspace — the same selectWorkspace path the parent row uses. */}
        {!filtering && pinnedChildRows(
          project.id,
          Math.min(depth + 1, PROJECT_RAIL_MAX_DEPTH),
          (branchName) => ({
            label: branchName,
            targetId:
              project.workspaces.find((workspace) => workspace.branch === branchName)?.id ??
              preferred ?? project.preferredWorkspaceId
          })
        )}
      </Fragment>
    )
  }

  return (
    <aside className="sidebar project-rail" {...(railDensity !== 'default' ? { 'data-rail-density': railDensity } : {})}>
      <header className="project-rail-titlebar">
        <SidebarToggleChrome />
      </header>
      <div className="sidebar__section-heading">
        <span>Spaces</span>
        <div className="sidebar__heading-actions">
          {/* 密度就地切换：可见常驻控件，不进设置页——用户要在看着树的同时调（DEN
              「Project Rail 与 Topic 行密度」）。三档轮换，不是无级滑块。 */}
          <button
            className="icon-button"
            onClick={() => void toggleDensity()}
            aria-label={densityControlLabel}
            aria-pressed={railDensity !== 'default'}
            title={densityTitle}
          >{railDensity === 'default' ? <Rows2 size={15} /> : railDensity === 'compact' ? <Rows3 size={15} /> : <Rows4 size={15} />}</button>
          <SpaceCreateMenu onOpenFolder={chooseFolder} />
        </div>
      </div>
      <div className="space-tree-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          aria-label="Find Spaces"
          placeholder="Find a Space…"
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) { event.preventDefault(); changeQuery('') }
          }}
        />
        {query ? (
          <button type="button" className="icon-button" aria-label="Clear Space search" title="Clear · Esc"
            onClick={() => { changeQuery(''); searchRef.current?.focus() }}>
            <X size={12} />
          </button>
        ) : null}
      </div>
      <div className="space-tree" ref={treeRef} onKeyDown={navigateSpaceTree}>
        {scratch ? <SpaceTopicsTree workspace={scratch} query={query} /> : null}
        <nav className="project-list" aria-label="Folders">
          <div className="project-rail-row-shell space-folders-heading" data-space-entry>
            <button
              type="button"
              className="project-rail-row__collapse"
              data-space-disclosure
              disabled={filtering}
              aria-label={`${foldersCollapsed ? 'Expand' : 'Collapse'} Folders`}
              aria-expanded={!foldersCollapsed}
              onClick={() => toggleProjectGroup('space:folders')}
            >
              {foldersCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
            <button
              type="button"
              className="project-rail-row space-folders-row"
              data-space-nav="space:folders"
              data-space-expanded={!filtering ? !foldersCollapsed : undefined}
              aria-label="Folders"
              aria-expanded={!foldersCollapsed}
              onClick={() => { if (!filtering) toggleProjectGroup('space:folders') }}
            >
              <span className="project-rail-row__icon"><Folders size={14} /></span>
              <span className="project-rail-row__identity"><strong>Folders</strong></span><small>{projects.length}</small>
            </button>
            {foldersCollapsed ? (
              <ProjectActivity
                compact
                sessions={sessions.filter((session) => projects.some((project) =>
                  project.workspaces.some((workspace) => workspaceOwnsSessionPath(workspace, session))))}
                contexts={activityContextsForWorkspaces(projects.flatMap((project) => project.workspaces))}
              />
            ) : null}
          </div>
          {filtering && shownGroups.length === 0 ? <p className="space-tree-empty" role="status">No matching Folders</p> : null}
          {foldersCollapsed ? null : shownGroups.map((group) => {
            const key = projectGroupKey(group)
            const collapsed = !filtering && key !== null && collapsedProjectGroups[key] === true
            return (
              <div className={`project-rail-group ${group.label && key !== null && !collapsed ? 'project-rail-group--expanded' : ''}`} key={`${group.hostId}:${group.groupPath ?? group.nodes[0]?.project.id}`}>
                {group.label && key !== null ? (
                  <GroupHeader
                    group={group}
                    collapsed={collapsed}
                    filtering={filtering}
                    onToggle={() => { if (!filtering) toggleProjectGroup(key) }}
                  />
                ) : null}
                {collapsed ? null : group.nodes.map((node) => projectRow({
                  ...node,
                  // A grouped Project gets one visual level for the group itself;
                  // path-derived nesting remains additive below that level.
                  depth: Math.min(
                    node.depth + (group.groupPath ? 1 : 0),
                    PROJECT_RAIL_MAX_DEPTH
                  )
                }))}
              </div>
            )
          })}
          {projects.length === 0 && !filtering && !foldersCollapsed ? (
            <div className="workspace-list__empty"><strong>No projects yet</strong><span>Add a local folder, then manage its branches and worktrees from the navigator.</span><button className="small-button" onClick={() => void chooseFolder()}><Plus size={12} /> Add project</button></div>
          ) : null}
        </nav>
      </div>
      <ConfirmationDialog
        open={removeRequest !== null}
        title="Remove project view?"
        description={
          removeRequest
            ? `This removes ${removeRequest.name} from the Project Rail only. Its files, layouts, Sessions and running Agents stay untouched.`
            : ''
        }
        {...(removeRequest ? { subject: removeRequest.repoPath } : {})}
        confirmLabel="Remove view"
        busy={removing}
        onCancel={() => {
          if (!removing) setRemoveRequest(null)
        }}
        onConfirm={() => void confirmRemoveProject()}
      />
    </aside>
  )
}

/** Path-derived disclosure; member attention remains visible when collapsed. */
function GroupHeader({
  group,
  collapsed,
  filtering,
  onToggle
}: {
  group: ProjectRailGroup
  collapsed: boolean
  filtering: boolean
  onToggle: () => void
}) {
  const sessions = useAppStore((state) => state.sessions)
  // 卷的是这一组里**每个** Project 的 Session，含缩进的子孙——折叠把它们全藏起来了，所以信号也
  // 必须全卷上来。
  const groupSessions = sessions.filter((session) =>
    group.nodes.some((node) =>
      node.project.workspaces.some((workspace) => workspaceOwnsSessionPath(workspace, session))
    )
  )
  const attention = rowAttention(groupSessions)
  const attentionLabel = rowAttentionLabel(attention)
  const producing = producingAgentCount(groupSessions)
  const workingLabel = producing > 0
    ? `${producing} ${producing === 1 ? 'Agent is' : 'Agents are'} working`
    : null
  const idle = idleAgentCount(groupSessions)
  const idleLabel = idle > 0 ? `${idle} idle` : null
  const topLevel = group.nodes.filter((node) => node.depth === 0).length
  const memberLabel = `${topLevel} ${topLevel === 1 ? 'project' : 'projects'}`
  // 与项目行同一条规则：attention 压过 running，因为 CSS 给同一个角标上色并挂 `?`/`!`。
  return (
    <div className="project-rail-entry" data-space-entry>
      <button
        type="button"
        className="project-rail-group__header"
        aria-label={[group.label, memberLabel, ...(attentionLabel ? [attentionLabel] : [])].join(' · ')}
        aria-expanded={!collapsed}
        data-space-nav={projectGroupKey(group) ?? undefined}
        data-space-parent="space:folders"
        data-space-expanded={!filtering ? !collapsed : undefined}
        data-space-disclosure
        title={[group.groupPath, memberLabel, ...(workingLabel ? [workingLabel] : []), ...(idleLabel ? [idleLabel] : [])]
          .filter(Boolean)
          .join(' · ')}
        onClick={onToggle}
      >
        <span className="project-rail-group__chevron" aria-hidden="true">
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </span>
        <span className="project-rail-group__identity">
          <span className="project-rail-row__icon"><Folders size={13} aria-label="Automatic path group" /></span>
          <span className="project-rail-group__label">{group.label}</span>
          {collapsed && group.groupPath ? (
            <span className="project-rail-group__address">{railGroupAddress(group.groupPath)}</span>
          ) : null}
        </span>
      </button>
      {collapsed ? (
        <ProjectActivity
          compact
          sessions={groupSessions}
          contexts={activityContextsForWorkspaces(group.nodes.flatMap((node) => node.project.workspaces))}
        />
      ) : null}
    </div>
  )
}
