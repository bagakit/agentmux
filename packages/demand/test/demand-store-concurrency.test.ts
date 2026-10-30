import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'

const roots: string[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const root of roots.splice(0)) { try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'Demand test cleanup failed')
})

describe('DemandStore locking', () => {
  it('serializes concurrent writers from separate store instances', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-lock-'))
    roots.push(root)
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

  it('keeps unrecognized lock ownership unknown and preserves ordinary reads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-lock-timeout-'))
    roots.push(root)
    const seed = openDemandStore({ root })
    await seed.create({ id: 'preserved', title: 'Keep me' })
    const original = await readFile(path.join(root, 'store.json'))
    // An inherited legacy lock, not a current protocol owner replacing a lock.
    await writeFile(path.join(root, 'store.lock'), 'held', 'utf8')
    const store = openDemandStore({ root, lockTimeoutMs: 1, lockRetryMs: 1 })
    await expect(store.update('preserved', { title: 'Blocked' })).rejects.toMatchObject({ code: 'WRITE_FAILED', phase: 'lock', message: expect.stringContaining('ownership is unknown') })
    expect(await readFile(path.join(root, 'store.lock'), 'utf8')).toBe('held')
    expect(await readFile(path.join(root, 'store.json'))).toEqual(original)
    await expect(store.get('preserved')).resolves.toMatchObject({ title: 'Keep me' })
  })
})
