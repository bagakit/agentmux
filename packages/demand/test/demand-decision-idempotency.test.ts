import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

it('replays an explicit Decision identity from disk and rejects changed content or author without rewriting it', async () => {
  const { root, store } = await fixture()
  await store.create({ id: 'goal', title: 'Original Goal' })
  const decision = { id: 'original-decision', question: 'Which source?', decision: 'Use the original owner.', rationale: 'Keep one fact.', actorId: 'original-author' }
  const first = await store.addDecision('goal', decision)
  const originalBytes = await readFile(store.storePath, 'utf8')
  const reopened = openDemandStore({ root })
  const changes: string[][] = []
  reopened.subscribe((_snapshot, ids) => changes.push([...ids]))
  const replay = await reopened.addDecision('goal', { ...decision })
  expect(replay).toMatchObject({ replayed: true, revision: first.revision, demand: first.demand })
  expect(await readFile(store.storePath, 'utf8')).toBe(originalBytes)
  for (const patch of [{ question: 'Another question' }, { decision: 'Another decision' }, { rationale: 'Another rationale' }, { actorId: 'another-author' }]) {
    await expect(reopened.addDecision('goal', { ...decision, ...patch })).rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
    expect(await readFile(store.storePath, 'utf8')).toBe(originalBytes)
  }
  expect((await openDemandStore({ root }).get('goal'))?.decisions).toEqual(first.demand.decisions)
  expect(changes).toEqual([])
})
