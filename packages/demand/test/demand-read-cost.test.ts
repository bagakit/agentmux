import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import type { DemandStoreSnapshot, UpdateDemandInput } from '../src/demand-types.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})
async function fixture(count = 1) {
  const root = await fs.mkdtemp(join(tmpdir(), 'amux-demand-point-read-')); roots.push(root)
  const store = openDemandStore({ root })
  await store.create({ id: 'goal-0', title: 'Before', description: 'Original description' })
  const raw = JSON.parse(await fs.readFile(store.storePath, 'utf8')) as DemandStoreSnapshot
  raw.demands = Array.from({ length: count }, (_, index) => ({ ...structuredClone(raw.demands[0]!), id: 'goal-' + index }))
  await fs.writeFile(store.storePath, JSON.stringify(raw, null, 2) + '\n')
  return { root, store }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('keeps repeated exact Goal read work bounded with 1 or 1000 original Goals', async () => {
  const costs: Array<{ goals: number; fileReads: number; versionReads: number; snapshotParses: number; individualGoalClones: number }> = []
  for (const count of [1, 1000]) {
    const { store } = await fixture(count)
    expect((await store.get('goal-0'))?.title).toBe('Before')
    const read = vi.spyOn(fs, 'readFile'), stat = vi.spyOn(fs, 'stat'), parse = vi.spyOn(JSON, 'parse')
    const goal = await store.get('goal-0')
    expect(goal?.id).toBe('goal-0')
    const parsed = parse.mock.results.filter(result => result.type === 'return').map(result => result.value)
    costs.push({ goals: count, fileReads: read.mock.calls.length, versionReads: stat.mock.calls.length,
      snapshotParses: parsed.filter(value => value && Array.isArray(value.demands)).length,
      individualGoalClones: parsed.filter(value => value && typeof value.id === 'string' && value.id.startsWith('goal-')).length })
    read.mockRestore(); stat.mockRestore(); parse.mockRestore()
  }
  expect(costs).toHaveLength(2)
  for (const cost of costs) {
    expect(cost.fileReads).toBe(0)
    expect(cost.versionReads).toBe(1)
    expect(cost.snapshotParses).toBe(0)
    expect(cost.individualGoalClones).toBe(1)
  }
  if (process.env.AGENTMUX_DEMAND_READ_COST_EVIDENCE) await fs.writeFile(process.env.AGENTMUX_DEMAND_READ_COST_EVIDENCE, JSON.stringify(costs, null, 2) + '\n')
})

it('coalesces concurrent cold reads of the same original file instead of parsing it per consumer', async () => {
  const { root } = await fixture(1000), store = openDemandStore({ root })
  const started = deferred(), release = deferred(), actualRead = fs.readFile.bind(fs)
  const read = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const result = await actualRead(...args)
    started.resolve(); await release.promise
    return result
  }) as typeof fs.readFile)
  const pending = Array.from({ length: 16 }, (_, index) => store.get('goal-' + index))
  await started.promise; release.resolve()
  const goals = await Promise.all(pending)
  expect(goals.map(goal => goal?.id)).toEqual(Array.from({ length: 16 }, (_, index) => 'goal-' + index))
  expect(read).toHaveBeenCalledOnce()
})

it('invalidates for another original Store writer and for same revision, inode and size edits', async () => {
  const { root, store } = await fixture()
  await store.get('goal-0')
  await openDemandStore({ root }).update('goal-0', { title: 'After!' }, { operationId: 'external-original-write' })
  const updated = (await store.get('goal-0'))!
  expect(updated.title).toBe('After!')
  expect(updated.activities.at(-1)?.nameChange?.operationId).toBe('external-original-write')
  const raw = JSON.parse(await fs.readFile(store.storePath, 'utf8')) as DemandStoreSnapshot
  const before = await fs.stat(store.storePath, { bigint: true })
  raw.demands[0]!.description = 'External description'
  // Equal-length text keeps the persisted version, inode and size unchanged.
  expect(raw.demands[0]!.description.length).toBe('Original description'.length)
  await fs.writeFile(store.storePath, JSON.stringify(raw, null, 2) + '\n')
  const after = await fs.stat(store.storePath, { bigint: true })
  expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size)
  expect((await store.get('goal-0'))?.description).toBe('External description')
  expect((await store.snapshot()).revision).toBe(raw.revision)
})

it('isolates returned records, projections and failed mutable transactions from retained file facts', async () => {
  const { store } = await fixture()
  await store.update('goal-0', { title: 'Chosen' }, { operationId: 'original-name' })
  const original = (await store.get('goal-0'))!, bytes = await fs.readFile(store.storePath)
  const edited = (await store.get('goal-0'))!
  edited.title = 'Reader edit'; edited.activities[0]!.nameChange!.actual = 'Reader projection edit'
  const snapshot = await store.snapshot(); snapshot.demands[0]!.description = 'Reader snapshot edit'
  const history = await store.listNameChanges('goal-0'); history.records[0]!.actual = 'Reader history edit'
  await expect(store.update('goal-0', { description: 'Uncommitted mutation', status: 'invalid' } as unknown as UpdateDemandInput)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(await store.get('goal-0')).toEqual(original)
  expect(await fs.readFile(store.storePath)).toEqual(bytes)
})

it('reports unavailable or damaged original files without returning cached normal facts or changing data', async () => {
  const { store } = await fixture()
  const original = (await store.get('goal-0'))!, bytes = await fs.readFile(store.storePath)
  const stat = vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('Original metadata unavailable'), { code: 'EACCES' }))
  await expect(store.get('goal-0')).rejects.toMatchObject({ code: 'READ_FAILED', phase: 'read' })
  stat.mockRestore()
  expect(await fs.readFile(store.storePath)).toEqual(bytes)
  expect(await store.get('goal-0')).toEqual(original)
  await fs.writeFile(store.storePath, '{damaged original file')
  await expect(store.get('goal-0')).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT', phase: 'read' })
  expect(await fs.readFile(store.storePath, 'utf8')).toBe('{damaged original file')
  await fs.writeFile(store.storePath, bytes)
  expect(await store.get('goal-0')).toEqual(original)
})

it('invalidates after explicit original file deletion and reads a later recreation at the same path', async () => {
  const { root, store } = await fixture()
  await store.get('goal-0')
  await fs.unlink(store.storePath)
  expect(await store.get('goal-0')).toBeNull()
  await openDemandStore({ root }).create({ id: 'goal-0', title: 'Explicitly recreated original path' })
  expect((await store.get('goal-0'))?.title).toBe('Explicitly recreated original path')
})

it.each(['atomic-replacement', 'in-place-edit'] as const)('keeps the original read protocol during a concurrent %s', async mode => {
  const { root } = await fixture(), reader = openDemandStore({ root })
  const started = deferred(), release = deferred(), actualRead = fs.readFile.bind(fs)
  let held = false
  const read = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const result = await actualRead(...args)
    if (!held) { held = true; started.resolve(); await release.promise }
    return result
  }) as typeof fs.readFile)
  const pending = reader.get('goal-0')
  // Attach the rejection observer before the deliberately overlapping file mutation.
  const observed = pending.then(value => ({ value }), error => ({ error }))
  await started.promise
  if (mode === 'atomic-replacement') await openDemandStore({ root }).update('goal-0', { description: 'Writer committed next snapshot' })
  else {
    const raw = JSON.parse(await actualRead(join(root, 'store.json'), 'utf8')) as DemandStoreSnapshot
    raw.demands[0]!.description = 'External in-place next snapshot'
    await fs.writeFile(join(root, 'store.json'), JSON.stringify(raw, null, 2) + '\n')
  }
  release.resolve(); const result = await observed
  read.mockRestore()
  if (mode === 'atomic-replacement') expect(result).toMatchObject({ value: { description: 'Original description' } })
  else expect(result).toMatchObject({ error: { code: 'READ_FAILED', phase: 'read' } })
  const latest = await reader.get('goal-0')
  expect(latest?.description).toBe(mode === 'atomic-replacement' ? 'Writer committed next snapshot' : 'External in-place next snapshot')
})
