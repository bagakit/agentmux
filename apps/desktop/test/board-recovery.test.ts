import { describe, expect, it } from 'vitest'
import { projectBoardTasks } from '../src/renderer/src/lib/global-task-board.js'

describe('Board recovery projection', () => {
  it('keeps a persisted Task when its Session is temporarily unavailable', () => {
    const task = { id: 'task:recover', title: 'Recover', description: '', status: 'working' as const, priority: 'normal' as const, projectId: 'repo', projectName: 'Repo', sessionIds: ['gone'], createdAt: 1, updatedAt: 2, source: 'default-topic' as const }
    const projection = projectBoardTasks({ workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: '/repo', kind: 'folder' }] } as never, [], { [task.id]: task })
    expect(projection[0]?.id).toBe(task.id)
    expect(projection[0]?.sessions).toEqual([])
  })
})
