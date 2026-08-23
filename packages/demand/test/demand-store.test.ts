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
  it('stores a demand with zero or multiple session links and explicit project/executor links', async () => {
    const root = await tempRoot()
    const store = openDemandStore({ root })
    const first = await store.create({ id: 'd-zero', title: 'No session yet' })
    expect(first.demand.sessionIds).toEqual([])
    await store.linkProject('d-zero', 'project-a', 'Project A')
    await store.update('d-zero', { executorId: 'executor-a', status: 'in_progress' })
    await store.linkSession('d-zero', 'session-1')
    await store.linkSession('d-zero', 'session-2')
    await store.addActivity('d-zero', { kind: 'note', message: 'started', actorId: null })
    await store.addDecision('d-zero', { question: 'Which path?', decision: 'Use filesystem', rationale: 'Shared fact', actorId: null })

    const loaded = await store.get('d-zero')
    expect(loaded).toMatchObject({
      status: 'in_progress',
      projectId: 'project-a',
      executorId: 'executor-a',
      sessionIds: ['session-1', 'session-2'],
    })
    expect(loaded?.activities).toHaveLength(1)
    expect(loaded?.decisions).toHaveLength(1)

    const raw = JSON.parse(await readFile(path.join(root, 'store.json'), 'utf8')) as DemandStoreSnapshot
    expect(raw.schema).toBe(DEMAND_STORE_SCHEMA)
    expect(raw.revision).toBe(7)
    expect(raw.demands).toHaveLength(1)
  })

  it('publishes immutable snapshots to subscribers and removes a demand explicitly', async () => {
    const root = await tempRoot()
    const store = openDemandStore({ root })
    const revisions: number[] = []
    store.subscribe((snapshot) => revisions.push(snapshot.revision))
    await store.create({ id: 'd-1', title: 'One' })
    await store.remove('d-1')
    expect(revisions).toEqual([1, 2])
    expect(await store.list()).toEqual([])
  })
})
