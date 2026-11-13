// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, webcrypto } from 'node:crypto'
import { durableWriteFile } from '@agentmux/core'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('monaco-editor', () => ({}))
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { fileViewReadingOwnerKey, encodeFileViewReading, type FileViewReadingOwner } from '../src/shared/workbench-user-state'
import { useAppStore, checkpointFileViewReading } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFileViewReadingBinding, readingProjection, type FileViewReadingBinding } from '../src/renderer/src/lib/file-view-reading'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig } from './helpers/composer-dom-fixture'
import { agent } from './helpers/workface-control-fixture'

const initial = useAppStore.getState(), owner: FileViewReadingOwner = { regionId: 'book', workspaceId: 'workspace', hostId: 'local', workspacePath: '/original/root', path: 'novel.epub' }
const position = (progress = .625) => ({ section: 2, sectionId: 'chapter-3', progress })
const deferred = <T = void>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
let directory: string
let native: WorkbenchUserStateStore
let rootPath: string
let writes: { path: string; bytes: number }[]
let reads: string[]
const memberPath = (value = owner) => join(rootPath + '.file-view-reading', createHash('sha256').update(fileViewReadingOwnerKey(value)).digest('hex') + '.json')
const projection = (value = owner) => readingProjection(useAppStore.getState().fileViewReading, value)!
function originalTab() { return addWorkbenchRegion(createWorkbenchTab('original-tab', { regionId: 'book', kind: 'file', workspaceId: 'workspace', path: 'novel.epub' }), 'book', 'right', { regionId: 'healthy-agent', kind: 'agent', workspaceId: 'workspace', phase: 'attached', sessionId: 'retained-session' }) }
function binding(capture = () => {}, scope = owner): FileViewReadingBinding {
  return createFileViewReadingBinding({ resource: { workspaceId: scope.workspaceId, hostId: scope.hostId, workspacePath: scope.workspacePath }, current: () => true }, 'original-tab', scope.regionId, scope.path, useAppStore.getState, capture)
}
function ports(store = native) {
  vi.spyOn(api.ui, 'readFileViewReading').mockImplementation(value => store.readFileViewReading(value))
  vi.spyOn(api.ui, 'writeFileViewReading').mockImplementation(value => store.writeFileViewReading(value))
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  directory = await mkdtemp(join(tmpdir(), 'agentmux-reading-member-')); rootPath = join(directory, 'user.json'); writes = []; reads = []
  native = new WorkbenchUserStateStore(rootPath, { read: async (path, encoding) => { reads.push(path); return readFile(path, encoding) }, write: async (path, body, options) => { writes.push({ path, bytes: Buffer.byteLength(body) }); return durableWriteFile(path, body, options) } })
  const tab = originalTab()
  useAppStore.setState({ config: composerConfig, loading: false, tabs: { [tab.id]: tab }, fileViewReading: {}, sessions: [], documents: {}, dirtyDocuments: {}, savingDocuments: {} })
  ports()
})
afterEach(async () => {
  await checkpointFileViewReading().catch(() => {})
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true })
})

it('uses one physical exact-Region/resource member and real durable ACK, retaining unrelated root bytes and graph references', async () => {
  const root = JSON.stringify({ version: 1, state: { originalDraft: 'x'.repeat(4 * 1024 * 1024) } }); await writeFile(rootPath, root)
  const before = useAppStore.getState(), view = binding()
  await before.loadFileViewReading(view)
  before.setFileViewReading(view, position()); await checkpointFileViewReading()
  expect(projection()).toMatchObject({ position: position(), input: 1, acknowledged: 1, pending: false, phase: 'ready' })
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().documents).toBe(before.documents); expect(useAppStore.getState().dirtyDocuments).toBe(before.dirtyDocuments)
  expect(reads.every(path => path !== rootPath)).toBe(true); expect(writes).toEqual([{ path: memberPath(), bytes: Buffer.byteLength(encodeFileViewReading({ owner, position: position() })) }]); expect(writes[0]!.bytes).toBeLessThan(512)
  expect(await readFile(rootPath, 'utf8')).toBe(root); expect(JSON.parse(await readFile(memberPath(), 'utf8'))).toEqual({ schema: 'agentmux.file-view-reading.v1', owner, position: position() })
  const restart = new WorkbenchUserStateStore(rootPath); expect(await restart.readFileViewReading(owner)).toEqual({ owner, position: position() })
  expect(await readdir(rootPath + '.file-view-reading')).toHaveLength(1)
})

it('has zero unrelated Session or File path inspections and constant member bytes as unrelated workfaces grow', async () => {
  let tracking = false, sessionReads = 0, pathReads = 0
  const tab = originalTab(), tabs: Record<string, any> = { [tab.id]: tab }
  for (let index = 0; index < 200; index++) { const surface: any = { kind: 'file', regionId: 'other-region-' + index, workspaceId: 'workspace' }; Object.defineProperty(surface, 'path', { enumerable: true, get() { if (tracking) pathReads++; return 'other.txt' } }); const other = createWorkbenchTab('other-tab-' + index, surface); tabs[other.id] = other }
  const sessions = Array.from({ length: 1000 }, (_, index) => { const item = agent('unrelated-' + index); Object.defineProperty(item, 'id', { enumerable: true, get() { if (tracking) sessionReads++; return 'unrelated-' + index } }); return item })
  useAppStore.setState({ tabs, sessions }); const view = binding(); await useAppStore.getState().loadFileViewReading(view); view.current()
  let graphInvalidations = 0; const stop = useAppStore.subscribe((state, old) => { if (state.tabs !== old.tabs || state.sessions !== old.sessions || state.layouts !== old.layouts) graphInvalidations++ })
  tracking = true; useAppStore.getState().setFileViewReading(view, position(.75)); await checkpointFileViewReading(); tracking = false; stop()
  expect({ sessionReads, pathReads, graphInvalidations }).toEqual({ sessionReads: 0, pathReads: 0, graphInvalidations: 0 })
  expect(writes).toHaveLength(1); expect(writes[0]!.bytes).toBeLessThan(512); expect(reads.every(path => path !== rootPath)).toBe(true)
  if (process.env.FILE_VIEW_READING_COST) await writeFile(resolve(process.env.FILE_VIEW_READING_COST), JSON.stringify({ unrelatedSessions: 1000, unrelatedTabs: 200, sessionReads, pathReads, graphInvalidations, memberWriteBytes: writes[0]!.bytes, rootReadOrWrite: reads.includes(rootPath) || writes.some(item => item.path === rootPath) }, null, 2) + '\n')
})

it('keeps initial unread/default layout as baseline, never overwrites corrupt bytes, and restores on explicit retry', async () => {
  await native.readFileViewReading(owner); await native.writeFileViewReading({ owner, position: position(.82) }); await writeFile(memberPath(), '{original damaged bytes')
  const view = binding(); await useAppStore.getState().loadFileViewReading(view)
  const failedWrites = writes.length
  useAppStore.getState().setFileViewReading(view, position(0), true)
  useAppStore.getState().setFileViewReading(view, position(0))
  expect(projection()).toMatchObject({ loaded: false, phase: 'error', input: 0, acknowledged: 0, position: position(0) })
  await checkpointFileViewReading()
  expect(await readFile(memberPath(), 'utf8')).toBe('{original damaged bytes'); expect(writes).toHaveLength(failedWrites)
  await writeFile(memberPath(), encodeFileViewReading({ owner, position: position(.82) }))
  await useAppStore.getState().retryFileViewReading(view)
  expect(projection()).toMatchObject({ loaded: true, position: position(.82), input: 0, restoration: 1 }); expect(writes).toHaveLength(failedWrites)
})

it('holds a real changed DOM position across failed read, then explicitly saves it after recovery without rollback', async () => {
  await native.readFileViewReading(owner); await native.writeFileViewReading({ owner, position: position(.4) }); await writeFile(memberPath(), 'unknown')
  const view = binding(); await useAppStore.getState().loadFileViewReading(view)
  useAppStore.getState().setFileViewReading(view, position(0), true)
  useAppStore.getState().setFileViewReading(view, position(.91))
  await expect(checkpointFileViewReading()).rejects.toThrow(); expect(await readFile(memberPath(), 'utf8')).toBe('unknown')
  await writeFile(memberPath(), encodeFileViewReading({ owner, position: position(.4) })); await useAppStore.getState().retryFileViewReading(view); await checkpointFileViewReading()
  expect(projection()).toMatchObject({ input: 1, acknowledged: 1, position: position(.91), phase: 'ready' }); expect(JSON.parse(await readFile(memberPath(), 'utf8')).position).toEqual(position(.91))
})

it('refuses writes without qualified read and revalidates a once-read member before replacement', async () => {
  await expect(native.writeFileViewReading({ owner, position: position() })).rejects.toMatchObject({ code: 'FILE_VIEW_READING_READ_UNCONFIRMED' })
  expect(writes).toHaveLength(0)
  await native.readFileViewReading(owner); const receipt = await native.writeFileViewReading({ owner, position: position() })
  await writeFile(receipt.path, 'externally corrupt original'); const prior = writes.length
  await expect(native.writeFileViewReading({ owner, position: position(.9) })).rejects.toThrow()
  expect(writes).toHaveLength(prior); expect(await readFile(receipt.path, 'utf8')).toBe('externally corrupt original')
  await expect(native.flushFileViewReadings()).rejects.toMatchObject({ code: 'FILE_VIEW_READING_SAVE_UNCONFIRMED' })
})

it('keeps ordinary root fences healthy while an exact reading member write is delayed or failed', async () => {
  const root = JSON.stringify({ state: { draft: 'retained' }, version: 1 }); await writeFile(rootPath, root)
  const entered = deferred(), release = deferred()
  const separate = new WorkbenchUserStateStore(rootPath, { write: async (path, body, options) => { if (path !== rootPath) { entered.resolve(); await release.promise; throw new Error('member fsync unavailable') }; await durableWriteFile(path, body, options) } })
  await separate.readFileViewReading(owner); const writing = separate.writeFileViewReading({ owner, position: position() }); const rejected = writing.catch(error => error); await entered.promise
  try {
    expect(await Promise.race([separate.read(), new Promise(resolve => setTimeout(() => resolve('BLOCKED'), 100))])).toBe(root)
    expect(await separate.write(root)).toMatchObject({ path: rootPath, diskDurability: 'confirmed' })
  } finally { release.resolve() }
  expect((await rejected).message).toBe('member fsync unavailable'); expect(separate.observe().lastFailure).toBeNull(); expect(await separate.read()).toBe(root)
  await expect(separate.flushFileViewReadings()).rejects.toThrow(); expect(await separate.read()).toBe(root)
})

it('isolates different Region/resource members and lets unrelated members save during a delayed member', async () => {
  const entered = deferred(), release = deferred(); let first = true
  const store = new WorkbenchUserStateStore(rootPath, { write: async (path, body, options) => { if (first) { first = false; entered.resolve(); await release.promise }; await durableWriteFile(path, body, options) } })
  const other = { ...owner, workspacePath: '/replacement/root' }
  await store.readFileViewReading(owner); await store.readFileViewReading(other)
  const old = store.writeFileViewReading({ owner, position: position(.3) }); await entered.promise
  try { const result = await Promise.race([store.writeFileViewReading({ owner: other, position: position(.8) }), new Promise(resolve => setTimeout(() => resolve(null), 100))]); expect(result).toMatchObject({ owner: other, diskDurability: 'confirmed' }) } finally { release.resolve(); await old }
  expect(await store.readFileViewReading(owner)).toEqual({ owner, position: position(.3) }); expect(await store.readFileViewReading(other)).toEqual({ owner: other, position: position(.8) }); expect(memberPath(other)).not.toBe(memberPath())
})

it('rejects wrong receipts and retains the newest input until a real same-value writer ACK succeeds', async () => {
  const view = binding(); await useAppStore.getState().loadFileViewReading(view)
  vi.mocked(api.ui.writeFileViewReading).mockImplementation(async record => ({ ...await native.writeFileViewReading(record), contentDigest: 'not-the-input' }))
  useAppStore.getState().setFileViewReading(view, position(.9)); await expect(checkpointFileViewReading()).rejects.toThrow('did not confirm')
  expect(projection()).toMatchObject({ position: position(.9), input: 1, acknowledged: 0, phase: 'error' })
  vi.mocked(api.ui.writeFileViewReading).mockImplementation(record => native.writeFileViewReading(record))
  const before = writes.length; await useAppStore.getState().retryFileViewReading(view); await checkpointFileViewReading()
  expect(writes.length).toBe(before + 1); expect(projection()).toMatchObject({ input: 1, acknowledged: 1, phase: 'ready', position: position(.9) })
})

it('captures the actual final position before the ordinary 500ms callback and joins the latest writer', async () => {
  let current = .1
  const view = binding(() => useAppStore.getState().setFileViewReading(view, position(current)))
  await useAppStore.getState().loadFileViewReading(view); useAppStore.getState().setFileViewReading(view, position(.1), true)
  current = .94; await checkpointFileViewReading()
  expect(projection()).toMatchObject({ position: position(.94), input: 1, acknowledged: 1 }); expect(JSON.parse(await readFile(memberPath(), 'utf8')).position.progress).toBe(.94)
})

it('preserves the Region key across move/promote and accepts its final cleanup, then rejects a retargeted or expired reader', async () => {
  let alive = true
  const view = createFileViewReadingBinding({ resource: { workspaceId: owner.workspaceId, hostId: owner.hostId, workspacePath: owner.workspacePath }, current: () => alive }, 'original-tab', owner.regionId, owner.path, useAppStore.getState, () => {})
  await useAppStore.getState().loadFileViewReading(view)
  const moved = createWorkbenchTab('promoted-tab', useAppStore.getState().tabs['original-tab']!.regions.book!)
  useAppStore.setState({ tabs: { [moved.id]: moved } }); expect(view.current()).toBe(true)
  useAppStore.getState().setFileViewReading(view, position(.7)); await checkpointFileViewReading(); expect(projection().acknowledged).toBe(1)
  useAppStore.setState({ tabs: {} }); useAppStore.getState().setFileViewReading(view, position(.83)); await checkpointFileViewReading()
  expect(JSON.parse(await readFile(memberPath(), 'utf8')).position.progress).toBe(.83)
  const replacement = createWorkbenchTab('promoted-tab', { kind: 'file', regionId: owner.regionId, workspaceId: owner.workspaceId, path: 'other.epub' })
  useAppStore.setState({ tabs: { [replacement.id]: replacement } }); useAppStore.getState().setFileViewReading(view, position(.95)); expect(projection().position?.progress).toBe(.83)
  alive = false; useAppStore.setState({ tabs: { 'original-tab': originalTab() } }); useAppStore.getState().setFileViewReading(view, position(.99)); expect(projection().position?.progress).toBe(.83)
})

it('discards a late original read after A→B→A source lifetimes and never rolls the new reader back', async () => {
  let oldAlive = true; const delayed = deferred<any>()
  vi.mocked(api.ui.readFileViewReading).mockImplementationOnce(() => delayed.promise)
  const old: FileViewReadingBinding = { owner, current: () => oldAlive, capture() {} }
  const first = useAppStore.getState().loadFileViewReading(old); oldAlive = false
  const fresh = binding(); await useAppStore.getState().loadFileViewReading(fresh)
  useAppStore.getState().setFileViewReading(fresh, position(.88)); await checkpointFileViewReading()
  delayed.resolve({ owner, position: position(.12) }); await first
  useAppStore.getState().setFileViewReading(old, position(.99))
  expect(projection()).toMatchObject({ position: position(.88), input: 1, acknowledged: 1, binding: fresh })
})


it('retries an accepted original-owner position at controlled checkpoint after its File display closed', async () => {
  const view = binding(); await useAppStore.getState().loadFileViewReading(view)
  vi.mocked(api.ui.writeFileViewReading).mockRejectedValueOnce(new Error('one failed member write'))
  useAppStore.getState().setFileViewReading(view, position(.89))
  // Let the admitted asynchronous write fail, without invoking the controlled retry yet.
  await vi.waitFor(() => expect(projection().phase).toBe('error'))
  const other = createWorkbenchTab('replacement-tab', { kind: 'file', regionId: owner.regionId, workspaceId: owner.workspaceId, path: 'replacement.epub' })
  useAppStore.setState({ tabs: { [other.id]: other } }); expect(view.current()).toBe(false)
  await checkpointFileViewReading()
  expect(projection()).toMatchObject({ input: 1, acknowledged: 1, position: position(.89), phase: 'ready' })
  expect(JSON.parse(await readFile(memberPath(), 'utf8')).owner.path).toBe('novel.epub')
  expect(useAppStore.getState().tabs[other.id]).toBe(other)
})

it('can save an already accepted original preference after Workspace removal/rebind without invoking the stale reader', async () => {
  let oldResource = true, staleCaptures = 0
  const view = createFileViewReadingBinding({ resource: { workspaceId: owner.workspaceId, hostId: owner.hostId, workspacePath: owner.workspacePath }, current: () => oldResource }, 'original-tab', owner.regionId, owner.path, useAppStore.getState, () => { staleCaptures++ })
  await useAppStore.getState().loadFileViewReading(view)
  vi.mocked(api.ui.writeFileViewReading).mockRejectedValueOnce(new Error('original member unavailable'))
  useAppStore.getState().setFileViewReading(view, position(.86)); await vi.waitFor(() => expect(projection().phase).toBe('error'))
  oldResource = false; useAppStore.setState({ config: { ...composerConfig, workspaces: [] } })
  useAppStore.getState().setFileViewReading(view, position(.99)); await checkpointFileViewReading()
  expect(staleCaptures).toBe(0); expect(projection()).toMatchObject({ position: position(.86), input: 1, acknowledged: 1 })
  expect(JSON.parse(await readFile(memberPath(), 'utf8'))).toMatchObject({ owner, position: position(.86) })
})

it('coalesces inflight samples and prevents an old ACK from rolling back a fresh A lifetime', async () => {
  const entered = deferred(), release = deferred(); let first = true, oldAlive = true
  const store = new WorkbenchUserStateStore(rootPath, { write: async (path, body, options) => { if (first) { first = false; entered.resolve(); await release.promise }; writes.push({ path, bytes: Buffer.byteLength(body) }); await durableWriteFile(path, body, options) } })
  vi.mocked(api.ui.readFileViewReading).mockImplementation(value => store.readFileViewReading(value)); vi.mocked(api.ui.writeFileViewReading).mockImplementation(record => store.writeFileViewReading(record))
  const old: FileViewReadingBinding = { owner, current: () => oldAlive, capture() {} }
  await useAppStore.getState().loadFileViewReading(old); useAppStore.getState().setFileViewReading(old, position(.2)); await entered.promise
  oldAlive = false; const fresh = binding(), opening = useAppStore.getState().loadFileViewReading(fresh)
  for (let index = 0; index < 50; index++) useAppStore.getState().setFileViewReading(fresh, position(.5 + index / 100))
  release.resolve(); await opening; await checkpointFileViewReading()
  expect(writes).toHaveLength(2); expect(projection()).toMatchObject({ position: position(.99), input: 51, acknowledged: 51, phase: 'ready', binding: fresh }); expect(JSON.parse(await readFile(memberPath(), 'utf8')).position.progress).toBe(.99)
})


it('requires the existing App root namespace directory ACK before publishing a member durable receipt', async () => {
  const steps: string[] = []; let fail = true
  const store = new WorkbenchUserStateStore(rootPath, { syncDirectory: async path => { expect(path).toBe(directory); steps.push('root-directory-sync'); if (fail) throw new Error('namespace directory sync unavailable') }, write: async (path, body, options) => { steps.push('member-durable-write'); await durableWriteFile(path, body, options) } })
  await store.readFileViewReading(owner)
  await expect(store.writeFileViewReading({ owner, position: position() })).rejects.toThrow('namespace directory sync unavailable')
  expect(steps).toEqual(['root-directory-sync']); expect(await store.readFileViewReading(owner)).toBeNull()
  await expect(store.flushFileViewReadings()).rejects.toThrow('no confirmed writer')
  fail = false; const receipt = await store.writeFileViewReading({ owner, position: position() })
  expect(steps).toEqual(['root-directory-sync', 'root-directory-sync', 'member-durable-write']); expect(receipt.diskDurability).toBe('confirmed'); expect(store.observe().lastFailure).toBeNull(); await store.flushFileViewReadings()
})
