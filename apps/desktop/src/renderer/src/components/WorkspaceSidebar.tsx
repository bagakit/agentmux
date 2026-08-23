import { ProjectIcon } from './ProjectIcon'
import { ProjectActivity } from './ProjectActivity'
import { ChevronDown, ChevronRight, Folders, Pin, Plus, RadioTower, Rows2, Rows3, Rows4 } from 'lucide-react'
import { useMemo, useState, Fragment, type CSSProperties, type ReactNode } from 'react'
import { SCRATCH_WORKSPACE_ID, workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import type { ProjectRailDensity } from '../../../shared/contracts'
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
import type { SettingsSectionId } from './SettingsPanel'
import { BrandIcon } from './BrandIcon'
import { ProjectRailToolbar } from './ProjectRailToolbar'
import { WorkspaceRowContextMenu } from './WorkspaceRowContextMenu'
import { ConfirmationDialog } from './ConfirmationDialog'
import { SidebarToggleChrome } from './TopRowChrome'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { activityContextsForWorkspaces } from '../lib/activity-groups'

function projectCollapseKey(id: string): string { return `project:${id}` }
function isPathInside(inner: string, outer: string): boolean {
  const root = outer.replace(/[\\/]+$/, '')
  return inner.startsWith(`${root}/`) || inner.startsWith(`${root}\\`)
}

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
  const openScratchTopic = useAppStore((state) => state.openScratchTopic)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const setConfig = useAppStore((state) => state.setConfig)
  const collapsedProjectGroups = useAppStore((state) => state.collapsedProjectGroups)
  const toggleProjectGroup = useAppStore((state) => state.toggleProjectGroup)
  const pinnedItems = useAppStore((state) => state.pinnedItems)
  const reportError = useAppStore((state) => state.reportError)
  const [removeRequest, setRemoveRequest] = useState<ReturnType<typeof projectRailNavigation>['projects'][number] | null>(null)
  const [removing, setRemoving] = useState(false)
  const navigation = useMemo(
    () => projectRailNavigation(config?.workspaces ?? []),
    [config?.workspaces]
  )
  const { scratch, projects } = navigation
  const projectNodes = useMemo(() => projectRailTree(projects).flatMap((group) => group.nodes), [projects])

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
  const railDensity: ProjectRailDensity = config?.projectRailDensity ?? 'default'
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
      setConfig(await api.config.save({ ...config, projectRailDensity: nextDensity }))
    } catch (error) {
      reportError(error)
    }
  }
  const { topics: scratchTopics } = useScratchTopics(scratch?.id ?? null)
  const activeProjectId = activeWorkspace && activeWorkspace.id !== scratch?.id
    ? workspaceProjectId(activeWorkspace)
    : null
  const scratchSessionCount = scratch
    ? sessions.filter((session) => workspaceOwnsSessionPath(scratch, session)).length
    : 0
  const scratchWorkingAgentCount = scratch
    ? producingAgentCount(sessions.filter((session) => workspaceOwnsSessionPath(scratch, session)))
    : 0
  const scratchIdleAgentCount = scratch
    ? idleAgentCount(sessions.filter((session) => workspaceOwnsSessionPath(scratch, session)))
    : 0

  async function chooseFolder(): Promise<void> {
    const workspace = await api.workspaces.chooseLocalFolder()
    if (!workspace || !config) return
    // chooseLocalFolder now returns the existing record when the folder is already registered (a no-op
    // with feedback rather than a zod-dump error), so append only when it is actually new — otherwise
    // just focus what is already there.
    if (!config.workspaces.some((item) => item.id === workspace.id)) {
      setConfig({ ...config, workspaces: [...config.workspaces, workspace] })
    }
    await selectWorkspace(workspace.id)
  }

  async function confirmRemoveProject(): Promise<void> {
    if (!removeRequest || !config || removing) return
    setRemoving(true)
    try {
      const saved = await api.config.save({
        ...config,
        workspaces: removeProjectWorkspaces(config.workspaces, removeRequest)
      })
      setConfig(saved)
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
      {projectHasChildren(project.id) ? <button
        type="button"
        className="project-rail-row__collapse"
        aria-label={`${collapsedProjectGroups[projectCollapseKey(project.id)] ? 'Expand' : 'Collapse'} ${project.name}`}
        aria-expanded={collapsedProjectGroups[projectCollapseKey(project.id)] !== true}
        onClick={(event) => { event.stopPropagation(); toggleProjectGroup(projectCollapseKey(project.id)) }}
      >{collapsedProjectGroups[projectCollapseKey(project.id)] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</button> : <span className="project-rail-row__collapse-spacer" aria-hidden="true" />}
      <button
        className={`project-rail-row ${active ? 'project-rail-row--active' : ''}`}
        title={`${project.repoPath} · ${countTitle}`}
        aria-label={rowStateLabel ? `${project.name} · ${rowStateLabel}` : project.name}
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
          {idleLabel ? <small className="project-rail-row__activity" aria-hidden="true">{idleLabel}</small> : null}
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
          {isProjectHidden(project.id) ? null : <div className="project-rail-entry">{row}<ProjectActivity sessions={projectSessions} contexts={activityContextsForWorkspaces(project.workspaces)} /></div>}
        </WorkspaceRowContextMenu>
        {/* Branch pins key by workspaceProjectId(workspace) — which is exactly project.id (see
            projectWorkspaces). The pinned branch name labels the row; navigation prefers the
            worktree carrying that branch (in-scope data, no fetch), else the project's preferred
            workspace — the same selectWorkspace path the parent row uses. */}
        {pinnedChildRows(
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
      {scratch ? (
        <div className="scratch-workspace-slot">
          <WorkspaceRowContextMenu
            path={scratch.path}
            branch={scratch.branch ?? null}
            isLocal={scratch.hostId === 'local'}
            workspaceId={scratch.id}
          >
            <div className="project-rail-entry"><button
            className={`project-rail-row scratch-workspace-row ${activeWorkspaceId === scratch.id ? 'project-rail-row--active' : ''}`}
            aria-current={activeWorkspaceId === scratch.id ? 'page' : undefined}
            aria-label={[
              'Scratch',
              ...(scratchWorkingAgentCount > 0
                ? [`${scratchWorkingAgentCount} ${scratchWorkingAgentCount === 1 ? 'Agent is' : 'Agents are'} working`]
                : []),
              ...(scratchIdleAgentCount > 0 ? [`${scratchIdleAgentCount} idle`] : [])
            ].join(' · ')}
            title={scratch.path}
            onClick={() => void selectWorkspace(scratch.id)}
          >
            <span className="project-rail-row__icon scratch-workspace-row__icon"><BrandIcon size={16} /></span>
            <span className="project-rail-row__identity scratch-workspace-row__identity">
              <strong>Scratch</strong>
              {scratchIdleAgentCount > 0 ? <small className="project-rail-row__activity" aria-hidden="true">{scratchIdleAgentCount} idle</small> : null}
            </span>
            <span
              className="scratch-workspace-row__meta"
              title={`Pinned workspace · ${scratchSessionCount} ${scratchSessionCount === 1 ? 'session' : 'sessions'}`}
            >
              {/* Pin is the one thing that distinguishes this row from every other — it stays.
                  The number beside it follows the same rule as the project rows: it counts running
                  Agents and disappears at zero, rather than showing a session total nobody asked for. */}
              <Pin size={10} />

            </span>
          </button><ProjectActivity
            sessions={sessions.filter((session) => workspaceOwnsSessionPath(scratch, session))}
            contexts={activityContextsForWorkspaces([scratch], scratchTopics ?? [])}
          /></div>
          </WorkspaceRowContextMenu>
          {/* Pinned Topics hang under Scratch. The pin list alone is enough to render — a Topic
              whose snapshot has not loaded (scratchTopics null, or id not yet in it) falls back to
              its id rather than disappearing. Clicking selects the Scratch workspace, following the
              row above. Note: these child rows use --rail-depth + a smaller type, distinct from the
              static <Pin> badge above (which means "this workspace is pinned"). */}
          {pinnedChildRows(SCRATCH_WORKSPACE_ID, 1, (topicId) => ({
            label: scratchTopics?.find((topic) => topic.id === topicId)?.title ?? topicId,
            targetId: scratch.id,
            onSelect: () => void openScratchTopic(topicId)
          }))}
        </div>
      ) : null}
      <div className="sidebar__section-heading">
        <span>Projects</span>
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
          <button className="icon-button" onClick={() => void chooseFolder()} title="Add project folder"><Plus size={15} /></button>
        </div>
      </div>
      <nav className="project-list" aria-label="Projects">
        {projectRailTree(projects).map((group) => {
          const key = projectGroupKey(group)
          const collapsed = key !== null && collapsedProjectGroups[key] === true
          return (
            <div className={`project-rail-group ${group.label && key !== null && !collapsed ? 'project-rail-group--expanded' : ''}`} key={`${group.hostId}:${group.groupPath ?? group.nodes[0]?.project.id}`}>
              {group.label && key !== null ? (
                <GroupHeader
                  group={group}
                  collapsed={collapsed}
                  onToggle={() => toggleProjectGroup(key)}
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
        {projects.length === 0 ? (
          <div className="workspace-list__empty"><strong>No projects yet</strong><span>Add a local folder, then manage its branches and worktrees from the navigator.</span><button className="small-button" onClick={() => void chooseFolder()}><Plus size={12} /> Add project</button></div>
        ) : null}
      </nav>
      <ProjectRailToolbar onOpenSettings={onOpenSettings} />
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

/**
 * 一个 Project 分组的头。
 *
 * ## 它与项目行的区别是**角色**，不是字号
 *
 * 用户报告分组头与项目行「太接近」。原因不在字号（它已经比项目名小一档）：两者从**同一条左缘**
 * 起排、同一个 `--text-3`，于是扫下来像同一列表里深浅不同的两行。而密度合同又明确禁止把分组头
 * 做得更醒目——父目录名比项目名还响是更糟的错。
 *
 * 所以区分走三件不占视觉重量的事：**它是个 disclosure 控件**（左侧一枚 chevron，项目行没有）、
 * 标签**转成大写字距展开**的分类学写法（与 `Projects` 那条 section 头同族，明确"我是标签不是条目"）、
 * 以及它**不占项目行的左缘**——chevron 在缩进槽里，项目名的左缘因此仍是那一条唯一的读取线。
 *
 * ## 折叠就是那个"操作"
 *
 * 用户还问「分组上面是不是应该有些操作」。折叠是这个位置唯一说得通的动作：分组是从磁盘路径**派生**
 * 的，不是一个可以被重命名、删除、配置的实体——给它挂"重命名分组"就是凭空发明一个注册表。而
 * 折叠答的是真实需求：rail 上项目一多，不看的那几组该能收起来。
 *
 * ## 折起来之后必须自己答出身份
 *
 * 用户第三问「后退的时候，是不是应该显示它的地址之类的元信息呀」——折叠正是那个"后退"。成员一藏，
 * 这一行就成了那几个项目在界面上唯一的痕迹，于是它必须补出：地址（尾部三段，见
 * {@link railGroupAddress}）与成员数。
 *
 * 且必须把**注意力**一起卷上来。`rowAttention` 的注释记着上一次同样的错：项目行只显示 workspace
 * 计数时，「一个 Agent 正在里面等你」的折叠项目看起来和空闲的一模一样。分组折叠会在**分组这一层**
 * 原样复现这个洞，所以这里复用同一个 rollup，而不是只显示一个成员数。
 */
function GroupHeader({
  group,
  collapsed,
  onToggle
}: {
  group: ProjectRailGroup
  collapsed: boolean
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
    <div className="project-rail-entry">
    <button
      type="button"
      className="project-rail-group__header"
      // 名字里带上"这是个分组"和它领了几个：读屏用户拿到的不能只是一个目录名，否则它和项目行
      // 在听觉上才真的无从区分。
      aria-label={[group.label, memberLabel, ...(attentionLabel ? [attentionLabel] : [])].join(' · ')}
      aria-expanded={!collapsed}
      title={[group.groupPath, memberLabel, ...(workingLabel ? [workingLabel] : []), ...(idleLabel ? [idleLabel] : [])]
        .filter(Boolean)
        .join(' · ')}
      onClick={onToggle}
    >
      <span className="project-rail-group__chevron" aria-hidden="true">
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
      </span>
      <Folders size={13} aria-label="Automatic path group" /><span className="project-rail-group__label">{group.label}</span>
      {/* 地址只在折起来时出现。展开时下面那几行项目名已经把"这是哪儿"答完了，再挂一条路径
          就是同一个事实占两行——而折起来后它是唯一的线索。 */}
      {collapsed && group.groupPath ? (
        <span className="project-rail-group__address">{railGroupAddress(group.groupPath)}</span>
      ) : null}
    </button>
    {collapsed ? <ProjectActivity sessions={groupSessions} contexts={activityContextsForWorkspaces(group.nodes.flatMap((node) => node.project.workspaces))} /> : null}
    </div>
  )
}
