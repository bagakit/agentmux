import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
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
  const publications: Array<{ revision: number; ids: readonly string[]; operationId: string | undefined }> = []
  store.subscribe((snapshot, ids) => publications.push({ revision: snapshot.revision, ids,
    operationId: snapshot.demands.find(goal => goal.id === 'goal')?.discussionOperationId }))
  const input = { id: 'goal', title: 'Original Goal', description: 'Original request' }
  const options = { operationId: 'original-create', discussionOperationId: 'original-discussion', creationOrigin: { requesterAsSupervisor: true } }
  const first = await store.create(input, options)
  expect(publications).toEqual([{ revision: 1, ids: ['goal'], operationId: options.discussionOperationId }])
  const bytes = await readFile(store.storePath, 'utf8')
  const disk = JSON.parse(bytes)
  expect(disk).toMatchObject({ revision: 1, demands: [{ id: 'goal', discussionOperationId: options.discussionOperationId,
    creationOrigin: { operationId: options.operationId } }] })
  expect((await openDemandStore({ root }).get('goal'))?.discussionIntent).toBeUndefined()
  const replay = await openDemandStore({ root }).create(input, options)
  expect(replay).toMatchObject({ replayed: true, revision: first.revision, demand: first.demand })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
})

it('freezes one discussion intent across reopen and rejects another mode, caller or destination on its original operation', async () => {
  const { root, store } = await fixture()
  const created = await store.create({ id: 'goal', title: 'Original Goal' }, { discussionOperationId: 'original-discussion' })
  const beforePreparation = await readFile(store.storePath, 'utf8')
  await expect(store.prepareDiscussion('goal', 'original-discussion', { ...intent, mode: new String('grill') } as never, created.demand.updatedAt))
    .rejects.toThrow('The original Goal discussion intent is invalid.')
  expect(await readFile(store.storePath, 'utf8')).toBe(beforePreparation)
  const prepared = await store.prepareDiscussion('goal', 'original-discussion', intent, created.demand.updatedAt)
  const bytes = await readFile(store.storePath, 'utf8'), reopened = openDemandStore({ root })
  const replay = await reopened.prepareDiscussion('goal', 'original-discussion', { ...intent }, created.demand.updatedAt)
  expect(replay).toMatchObject({ replayed: true, revision: prepared.revision, demand: prepared.demand })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  for (const patch of [
    { mode: 'grounding' as const }, { callerAgentSessionId: 'another-caller' }, { spaceId: 'another-space' }, { zoneId: 'another-zone' },
    { executorId: 'another-executor' }, { prompt: 'Another input' }, { agentMuxNote: 'Another context' }, { requestOperationId: 'another-request' }
  ]) {
    await expect(reopened.prepareDiscussion('goal', 'original-discussion', { ...intent, ...patch }, prepared.demand.updatedAt))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
    expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  }
  await expect(reopened.prepareDiscussion('goal', 'another-discussion', intent, prepared.demand.updatedAt))
    .rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  expect((await openDemandStore({ root }).get('goal'))?.discussionIntent).toEqual(intent)
})

it('requires the original Goal revision before freezing a first discussion intent', async () => {
  const { root, store } = await fixture()
  const created = await store.create({ id: 'goal', title: 'Original Goal' }, { discussionOperationId: 'original-discussion' })
  const changed = await store.update('goal', { description: 'A newer original request' })
  const bytes = await readFile(store.storePath, 'utf8')
  await expect(store.prepareDiscussion('goal', 'original-discussion', intent, created.demand.updatedAt))
    .rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  const prepared = await openDemandStore({ root }).prepareDiscussion('goal', 'original-discussion', intent, changed.demand.updatedAt)
  expect(prepared.demand).toMatchObject({ description: changed.demand.description, discussionIntent: intent })
})

it('retains a Goal without discussion provenance and never adopts it through preparation or repeated creation', async () => {
  const { root, store } = await fixture()
  await store.create({ id: 'retained', title: 'Retained Goal', description: 'Original body', sessionIds: ['original-session'], tags: ['original-tag'] })
  await store.addDecision('retained', { id: 'retained-decision', question: 'Keep which identity?', decision: 'The original one.', rationale: 'Preserve its evidence.', actorId: null })
  const original = await store.get('retained'), bytes = await readFile(store.storePath, 'utf8')
  const reopened = openDemandStore({ root })
  expect(await reopened.get('retained')).toEqual(original)
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  await expect(reopened.prepareDiscussion('retained', 'unobserved-discussion', intent, original!.updatedAt))
    .rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
  await expect(reopened.create({ id: 'retained', title: 'Retained Goal' }, {
    operationId: 'another-create', discussionOperationId: 'unobserved-discussion', creationOrigin: { requesterAsSupervisor: true }
  })).rejects.toMatchObject({ code: 'INVALID_INPUT', phase: 'validate' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  await reopened.create({ id: 'new-goal', title: 'New Goal' }, { discussionOperationId: 'new-discussion' })
  expect(await openDemandStore({ root }).get('retained')).toEqual(original)
  expect((await reopened.get('retained'))?.discussionOperationId).toBeUndefined()
  expect((await reopened.get('retained'))?.discussionIntent).toBeUndefined()
})
