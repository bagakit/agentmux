import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'

describe('Demand planning metadata', () => {
  it('persists tags, dates and parent without creating a Session', async () => {
    const store = openDemandStore({ root: await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-meta-')) })
    const receipt = await store.create({ id: 'd-meta', title: 'Metadata', tags: ['release'], plannedStartAt: 10, targetAt: 20, parentDemandId: null })
    expect(receipt.demand).toMatchObject({ tags: ['release'], plannedStartAt: 10, targetAt: 20, parentDemandId: null, sessionIds: [] })
    expect(receipt.demand.phaseIndex).toBeNull()
  })

  it('keeps the original batch across reads, unrelated writes and owner restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-batch-'))
    const store = openDemandStore({ root })
    await store.create({ id: 'old', title: 'Written before the plan', tags: [] })
    const file = path.join(root, 'store.json')
    const written = JSON.parse(await readFile(file, 'utf8'))
    written.demands[0].phaseIndex = 3
    await writeFile(file, JSON.stringify(written))
    const reread = openDemandStore({ root })
    const goal = (await reread.get('old'))!
    expect(goal.title).toBe('Written before the plan')
    expect(goal.phaseIndex).toBe(3)
    await reread.update('old', { tags: ['kept'] })
    const after = JSON.parse(await readFile(file, 'utf8'))
    expect(after.demands[0].tags).toEqual(['kept'])
    expect(after.demands[0].phaseIndex).toBe(3)
    await reread.update('old', { phaseIndex: 0 })
    expect((await openDemandStore({ root }).get('old'))?.phaseIndex).toBe(0)
    await reread.update('old', { phaseIndex: null })
    expect((await reread.get('old'))?.phaseIndex).toBeNull()
  })

  it('validates a batch before committing, and includes it in original creation reconciliation', async () => {
    const store = openDemandStore({ root: await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-batch-')) })
    const options = { operationId: 'original-create', discussionOperationId: 'original-discussion', creationOrigin: { requesterAsSupervisor: false } }
    const input = { id: 'batched', title: 'Batch', phaseIndex: 2 }
    await store.create(input, options)
    expect((await store.create(input, options)).replayed).toBe(true)
    await expect(store.create({ ...input, phaseIndex: 3 }, options)).rejects.toThrow(/current content differs/)
    for (const phaseIndex of [-1, 1.5, Infinity, NaN]) {
      await expect(store.update('batched', { phaseIndex })).rejects.toThrow(/non-negative integer/)
      expect((await store.get('batched'))?.phaseIndex).toBe(2)
    }
  })
})
