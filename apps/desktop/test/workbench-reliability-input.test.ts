import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { durableWriteFile } from '@agentmux/core'
import { createBatchedPersistentStorage, USER_SAVE_REPLY_MS } from '../src/renderer/src/lib/persisted-ui-writer'
import { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY as key } from '../src/renderer/src/lib/workbench-user-storage'

const roots: string[] = []
const bytes = (draft: string) => JSON.stringify({ state: { agentComposerDrafts: { original: draft }, agentSteerQueues: { original: [{ text: draft, operationId: 'original-input' }] } }, version: 1 })
const barrier = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done }), get resolve() { return resolve } } }
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'amux-reliability-input-')); roots.push(root); return { root, path: join(root, 'user.json') } }
afterEach(async () => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('rejects a delayed pre-admission older document and a changed same-revision body', async () => {
  const f = await fixture(), owner = new WorkbenchUserStateStore(f.path), frame = {}
  await owner.writeFromRenderer(frame, { value: bytes('newer'), writeRevision: 2 }, () => true)
  await expect(owner.writeFromRenderer(frame, { value: bytes('older'), writeRevision: 1 }, () => true)).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
  await expect(owner.writeFromRenderer(frame, { value: bytes('different'), writeRevision: 2 }, () => true)).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
  expect(await readFile(f.path, 'utf8')).toBe(bytes('newer'))
})

it('keeps one physical writer and only the latest pending document behind an admitted write', async () => {
  const f = await fixture(), entered = barrier(), release = barrier(), frame = {}, published: string[] = []
  let active = 0, peak = 0
  const owner = new WorkbenchUserStateStore(f.path, { write: async (path, value, options) => {
    if (path !== f.path) return durableWriteFile(path, value, options)
    peak = Math.max(peak, ++active)
    try { if (!published.length) { entered.resolve(); await release.promise }; published.push(String(value)); await durableWriteFile(path, value, options) }
    finally { active-- }
  } })
  const first = owner.writeFromRenderer(frame, { value: bytes('first'), writeRevision: 1 }, () => true)
  await entered.promise
  const middle = owner.writeFromRenderer(frame, { value: bytes('middle'), writeRevision: 2 }, () => true)
  const last = owner.writeFromRenderer(frame, { value: bytes('last'), writeRevision: 3 }, () => true)
  await expect(middle).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_SUPERSEDED' })
  expect(owner.writeFromRenderer(frame, { value: bytes('last'), writeRevision: 3 }, () => true)).toBe(last)
  release.resolve(); await Promise.all([first, last])
  expect(peak).toBe(1); expect(published).toEqual([bytes('first'), bytes('last')])
  expect(await new WorkbenchUserStateStore(f.path).read()).toBe(bytes('last'))
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
  expect(await owner.read()).toBe(bytes('latest')); expect(doc.encodeProjection()).toBe(bytes('latest'))
  expect(doc.persistent.pending()).toBe(false)
})

it('a second real process reads the exact latest original input after owner recovery', async () => {
  const f = await fixture(), owner = new WorkbenchUserStateStore(f.path), frame = {}
  await owner.writeFromRenderer(frame, { value: bytes('durable authored draft and original queue'), writeRevision: 2 }, () => true)
  await expect(owner.writeFromRenderer(frame, { value: bytes('late old'), writeRevision: 1 }, () => true)).rejects.toThrow()
  const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
  const worker = join(f.root, 'reader.mjs')
  await build({ stdin: { resolveDir: process.cwd(), contents: `import { WorkbenchUserStateStore } from './apps/desktop/src/main/workbench-user-state.ts'; const value=await new WorkbenchUserStateStore(process.argv[2]).read(); process.stdout.write(JSON.stringify({pid:process.pid,value}));` },
    outfile: worker, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    alias: { '@agentmux/core': resolve('packages/core/src/durable-write.ts'), '@agentmux/core/object-avatar': resolve('packages/core/src/object-avatar.ts'), '@agentmux/core/mote-avatar-series': resolve('packages/core/src/mote/avatar-series.ts'), '@agentmux/identity': resolve('packages/identity/src/index.ts') },
    banner: { js: "import {createRequire as readerCreateRequire} from 'node:module'; const require=readerCreateRequire(import.meta.url);" } })
  const child = spawnSync(process.execPath, [worker, f.path], { encoding: 'utf8', timeout: 10000 })
  expect(child.status, child.stderr).toBe(0)
  const observed = JSON.parse(child.stdout)
  expect(observed.pid).not.toBe(process.pid); expect(observed.value).toBe(bytes('durable authored draft and original queue'))
})
