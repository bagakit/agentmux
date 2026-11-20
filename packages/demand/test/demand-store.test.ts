import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { DEMAND_STORE_SCHEMA, type DemandStoreSnapshot } from '../src/demand-types.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-'))
}

describe('DemandStore', () => {
  it('stores a demand with zero or multiple session links and explicit project and Session assignees', async () => {
    const root = await tempRoot()
    const store = openDemandStore({ root })
    const first = await store.create({ title: 'No session yet' })
    const goalId = first.demand.id
    expect(first.demand.sessionIds).toEqual([])
    await store.linkProject(goalId, 'project-a', 'Project A')
    await store.update(goalId, { assigneeSessionIds: ['session-1'], supervisorSessionId: 'session-1', status: 'in_progress' })
    await store.linkSession(goalId, 'session-1')
    await store.linkSession(goalId, 'session-2')
    await store.addActivity(goalId, { kind: 'note', message: 'started', actorId: null })
    await store.addDecision(goalId, { question: 'Which path?', decision: 'Use filesystem', rationale: 'Shared fact', actorId: null })

    const loaded = await store.get(goalId)
    expect(loaded).toMatchObject({
      status: 'in_progress',
      projectId: 'project-a',
      executorId: null,
      assigneeSessionIds: ['session-1'],
      supervisorSessionId: 'session-1',
      sessionIds: ['session-1', 'session-2'],
    })
    expect(loaded?.activities).toHaveLength(1)
    expect(loaded?.decisions).toHaveLength(1)

    const raw = JSON.parse(await readFile(path.join(root, 'store.json'), 'utf8')) as DemandStoreSnapshot
    expect(raw.schema).toBe(DEMAND_STORE_SCHEMA)
    expect(raw.revision).toBe(7)
    expect(raw.demands).toHaveLength(1)
  })

  it('rejects custom IDs through the public SDK before recording any Goal', async () => {
    const store = openDemandStore({ root: await tempRoot() })
    const legacyInput = { id: 'caller-selected-goal', title: 'Untrusted identity' }
    await expect(store.create(legacyInput)).rejects.toMatchObject({
      code: 'INVALID_INPUT', phase: 'validate', message: 'The Demand owner allocates the ID.'
    })
    expect(await store.snapshot()).toMatchObject({ revision: 0, demands: [] })
  })

  it('publishes immutable snapshots to subscribers and removes a demand explicitly', async () => {
    const root = await tempRoot()
    const store = openDemandStore({ root })
    const revisions: number[] = []
    store.subscribe((snapshot) => revisions.push(snapshot.revision))
    const created = await store.create({ title: 'One' })
    await store.remove(created.demand.id)
    expect(revisions).toEqual([1, 2])
    expect(await store.list()).toEqual([])
  })
})
