import { describe, expect, it } from 'vitest'
import { SCRATCH_WORKSPACE_ID, type WorkspaceRecord } from '../src/shared/contracts'
import {
  PROJECT_RAIL_MAX_DEPTH,
  defaultWorktreePath,
  projectRailNavigation,
  projectRailTree,
  projectWorkspaces,
  workspaceProjectId
} from '../src/renderer/src/lib/workspace-projects'

describe('workspace projects', () => {
  it('pins Scratch outside the repository project projection regardless of config order', () => {
    const scratch: WorkspaceRecord = {
      id: SCRATCH_WORKSPACE_ID,
      name: 'Scratch',
      hostId: 'local',
      path: '/data/scratch',
      kind: 'folder'
    }
    const project: WorkspaceRecord = {
      id: 'project',
      name: 'AgentMux',
      hostId: 'local',
      path: '/repo/agentmux',
      kind: 'folder'
    }

    const navigation = projectRailNavigation([project, scratch])

    expect(navigation.scratch).toBe(scratch)
    expect(navigation.projects).toHaveLength(1)
    expect(navigation.projects[0]?.workspaces).toEqual([project])
  })

  it('groups a project folder and its worktrees by host and repository path', () => {
    const workspaces: WorkspaceRecord[] = [
      { id: 'root', name: 'AgentMux', hostId: 'local', path: '/repo/agentmux', kind: 'folder' },
      {
        id: 'feature',
        name: 'feature-a',
        hostId: 'local',
        path: '/repo/agentmux/.worktrees/feature-a',
        kind: 'worktree',
        repoPath: '/repo/agentmux',
        branch: 'feature/a'
      },
      {
        id: 'remote',
        name: 'feature-a',
        hostId: 'studio',
        path: '/repo/agentmux/.worktrees/feature-a',
        kind: 'worktree',
        repoPath: '/repo/agentmux',
        branch: 'feature/a'
      }
    ]

    const projects = projectWorkspaces(workspaces)

    expect(projects).toHaveLength(2)
    expect(projects[0]).toMatchObject({
      name: 'AgentMux',
      hostId: 'local',
      repoPath: '/repo/agentmux',
      preferredWorkspaceId: 'root'
    })
    expect(projects[0]?.workspaces.map((workspace) => workspace.id)).toEqual(['root', 'feature'])
    expect(workspaceProjectId(workspaces[0]!)).toBe(workspaceProjectId(workspaces[1]!))
    expect(workspaceProjectId(workspaces[2]!)).not.toBe(workspaceProjectId(workspaces[0]!))
  })

  it('derives host-neutral worktree paths inside the project without leaking branch separators', () => {
    expect(defaultWorktreePath('/repo/agentmux', 'feature/new-tab')).toBe(
      '/repo/agentmux/.worktrees/feature-new-tab'
    )
    expect(defaultWorktreePath('C:\\repo\\agentmux', 'fix/ui')).toBe(
      'C:\\repo\\agentmux\\.worktrees\\fix-ui'
    )
  })

  it('nests the worktree inside the project rather than beside it as a sibling directory', () => {
    const path = defaultWorktreePath('/repo/agentmux', 'feature/a')
    // The separator before `.worktrees` is the whole fix: it keeps the worktree under the project
    // (covered by its .gitignore, its file tree, its moves) instead of at `/repo/agentmux.worktrees/...`.
    expect(path).toBe('/repo/agentmux/.worktrees/feature-a')
    expect(path.startsWith('/repo/agentmux/')).toBe(true)
    expect(path).not.toBe('/repo/agentmux.worktrees/feature-a')
  })
})

describe('project rail tree', () => {
  function folder(name: string, path: string, hostId = 'local'): WorkspaceRecord {
    return { id: name, name, hostId, path, kind: 'folder' }
  }

  /** 把树压成一份可读的快照：每行 `<缩进><名字>`，分组头写成 `[label]`。 */
  function outline(records: WorkspaceRecord[]): string[] {
    const lines: string[] = []
    for (const group of projectRailTree(projectWorkspaces(records))) {
      if (group.label) lines.push(`[${group.label}]`)
      for (const node of group.nodes) lines.push(`${'  '.repeat(node.depth)}${node.project.name}`)
    }
    return lines
  }

  it('groups siblings under their common parent directory but leaves a lone project flat', () => {
    // 用户：「假设两个 projects 在同一个目录下，就在界面中显示它们的分组」。
    // 单例不成组是这条的另一半：实测用户真实的 10 个 Project 派生出 6 个共同父目录，其中
    // 4 个只领一个成员——不设这条，一半的项目会各自顶着一个只领一人的标题，那是纯噪音。
    expect(outline([
      folder('agentmux', '/proj/bagakit/agentmux'),
      folder('avatars', '/proj/bagakit/avatars'),
      folder('besql', '/proj/solo/besql')
    ])).toEqual(['[bagakit]', 'agentmux', 'avatars', 'besql'])
  })

  it('indents a project that truly lives inside another, attaching it to the deepest ancestor', () => {
    // 用户：「如果某个 project 是在另一个 project 目录结构的子结构里面……向前缩进，形成一个树结构」。
    // 挂到最深的祖先：把 leaf 挂到 outer 而不是 mid，中间那层就凭空消失了。
    expect(outline([
      folder('outer', '/w/outer'),
      folder('mid', '/w/outer/mid'),
      folder('leaf', '/w/outer/mid/leaf'),
      folder('sibling', '/w/sibling')
    ])).toEqual(['[w]', 'outer', '  mid', '    leaf', 'sibling'])
  })

  it('treats a name-prefix neighbour as a sibling, not as a nested child', () => {
    // `…/agentmux-preview` 以 `…/agentmux` 开头但不在它**里面**。裸 startsWith 会把它错判成
    // 子节点——这类错判只在名字恰好是前缀时发生，抽查很难撞上，所以单独钉一条。
    expect(outline([
      folder('agentmux', '/proj/agentmux'),
      folder('agentmux-preview', '/proj/agentmux-preview')
    ])).toEqual(['[proj]', 'agentmux', 'agentmux-preview'])
  })

  it('never groups the same path across hosts', () => {
    // 路径字符串一样不代表是同一个地方；跨 host 混排会让用户点错机器。两个单例组，不是一组两员。
    const groups = projectRailTree(projectWorkspaces([
      folder('local-a', '/proj/a', 'local'),
      folder('remote-a', '/proj/a', 'studio')
    ]))
    expect(groups.map((group) => group.hostId).sort()).toEqual(['local', 'studio'])
    expect(groups.every((group) => group.nodes.length === 1)).toBe(true)
    expect(groups.every((group) => group.label === null)).toBe(true)
  })

  it('keeps worktrees out of the tree even though they live inside the repository directory', () => {
    // `defaultWorktreePath` 把 worktree 放在 `<repo>/.worktrees/<branch>`，它天然是子目录。
    // 但它已经是所属 Project 的一个 Workspace——再按路径把它变成子节点，同一个东西就有了
    // 两套嵌套，用户无从判断该点哪个（交互合同：归属只有一种表达）。
    const repo = folder('agentmux', '/proj/agentmux')
    const worktree: WorkspaceRecord = {
      id: 'wt',
      name: 'feature',
      hostId: 'local',
      path: defaultWorktreePath('/proj/agentmux', 'feature'),
      kind: 'worktree',
      repoPath: '/proj/agentmux',
      branch: 'feature'
    }
    const groups = projectRailTree(projectWorkspaces([repo, worktree]))
    const nodes = groups.flatMap((group) => group.nodes)
    // 一个节点，深度 0——worktree 没有变成第二个节点，也没有把 repo 推成父节点。
    expect(nodes.map((node) => [node.project.name, node.depth])).toEqual([['agentmux', 0]])
    expect(nodes[0]?.project.workspaces.map((workspace) => workspace.id)).toEqual(['agentmux', 'wt'])
  })

  it('caps the indent so a deep directory cannot squeeze the title away', () => {
    const deep = outline([
      folder('l0', '/w/l0'),
      folder('l1', '/w/l0/l1'),
      folder('l2', '/w/l0/l1/l2'),
      folder('l3', '/w/l0/l1/l2/l3'),
      folder('l4', '/w/l0/l1/l2/l3/l4')
    ])
    expect(PROJECT_RAIL_MAX_DEPTH).toBe(3)
    // 第 5 层与第 4 层同缩进：封顶之后不再继续吃标题宽度，但顺序仍然表达了归属。
    // 没有分组头：这一组虽有 5 个节点，但只有 l0 真的位于 `/w`——其余四个是它的子孙，
    // 归属已由缩进表达。成组与否数的是**顶层**成员，不是节点总数。
    expect(deep).toEqual(['l0', '  l1', '    l2', '      l3', '      l4'])
  })
})
