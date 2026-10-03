import { HostBadge } from './HostBadge'
import { hostIdentityProjection } from '../lib/region-execution-host'
import type { AgentMuxProjectGroupFact } from '@agentmux/core/control'
import { projectGroupsFor } from '../lib/cross-device-project-groups'
import { useGitProjectAssociations } from '../hooks/useGitProjectAssociations'
import { ProjectGroupDialog } from './ProjectGroupDialog'
import { ProjectGroupsTree } from './ProjectGroupsTree'
import { HostFolderDialog } from './HostFolderDialog'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceIconPicker } from './SpaceIconPicker'
import { folderSpaceIconTarget, type SpaceIconTarget } from '../lib/space-object-appearance'
import { ProjectActivity } from './ProjectActivity'
import { Folders, Layers, Link2, Pin, Plus, Rows2, Rows3, Rows4, Search, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
import { SpaceDisclosure, SpaceSectionHeader } from './SpaceSectionHeader'
import { WorkspaceRowContextMenu } from './WorkspaceRowContextMenu'
import { ConfirmationDialog } from './ConfirmationDialog'
import { SidebarToggleChrome } from './TopRowChrome'
import { activityContextsForWorkspaces } from '../lib/activity-groups'
import { matchesSpaceQuery, navigateSpaceTree } from '../lib/space-tree-navigation'
import { folderLastActivityAt } from '../lib/space-folder-icon-recency'
import { usePathDisplay } from '../hooks/usePathDisplay'

function folderSectionKey(hostId: string): string { return hostId === 'local' ? 'space:folders' : `space:folders:${hostId}` }
function projectCollapseKey(id: string): string { return `project:${id}` }
function isPathInside(inner: string, outer: string): boolean {
  const root = outer.replace(/[\\/]+$/, '')
  return inner.startsWith(`${root}/`) || inner.startsWith(`${root}\\`)
}

export function WorkspaceSidebar({ visible = true }: { visible?: boolean }) {
  const displayPath = usePathDisplay()
  const config = useAppStore((state) => state.config)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const mainSurface = useAppStore((state) => state.mainSurface)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const collapsedProjectGroups = useAppStore((state) => state.collapsedProjectGroups)
  const toggleProjectGroup = useAppStore((state) => state.toggleProjectGroup)
  const pinnedItems = useAppStore((state) => state.pinnedItems)
  const icons = useAppStore((state) => state.spaceObjectIcons)
  const projectGroups = useAppStore(state => state.projectGroups)
  const dissolveProjectGroup = useAppStore(state => state.dissolveProjectGroup)
  const [folderHost, setFolderHost] = useState<{ hostId: string; label: string } | null>(null)
  const [groupDialog, setGroupDialog] = useState<{ seed?: string; editing?: AgentMuxProjectGroupFact } | null>(null)
  const [dissolveRequest, setDissolveRequest] = useState<AgentMuxProjectGroupFact | null>(null)
  const [dissolving, setDissolving] = useState(false)
  const [dissolveIssue, setDissolveIssue] = useState<string | null>(null)
  const reportError = useAppStore((state) => state.reportError)
  const [removeRequest, setRemoveRequest] = useState<ReturnType<typeof projectRailNavigation>['projects'][number] | null>(null)
  const [removing, setRemoving] = useState(false)
  const [query, setQuery] = useState('')
  const [iconTarget, setIconTarget] = useState<SpaceIconTarget | null>(null)
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
  const associations = useGitProjectAssociations(projects, config?.hosts, visible)
  const groups = useMemo(() => projectRailTree(projects), [projects])
  const projectNodes = useMemo(() => groups.flatMap((group) => group.nodes), [groups])
  const shownGroups = useMemo(() => groups.map((group) => {
    if (!filtering) return group
    const hits = group.nodes.filter(({ project }) => matchesSpaceQuery(
      query, 'Folders', config?.hosts.find(host => host.id === group.hostId)?.label, group.label ?? undefined, group.groupPath ?? undefined,
      project.name, project.repoPath, project.hostId,
      ...project.workspaces.flatMap((workspace) => [workspace.name, workspace.path, workspace.branch])
    ))
    return { ...group, nodes: group.nodes.filter(({ project }) => hits.some(({ project: hit }) => hit.id === project.id || (hit.hostId === project.hostId && isPathInside(hit.repoPath, project.repoPath)))) }
  }).filter((group) => group.nodes.length > 0), [groups, filtering, query, config?.hosts])
  // Build location buckets once. Rows and collapsed summaries only visit their own consumers.
  const sessionsByProject = useMemo(() => {
    const byLocation = new Map<string, typeof sessions>()
    for (const session of sessions) {
      const key = JSON.stringify([session.hostId, session.workspacePath])
      const bucket = byLocation.get(key)
      if (bucket) bucket.push(session)
      else byLocation.set(key, [session])
    }
    return new Map(projects.map((project) => [project.id, [...new Map(project.workspaces.flatMap((workspace) =>
      byLocation.get(JSON.stringify([workspace.hostId, workspace.path])) ?? []).map((session) => [session.id, session])).values()]]))
  }, [sessions, projects])
  const lastActivityByProject = useMemo(() => {
    const now = Date.now()
    return new Map([...sessionsByProject].map(([id, owned]) => [id, folderLastActivityAt(owned, now)]))
  }, [sessionsByProject])
  const folderSections = useMemo(() => {
    const hostIds = [...new Set(['local', ...(config?.hosts.map(host => host.id) ?? []), ...projects.map(project => project.hostId)])]
    const remote = hostIds.some(id => id !== 'local')
    return hostIds.map(hostId => ({ hostId, key: folderSectionKey(hostId),
      label: hostId === 'local' && !remote ? 'Folders' : config?.hosts.find(host => host.id === hostId)?.label ?? (hostId === 'local' ? 'This Mac' : hostId),
      projects: projects.filter(project => project.hostId === hostId),
      groups: shownGroups.filter(group => group.hostId === hostId)
    }))
  }, [config?.hosts, projects, shownGroups])

  // Relations change with the folder projection, not with each Session update.
  const projectRelations = useMemo(() => {
    const nodes = new Map(projectNodes.map((node) => [node.project.id, node.project]))
    const ancestors = new Map(projectNodes.map(({ project }) => [project.id, projectNodes.filter((node) =>
      node.project.id !== project.id && node.project.hostId === project.hostId && isPathInside(project.repoPath, node.project.repoPath)
    ).sort((a, b) => a.project.repoPath.length - b.project.repoPath.length).map((node) => node.project.id)]))
    const descendants = new Map(projectNodes.map(({ project }) => [project.id, [] as string[]]))
    for (const [id, parents] of ancestors) for (const parent of parents) descendants.get(parent)!.push(id)
    const groupKeys = new Map(groups.flatMap((group) => group.nodes.map((node) => [node.project.id, projectGroupKey(group)] as const)))
    return { nodes, ancestors, descendants, groupKeys }
  }, [projectNodes, groups])
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

  // Branch pins retain their owning Project and one real depth step; no branch fetch enters the rail.
  function pinnedChildRows(
    scope: string,
    depth: number,
    resolve: (id: string) => { label: string; targetId: string | undefined }
  ): ReactNode {
    const ids = pinnedItems[scope] ?? []
    if (ids.length === 0) return null
    return ids.map((id) => {
      const { label, targetId } = resolve(id)
      const row = (
        <button
          type="button"
          className="project-rail-row project-rail-row--pinned-child"
          data-space-nav={`pin:${scope}:${id}`}
          data-space-parent={scope}
          data-space-pin-owner={scope}
          aria-label={label}
          title={label}
          style={{ '--rail-depth': depth } as CSSProperties}
          onClick={() => {
            if (targetId) void selectWorkspace(targetId)
          }}
        >
          <span className="project-rail-row__icon" aria-hidden="true"><Pin size={11} /></span>
          <span className="project-rail-row__identity"><strong>{label}</strong></span>
        </button>
      )
      return (
        <div className="project-rail-entry" key={`${scope}:${id}`} style={{ '--rail-depth': depth } as CSSProperties}>
          <div className="project-rail-row-shell" style={{ '--rail-depth': depth } as CSSProperties}>{row}</div>
        </div>
      )
    })
  }

  function projectRow({ project, depth }: ProjectRailNode) {
    const target = folderSpaceIconTarget(project)
    const manualIcon = icons[target.key] ?? null
    const identity = <SpaceObjectIcon kind="folder" name={project.name} workspaceId={project.preferredWorkspaceId} folderIdentityKey={target.key}
      manualIcon={manualIcon} lastActivityAt={manualIcon === null ? lastActivityByProject.get(project.id) ?? null : undefined}
      visible={manualIcon === null ? visible : undefined} />
    const ancestors = projectRelations.ancestors.get(project.id) ?? []
    if (!filtering && ancestors.some((id) => collapsedProjectGroups[projectCollapseKey(id)] === true)) return null
    const parentKey = ancestors.at(-1) ?? projectRelations.groupKeys.get(project.id) ?? folderSectionKey(project.hostId)
    const descendants = projectRelations.descendants.get(project.id) ?? []
    const hasChildren = descendants.length > 0
    const collapsed = !filtering && collapsedProjectGroups[projectCollapseKey(project.id)] === true
    const visibleProjectIds = collapsed ? [project.id, ...descendants] : [project.id]
    const projectSessions = [...new Map(visibleProjectIds.flatMap((id) => sessionsByProject.get(id) ?? []).map((session) => [session.id, session])).values()]
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
    const memberships = projectGroupsFor(projectGroups, project.id)
    const groupNames = memberships.map(group => group.name).join(', ')
    const related = associations.related.get(project.id) ?? []
    const active = project.id === activeProjectId
    const preferred = project.id === activeProjectId
      ? activeWorkspaceId
      : project.preferredWorkspaceId
    // 复制分支名只对 git worktree 有意义：一个聚合了多个 worktree 的 folder 项目本身没有单一分支。
    // 取被这一行选中的那个 workspace 的 branch，没有就不给这一项。
    const preferredWorkspace = project.workspaces.find((workspace) => workspace.id === preferred)
    const branch = preferredWorkspace?.branch ?? null
    const row = (
      <div className="project-rail-row-shell" style={{ '--rail-depth': depth } as CSSProperties}>
      {hasChildren ? <SpaceDisclosure icon={identity}
        expanded={!collapsed} label={`${collapsed ? 'Expand' : 'Collapse'} ${project.name}`} disabled={filtering}
        onToggle={() => toggleProjectGroup(projectCollapseKey(project.id))} /> : null}
      <button
        className={`project-rail-row ${hasChildren ? 'project-rail-row--disclosure ' : ''}${active ? 'project-rail-row--active' : ''}`}
        data-project-group-reference={memberships.length ? memberships.map(group => group.groupId).join(' ') : undefined}
        title={`${memberships.length ? `In ${groupNames}\n` : ''}${displayPath(project.repoPath, project.hostId)} · ${countTitle}`}
        aria-label={[project.name, memberships.length ? `In ${groupNames}` : null, rowStateLabel].filter(Boolean).join(' · ')}
        aria-current={active ? 'page' : undefined}
        data-space-nav={project.id}
        data-space-parent={parentKey}
        data-space-expanded={hasChildren && !filtering ? !collapsed : undefined}
        data-workspace-id={preferred ?? undefined}
        data-space-icon-target={target.key}
        {...(active ? { 'data-active-workspace-id': activeWorkspaceId } : {})}
        // 分类成员、路径聚合与真实目录层级相加；这里只报层数，像素归密度合同和样式表。
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
        {hasChildren ? null : identity}
        <span className="project-rail-row__identity">
          <strong>{project.name}</strong>

        </span>
      </button>
      {related.length > 0 ? <button type="button" className="icon-button project-association"
        aria-label={`Related projects for ${project.name}`} title={`Related Git projects\n${related.map(id => {
          const candidate = projects.find(candidate => candidate.id === id)!
          return `${candidate.name} · ${config?.hosts.find(host => host.id === candidate.hostId)?.label ?? candidate.hostId} · ${displayPath(candidate.repoPath, candidate.hostId)}`
        }).join('\n')}\nSame Git origin; grouping is optional`}
        onClick={() => setGroupDialog({ seed: project.id })}><Link2 size={13} /></button> : null}
      </div>
    )
    return (
      <div key={project.id} data-space-folder={project.id}
        className={`project-rail-folder-block${!filtering && pinnedItems[project.id]?.length ? ' project-rail-folder-block--pinned' : ''}`}>
        <WorkspaceRowContextMenu
          path={project.repoPath}
          branch={branch}
          isLocal={project.hostId === 'local'}
          workspaceId={preferred ?? project.preferredWorkspaceId}
          onRemove={() => setRemoveRequest(project)}
          onChangeIcon={() => setIconTarget(target)}
          onGroupProjects={() => setGroupDialog({ seed: project.id })}
        >
          <div className="project-rail-entry" data-space-entry>{row}{projectSessions.some((session) => session.kind === 'agent') ? <ProjectActivity compact sessions={projectSessions} contexts={activityContextsForWorkspaces(visibleProjectIds.flatMap((id) => projectRelations.nodes.get(id)!.workspaces))} /> : null}</div>
        </WorkspaceRowContextMenu>
        {/* Branch pins key by workspaceProjectId(workspace) — which is exactly project.id (see
            projectWorkspaces). The pinned branch name labels the row; navigation prefers the
            worktree carrying that branch (in-scope data, no fetch), else the project's preferred
            workspace — the same selectWorkspace path the parent row uses. */}
        {!filtering && pinnedChildRows(
          project.id,
          depth + 1,
          (branchName) => ({
            label: branchName,
            targetId:
              project.workspaces.find((workspace) => workspace.branch === branchName)?.id ??
              preferred ?? project.preferredWorkspaceId
          })
        )}
      </div>
    )
  }

  return (
    <aside className="sidebar project-rail" {...(railDensity !== 'default' ? { 'data-rail-density': railDensity } : {})}>
      <header className="project-rail-titlebar">
        <SidebarToggleChrome />
        <SpaceCreateMenu onOpenFolder={chooseFolder} onCreateProjectGroup={() => setGroupDialog({})} />
      </header>
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
        <button
          className="icon-button"
          onClick={() => void toggleDensity()}
          aria-label={densityControlLabel}
          aria-pressed={railDensity !== 'default'}
          title={densityTitle}
        >{railDensity === 'default' ? <Rows2 size={15} /> : railDensity === 'compact' ? <Rows3 size={15} /> : <Rows4 size={15} />}</button>
      </div>
      <div className="space-tree" ref={treeRef} onKeyDown={navigateSpaceTree}>
        {scratch ? <SpaceTopicsTree workspace={scratch} query={query} icons={icons} onChangeIcon={setIconTarget} /> : null}
        <ProjectGroupsTree projects={projects} query={query} activeProjectId={activeProjectId}
          visible={visible} sessionsByProject={sessionsByProject} lastActivityByProject={lastActivityByProject}
          onCreate={() => setGroupDialog({})} onEdit={editing => setGroupDialog({ editing })} onDissolve={group => { setDissolveIssue(null); setDissolveRequest(group) }} />
        {folderSections.map(section => {
          const foldersCollapsed = !filtering && collapsedProjectGroups[section.key] === true
          const folderSessions = [...new Map(section.projects.flatMap(project => sessionsByProject.get(project.id) ?? []).map(session => [session.id, session])).values()]
          return (        <nav className="project-list host-folders" aria-label={`${section.label} Folders · ${section.hostId}`} key={section.hostId} data-folder-host={section.hostId}>
          <SpaceSectionHeader label={section.label} navigationId={section.key} count={section.projects.length} icon={section.hostId !== 'local' ? <HostBadge context="Host" compact host={hostIdentityProjection(section.hostId, config?.hosts.find(host => host.id === section.hostId))} /> : <Folders size={14} />}
            expanded={!foldersCollapsed} filtering={filtering} onToggle={() => toggleProjectGroup(section.key)}
            createLabel={section.hostId === 'local' ? 'Open Folder' : `Open Folder on ${section.label}`} onCreate={async () => { if (section.hostId === 'local') await chooseFolder(); else setFolderHost({ hostId: section.hostId, label: section.label }) }}
            activity={foldersCollapsed && folderSessions.some((session) => session.kind === 'agent') ? <ProjectActivity compact sessions={folderSessions}
              contexts={activityContextsForWorkspaces(section.projects.flatMap((project) => project.workspaces))} /> : undefined} />
          {filtering && section.groups.length === 0 ? <p className="space-tree-empty" role="status">No matching Folders</p> : null}
          {foldersCollapsed ? null : section.groups.map((group) => {
            const key = projectGroupKey(group)
            const collapsed = !filtering && key !== null && collapsedProjectGroups[key] === true
            return (
              <div className="project-rail-group" key={`${group.hostId}:${group.groupPath ?? group.nodes[0]?.project.id}`}>
                {group.label && key !== null ? (
                  <GroupHeader
                    group={group}
                    parentKey={section.key}
                    collapsed={collapsed}
                    filtering={filtering}
                    sessions={[...new Map(group.nodes.flatMap((node) => sessionsByProject.get(node.project.id) ?? []).map((session) => [session.id, session])).values()]}
                    onToggle={() => { if (!filtering) toggleProjectGroup(key) }}
                  />
                ) : null}
                {collapsed ? null : group.nodes.map((node) => projectRow({
                  ...node,
                  // One category step; a path group and real directory nesting add their own steps.
                  depth: 1 + (group.groupPath ? 1 : 0) + Math.min(node.depth, PROJECT_RAIL_MAX_DEPTH)
                }))}
              </div>
            )
          })}
          {section.projects.length === 0 && !filtering && !foldersCollapsed ? (
            <div className="workspace-list__empty"><span>{section.hostId === 'local' ? 'Open a folder to get started.' : `No folders on ${section.label}.`}</span></div>
          ) : null}
        </nav>)
        })}
      </div>
      {folderHost ? <HostFolderDialog {...folderHost} onClose={() => setFolderHost(null)} /> : null}
      {groupDialog ? <ProjectGroupDialog projects={projects} {...groupDialog} related={associations.related}
        observations={associations.observations} onClose={() => setGroupDialog(null)} /> : null}
      <ConfirmationDialog open={dissolveRequest !== null} title="Dissolve project group?" intent="neutral"
        description={dissolveIssue ?? 'Only this group is dissolved. Folders remain in their other groups and original directory entries. Files and sessions stay on their devices.'}
        {...(dissolveRequest ? { subject: dissolveRequest.name } : {})} confirmLabel={dissolveIssue ? 'Retry saving dissolution' : 'Dissolve group'} busy={dissolving}
        onCancel={() => { if (!dissolving) setDissolveRequest(null) }} onConfirm={() => {
          if (!dissolveRequest) return
          setDissolving(true)
          void dissolveProjectGroup(dissolveRequest.groupId).then(result => {
            if (result.diskDurability === 'confirmed') setDissolveRequest(null)
            else setDissolveIssue(`Dissolution is applied here. Saving is unconfirmed: ${result.reason ?? 'The Core save acknowledgement is unavailable.'} Retry saving to confirm it.`)
          }, error => { reportError(error); setDissolveIssue('The group could not be dissolved. Retry saving; original work is retained.') }).finally(() => setDissolving(false))
        }} />
      <SpaceIconPicker target={iconTarget} onClose={() => setIconTarget(null)} />
      <ConfirmationDialog
        open={removeRequest !== null}
        title="Remove project view?"
        intent="neutral"
        description={
          removeRequest
            ? `This removes ${removeRequest.name} from the Project Rail only. Its files, layouts, Sessions and running Agents stay untouched.`
            : ''
        }
        {...(removeRequest ? { subject: displayPath(removeRequest.repoPath, removeRequest.hostId) } : {})}
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
  parentKey,
  collapsed,
  filtering,
  sessions: groupSessions,
  onToggle
}: {
  parentKey: string
  group: ProjectRailGroup
  collapsed: boolean
  filtering: boolean
  sessions: ReturnType<typeof useAppStore.getState>['sessions']
  onToggle: () => void
}) {
  const displayPath = usePathDisplay()
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
        data-space-parent={parentKey}
        data-space-expanded={!filtering ? !collapsed : undefined}
        data-space-disclosure
        title={[group.groupPath ? displayPath(group.groupPath, group.hostId) : null, memberLabel, ...(workingLabel ? [workingLabel] : []), ...(idleLabel ? [idleLabel] : [])]
          .filter(Boolean)
          .join(' · ')}
        onClick={onToggle}
      >
        <span className="project-rail-group__identity">
          <span className="space-disclosure__type project-rail-row__icon"><Layers size={13} aria-label="Automatic path group" /></span>
          <span className="project-rail-group__label">{group.label}</span>
          {collapsed && group.groupPath ? (
            <span className="project-rail-group__address">{railGroupAddress(displayPath(group.groupPath, group.hostId))}</span>
          ) : null}
        </span>
      </button>
      {collapsed && groupSessions.some((session) => session.kind === 'agent') ? (
        <ProjectActivity
          compact
          sessions={groupSessions}
          contexts={activityContextsForWorkspaces(group.nodes.flatMap((node) => node.project.workspaces))}
        />
      ) : null}
    </div>
  )
}
