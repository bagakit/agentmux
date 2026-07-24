import { describe, expect, it } from 'vitest'
import type { WorkspaceBranchesSnapshot } from '../src/shared/contracts.js'
import {
  visibleWorkspaceBranchesState,
  type WorkspaceBranchesRequestState
} from '../src/renderer/src/lib/workspace-branches-state.js'

const snapshot: WorkspaceBranchesSnapshot = {
  kind: 'git-repository',
  hostId: 'local',
  repoPath: '/repo-a',
  branches: [
    { name: 'main', worktreePath: '/repo-a', workspaceId: 'workspace-a', isCurrent: true }
  ]
}

describe('Workspace Branch snapshot identity', () => {
  it('hides the previous Workspace snapshot on the synchronous Project-switch render', () => {
    const previous: WorkspaceBranchesRequestState = {
      workspaceId: 'workspace-a',
      snapshot,
      loading: false,
      error: 'stale error'
    }

    expect(visibleWorkspaceBranchesState('workspace-b', previous)).toEqual({
      snapshot: null,
      loading: true,
      error: null
    })
    expect(visibleWorkspaceBranchesState('workspace-a', previous)).toEqual({
      snapshot,
      loading: false,
      error: 'stale error'
    })
  })

  it('shows no loading or stale data when no Workspace is selected', () => {
    expect(visibleWorkspaceBranchesState(null, {
      workspaceId: 'workspace-a',
      snapshot,
      loading: false,
      error: null
    })).toEqual({ snapshot: null, loading: false, error: null })
  })

  it('keeps a non-Git folder snapshot on the normal success path', () => {
    const nonGitSnapshot: WorkspaceBranchesSnapshot = {
      kind: 'not-a-git-repository',
      hostId: 'remote',
      workspacePath: '/srv/plain-folder'
    }

    expect(visibleWorkspaceBranchesState('plain-folder', {
      workspaceId: 'plain-folder',
      snapshot: nonGitSnapshot,
      loading: false,
      error: null
    })).toEqual({ snapshot: nonGitSnapshot, loading: false, error: null })
  })
})
