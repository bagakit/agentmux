import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { boardTaskColumns, boardTaskStatusForSession, projectBoardTasks, projectTaskFromSession } from '../src/renderer/src/lib/global-task-board.js'

const config = {
  workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: '/repo', kind: 'folder' }]
} as AppConfig

function session(id: string, state: SessionSnapshot['status']['state'], processState: SessionSnapshot['processState'] = 'running'): SessionSnapshot {
  return {
    id,
    hostId: 'local',
    workspacePath: '/repo',
    label: `Agent ${id}`,
    createdAt: 10,
    updatedAt: Number(id.replace(/\D/gu, '')) || 1,
    processState,
    latestOutputBytes: 0,
    status: { state, source: 'run-process', observedAt: 10 },
    kind: 'terminal',
    providerId: null,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id, generation: 1 } }
  }
}

describe('global task board projection', () => {
  it('projects session facts into task cards without copying process state', () => {
    const working = session('1', 'working')
    const waiting = session('2', 'waiting')
    expect(boardTaskStatusForSession(working)).toBe('working')
    expect(boardTaskStatusForSession(waiting)).toBe('needs-you')
    expect(projectTaskFromSession(config, working)).toMatchObject({ id: 'session:1', projectId: 'repo', projectName: 'Repo', sessionIds: ['1'] })
  })

  it('keeps durable task records and live session projections in one ordered collection', () => {
    const tasks = projectBoardTasks(config, [session('1', 'working')], {
      'task:one': {
        id: 'task:one', title: 'Write release notes', description: 'Draft the final notes', status: 'inbox', priority: 'high',
        projectId: 'repo', projectName: 'Repo', sessionIds: [], createdAt: 1, updatedAt: 20, source: 'default-topic'
      }
    })
    expect(tasks.map((task) => task.id)).toEqual(['task:one', 'session:1'])
    expect(boardTaskColumns(tasks).inbox).toHaveLength(1)
    expect(boardTaskColumns(tasks).working).toHaveLength(1)
  })

  it('does not erase a persisted task when its Session temporarily disappears', () => {
    const tasks = projectBoardTasks(config, [], {
      'task:one': {
        id: 'task:one', title: 'Recover after restart', description: '', status: 'working', priority: 'normal',
        projectId: 'repo', projectName: 'Repo', sessionIds: ['missing-session'], createdAt: 1, updatedAt: 2, source: 'default-topic'
      }
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.sessionIds).toEqual(['missing-session'])
    expect(tasks[0]?.sessions).toEqual([])
  })

  // 去重的两侧都要钉死。只钉「被认领的那个不再单独出现」会放过「这一类一律不投影」——那种坏法
  // 会把没人认领的 Session 也从看板上抹掉，而它在本用例里同样是绿的。所以同一个 it 里既断言
  // 认领过的被吸收，也断言没认领的仍然在场，并把整个集合 toEqual 钉死而不是写 every/some。
  it('a Session claimed by a hand-written task appears once, and an unclaimed Session still appears', () => {
    const tasks = projectBoardTasks(config, [session('1', 'working'), session('2', 'working')], {
      'task:mine': {
        id: 'task:mine', title: 'Ship the board', description: '', status: 'working', priority: 'normal',
        projectId: 'repo', projectName: 'Repo', sessionIds: ['1'], createdAt: 1, updatedAt: 20, source: 'default-topic'
      }
    })
    expect(tasks.map((task) => task.id)).toEqual(['task:mine', 'session:2'])
    expect(tasks[0]?.sessions.map((entry) => entry.id)).toEqual(['1'])
  })
})
