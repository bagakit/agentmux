import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openDemandStore, parseDemandContentReferences } from '../src/index.js'
const ref = { hostId: 'host', workspaceId: 'resource-workspace', zoneId: 'original-zone' }
it('original content provenance persists through owner restart and atomic appends without changing original results or links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-content-'))
  try {
    const owner = openDemandStore({ root }); const original = await owner.create({ id: 'original', title: 'Original work', description: 'User content', sessionIds: ['first'], contentRefs: [ref] })
    await Promise.all([owner.update('original', { contentRefs: [{ ...ref, zoneId: 'second' }] }), owner.update('original', { contentRefs: [{ ...ref, zoneId: 'third' }] })])
    await owner.unlinkSession('original', 'first'); await owner.linkSession('original', 'new-discussion')
    const restored = await openDemandStore({ root }).get('original')
    expect(restored).toMatchObject({ id: original.demand.id, title: 'Original work', description: 'User content', sessionIds: ['new-discussion'] })
    expect(restored?.contentRefs?.map(ref => ref.zoneId).sort()).toEqual(['original-zone', 'second', 'third'])
    const linked = await owner.update('original', { contentRefs: [ref] }); expect(linked.demand.contentRefs).toHaveLength(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('same-millisecond owner mutations advance the record guard and refuse stale association before any change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-content-cas-'))
  try {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const owner = openDemandStore({ root }); const original = await owner.create({ title: 'Original' })
    const linked = await owner.linkSession(original.demand.id, 'original-session')
    expect(linked.demand.updatedAt).toBeGreaterThan(original.demand.updatedAt)
    const changed = await owner.update(original.demand.id, { description: 'Later work' })
    expect(changed.demand.updatedAt).toBeGreaterThan(linked.demand.updatedAt)
    await expect(owner.update(original.demand.id, { contentRefs: [ref], description: 'Stale' }, { expectedUpdatedAt: linked.demand.updatedAt })).rejects.toThrow('Goal changed')
    expect(await owner.get(original.demand.id)).toMatchObject({ description: 'Later work' }); expect((await owner.get(original.demand.id))?.contentRefs).toBeUndefined()
    const association = await owner.update(original.demand.id, { contentRefs: [ref] }, { expectedUpdatedAt: changed.demand.updatedAt, operationId: 'exact-source-append' })
    expect(association.operationId).toBe('exact-source-append'); expect(association.nameChange).toBeUndefined()
    await expect(owner.update(original.demand.id, { contentRefs: [ref] }, { expectedUpdatedAt: changed.demand.updatedAt, operationId: association.operationId })).rejects.toThrow('Goal changed')
    expect(await owner.get(original.demand.id)).toEqual(association.demand)
    expect((await owner.snapshot()).nameHistory).toEqual([])
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
})
it('refuses malformed, duplicate, foreign field and unbounded refs instead of persisting partial identities', () => {
  for (const refs of [[{ hostId: '', workspaceId: 'w', zoneId: 'z' }], [{ hostId: 'h', zoneId: 'z' }], [{ ...ref, groupId: 'display' }], [ref, ref], Array.from({ length: 65 }, (_, i) => ({ ...ref, zoneId: String(i) }))]) expect(() => parseDemandContentReferences(refs)).toThrow()
})
