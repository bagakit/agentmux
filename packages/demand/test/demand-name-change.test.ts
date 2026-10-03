import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { runDemandCli } from '../src/cli.js'
import type { DemandNameContext, UpdateDemandInput } from '../src/demand-types.js'

const exec = promisify(execFile)
const context: DemandNameContext = { actor: { kind: 'agent', id: 'authenticated-agent', verified: true }, source: 'agent', entryPoint: 'goal.update', transport: 'rpc', location: { sessionId: 'session-a', regionId: 'region-a' } }

const roots: string[] = []
async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-name-'))
  roots.push(value)
  return value
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(value => fs.rm(value, { recursive: true, force: true }))) })

describe('Demand title owner', () => {
  it('commits a structured unknown-source rename with its title and receipt in one snapshot', async () => {
    const directory = await root()
    const store = openDemandStore({ root: directory })
    await store.create({ id: 'goal', title: 'Before' })
    const receipt = await store.update('goal', { title: 'After' })
    const reopened = openDemandStore({ root: directory })
    const demand = await reopened.get('goal')
    expect(demand?.title).toBe('After')
    expect(demand?.activities.at(-1)?.nameChange).toMatchObject({
      operationId: receipt.operationId, target: { kind: 'demand', id: 'goal' },
      before: 'Before', requested: 'After', actual: 'After', status: 'applied', ownerRevision: receipt.revision,
      context: { actor: { kind: 'unknown', id: null, verified: false }, source: 'unknown', entryPoint: 'demand.update' }
    })
    const raw = JSON.parse(await fs.readFile(store.storePath, 'utf8'))
    expect(raw.nameHistory.at(-1).ownerRevision).toBe(raw.revision)
    expect(raw.demands[0].activities.at(-1).nameChangeId).toBe(receipt.operationId)
    expect(raw.demands[0].activities.at(-1)).not.toHaveProperty('nameChange')
  })

  it('preserves deleted-target history in the same snapshot and queries it after reopening', async () => {
    const directory = await root(), store = openDemandStore({ root: directory })
    await store.create({ id: 'goal', title: 'Before' })
    const first = await store.update('goal', { title: 'Chosen' }, { operationId: 'original', context })
    await expect(store.update('goal', { title: '' }, { operationId: 'refused', context })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const history = (await store.snapshot()).nameHistory
    const removed = await store.delete('goal').catch(error => error)
    expect(removed).toMatchObject({ operation: 'remove', demand: { id: 'goal' } })
    const reopened = openDemandStore({ root: directory })
    expect(await reopened.get('goal')).toBeNull()
    expect((await reopened.snapshot()).nameHistory).toEqual(history)
    const page = await reopened.listNameChanges('goal', { limit: 1 })
    expect(page.records).toEqual([first.nameChange])
    expect((await reopened.listNameChanges('goal', { offset: page.nextOffset!, limit: 1 })).records).toEqual([history[1]])
    await reopened.create({ id: 'goal', title: 'New object using retained ID' })
    const replay = await reopened.update('goal', { title: 'Chosen' }, { operationId: 'original', context })
    expect(replay).toMatchObject({ replayed: true, demand: { title: 'New object using retained ID' }, nameChange: first.nameChange })
    expect((await reopened.snapshot()).nameHistory).toEqual(history)
  })

  it('reads old v1 free-text activities unchanged without inventing trusted title history', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Original' })
    await store.addActivity('goal', { kind: 'note', message: 'A previous author renamed this goal.', actorId: 'unverified-free-text' })
    const raw = JSON.parse(await fs.readFile(store.storePath, 'utf8'))
    delete raw.nameHistory
    await fs.writeFile(store.storePath, JSON.stringify(raw))
    const bytes = await fs.readFile(store.storePath)
    expect((await store.snapshot()).nameHistory).toEqual([])
    expect((await store.get('goal'))?.activities).toEqual(raw.demands[0].activities)
    expect(await fs.readFile(store.storePath)).toEqual(bytes)
    await store.update('goal', { title: 'Current' })
    expect((await store.get('goal'))?.activities[0]).toEqual(raw.demands[0].activities[0])
    expect((await store.snapshot()).nameHistory).toHaveLength(1)
  })

  it('records invalid and unchanged title attempts without losing the confirmed title', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Keep' })
    await expect(store.update('goal', { title: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const failed = await store.get('goal')
    expect(failed?.title).toBe('Keep')
    expect(failed?.activities.at(-1)?.nameChange).toMatchObject({ status: 'failed', before: 'Keep', requested: '', actual: 'Keep' })
    const unchanged = await store.update('goal', { title: 'Keep' })
    expect(unchanged.nameChange).toMatchObject({ status: 'applied', before: 'Keep', actual: 'Keep', reason: 'unchanged' })
  })

  it('takes actor and where from the separate host context, never business input', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Before' })
    const patch = { title: 'After', actor: { kind: 'user', id: 'pretend-user', verified: true }, context: { source: 'manual' } } as unknown as UpdateDemandInput
    const attribution = structuredClone(context)
    const pending = store.update('goal', patch, { context: attribution, operationId: 'authenticated-operation' })
    attribution.actor.id = 'mutated-after-call'
    patch.title = 'Mutated after call'
    const receipt = await pending
    expect(receipt.nameChange).toMatchObject({ requested: 'After', context, operationId: 'authenticated-operation' })
    expect(receipt.demand.activities.at(-1)?.actorId).toBe(context.actor.id)
  })

  it('preserves the competing title on stale CAS and durably records the refused attempt', async () => {
    const directory = await root()
    const left = openDemandStore({ root: directory })
    const right = openDemandStore({ root: directory })
    await left.create({ id: 'goal', title: 'Before' })
    const earlier = (await left.snapshot()).revision
    await right.update('goal', { title: 'Concurrent winner' })
    const rejected = await left.update('goal', { title: 'Stale overwrite' }, { expectedRevision: earlier, operationId: 'stale' }).catch(error => error)
    expect(rejected).toMatchObject({ commitStatus: 'confirmed', nameChange: { status: 'failed', before: 'Concurrent winner', requested: 'Stale overwrite', actual: 'Concurrent winner', reason: expect.stringContaining('revision conflict') } })
    expect((await right.get('goal'))?.title).toBe('Concurrent winner')
    expect((await right.listNameChanges('goal')).records.at(-1)?.operationId).toBe('stale')
  })

  it('observes the original operation on retry without reapplying it over a later title', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Before' })
    const original = await store.update('goal', { title: 'First' }, { operationId: 'one' })
    await store.update('goal', { title: 'Later' }, { operationId: 'two' })
    const beforeRetry = await store.snapshot()
    const replay = await store.update('goal', { title: 'First' }, { operationId: 'one', expectedRevision: 1 }).catch(error => error)
    expect(replay).toMatchObject({ replayed: true, revision: original.revision, nameChange: original.nameChange, demand: { title: 'Later' } })
    expect(await store.snapshot()).toEqual(beforeRetry)
    await expect(store.update('goal', { title: 'Different' }, { operationId: 'one' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.update('goal', { title: 'First' }, { operationId: 'one', context })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await store.snapshot()).toEqual(beforeRetry)
  })

  it('does not apply a valid title when another field in that update is invalid', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Before' })
    await expect(store.update('goal', { title: 'After', status: 'imaginary' } as unknown as UpdateDemandInput)).rejects.toMatchObject({ nameChange: { status: 'failed', before: 'Before', actual: 'Before', requested: 'After' } })
    expect((await store.get('goal'))?.title).toBe('Before')
  })

  it('keeps exact previous bytes when the atomic replacement fails and does not claim a committed audit', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Before' })
    const before = await fs.readFile(store.storePath)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('read-only storage'), { code: 'EACCES' }))
    await expect(store.update('goal', { title: 'After' }, { operationId: 'write-failed' })).rejects.toMatchObject({ code: 'WRITE_FAILED', commitStatus: 'not_applied', nameChange: { status: 'failed', actual: 'Before', ownerRevision: null } })
    expect(await fs.readFile(store.storePath)).toEqual(before)
    expect(await fs.readdir(store.root)).toEqual(['store.json'])
  })

  it('returns the confirmed title despite a throwing observer, warns, and continues other listeners', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Before' })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const observed: string[] = []
    store.subscribe(() => { throw new Error('observer unavailable') })
    store.subscribe(snapshot => { observed.push(snapshot.demands[0]!.title) })
    const receipt = await store.update('goal', { title: 'After' }, { operationId: 'observer-operation' }).catch(error => error)
    expect(receipt.nameChange).toMatchObject({ status: 'applied', actual: 'After', ownerRevision: receipt.revision })
    expect(observed).toEqual(['After'])
    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('observer-operation'))
    const beforeReplay = await store.snapshot()
    expect((await store.update('goal', { title: 'After' }, { operationId: 'observer-operation' })).replayed).toBe(true)
    expect(await store.snapshot()).toEqual(beforeReplay)
    expect(warning).toHaveBeenCalledOnce()
  })

  it('keeps the actual replaced title but reports unknown durability when directory fsync fails', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Before' })
    const actualOpen = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await actualOpen(...args)
      if (args[0] === store.root) vi.spyOn(handle, 'sync').mockRejectedValue(Object.assign(new Error('directory sync unsupported'), { code: 'ENOTSUP' }))
      return handle
    })
    const rejected = await store.update('goal', { title: 'After' }, { operationId: 'write-unknown' }).catch(error => error)
    expect(rejected).toMatchObject({ code: 'WRITE_FAILED', commitStatus: 'unknown', nameChange: { status: 'unknown', actual: 'After', ownerRevision: null }, message: expect.stringContaining('not resent') })
    const unconfirmedBytes = await fs.readFile(store.storePath)
    const unconfirmedReplay = await store.update('goal', { title: 'After' }, { operationId: 'write-unknown' }).catch(error => error)
    expect(unconfirmedReplay).toMatchObject({ commitStatus: 'unknown', nameChange: { status: 'unknown', actual: 'After' } })
    expect(await fs.readFile(store.storePath)).toEqual(unconfirmedBytes)
    const failedAttempt = await store.update('goal', { title: '' }, { operationId: 'invalid-unknown' }).catch(error => error)
    expect(failedAttempt).toMatchObject({ commitStatus: 'unknown' })
    expect(await store.update('goal', { title: '' }, { operationId: 'invalid-unknown' }).catch(error => error)).toMatchObject({ commitStatus: 'unknown' })
    vi.restoreAllMocks()
    expect((await store.get('goal'))?.title).toBe('After')
    expect((await store.listNameChanges('goal')).records[0]?.operationId).toBe('write-unknown')
    await store.update('goal', { title: 'Later name' }, { operationId: 'later-name' })
    const beforeConfirmedReplay = await fs.readFile(store.storePath), observer = vi.fn()
    store.subscribe(observer)
    const sync = vi.spyOn(fs, 'open')
    const confirmedReplay = await store.update('goal', { title: 'After' }, { operationId: 'write-unknown' })
    expect(confirmedReplay).toMatchObject({ replayed: true, demand: { title: 'Later name' }, nameChange: { actual: 'After', operationId: 'write-unknown' } })
    expect(sync.mock.calls.some(args => args[0] === store.storePath && args[1] === 'r')).toBe(true)
    expect(sync.mock.calls.some(args => args[0] === store.root && args[1] === 'r')).toBe(true)
    expect(await store.update('goal', { title: '' }, { operationId: 'invalid-unknown' }).catch(error => error)).toMatchObject({ commitStatus: 'confirmed', nameChange: { status: 'failed' } })
    expect(await fs.readFile(store.storePath)).toEqual(beforeConfirmedReplay)
    expect(observer).not.toHaveBeenCalled()
    expect(await fs.readdir(store.root)).toEqual(['store.json'])
  })

  it('retains ordered before/after evidence from independent writers and bounds history pages', async () => {
    const directory = await root()
    const stores = [openDemandStore({ root: directory }), openDemandStore({ root: directory })]
    await stores[0]!.create({ id: 'goal', title: 'Before' })
    await Promise.all(stores.map((store, index) => store.update('goal', { title: `Writer ${index}` })))
    const first = await stores[0]!.listNameChanges('goal', { limit: 1 })
    const second = await stores[1]!.listNameChanges('goal', { offset: first.nextOffset!, limit: 1 })
    expect(first.records).toHaveLength(1)
    expect(first.records[0]?.before).toBe('Before')
    expect(second.records[0]?.before).toBe(first.records[0]?.actual)
    expect(second.records[0]?.ownerRevision).toBe(first.records[0]!.ownerRevision! + 1)
    expect(second.nextOffset).toBeNull()
    await expect(stores[0]!.listNameChanges('goal', { limit: 101 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('does not let an ordinary activity counterfeit an owner rename record', async () => {
    const store = openDemandStore({ root: await root() })
    await store.create({ id: 'goal', title: 'Keep' })
    await expect(store.addActivity('goal', { kind: 'name-change', message: 'User renamed this', actorId: 'human' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await store.get('goal'))?.activities).toEqual([])
  })

  it('routes standalone CLI updates into the same structured owner without trusting actor flags', async () => {
    const directory = await root()
    const store = openDemandStore({ root: directory })
    await store.create({ id: 'goal', title: 'Before' })
    const output: string[] = []
    const code = await runDemandCli(['--root', directory, 'update', '--id', 'goal', '--title', 'CLI title', '--actor-id', 'invented-human'], { stdout: value => output.push(value), stderr: value => output.push(value) })
    expect(code).toBe(0)
    const record = (await store.get('goal'))?.activities.at(-1)?.nameChange
    expect(record).toMatchObject({ context: { actor: { kind: 'device', verified: true }, source: 'local-cli', entryPoint: 'agentmux-demand.update', transport: 'local-process', location: { demandRoot: path.resolve(directory), cwd: process.cwd() } } })
    expect(record?.context.actor.id).not.toBe('invented-human')
    expect(JSON.parse(output[0]!).receipt.nameChange).toEqual(record)
  })

  it('executes the real standalone bin in separate processes and reads its persisted structured receipt', async () => {
    const directory = await root()
    const compiled = path.join(directory, 'compiled')
    await exec(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'packages/demand/tsconfig.build.json', '--outDir', compiled])
    const bin = path.join(compiled, 'bin/agentmux-demand.js')
    const demandRoot = path.join(directory, 'store')
    await exec(process.execPath, [bin, '--root', demandRoot, 'create', '--id', 'native', '--title', 'Before'])
    const { stdout } = await exec(process.execPath, [bin, '--root', demandRoot, 'update', '--id', 'native', '--title', 'After', '--actor-id', 'self-declared-human', '--operation-id', 'native-operation'])
    const applied = JSON.parse(stdout)
    expect(applied.receipt.nameChange).toMatchObject({ status: 'applied', context: { actor: { kind: 'device', verified: true }, source: 'local-cli' }, operationId: 'native-operation' })
    expect(applied.receipt.nameChange.context.actor.id).not.toBe('self-declared-human')
    const read = await exec(process.execPath, [bin, '--root', demandRoot, 'name-history', '--id', 'native', '--limit', '1'])
    expect(JSON.parse(read.stdout)).toMatchObject({ records: [applied.receipt.nameChange], nextOffset: null })
    const reopened = openDemandStore({ root: demandRoot })
    expect((await reopened.get('native'))?.activities.at(-1)?.nameChange).toEqual(applied.receipt.nameChange)
    await exec(process.execPath, [bin, '--root', demandRoot, 'delete', '--id', 'native', '--confirm', 'delete'])
    const deletedRead = await exec(process.execPath, [bin, '--root', demandRoot, 'name-history', '--id', 'native', '--limit', '1'])
    expect(JSON.parse(deletedRead.stdout)).toMatchObject({ records: [applied.receipt.nameChange], nextOffset: null })
  })
})
