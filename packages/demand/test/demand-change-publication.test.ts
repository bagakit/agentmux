import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-demand-owner-')); roots.push(root)
  return { root, store: openDemandStore({ root }) }
}

it('publishes exact changed Goal identities for create, update and delete without including unrelated Goals', async () => {
  const { store } = await fixture()
  await store.create({ id: 'unrelated', title: 'Same title' })
  const changes: Array<{ revision: number; ids: string[] }> = []
  const unsubscribe = store.subscribe((snapshot, changedGoalIds) => changes.push({ revision: snapshot.revision, ids: [...changedGoalIds] }))
  const first = await store.create({ id: 'first', title: 'Same title' })
  const second = await store.create({ id: 'second', title: 'Same title' })
  const updated = await store.update('first', { description: 'Original changed content' })
  const removed = await store.delete('second')
  expect(changes).toEqual([
    { revision: first.revision, ids: ['first'] }, { revision: second.revision, ids: ['second'] },
    { revision: updated.revision, ids: ['first'] }, { revision: removed.revision, ids: ['second'] }
  ])
  expect((await store.list()).map(goal => goal.id)).toEqual(['unrelated', 'first'])
  unsubscribe()
  await store.update('first', { description: 'Later independent content' })
  expect(changes).toHaveLength(4)
})
