import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { recoveryDigest } from '@agentmux/core'
import { createBatchedPersistentStorage, USER_SAVE_REPLY_MS } from '../src/renderer/src/lib/persisted-ui-writer'
import { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY as key } from '../src/renderer/src/lib/workbench-user-storage'

const roots: string[] = []
const bytes = (draft: string) => JSON.stringify({ state: { agentComposerDrafts: { original: draft }, agentSteerQueues: { original: [{ text: draft, operationId: 'original-input' }] } }, version: 1 })
const change = (draft: string) => JSON.stringify({ state: { agentComposerDrafts: { original: draft } }, version: 1,
  inputQueueDelta: { changes: [{ ownerKey: 'original', order: ['original-input'], remove: [],
    upsert: [{ operationId: 'original-input', entry: { text: draft, operationId: 'original-input' } }] }] } })
const barrier = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done }), get resolve() { return resolve } } }
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'amux-reliability-input-')); roots.push(root); return { root, path: join(root, 'user.json') } }
afterEach(async () => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('rejects a delayed pre-admission older document and a changed same-revision body', async () => {
  const f = await fixture(), owner = new WorkbenchUserStateStore(f.path), frame = {}
  await owner.writeFromRenderer(frame, { value: change('newer'), writeRevision: 2 }, () => true)
  await expect(owner.writeFromRenderer(frame, { value: change('older'), writeRevision: 1 }, () => true)).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
  await expect(owner.writeFromRenderer(frame, { value: change('different'), writeRevision: 2 }, () => true)).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
  expect(JSON.parse((await owner.read())!)).toEqual(JSON.parse(bytes('newer')))
})

it('keeps one physical writer and only the latest pending document behind an admitted write', async () => {
  const f = await fixture(), entered = barrier(), release = barrier(), frame = {}
  const owner = new WorkbenchUserStateStore(f.path, { syncDirectory: async () => { entered.resolve(); await release.promise } })
  const first = owner.writeFromRenderer(frame, { value: change('first'), writeRevision: 1 }, () => true)
  await entered.promise
  const middle = owner.writeFromRenderer(frame, { value: change('middle'), writeRevision: 2 }, () => true)
  const last = owner.writeFromRenderer(frame, { value: change('last'), writeRevision: 3 }, () => true)
  await expect(middle).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
  expect(owner.writeFromRenderer(frame, { value: change('last'), writeRevision: 3 }, () => true)).toBe(last)
  expect(JSON.parse((await new WorkbenchUserStateStore(f.path).read())!)).toEqual(JSON.parse(bytes('first')))
  release.resolve()
  const receipts = await Promise.all([first, last])
  expect(receipts.map(receipt => receipt.contentDigest)).toEqual([recoveryDigest(change('first')), recoveryDigest(change('last'))])
  expect(JSON.parse((await new WorkbenchUserStateStore(f.path).read())!)).toEqual(JSON.parse(bytes('last')))
})

it('autonomously retries a rejected batch without another edit', async () => {
  vi.useFakeTimers()
  let healthy = false, saved: string | null = null
  const errors = vi.fn(), recovered = vi.fn(), write = vi.fn(async (_key, value) => { if (!healthy) throw Error('temporary EIO'); saved = value })
  const batch = createBatchedPersistentStorage({ getItem: async () => saved, setItem: write, removeItem: async () => {} }, 400, errors, recovered)
  batch.storage.setItem(key, { state: { draft: 'Latest authored input' }, version: 1 })
  await vi.advanceTimersByTimeAsync(400); healthy = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(saved).toContain('Latest authored input'); expect(errors).toHaveBeenCalledTimes(1); expect(recovered).toHaveBeenCalledTimes(1)
  expect(batch.pending()).toBe(false)
})

it('retires only the missing ACK observer and retains the later real native document through its late ACK', async () => {
  const f = await fixture(), owner = new WorkbenchUserStateStore(f.path), frame = {}, acknowledged = barrier(), late = barrier(), newest = barrier(), secondACK = barrier()
  await owner.write(bytes('seed')); let revision = 0
  const source = { getItem: () => null, removeItem() {}, length: 0, key: () => null } as unknown as Storage
  const errors = vi.fn(), doc = createWorkbenchUserDocument({ readWorkbenchState: () => owner.read(), importWorkbenchState: value => owner.importIfAbsent(value),
    writeWorkbenchState: async value => {
      const input = ++revision, receipt = await owner.writeFromRenderer(frame, { value, writeRevision: input }, () => true)
      if (input === 1) { acknowledged.resolve(); await late.promise } else if (input === 2) { newest.resolve(); await secondACK.promise }
      return receipt
    } }, () => source, errors)
  await doc.hydrate(); vi.useFakeTimers()
  doc.persistent.storage.setItem(key, { state: JSON.parse(bytes('first')).state, version: 1 })
  const oldWait = Promise.resolve(doc.persistent.flush())
  const oldOutcome = oldWait.catch(error => error)
  await acknowledged.promise
  doc.persistent.storage.setItem(key, { state: JSON.parse(bytes('newer')).state, version: 1 })
  await vi.advanceTimersByTimeAsync(USER_SAVE_REPLY_MS)
  expect((await oldOutcome).code).toBe('WORKBENCH_USER_STATE_REPLY_OVERDUE')
  await vi.advanceTimersByTimeAsync(1000)
  await newest.promise
  doc.persistent.storage.setItem(key, { state: JSON.parse(bytes('latest')).state, version: 1 })
  late.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  secondACK.resolve(); await doc.persistent.flush()
  expect(JSON.parse((await owner.read())!)).toEqual(JSON.parse(bytes('latest')))
  expect(doc.confirmedProjectionDigest()).toBe(owner.observe().lastConfirmedWrite?.contentDigest)
  expect(doc.persistent.pending()).toBe(false)
})

it('a second real process reads the exact latest original input after owner recovery', async () => {
  const f = await fixture(), owner = new WorkbenchUserStateStore(f.path), frame = {}
  await owner.writeFromRenderer(frame, { value: change('durable authored draft and original queue'), writeRevision: 2 }, () => true)
  await expect(owner.writeFromRenderer(frame, { value: change('late old'), writeRevision: 1 }, () => true)).rejects.toThrow()
  const worker = join(f.root, 'reader.mjs')
  await writeFile(worker, `import { WorkbenchUserStateStore } from ${JSON.stringify(resolve('apps/desktop/src/main/workbench-user-state.ts'))}; const value=await new WorkbenchUserStateStore(process.argv[2]).read(); process.stdout.write(JSON.stringify({pid:process.pid,value}));`)
  const child = spawnSync(process.execPath, ['--import', resolve('packages/core/scripts/helpers/core-source-loader.mjs'), worker, f.path], { encoding: 'utf8', timeout: 20000 })
  expect(child.status, child.stderr).toBe(0)
  const observed = JSON.parse(child.stdout)
  expect(observed.pid).not.toBe(process.pid); expect(JSON.parse(observed.value)).toEqual(JSON.parse(bytes('durable authored draft and original queue')))
})
