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
    expect(receipt.demand).not.toHaveProperty('phaseIndex')
  })

  it('reads a store written with the retired batch field and stops carrying it on the next write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-batch-'))
    const store = openDemandStore({ root })
    await store.create({ id: 'old', title: 'Written before the plan', tags: [] })
    const file = path.join(root, 'store.json')
    const written = JSON.parse(await readFile(file, 'utf8'))
    written.demands[0].phaseIndex = null
    await writeFile(file, JSON.stringify(written))
    const reread = openDemandStore({ root })
    const goal = (await reread.get('old'))!
    expect(goal.title).toBe('Written before the plan')
    expect(goal).not.toHaveProperty('phaseIndex')
    await reread.update('old', { tags: ['kept'] })
    const after = JSON.parse(await readFile(file, 'utf8'))
    expect(after.demands[0].tags).toEqual(['kept'])
    expect(after.demands[0]).not.toHaveProperty('phaseIndex')
  })
})
