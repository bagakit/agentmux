import { describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { buildTopicBoardRows } from '../src/renderer/src/lib/project-board.js'

const scratch: WorkspaceRecord = { id: '__scratch__', hostId: 'local', path: '/scratch', name: 'Scratch', kind: 'folder' }
const topic = { id: 'view:load', title: 'Load', summary: '', directoryPath: 'topic--view--load', topicPath: 'topic--view--load/topic.md', collaborators: [] }

describe('dense Topic Board grouping cost', () => {
  it('visits session references a bounded number of times instead of repeatedly copying the growing group', () => {
    const sessions: SessionSnapshot[] = Array.from({ length: 2000 }, (_, i) => ({
      id: String(i), kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/scratch/topic--view--load',
      label: `Run ${i}`, createdAt: i, updatedAt: i, processState: 'running', latestOutputBytes: 0,
      status: { state: 'running', source: 'run-process', observedAt: i },
      control: { kind: 'terminal', hostId: 'local', runId: `run-${i}`, run: { runId: `run-${i}` } }
    }))
    const members = new Set(sessions)
    const originalIterator = Array.prototype[Symbol.iterator]
    let visits = 0
    const iteration = vi.spyOn(Array.prototype, Symbol.iterator).mockImplementation(function (this: unknown[]) {
      const iterator = originalIterator.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        const result = next()
        if (!result.done && members.has(result.value as SessionSnapshot)) visits++
        return result
      }
      return iterator
    })
    let rows: ReturnType<typeof buildTopicBoardRows>
    try { rows = buildTopicBoardRows([topic], scratch, sessions) } finally { iteration.mockRestore() }
    expect(rows![0]!.sessions).toHaveLength(sessions.length)
    expect(rows![0]!.runsByColumn.working[0]!.id).toBe('1999')
    expect(visits).toBeGreaterThan(0)
    expect(visits).toBeLessThanOrEqual(sessions.length * 4)
    expect(sessions[0]!.id).toBe('0')
  })
})
