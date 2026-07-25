import { describe, expect, it } from 'vitest'
import { SCRATCH_WORKSPACE_ID, type WorkspaceRecord } from '../src/shared/contracts'
import {
  defaultWorktreePath,
  projectRailNavigation,
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
