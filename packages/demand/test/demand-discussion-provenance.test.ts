import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { deriveBoundGoalId } from '../src/goals.js'
import { openDemandStore } from '../src/demand-store.js'
import type { DemandDiscussionIntent } from '../src/discussion.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-demand-owner-')); roots.push(root)
  return { root, store: openDemandStore({ root }) }
}

const intent: DemandDiscussionIntent = {
  requestOperationId: 'original-discussion-request', mode: 'grill', executorId: 'original-executor',
  spaceId: 'original-space', zoneId: 'original-zone', agentMuxNote: 'Original manager context',
  callerAgentSessionId: 'original-caller', prompt: 'Clarify the original Goal.'
}

it('admits a new Goal and its original discussion operation in the same first durable publication', async () => {
  const { root, store } = await fixture()
  const input = { title: 'Original Goal', description: 'Original request' }
  const goalOwner = { runtimeId: 'original-runtime', namespace: 'original-store' }
  const options = { operationId: 'original-create', discussionOperationId: 'original-discussion', creationOrigin: { requesterAsSupervisor: true }, goalOwner }
  const id = deriveBoundGoalId(goalOwner.runtimeId, goalOwner.namespace, options.operationId)
  const publications: Array<{ revision: number; ids: readonly string[]; operationId: string | undefined }> = []
  store.subscribe((snapshot, ids) => publications.push({ revision: snapshot.revision, ids,
    operationId: snapshot.demands.find(goal => goal.id === id)?.discussionOperationId }))
  const first = await store.create(input, options)
  expect(first.demand.id).toBe(id)
  expect(publications).toEqual([{ revision: 1, ids: [id], operationId: options.discussionOperationId }])
  const bytes = await readFile(store.storePath, 'utf8')
  const disk = JSON.parse(bytes)
  expect(disk).toMatchObject({ revision: 1, demands: [{ id, discussionOperationId: options.discussionOperationId,
    creationOrigin: { operationId: options.operationId } }] })
  expect((await openDemandStore({ root }).get(id))?.discussionIntent).toBeUndefined()
  const replay = await openDemandStore({ root }).create(input, options)
  expect(replay).toMatchObject({ replayed: true, revision: first.revision, demand: first.demand })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
})

it('freezes one discussion intent across reopen and rejects another mode, caller or destination on its original operation', async () => {
  const { root, store } = await fixture()
  const created = await store.create({ title: 'Original Goal' }, { discussionOperationId: 'original-discussion' })
  const id = created.demand.id
  const beforePreparation = await readFile(store.storePath, 'utf8')
  await expect(store.prepareDiscussion(id, 'original-discussion', { ...intent, mode: new String('grill') } as never, created.demand.updatedAt))
    .rejects.toThrow('The original Goal discussion intent is invalid.')
  expect(await readFile(store.storePath, 'utf8')).toBe(beforePreparation)
  const prepared = await store.prepareDiscussion(id, 'original-discussion', intent, created.demand.updatedAt)
  const bytes = await readFile(store.storePath, 'utf8'), reopened = openDemandStore({ root })
  const replay = await reopened.prepareDiscussion(id, 'original-discussion', { ...intent }, created.demand.updatedAt)
  expect(replay).toMatchObject({ replayed: true, revision: prepared.revision, demand: prepared.demand })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  for (const patch of [
    { mode: 'grounding' as const }, { callerAgentSessionId: 'another-caller' }, { spaceId: 'another-space' }, { zoneId: 'another-zone' },
    { executorId: 'another-executor' }, { prompt: 'Another input' }, { agentMuxNote: 'Another context' }, { requestOperationId: 'another-request' }
  ]) {
    await expect(reopened.prepareDiscussion(id, 'original-discussion', { ...intent, ...patch }, prepared.demand.updatedAt))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
    expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  }
  await expect(reopened.prepareDiscussion(id, 'another-discussion', intent, prepared.demand.updatedAt))
    .rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  expect((await openDemandStore({ root }).get(id))?.discussionIntent).toEqual(intent)
})

it('requires the original Goal revision before freezing a first discussion intent', async () => {
  const { root, store } = await fixture()
  const created = await store.create({ title: 'Original Goal' }, { discussionOperationId: 'original-discussion' })
  const id = created.demand.id
  const changed = await store.update(id, { description: 'A newer original request' })
  const bytes = await readFile(store.storePath, 'utf8')
  await expect(store.prepareDiscussion(id, 'original-discussion', intent, created.demand.updatedAt))
    .rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  const prepared = await openDemandStore({ root }).prepareDiscussion(id, 'original-discussion', intent, changed.demand.updatedAt)
  expect(prepared.demand).toMatchObject({ description: changed.demand.description, discussionIntent: intent })
})

it('keeps a legacy Goal untouched until an explicit first discussion atomically saves its operation and intent', async () => {
  const { root, store } = await fixture()
  await seedStoredDemand(store, { id: 'retained', title: 'Retained Goal', description: 'Original body', sessionIds: ['original-session'], tags: ['original-tag'] })
  await store.addDecision('retained', { id: 'retained-decision', question: 'Keep which identity?', decision: 'The original one.', rationale: 'Preserve its evidence.', actorId: null })
  const original = await store.get('retained'), bytes = await readFile(store.storePath, 'utf8')
  const reopened = openDemandStore({ root })
  expect(await reopened.get('retained')).toEqual(original)
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  const forgedCreate = { id: 'retained', title: 'Retained Goal' }
  await expect(reopened.create(forgedCreate, {
    operationId: 'another-create', discussionOperationId: 'unobserved-discussion', creationOrigin: { requesterAsSupervisor: true }
  })).rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  await reopened.create({ title: 'New Goal' }, { discussionOperationId: 'new-discussion' })
  expect(await openDemandStore({ root }).get('retained')).toEqual(original)
  expect((await reopened.get('retained'))?.discussionOperationId).toBeUndefined()
  expect((await reopened.get('retained'))?.discussionIntent).toBeUndefined()
  const publications: unknown[] = []
  reopened.subscribe(snapshot => {
    const goal = snapshot.demands.find(value => value.id === 'retained')!
    publications.push({ operationId: goal.discussionOperationId, intent: goal.discussionIntent })
  })
  const prepared = await reopened.prepareDiscussion('retained', 'explicit-discussion', intent, original!.updatedAt)
  expect(publications).toEqual([{ operationId: 'explicit-discussion', intent }])
  const { updatedAt: _old, ...retained } = original!, { updatedAt: _new, discussionOperationId, discussionIntent, ...after } = prepared.demand
  expect(after).toEqual(retained)
  expect(discussionOperationId).toBe('explicit-discussion'); expect(discussionIntent).toEqual(intent)
  expect(prepared.demand.creationOrigin).toBeUndefined(); expect(prepared.demand.supervisorSessionId).toBeNull()
  expect((await openDemandStore({ root }).get('retained'))!.discussionIntent).toEqual(intent)
})

it('concurrent explicit first discussions retain one winner and cannot overwrite it even after reading its new revision', async () => {
  const { root, store } = await fixture(), original = (await seedStoredDemand(store, { id: 'legacy', title: 'Original legacy Goal' })).demand
  const second = { ...intent, requestOperationId: 'second-request', mode: 'plan' as const }
  const results = await Promise.allSettled([
    store.prepareDiscussion('legacy', 'first-operation', intent, original.updatedAt),
    openDemandStore({ root }).prepareDiscussion('legacy', 'second-operation', second, original.updatedAt)
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  const saved = (await store.get('legacy'))!, before = await readFile(store.storePath, 'utf8')
  expect(saved.discussionIntent).toEqual(saved.discussionOperationId === 'first-operation' ? intent : second)
  expect(await store.prepareDiscussion('legacy', saved.discussionOperationId!, saved.discussionIntent!, original.updatedAt)).toMatchObject({ replayed: true })
  expect(await readFile(store.storePath, 'utf8')).toBe(before)
  const loserOperation = saved.discussionOperationId === 'first-operation' ? 'second-operation' : 'first-operation'
  const loserIntent = loserOperation === 'first-operation' ? intent : second
  await expect(store.prepareDiscussion('legacy', loserOperation, loserIntent, saved.updatedAt)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(await readFile(store.storePath, 'utf8')).toBe(before)
})

it('a changed legacy Goal does not gain any discussion fields from a stale first reservation', async () => {
  const { store } = await fixture(), original = (await seedStoredDemand(store, { id: 'legacy', title: 'Original legacy Goal' })).demand
  const changed = await store.update('legacy', { description: 'Keep the newer human intent.' })
  const bytes = await readFile(store.storePath, 'utf8')
  await expect(store.prepareDiscussion('legacy', 'stale-operation', intent, original.updatedAt)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  expect(await store.get('legacy')).toEqual(changed.demand)
})
