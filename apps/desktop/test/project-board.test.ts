import { describe, expect, it } from 'vitest'
import type {
  SessionSnapshot,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../src/shared/contracts.js'
import {
  PROJECT_BOARD_COLUMNS,
  buildProjectBranchLanes,
  filterProjectBranchLanes,
  sessionBoardColumn
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
  kind: 'git-repository',
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
    kind: 'agent',
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    label: overrides.id,
    createdAt: 100,
    updatedAt: 200,
    processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 200 },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: 'local',
      agentSessionId: overrides.id,
      run: { runId: overrides.id, incarnationId: `${overrides.id}-incarnation` }
    },
    ...overrides
  } as SessionSnapshot
}

describe('Project Branch × Status board projection', () => {
  it('defines the horizontal columns explicitly and maps every Session state', () => {
    expect(PROJECT_BOARD_COLUMNS).toEqual(['inbox', 'working', 'needs-you', 'done'])
    expect(sessionBoardColumn(session({ id: 'starting', status: { state: 'starting', source: 'run-process', observedAt: 1 } }))).toBe('working')
    expect(sessionBoardColumn(session({ id: 'working' }))).toBe('working')
    expect(sessionBoardColumn(session({ id: 'waiting', status: { state: 'waiting', source: 'native-hook', observedAt: 1 } }))).toBe('needs-you')
    expect(sessionBoardColumn(session({ id: 'done', status: { state: 'done', source: 'native-hook', observedAt: 1 } }))).toBe('done')
    expect(sessionBoardColumn(session({ id: 'exited', status: { state: 'exited', source: 'run-process', observedAt: 1 } }))).toBe('done')
  })

  it('uses Branches as stable rows and groups Runs into status cells', () => {
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
    expect(lanes.find((lane) => lane.branch.name === 'main')?.runsByColumn.working.map((run) => run.id)).toEqual(['main-run'])
    expect(lanes.find((lane) => lane.branch.name === 'feature/ui')).toMatchObject({ workspace: feature })
    expect(lanes.find((lane) => lane.branch.name === 'feature/ui')?.runsByColumn['needs-you'].map((run) => run.id)).toEqual(['feature-run'])
    expect(lanes.find((lane) => lane.branch.name === 'feature/unbound')).toMatchObject({ workspace: null, sessions: [] })
  })

  it('moves a status update horizontally without changing its Branch row', () => {
    const working = buildProjectBranchLanes(snapshot, [main, feature], [
      session({ id: 'feature-run', workspacePath: feature.path })
    ])
    const waiting = buildProjectBranchLanes(snapshot, [main, feature], [
      session({
        id: 'feature-run',
        workspacePath: feature.path,
        status: { state: 'blocked', source: 'native-hook', observedAt: 300 }
      })
    ])

    expect(working[1]?.branch.name).toBe('feature/ui')
    expect(working[1]?.runsByColumn.working.map((run) => run.id)).toEqual(['feature-run'])
    expect(waiting[1]?.branch.name).toBe('feature/ui')
    expect(waiting[1]?.runsByColumn['needs-you'].map((run) => run.id)).toEqual(['feature-run'])
  })

  it('sorts each status cell by the most recently updated Run', () => {
    const lanes = buildProjectBranchLanes(snapshot, [main, feature], [
      session({ id: 'older', updatedAt: 200 }),
      session({ id: 'newer', updatedAt: 400 })
    ])
    expect(lanes[0]?.runsByColumn.working.map((run) => run.id)).toEqual(['newer', 'older'])
  })

  it('does not leak Sessions from another Project path', () => {
    const lanes = buildProjectBranchLanes(snapshot, [main, feature], [
      session({ id: 'other-project', workspacePath: '/other-repo' })
    ])
    expect(lanes.every((lane) => lane.sessions.length === 0)).toBe(true)
  })

  it('projects no Branch lanes for a non-Git folder', () => {
    expect(buildProjectBranchLanes({
      kind: 'not-a-git-repository',
      hostId: 'local',
      workspacePath: '/plain-folder'
    }, [main], [session({ id: 'plain-run', workspacePath: '/plain-folder' })])).toEqual([])
  })

  it('filters Project rows by query, status column, and Worktree binding', () => {
    const lanes = buildProjectBranchLanes(snapshot, [main, feature], [
      session({
        id: 'feature-run',
        workspacePath: feature.path,
        status: { state: 'disconnected', source: 'run-process', observedAt: 220 }
      })
    ])
    expect(filterProjectBranchLanes(lanes, 'feature', 'all', 'all')).toHaveLength(2)
    expect(filterProjectBranchLanes(lanes, '', 'needs-you', 'bound').map((lane) => lane.branch.name)).toEqual(['feature/ui'])
    expect(filterProjectBranchLanes(lanes, '', 'inbox', 'all').map((lane) => lane.branch.name)).toEqual(['main', 'feature/ui'])
    expect(filterProjectBranchLanes(lanes, '', 'all', 'unbound').map((lane) => lane.branch.name)).toEqual(['feature/unbound'])
  })
})
