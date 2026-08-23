import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'

describe('Demand planning metadata', () => {
  it('persists tags, dates, parent, and phase without creating a Session', async () => {
    const store = openDemandStore({ root: await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-meta-')) })
    const receipt = await store.create({ id: 'd-meta', title: 'Metadata', tags: ['release'], plannedStartAt: 10, targetAt: 20, parentDemandId: null, phaseIndex: 1 })
    expect(receipt.demand).toMatchObject({ tags: ['release'], plannedStartAt: 10, targetAt: 20, parentDemandId: null, phaseIndex: 1, sessionIds: [] })
  })
})
