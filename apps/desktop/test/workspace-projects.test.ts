import { win32 as _hygiene_win32 } from "node:path"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import type { WorkspaceRecord } from '../src/shared/contracts'
import {
  defaultWorktreePath,
  projectWorkspaces,
  workspaceProjectId
} from '../src/renderer/src/lib/workspace-projects'

describe('workspace projects', () => {
  it('groups a project folder and its worktrees by host and repository path', () => {
    const workspaces: WorkspaceRecord[] = [
      { id: 'root', name: 'AgentMux', hostId: 'local', path: _hygiene_fixturePath("repo/agentmux"), kind: 'folder' },
      {
        id: 'feature',
        name: 'feature-a',
        hostId: 'local',
        path: _hygiene_fixturePath("repo/agentmux.worktrees/feature-a"),
        kind: 'worktree',
        repoPath: _hygiene_fixturePath("repo/agentmux"),
        branch: 'feature/a'
      },
      {
        id: 'remote',
        name: 'feature-a',
        hostId: 'studio',
        path: _hygiene_fixturePath("repo/agentmux.worktrees/feature-a"),
        kind: 'worktree',
        repoPath: _hygiene_fixturePath("repo/agentmux"),
        branch: 'feature/a'
      }
    ]

    const projects = projectWorkspaces(workspaces)

    expect(projects).toHaveLength(2)
    expect(projects[0]).toMatchObject({
      name: 'AgentMux',
      hostId: 'local',
      repoPath: _hygiene_fixturePath("repo/agentmux"),
      preferredWorkspaceId: 'root'
    })
    expect(projects[0]?.workspaces.map((workspace) => workspace.id)).toEqual(['root', 'feature'])
    expect(workspaceProjectId(workspaces[0]!)).toBe(workspaceProjectId(workspaces[1]!))
    expect(workspaceProjectId(workspaces[2]!)).not.toBe(workspaceProjectId(workspaces[0]!))
  })

  it('derives host-neutral sibling worktree paths without leaking branch separators', () => {
    expect(defaultWorktreePath(_hygiene_fixturePath("repo/agentmux"), 'feature/new-tab')).toBe(
      _hygiene_fixturePath("repo/agentmux.worktrees/feature-new-tab")
    )
    expect(defaultWorktreePath(_hygiene_win32.join("C:", _hygiene_win32.sep, "repo\\agentmux"), 'fix/ui')).toBe(
      _hygiene_win32.join("C:", _hygiene_win32.sep, "repo\\agentmux.worktrees\\fix-ui")
    )
  })
})
