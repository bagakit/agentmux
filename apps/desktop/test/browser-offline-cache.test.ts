import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { BinaryWriter } from '@bufbuild/protobuf'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, BrowserWindow: class {}, webContents: { getAllWebContents: () => [] } }))
import { inspectBrowserProfileStorage } from '../src/main/browser-profile-storage-inventory.js'
import { BrowserProfileStorage } from '../src/main/browser-profile-storage.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { executeBrowserProfileControl } from '../src/main/browser-profile-control.js'
import { registerBrowserProfileEditorIpc } from '../src/main/browser-profile-editor-ipc.js'
import type { BrowserProfileStorageReceipt } from '@agentmux/core/control'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'amux-cache-owner-')); roots.push(root); return root }
async function seed(root: string, origin = 'https://one.test/', key = origin, bucketId = '2', owner = 0) {
  const url = new URL(origin), identifier = `${url.protocol.slice(0, -1)}_${url.hostname.replaceAll(':', '_')}_${url.port || '0'}` + (owner ? '-1' : '')
  const path = key === origin ? join(root, 'Service Worker', 'CacheStorage', createHash('sha1').update(identifier).digest('hex')) : join(root, 'WebStorage', bucketId, 'CacheStorage')
  await mkdir(path, { recursive: true })
  const proto = new BinaryWriter().tag(2, 2).string(origin).tag(3, 2).string(key).tag(4, 0).int64(bucketId).tag(5, 0).bool(true).finish()
  await writeFile(join(path, 'index.txt'), proto)
  await writeFile(join(path, 'cached-response-body'), 'PRIVATE BODY MUST NEVER BE PARSED'.repeat(32))
  return path
}
it('discovers cold first/third-party exact keys, ignores quota/other clients, excludes BackgroundFetch and keeps corrupt bytes unknown', async () => {
  const root = await directory(), partitioned = 'https://one.test/^0https://top.test'
  await seed(root); await seed(root, 'https://one.test/', partitioned)
  const background = await seed(root, 'https://fetch.test/', 'https://fetch.test/', '4', 1)
  await writeFile(join(background, 'cached-response-body'), 'Background Fetch excluded bytes'.repeat(32768))
  const corrupt = join(root, 'Service Worker', 'CacheStorage', 'unattributed')
  await mkdir(corrupt); await writeFile(join(corrupt, 'index.txt'), 'not-a-proto')
  await writeFile(join(corrupt, 'body'), 'unknown bytes'.repeat(100))
  await writeFile(join(root, 'WebStorage', 'QuotaManager'), 'UNRELATED DATABASE'.repeat(1000))
  await mkdir(join(root, 'WebStorage', '3', 'IndexedDB'), { recursive: true })
  await writeFile(join(root, 'WebStorage', '3', 'IndexedDB', 'data'), 'UNRELATED BODY'.repeat(1000))
  const value = await inspectBrowserProfileStorage(root, 'p', 'r')
  expect(value.sites).toHaveLength(1)
  expect(value.sites[0]!.storageKeys).toEqual(['https://one.test/', partitioned])
  expect(value.sites[0]!.usage.logicalBytes).toBeGreaterThan(0)
  expect(value.unattributed.logicalBytes).toBeGreaterThan(1000)
  expect(value.usage.logicalBytes).toBeLessThan(10000)
  expect(value.usage.complete).toBe(false)
  expect(value.issues.join(' ')).toContain('Background Fetch')
  expect(JSON.stringify(value)).not.toContain(root)
  expect(JSON.stringify(value)).not.toContain('PRIVATE BODY')
})
it('keeps malformed UTF-8 key bytes unknown instead of replacing them with another storage identity', async () => {
  const root = await directory(), origin = 'https://one.test/'
  const path = await seed(root, origin, origin + '^0https://top.test')
  const malformed = Buffer.concat([Buffer.from(origin + '^0https://'), Buffer.from([0xff]), Buffer.from('.test')])
  const proto = new BinaryWriter().tag(2, 2).string(origin).tag(3, 2).bytes(malformed).tag(4, 0).int64('2').tag(5, 0).bool(true).finish()
  await writeFile(join(path, 'index.txt'), proto)
  const value = await inspectBrowserProfileStorage(root, 'p', 'r')
  expect(value.sites).toEqual([])
  expect(value.unattributed.logicalBytes).toBeGreaterThan(0)
  expect(value.usage.complete).toBe(false)
})
it('does not follow profile/client links and does not turn unreadable ownership into complete zero', async () => {
  const root = await directory(), outside = await directory(); await seed(outside)
  await symlink(join(outside, 'Service Worker'), join(root, 'Service Worker'))
  const value = await inspectBrowserProfileStorage(root, 'p', 'r')
  expect(value.sites).toEqual([]); expect(value.usage.complete).toBe(false)
})
async function owner() {
  const root = await directory(); await seed(root)
  let receipts: BrowserProfileStorageReceipt[] = []
  const save = vi.fn(async (_profile: string, receipt: BrowserProfileStorageReceipt, create?: boolean) => {
    if (create && receipts.some(r => r.operationId === receipt.operationId)) throw new Error('already admitted')
    receipts = [...receipts.filter(r => r.operationId !== receipt.operationId), structuredClone(receipt)]
  })
  const clear = vi.fn(async (_key: string) => {
    expect(receipts.at(-1)?.status).toBe('pending')
    expect(receipts.at(-1)?.results[0]?.status).toBe('unknown')
  })
  const ports = { read: async () => ({ revision: 'r', receipts: structuredClone(receipts) }), root: () => root, save,
    change: async <T,>(_id: string, fn: () => Promise<T>) => fn(), native: async () => ({ clear, dispose: vi.fn() }) }
  const storage = new BrowserProfileStorage(ports), confirmation = vi.fn(async () => true)
  storage.setConfirmationHandler(confirmation)
  const input = { profileId: 'p', expectedRevision: 'r', operationId: 'op', sites: [{ origin: 'https://one.test', storageKeys: ['https://one.test/'] }] }
  return { root, ports, storage, clear, input, confirmation, save, receipts: () => receipts }
}
it('persists before confirmation and each dispatch; repeated original OP returns its receipt without replay', async () => {
  const { storage, input, clear, confirmation, receipts } = await owner()
  confirmation.mockImplementation(async () => { expect(receipts()[0]?.status).toBe('awaiting-confirmation'); return true })
  const result = await storage.clear(input)
  expect(result.status).toBe('completed'); expect(result.results[0]?.status).toBe('acknowledged')
  expect(result.after?.usage.logicalBytes).toBeGreaterThan(0) // ACK is not a fabricated guarantee of physical deletion.
  expect(await storage.clear(input)).toEqual(result)
  expect(clear).toHaveBeenCalledExactlyOnceWith(input.sites[0]!.storageKeys[0]); expect(confirmation).toHaveBeenCalledOnce()
  expect((await storage.inspect('p', 'op')).receipt?.operationId).toBe('op')
})
it('retains cancelled and uncertain operations and preserves active confirmation facts', async () => {
  const o = await owner(); let release!: (confirmed: boolean) => void
  o.confirmation.mockImplementation(() => new Promise<boolean>(done => { release = done }))
  const running = o.storage.clear(o.input)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect((await o.storage.inspect('p', 'op')).pending[0]?.status).toBe('awaiting-confirmation')
  release(false); expect((await running).status).toBe('cancelled'); expect(o.clear).not.toHaveBeenCalled()
  const pending = { ...o.receipts()[0]!, status: 'pending' as const, finishedAt: null, results: [{ storageKey: o.input.sites[0]!.storageKeys[0]!, status: 'unknown' as const }] }
  await o.ports.save('p', pending)
  const restarted = new BrowserProfileStorage(o.ports); restarted.setConfirmationHandler(o.confirmation)
  expect((await restarted.inspect('p', 'op')).receipt?.status).toBe('unknown')
  expect((await restarted.clear(o.input)).status).toBe('unknown')
  expect(o.clear).not.toHaveBeenCalled(); expect(o.receipts()[0]?.status).toBe('pending')
})
it('refuses unobserved selection/changed original OP and never dispatches without durable original intent', async () => {
  const o = await owner()
  await expect(o.storage.clear({ ...o.input, sites: [{ origin: 'https://one.test', storageKeys: ['https://other.test/'] }] })).rejects.toThrow()
  expect(o.clear).not.toHaveBeenCalled()
  o.save.mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(o.storage.clear(o.input)).rejects.toThrow('disk unavailable')
  expect(o.confirmation).not.toHaveBeenCalled(); expect(o.clear).not.toHaveBeenCalled()
  await o.storage.clear(o.input)
  await expect(o.storage.clear({ ...o.input, sites: [{ origin: 'https://other.test', storageKeys: ['https://one.test/'] }] })).rejects.toThrow('different parameters')
  expect(o.clear).toHaveBeenCalledTimes(1)
})
it('keeps unknown native effect and remaining keys without retrying or fabricating zero', async () => {
  const o = await owner(); await seed(o.root, 'https://one.test/', 'https://one.test/^0https://top.test')
  o.clear.mockRejectedValueOnce(new Error('connection lost after send'))
  const result = await o.storage.clear({ ...o.input, sites: [{ origin: 'https://one.test', storageKeys: ['https://one.test/', 'https://one.test/^0https://top.test'] }] })
  expect(result.status).toBe('unknown')
  expect(result.results.map(r => r.status)).toEqual(['unknown', 'not-dispatched'])
  expect(o.clear).toHaveBeenCalledTimes(1)
  expect((await o.storage.inspect('p')).pending).toHaveLength(1)
})
it('Manager/Store, public dispatcher and GUI registrar share one owner and durable original operation across reopen', async () => {
  const root = await directory(), file = join(root, 'profiles.json'), data = join(root, 'partition')
  const make = () => new BrowserProfileManager(new BrowserProfileStore(file), { nativeSession: () => ({ storagePath: data }), observe: () => {}, prepare: () => undefined } as never, () => root)
  const manager = make(); await manager.initialize(); const profile = manager.listProfiles()[0]!
  await seed(data); manager.storage.setConfirmationHandler(async () => false)
  const input = { profileId: profile.id, expectedRevision: profile.revision, operationId: 'persisted-op', sites: [{ origin: 'https://one.test', storageKeys: ['https://one.test/'] }] }
  const request = { schemaVersion: 1, requestId: 'rpc', operation: 'browser.profile.storage.clear', ...input }
  const result = await executeBrowserProfileControl(request as never, { profiles: manager } as never, undefined)
  expect(result).toMatchObject({ operation: request.operation, receipt: { status: 'cancelled' } })
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved.profiles[0].storageReceipts[0].operationId).toBe('persisted-op')
  expect(manager.listProfiles()[0]!.revision).toBe(profile.revision)
  const reopen = make(); await reopen.initialize()
  const handlers = new Map<string, (...args: any[]) => any>()
  registerBrowserProfileEditorIpc({ profiles: reopen, handle: (channel, call) => { handlers.set(channel, call) } })
  const inspected = await handlers.get('browser:inspectProfileStorage')!({}, profile.id, 'persisted-op')
  expect(inspected).toMatchObject({ ok: true, value: { receipt: { profileId: profile.id, operationId: 'persisted-op', status: 'cancelled' } } })
  expect(await handlers.get('browser:clearProfileStorage')!({}, input)).toMatchObject({ ok: true, value: { status: 'cancelled' } })
})
