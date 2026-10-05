import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
let root: string, store: ReturnType<typeof openDemandStore>
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'demand-relations-')); store = openDemandStore({ root }) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
it('collaboration atomic relation CAS admits one complete collection without losing original historical refs', async () => {
  await store.create({ id: 'goal', title: 'Original', sessionIds: ['host/original-history'] })
  const original = (await store.get('goal'))!, observed: unknown[] = []
  const off = store.subscribe(snapshot => observed.push(snapshot.demands[0]))
  const results = await Promise.allSettled([
    store.update('goal', { assigneeSessionIds: ['a', 'b'], supervisorSessionId: 'a' }, { expectedUpdatedAt: original.updatedAt }),
    store.update('goal', { assigneeSessionIds: ['c'], supervisorSessionId: 'c' }, { expectedUpdatedAt: original.updatedAt })
  ]); off()
  expect(results.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected'])
  const saved = (await store.get('goal'))!
  expect(saved.assigneeSessionIds.includes(saved.supervisorSessionId!)).toBe(true)
  expect(saved.sessionIds).toContain('host/original-history')
  expect(observed).toHaveLength(1); expect(observed[0]).toEqual(saved)
  const bytes = await readFile(store.storePath, 'utf8')
  await expect(store.update('goal', { assigneeSessionIds: [], supervisorSessionId: saved.supervisorSessionId })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(store.unlinkSession('goal', saved.supervisorSessionId!)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(await readFile(store.storePath, 'utf8')).toBe(bytes)
  await store.update('goal', { assigneeSessionIds: [], supervisorSessionId: null }, { expectedUpdatedAt: saved.updatedAt })
  expect((await store.get('goal'))!.sessionIds).toEqual(saved.sessionIds)
})
it('collaboration legacy disk retains Executor and unknown history without inferring a responsible Session or provenance', async () => {
  await store.create({ id: 'goal', title: 'Legacy', sessionIds: ['unknown/old-agent'] })
  const disk = JSON.parse(await readFile(store.storePath, 'utf8')), goal = disk.demands[0]
  delete goal.assigneeSessionIds; delete goal.supervisorSessionId; delete goal.participations
  goal.executorId = 'old-launch-template'; await writeFile(store.storePath, JSON.stringify(disk))
  expect(await store.get('goal')).toMatchObject({ executorId: 'old-launch-template', assigneeSessionIds: [], supervisorSessionId: null, participations: [], sessionIds: ['unknown/old-agent'] })
  await store.update('goal', { assigneeSessionIds: ['new-responsible'], supervisorSessionId: 'new-responsible' })
  expect((await store.get('goal'))!).toMatchObject({ executorId: 'old-launch-template', sessionIds: ['unknown/old-agent', 'new-responsible'] })
  expect((await store.get('goal'))!.creationOrigin).toBeUndefined()
  await expect(store.create({ title: 'Forbidden new template owner', executorId: 'old-launch-template' } as any)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
it('collaboration trusted creation eligibility respects manual null and records policy-off original participants without applying a default', async () => {
  const source = { kind: 'create' as const, agentSessionId: 'exact-agent', hostId: 'local', entryPoint: 'authenticated-create' }
  const on = await store.create({ id: 'on', title: 'Source not yet available' }, { operationId: 'on-create', creationOrigin: { requesterAsSupervisor: true } })
  expect(on.demand.creationOrigin).toEqual({ operationId: 'on-create', requesterAsSupervisor: true, requesterParticipationId: null, supervisorDefaultPending: true })
  expect(on.demand.assigneeSessionIds).toEqual([]); expect(on.demand.sessionIds).toEqual([])
  await store.update('on', { supervisorSessionId: null }, { expectedUpdatedAt: on.demand.updatedAt })
  expect((await store.get('on'))!.creationOrigin!.supervisorDefaultPending).toBe(false)
  const manual = await store.create({ id: 'manual', title: 'Explicit clear', supervisorSessionId: null }, { creationOrigin: { requesterAsSupervisor: true } })
  expect(manual.demand.creationOrigin!.supervisorDefaultPending).toBe(false)
  const bound = await store.create({ id: 'bound', title: 'Exact trusted requester' }, { operationId: 'bound-create', participation: source, creationOrigin: { requesterAsSupervisor: true } })
  expect(bound.demand.creationOrigin).toEqual({ operationId: 'bound-create', requesterAsSupervisor: true, requesterParticipationId: bound.demand.participations[0]!.id, supervisorDefaultPending: false })
  expect(bound.demand.supervisorSessionId).toBe('exact-agent')
  expect(bound.demand.assigneeSessionIds).toEqual(['exact-agent'])
  expect(bound.demand.sessionIds).toEqual(['exact-agent'])
  const off = await store.create({ id: 'off', title: 'Policy off' }, { operationId: 'off-create', creationOrigin: { requesterAsSupervisor: false } })
  const participant = await store.recordParticipation('off', source, { operationId: 'off-create', expectedUpdatedAt: off.demand.updatedAt })
  expect(participant.demand.creationOrigin!.supervisorDefaultPending).toBe(false)
  expect(participant.demand.participations).toMatchObject([{ kind: 'create', agentSessionId: 'exact-agent' }])
  expect(participant.demand.supervisorSessionId).toBeNull(); expect(participant.demand.assigneeSessionIds).toEqual([])
  const repeat = await store.recordParticipation('off', source, { operationId: 'off-create', expectedUpdatedAt: off.demand.updatedAt })
  expect(repeat.demand.participations).toEqual(participant.demand.participations)
  await expect(store.update('on', { participations: [] } as any)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(store.create({ title: 'Body policy', creationOrigin: { requesterAsSupervisor: true } } as any)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
