import { describe, expect, it } from 'vitest'
import type {
  SessionSnapshot,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../src/shared/contracts.js'
import {
  buildProjectBranchLanes,
  buildProjectInbox,
  filterProjectBranchLanes
} from '../src/renderer/src/lib/project-board.js'

const main: WorkspaceRecord = {
  id: 'main',
  name: 'repo',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

const feature: WorkspaceRecord = {
  id: 'feature',
  name: 'feature/ui',
  hostId: 'local',
  path: '/repo.worktrees/feature-ui',
  kind: 'worktree',
  repoPath: '/repo',
  branch: 'feature/ui'
}

const snapshot: WorkspaceBranchesSnapshot = {
  hostId: 'local',
  repoPath: '/repo',
  branches: [
    { name: 'main', worktreePath: '/repo', workspaceId: 'main', isCurrent: true },
    {
      name: 'feature/ui',
      worktreePath: '/repo.worktrees/feature-ui',
      workspaceId: 'feature',
      isCurrent: false
    },
    { name: 'feature/unbound', worktreePath: null, workspaceId: null, isCurrent: false }
  ]
}

function session(overrides: Partial<SessionSnapshot> & Pick<SessionSnapshot, 'id'>): SessionSnapshot {
  return {
    id: overrides.id,
    tmuxSession: `agentmux-${overrides.id}`,
    kind: 'agent',
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    label: overrides.id,
    createdAt: 100,
    updatedAt: 200,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 200 },
    terminalSnapshot: '',
    ...overrides
  } as SessionSnapshot
}

describe('Project Branch board projection', () => {
  it('uses Git branches as lane identity and keeps Agent state as lane metadata', () => {
    const lanes = buildProjectBranchLanes(snapshot, [main, feature], [
      session({ id: 'main-run' }),
      session({
        id: 'feature-run',
        workspacePath: feature.path,
        status: {
          state: 'waiting',
          source: 'native-hook',
          observedAt: 210,
          detail: 'Approval required'
        }
      })
    ])

    expect(lanes.map((lane) => lane.branch.name)).toEqual([
      'main',
      'feature/ui',
      'feature/unbound'
    ])
    expect(lanes.find((lane) => lane.branch.name === 'feature/ui')).toMatchObject({
      workspace: feature,
      activity: 'attention'
    })
    expect(lanes.find((lane) => lane.branch.name === 'feature/unbound')).toMatchObject({
      workspace: null,
      activity: 'idle',
      sessions: []
    })
  })

  it('does not leak sessions from another Project with a different Workspace path', () => {
    const lanes = buildProjectBranchLanes(snapshot, [main, feature], [
      session({ id: 'other-project', workspacePath: '/other-repo' })
    ])
    expect(lanes.every((lane) => lane.sessions.length === 0)).toBe(true)
  })

  it('filters only the projected Project lanes by query, activity, and binding', () => {
    const lanes = buildProjectBranchLanes(snapshot, [main, feature], [
      session({
        id: 'feature-run',
        workspacePath: feature.path,
        status: { state: 'disconnected', source: 'tmux', observedAt: 220 }
      })
    ])
    expect(filterProjectBranchLanes(lanes, 'feature', 'all', 'all')).toHaveLength(2)
    expect(filterProjectBranchLanes(lanes, '', 'attention', 'bound').map((lane) => lane.branch.name)).toEqual(['feature/ui'])
    expect(filterProjectBranchLanes(lanes, '', 'all', 'unbound').map((lane) => lane.branch.name)).toEqual(['feature/unbound'])
  })

  it('builds Inbox only from real attention Session states in update order', () => {
    const lanes = buildProjectBranchLanes(snapshot, [main, feature], [
      session({ id: 'working', updatedAt: 400 }),
      session({
        id: 'blocked',
        updatedAt: 300,
        status: { state: 'blocked', source: 'native-hook', observedAt: 300 }
      }),
      session({
        id: 'disconnected',
        workspacePath: feature.path,
        updatedAt: 500,
        status: { state: 'disconnected', source: 'tmux', observedAt: 500 }
      })
    ])

    expect(buildProjectInbox(lanes).map((item) => item.id)).toEqual(['disconnected', 'blocked'])
  })
})
