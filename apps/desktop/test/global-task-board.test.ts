import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { demandColumns, projectDemands } from '../src/renderer/src/lib/global-task-board.js'

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
  it('does not create Board cards from unclaimed Sessions', () => {
    expect(projectDemands(config, [session('1', 'working')], {})).toEqual([])
  })

  it('does not erase a persisted task when its Session temporarily disappears', () => {
    const tasks = projectDemands(config, [], {
      'task:one': {
        id: 'task:one', title: 'Recover after restart', description: '', status: 'in_progress', priority: 'normal',
        projectId: 'repo', projectName: 'Repo', sessionIds: ['missing-session'], createdAt: 1, updatedAt: 2, source: 'default-topic'
      }
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.sessionIds).toEqual(['missing-session'])
    expect(tasks[0]?.sessions).toEqual([])
  })

  it('projects multiple explicitly linked Sessions under one requirement', () => {
    const tasks = projectDemands(config, [session('1', 'working'), session('2', 'working')], {
      'task:mine': { id: 'task:mine', title: 'Ship the board', description: '', status: 'in_progress', priority: 'normal', projectId: 'repo', projectName: 'Repo', sessionIds: ['1', '2'], createdAt: 1, updatedAt: 20, source: 'default-topic' }
    })
    expect(tasks.map((task) => task.id)).toEqual(['task:mine'])
    expect(tasks[0]?.sessions.map((entry) => entry.id)).toEqual(['1', '2'])
  })
})
