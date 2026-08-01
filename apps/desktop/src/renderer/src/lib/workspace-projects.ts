import { isScratchWorkspaceId, type WorkspaceRecord } from '../../../shared/contracts'

export type WorkspaceProject = {
  id: string
  name: string
  hostId: string
  repoPath: string
  workspaces: WorkspaceRecord[]
  preferredWorkspaceId: string
}

export function workspaceProjectId(workspace: WorkspaceRecord): string {
  return JSON.stringify([workspace.hostId, workspace.repoPath ?? workspace.path])
}

/** Remove every registered Workspace that makes up one Project Rail view. */
export function removeProjectWorkspaces(
  workspaces: readonly WorkspaceRecord[],
  project: Pick<WorkspaceProject, 'id' | 'workspaces'>
): WorkspaceRecord[] {
  const removedIds = new Set(project.workspaces.map((workspace) => workspace.id))
  return workspaces.filter((workspace) => !removedIds.has(workspace.id))
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function projectWorkspaces(workspaces: readonly WorkspaceRecord[]): WorkspaceProject[] {
  const projects = new Map<string, WorkspaceProject>()
  for (const workspace of workspaces) {
    const id = workspaceProjectId(workspace)
    const existing = projects.get(id)
    if (existing) {
      existing.workspaces.push(workspace)
      if (workspace.kind === 'folder' && workspace.path === existing.repoPath) {
        existing.preferredWorkspaceId = workspace.id
        existing.name = workspace.name
      }
      continue
    }
    const repoPath = workspace.repoPath ?? workspace.path
    projects.set(id, {
      id,
      name: workspace.kind === 'folder' ? workspace.name : basename(repoPath),
      hostId: workspace.hostId,
      repoPath,
      workspaces: [workspace],
      preferredWorkspaceId: workspace.id
    })
  }
  return [...projects.values()]
}

export function projectRailNavigation(workspaces: readonly WorkspaceRecord[]): {
  scratch: WorkspaceRecord | null
  projects: WorkspaceProject[]
} {
  return {
    scratch: workspaces.find((workspace) => isScratchWorkspaceId(workspace.id)) ?? null,
    projects: projectWorkspaces(
      workspaces.filter((workspace) => !isScratchWorkspaceId(workspace.id))
    )
  }
}

/** 一个 Project 在 rail 上的位置：属于哪一组、缩进几层。 */
export type ProjectRailNode = {
  project: WorkspaceProject
  /** 真嵌套的层数。0 = 顶层；每加一层表示它位于上一层那个 Project 的目录内。 */
  depth: number
}

export type ProjectRailGroup = {
  /** 共同父目录的绝对路径；单例组为 null（不渲染分组头）。 */
  groupPath: string | null
  /** 分组头显示的名字：父目录的最后一段。单例组为 null。 */
  label: string | null
  hostId: string
  nodes: ProjectRailNode[]
}

/** 缩进封顶。再深的目录也不继续吃标题宽度（密度合同《Project Rail Nesting Indent》）。 */
export const PROJECT_RAIL_MAX_DEPTH = 3

function parentPath(path: string): string {
  const root = path.replace(/[\\/]+$/, '')
  const cut = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))
  return cut > 0 ? root.slice(0, cut) : root
}

/**
 * `inner` 是否位于 `outer` 的目录内。
 *
 * 必须补上分隔符再比：裸的 `startsWith` 会把 `…/bagakit/agentmux-preview` 判成
 * `…/bagakit/agentmux` 的子目录，而它其实是兄弟。这类错判在 UI 上表现为"某个项目莫名其妙
 * 缩进到另一个下面"，且只在名字恰好是前缀时发生，抽查很难撞上。
 */
function isInside(inner: string, outer: string): boolean {
  const root = outer.replace(/[\\/]+$/, '')
  return inner.startsWith(`${root}/`) || inner.startsWith(`${root}\\`)
}

/**
 * 把 Project 排成 rail 上的分组树。**只改呈现**——分组与缩进全部从 `path`/`hostId` 派生，
 * 不新增第二份注册表，用户在磁盘上移动目录这棵树就跟着变（交互合同《Project 与 Workspace》）。
 *
 * 三条规则，每条都有它自己的失败模式：
 * - **跨 host 绝不同组**：路径字符串一样不代表是同一个地方，混排会让用户点错机器。
 * - **认最深的祖先**：一个 Project 嵌在多个 Project 里时挂到最深的那个，否则中间层凭空消失。
 * - **单例不成组**：只领一个成员的分组头不携带信息，那个 Project 直接平铺在顶层。
 *
 * worktree 不参与：它已经是所属 Project 的一个 Workspace，按路径再变成子节点，同一个东西
 * 就有了两套嵌套。这里遍历的是 Project（每个 Project 一个 repoPath），worktree 天然不在其中。
 */
export function projectRailTree(projects: readonly WorkspaceProject[]): ProjectRailGroup[] {
  const parentOf = new Map<string, WorkspaceProject>()
  for (const project of projects) {
    let deepest: WorkspaceProject | null = null
    for (const candidate of projects) {
      if (candidate === project || candidate.hostId !== project.hostId) continue
      if (!isInside(project.repoPath, candidate.repoPath)) continue
      if (!deepest || candidate.repoPath.length > deepest.repoPath.length) deepest = candidate
    }
    if (deepest) parentOf.set(project.id, deepest)
  }

  const depthOf = new Map<string, number>()
  function depth(project: WorkspaceProject): number {
    const cached = depthOf.get(project.id)
    if (cached !== undefined) return cached
    const parent = parentOf.get(project.id)
    // 先占位再递归：路径不可能成环，但缓存写在前面可以让"祖先链很长"退化成一次遍历。
    depthOf.set(project.id, 0)
    const value = parent ? Math.min(depth(parent) + 1, PROJECT_RAIL_MAX_DEPTH) : 0
    depthOf.set(project.id, value)
    return value
  }

  // 分组只看顶层 Project：被嵌套的那些跟着它们的祖先走，不另起一组。
  const groups = new Map<string, ProjectRailGroup>()
  for (const project of projects) {
    if (parentOf.has(project.id)) continue
    const groupPath = parentPath(project.repoPath)
    const key = JSON.stringify([project.hostId, groupPath])
    const existing = groups.get(key)
    if (existing) existing.nodes.push({ project, depth: 0 })
    else {
      groups.set(key, {
        groupPath,
        label: basename(groupPath),
        hostId: project.hostId,
        nodes: [{ project, depth: 0 }]
      })
    }
  }

  // 子孙紧跟在自己的祖先后面，缩进表达包含关系。
  for (const group of groups.values()) {
    const ordered: ProjectRailNode[] = []
    const visit = (parent: WorkspaceProject): void => {
      ordered.push({ project: parent, depth: depth(parent) })
      for (const child of projects) {
        if (parentOf.get(child.id) === parent) visit(child)
      }
    }
    for (const node of group.nodes) visit(node.project)
    group.nodes = ordered
  }

  // 单例不成组：分组头只领一个成员时不携带信息，退化成平铺的顶层行。
  // 数的是**顶层**成员（depth 0）而不是节点总数：分组头说的是"这几个共处一个父目录"，
  // 而嵌套的子孙并不在那个父目录里——它们的归属已经由缩进表达了。一个独苗项目底下挂着
  // 一串子项目时，`[父目录]` 这个头同样只领一个成员，同样是噪音。
  return [...groups.values()].map((group) =>
    group.nodes.filter((node) => node.depth === 0).length > 1
      ? group
      : { ...group, groupPath: null, label: null }
  )
}

/**
 * 分组头折叠时显示的地址：保留末尾几段，前面用 `…/` 代替。
 *
 * 折叠把成员藏起来，于是分组头必须自己答出"这是磁盘上哪儿"——展开时那几行项目名就是答案，
 * 折叠后就只剩这一行了（用户：「后退的时候，是不是应该显示它的地址之类的元信息呀」）。
 *
 * 从**末尾**保留而不是从开头：路径越靠后越能区分身份。`/Users/someone/proj/priv/kit` 与
 * 同一台机器上的任何别的路径，前三段大概都一样；分辨力全在尾部。这也是不能用 CSS
 * `text-overflow: ellipsis` 的原因——它只砍尾巴，砍掉的正好是唯一有信息的那一头。
 *
 * 完整路径仍然进 tooltip：这里只缩短显示，不隐藏事实。
 */
export function railGroupAddress(path: string, segments = 3): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return path
  // 用原路径里的分隔符重组，Windows 路径不会被改写成正斜杠。
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  return `…${separator}${parts.slice(-segments).join(separator)}`
}

/** 分组的折叠状态键。跨 host 同名目录不是一个分组，所以 hostId 必须进 key。 */
export function projectGroupKey(group: Pick<ProjectRailGroup, 'hostId' | 'groupPath'>): string | null {
  return group.groupPath === null ? null : JSON.stringify([group.hostId, group.groupPath])
}

export function defaultWorktreePath(repoPath: string, branch: string): string {
  const separator = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/'
  const root = repoPath.replace(/[\\/]+$/, '')
  const segment = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
  // The worktree belongs to this project, so it lives INSIDE it as `<repo>/.worktrees/<segment>`.
  // A separator before `.worktrees` is what keeps it there — without it the path collapses into a
  // sibling `<repo>.worktrees/<segment>`, which the project's .gitignore, moves, and file tree miss.
  return `${root}${separator}.worktrees${separator}${segment}`
}
