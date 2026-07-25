import { describe, expect, it } from 'vitest'
import type {
  SessionSnapshot,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../src/shared/contracts.js'
import {
  PROJECT_BOARD_COLUMNS,
  buildProjectBranchLanes,
  buildTopicBoardRows,
  filterBoardRows,
  sessionBoardColumn
} from '../src/renderer/src/lib/project-board.js'
import {
  SCRATCH_WORKSPACE_ID,
  scratchTopicDirectoryName,
  type ScratchTopicSnapshot
} from '../src/shared/scratch-topics.js'

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
    providerId: 'codex',
    executorId: 'codex',
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
      run: { runId: overrides.id }
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
    expect(filterBoardRows(lanes, 'feature', 'all', 'all')).toHaveLength(2)
    expect(filterBoardRows(lanes, '', 'needs-you', 'bound').map((lane) => lane.branch.name)).toEqual(['feature/ui'])
    expect(filterBoardRows(lanes, '', 'inbox', 'all').map((lane) => lane.branch.name)).toEqual(['main', 'feature/ui'])
    expect(filterBoardRows(lanes, '', 'all', 'unbound').map((lane) => lane.branch.name)).toEqual(['feature/unbound'])
  })
})

// ---------------------------------------------------------------------------
// 行来源参数化：Scratch 的一行是 Topic，Git 项目的一行是 Branch，但两者经**同一套**列、
// 同一个状态归类、同一个筛选器。这些用例钉住的是「只有一个 Board」——为 Topic 复制一份列定义
// 或一份状态归类，会让下面对照 Branch 的断言与 `sessionBoardColumn` 的唯一性同时失效。
// ---------------------------------------------------------------------------
const scratch: WorkspaceRecord = {
  id: SCRATCH_WORKSPACE_ID,
  name: 'Scratch',
  hostId: 'local',
  path: '/scratch',
  kind: 'folder'
}

function topicPath(topicId: string): string {
  return `${scratch.path}/${scratchTopicDirectoryName(topicId)}`
}

function topic(id: string, title: string, summary = ''): ScratchTopicSnapshot {
  const directoryPath = scratchTopicDirectoryName(id)
  return { id, directoryPath, topicPath: `${directoryPath}/topic.md`, title, summary, collaborators: [] }
}

describe('Scratch Topic × Status board rows', () => {
  const topics = [topic('view:alpha', 'Alpha goal', 'ship the thing'), topic('view:beta', 'Beta goal')]

  it('groups Topic Runs through the same column mapping as Branch rows', () => {
    const rows = buildTopicBoardRows(topics, scratch, [
      session({ id: 'alpha-run', workspacePath: topicPath('view:alpha') }),
      session({
        id: 'alpha-waiting',
        workspacePath: topicPath('view:alpha'),
        updatedAt: 300,
        status: { state: 'blocked', source: 'native-hook', observedAt: 300 }
      })
    ])

    const alpha = rows.find((row) => row.id === 'view:alpha')!
    expect(alpha.kind).toBe('topic')
    expect(alpha.name).toBe('Alpha goal')
    expect(alpha.runsByColumn.working.map((run) => run.id)).toEqual(['alpha-run'])
    expect(alpha.runsByColumn['needs-you'].map((run) => run.id)).toEqual(['alpha-waiting'])
    // 每一列的归类都必须与 sessionBoardColumn 给 Branch 的答案逐字相同。
    for (const run of alpha.sessions) {
      expect(alpha.runsByColumn[sessionBoardColumn(run)].map((entry) => entry.id)).toContain(run.id)
    }
    expect(rows.find((row) => row.id === 'view:beta')?.sessions).toEqual([])
  })

  it('always gives a Topic row a path, so its Inbox is never gated on creating a directory', () => {
    expect(buildTopicBoardRows(topics, scratch, []).every((row) => row.path !== null)).toBe(true)
  })

  it('matches Sessions onto the filesystem Topic list and never reverse-derives a Topic', () => {
    const rows = buildTopicBoardRows([topic('view:listed', 'Listed')], scratch, [
      // 磁盘快照里没有的 Topic 目录：不得因此凭空多出一行。
      session({ id: 'ghost', workspacePath: topicPath('view:unlisted') }),
      // 不在任何 Topic 目录里的 Agent：属于 Scratch 根，不属于任何一行。
      session({ id: 'root', workspacePath: scratch.path }),
      // 另一台主机上的同名路径：不是这一行的 Agent。
      session({ id: 'remote', hostId: 'other', workspacePath: topicPath('view:listed') })
    ])
    expect(rows.map((row) => row.id)).toEqual(['view:listed'])
    expect(rows[0]!.sessions).toEqual([])
  })

  it('filters Topic rows with the same filter used for Branch rows', () => {
    const rows = buildTopicBoardRows(topics, scratch, [
      session({
        id: 'beta-run',
        workspacePath: topicPath('view:beta'),
        status: { state: 'waiting', source: 'native-hook', observedAt: 260 }
      })
    ])
    expect(filterBoardRows(rows, 'ship the thing', 'all', 'all').map((row) => row.id)).toEqual(['view:alpha'])
    expect(filterBoardRows(rows, '', 'needs-you', 'all').map((row) => row.id)).toEqual(['view:beta'])
    // Topic 恒有目录，因此在 Inbox 列与 bound 下全部在场，unbound 下一个也没有。
    expect(filterBoardRows(rows, '', 'inbox', 'all')).toHaveLength(2)
    expect(filterBoardRows(rows, '', 'all', 'bound')).toHaveLength(2)
    expect(filterBoardRows(rows, '', 'all', 'unbound')).toEqual([])
  })

  it('renders an honest empty state rather than a zero-row matrix', () => {
    expect(buildTopicBoardRows([], scratch, [session({ id: 'anything' })])).toEqual([])
  })
})
