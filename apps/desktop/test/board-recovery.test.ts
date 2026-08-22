import { describe, expect, it } from 'vitest'
import { projectDemands } from '../src/renderer/src/lib/global-task-board.js'

describe('Board recovery projection', () => {
  it('keeps a persisted Task when its Session is temporarily unavailable', () => {
    const task = { id: 'task:recover', title: 'Recover', description: '', status: 'in_progress' as const, priority: 'normal' as const, projectId: 'repo', projectName: 'Repo', sessionIds: ['gone'], createdAt: 1, updatedAt: 2, source: 'default-topic' as const }
    const projection = projectDemands({ workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: '/repo', kind: 'folder' }] } as never, [], { [task.id]: task })
    expect(projection[0]?.id).toBe(task.id)
    expect(projection[0]?.sessions).toEqual([])
  })
})
