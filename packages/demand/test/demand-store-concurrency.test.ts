import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'

describe('DemandStore locking', () => {
  it('serializes concurrent writers from separate store instances', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-lock-'))
    const left = openDemandStore({ root })
    const right = openDemandStore({ root })
    await Promise.all([
      left.create({ id: 'left', title: 'Left' }),
      right.create({ id: 'right', title: 'Right' }),
    ])
    const snapshot = await left.snapshot()
    expect(snapshot.revision).toBe(2)
    expect(snapshot.demands.map((demand) => demand.id).sort()).toEqual(['left', 'right'])
  })

  it('reports a lock timeout and does not write an empty replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-lock-timeout-'))
    const seed = openDemandStore({ root })
    await seed.create({ id: 'preserved', title: 'Keep me' })
    await writeFile(path.join(root, 'store.lock'), 'held', 'utf8')
    const store = openDemandStore({ root, lockTimeoutMs: 1, lockRetryMs: 1 })
    await expect(store.update('preserved', { title: 'Blocked' })).rejects.toMatchObject({ code: 'LOCK_TIMEOUT', phase: 'lock' })
    await rm(path.join(root, 'store.lock'))
    await expect(store.get('preserved')).resolves.toMatchObject({ title: 'Keep me' })
  })
})
