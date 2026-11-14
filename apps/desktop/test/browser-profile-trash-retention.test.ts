import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pack } from 'tar-stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ partialPath: '', partialTriggered: false, copyFailure: false, deleting: [] as string[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (path: any, options: any) => {
    fault.deleting.push(String(path))
    if (String(path) === fault.partialPath && !fault.partialTriggered) {
      fault.partialTriggered = true
      await actual.unlink(join(String(path), 'nested', 'site.data'))
      throw Object.assign(new Error('Controlled partial original directory removal'), { code: 'EIO' })
    }
    return actual.rm(path, options)
  } }
})
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
    if (fault.copyFailure && String(args[0]).endsWith('/profile.tar')) throw Object.assign(new Error('Controlled safety-copy IO failure'), { code: 'EIO' })
    return actual.createWriteStream(...args)
  } }
})
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: { fromPartition: () => { throw new Error('No implicit native admission') } }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore, BrowserProfileWriteUnconfirmed, browserProfilePartition } from '../src/main/browser-profile-store.js'
import { createProfileSafetyCopy, restoreProfileSafetyCopy, verifyProfileSafetyCopy } from '../src/main/browser-profile-purge-data.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileSessions } from '../src/main/browser-profile-session.js'
import { createBrowserProfileUsage } from '../src/main/browser-profile-usage.js'
import { executeBrowserProfileControl } from '../src/main/browser-profile-control.js'
import { parseBrowserProfileControlPayload, parseBrowserProfileControlResult, assertBrowserProfileControlTarget } from '../../../packages/core/src/browser-profile-control.js'
import { mintObjectId } from '../../../packages/core/src/object-id.js'

const roots: string[] = []
afterEach(async () => { fault.partialPath = ''; fault.partialTriggered = false; fault.copyFailure = false; fault.deleting = []; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const person = { kind: 'user', verified: true } as const
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-retention-')); roots.push(root)
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path)
  await store.list()
  const created = await store.createProfile('Retained original', crypto.randomUUID(), profileCreationTestActor), profile = created.profile, data = join(root, 'Partitions', profile.id)
  await mkdir(join(data, 'nested'), { recursive: true }); await writeFile(join(data, 'nested', 'site.data'), 'complete original site data'); await writeFile(join(data, 'cookies.bin'), Buffer.from([3, 8, 1, 0]))
  const archive = (await store.archiveProfile(profile.id, profile.revision, { partition: browserProfilePartition(profile.id), relativePath: `Partitions/${profile.id}` })).archive
  let now = Date.now(), exclusive = true
  const native = Object.assign(new EventEmitter(), { storagePath: data, webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} }, serviceWorkers: { getAllRunning: () => ({}) } }) as any
  const sessions = createBrowserProfileSessions({ session: () => native, retainedSession: () => native, network: () => undefined, openContents: () => [] })
  const manager = new BrowserProfileManager(store, sessions, () => root, { now: () => now, assertExclusiveDataOwner: async () => { if (!exclusive) throw new Error('Another Main may own this storage root') } })
  await manager.initialize()
  const usage = createBrowserProfileUsage({ open: () => [], readSaved: async () => null, nativeUse: id => manager.nativeUse(id), deleteProfile: (...args) => manager.deleteProfile(...args) })
  const ports = { profiles: manager, usage, network: {} as any }
  const purge = (purgeId = mintObjectId()) => manager.purgeProfile(archive.id, manager.listTrash()[0]!.revision, purgeId, id => usage.assertUnused(id))
  return { root, path, store, manager, sessions, native, data, archive, profile, purge, ports, now: (value: number) => { now = value }, exclusive: (value: boolean) => { exclusive = value } }
}

describe('retained Profile expiry and exact irreversible cleanup', () => {
  it('removes the exact inactive partition after a verified durable whole copy and retains its original receipt', async () => {
    const f = await fixture(), neighbor = await f.store.createProfile('Healthy neighbor', crypto.randomUUID(), profileCreationTestActor), purgeId = mintObjectId()
    const result = await f.purge(purgeId)
    expect(result.purge).toMatchObject({ purgeId, archiveId: f.archive.id, profileId: f.profile.id, status: 'deleted' })
    await expect(readFile(join(f.data, 'cookies.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.manager.listTrash()).toEqual([]); expect(await f.manager.inspectTrashPurge(purgeId)).toEqual(result.purge)
    expect((await f.store.read()).profiles.some(value => value.id === neighbor.profile.id)).toBe(true)
    expect(await f.manager.purgeProfile(f.archive.id, f.archive.revision, purgeId, async () => { throw new Error('Must not replay') })).toEqual(result)
    expect((await readFile(f.path, 'utf8')).includes('complete original site data')).toBe(false)
  })
  it('reports independent credential and permission confirmation and never repeats their cleanup on inspection or the same purge ID', async () => {
    const f = await fixture(), cleanup = vi.fn(async () => ({ credentialCleanup: 'unknown' as const, permissionCleanup: 'confirmed' as const })), purgeId = mintObjectId()
    f.manager.cleanupPurgedIdentity = cleanup
    const result = await f.purge(purgeId)
    expect(result.purge).toMatchObject({ status: 'deleted', credentialCleanup: 'unknown', permissionCleanup: 'confirmed' })
    expect(await f.manager.inspectTrashPurge(purgeId)).toEqual(result.purge)
    expect(await f.manager.purgeProfile(f.archive.id, f.archive.revision, purgeId, async () => {})).toEqual(result)
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(f.profile.id)
  })
  it('keeps original bytes when copy creation fails and can restore the same original identity', async () => {
    const f = await fixture(); fault.copyFailure = true
    const result = await f.purge(); expect(result.purge.status).toBe('failed')
    expect(await readFile(join(f.data, 'nested', 'site.data'), 'utf8')).toBe('complete original site data')
    expect(fault.deleting).not.toContain(f.data)
    fault.copyFailure = false
    const entry = f.manager.listTrash()[0]!, restored = await f.manager.restoreProfile(entry.id, entry.revision)
    expect(restored.profile.id).toBe(f.profile.id)
  })
  it('actually removes one source file then fails, and restores complete original bytes from the recorded safety copy', async () => {
    const f = await fixture(); fault.partialPath = f.data
    const result = await f.purge()
    expect(fault.partialTriggered).toBe(true); expect(result.purge.status).toBe('failed')
    await expect(readFile(join(f.data, 'nested', 'site.data'), 'utf8')).resolves.toBe('complete original site data')
    expect(await readFile(join(f.data, 'cookies.bin'))).toEqual(Buffer.from([3, 8, 1, 0]))
    const metadata = JSON.parse(await readFile(f.path, 'utf8')), retained = metadata.trash[0]
    expect(retained.safetyCopy.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(retained.purge.purgeId).toBe(result.purge.purgeId)
    const restored = await f.manager.restoreProfile(retained.id, retained.revision)
    expect(restored.profile.id).toBe(f.profile.id)
    expect(await f.manager.inspectTrashPurge(result.purge.purgeId)).toMatchObject({ status: 'restored' })
  })
  it('does not remove any source bytes when the exact safety-copy phase lacks its original writer confirmation', async () => {
    const f = await fixture(), original = f.store.updateArchivePurge.bind(f.store), purgeId = mintObjectId()
    vi.spyOn(f.store, 'updateArchivePurge').mockImplementation(async (...args) => {
      const saved = await original(...args)
      if (args[2] === 'deleting-data') throw new BrowserProfileWriteUnconfirmed('purge', f.profile.id, saved.snapshot, new Error('Controlled directory ACK loss'))
      return saved
    })
    await expect(f.purge(purgeId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_WRITE_UNCONFIRMED' })
    expect(fault.deleting).not.toContain(f.data)
    expect(await readFile(join(f.data, 'nested', 'site.data'), 'utf8')).toBe('complete original site data')
    expect(await f.manager.inspectTrashPurge(purgeId)).toMatchObject({ status: 'deleting-data' })
    await f.manager.cleanupApprovedTrash(async () => {})
    expect(fault.deleting).not.toContain(f.data)
  })
  it('removes earlier owned recovery copies when the same restored identity is later permanently deleted', async () => {
    const f = await fixture(); fault.partialPath = f.data
    const first = await f.purge(), held = f.manager.listTrash()[0]!
    expect(first.purge.status).toBe('failed')
    const oldCopy = (await f.store.inspectArchive(held.id)).archive.safetyCopy!
    // Exercise the original metadata owner without admitting a native Session in this isolated cold-file fixture.
    const restored = await f.store.restoreProfile(held.id, held.revision)
    const next = (await f.store.archiveProfile(restored.profile.id, restored.profile.revision, f.archive.data)).archive
    await f.manager.refresh(); f.now(Date.now())
    const result = await f.manager.purgeProfile(next.id, next.revision, mintObjectId(), id => f.ports.usage.assertUnused(id))
    expect(result.purge.status).toBe('deleted')
    await expect(readFile(join(f.root, oldCopy.relativePath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.manager.inspectTrashPurge(first.purge.purgeId)).toMatchObject({ status: 'restored' })
    expect(JSON.parse(await readFile(f.path, 'utf8')).purgeReceipts.every((receipt: any) => !receipt.safetyCopy)).toBe(true)
  })
  it('refuses unsafe links and unsupported archive members before replacing the original partition', async () => {
    const f = await fixture(), data = f.archive.data
    await symlink(f.data, join(f.root, '.agentmux-profile-purge'))
    await expect(createProfileSafetyCopy(f.root, f.archive.id, mintObjectId(), data)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' })
    await unlink(join(f.root, '.agentmux-profile-purge'))
    const archive = pack(), buffers: Buffer[] = [], done = (async () => { for await (const bytes of archive) buffers.push(bytes) })()
    archive.entry({ name: 'linked-data', type: 'symlink', linkname: '../outside' }); archive.finalize(); await done
    const bytes = Buffer.concat(buffers), path = join(f.root, 'bad.tar'); await writeFile(path, bytes)
    const copy = { relativePath: 'bad.tar', sha256: createHash('sha256').update(bytes).digest('hex') }
    await expect(verifyProfileSafetyCopy(f.root, copy)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' })
    await expect(restoreProfileSafetyCopy(f.root, data, copy)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' })
    expect(await readFile(join(f.data, 'nested', 'site.data'), 'utf8')).toBe('complete original site data')
    expect(fault.deleting).not.toContain(f.data)
  })
  it('never treats idle counters as permission to remove a native Session admitted earlier in this process', async () => {
    const f = await fixture(); f.sessions.retainedSession(f.profile.id)
    expect(f.manager.nativeUse(f.profile.id).status).toBe('idle')
    const result = await f.purge(); expect(result.purge.status).toBe('waiting-for-restart')
    await f.manager.cleanupApprovedTrash(id => f.ports.usage.assertUnused(id))
    expect(fault.deleting).not.toContain(f.data)
    expect(await readFile(join(f.data, 'nested', 'site.data'), 'utf8')).toBe('complete original site data')
  })
  it('keeps explicit intent and original bytes when another Main may own the same storage root', async () => {
    const f = await fixture(); f.exclusive(false)
    const result = await f.purge(); expect(result.purge).toMatchObject({ status: 'waiting-for-restart', warning: expect.stringContaining('Another Main') })
    expect(fault.deleting).not.toContain(f.data)
    expect(await readFile(join(f.data, 'cookies.bin'))).toEqual(Buffer.from([3, 8, 1, 0]))
  })
  it('leaves legacy archives indefinitely, refuses unknown/backward time, then cleans only the approved expired entry', async () => {
    const f = await fixture(), initial = f.manager.listTrash()[0]!, now = Date.now(), purgeId = mintObjectId()
    await f.manager.cleanupApprovedTrash(id => f.ports.usage.assertUnused(id)); expect(f.manager.listTrash()[0]!.retention).toBeUndefined()
    f.now(now)
    await f.manager.setTrashRetention(initial.id, initial.revision, purgeId, now + 1000)
    f.now(Number.NaN); await expect(f.manager.cleanupApprovedTrash(async () => {})).rejects.toThrow('time is unknown')
    f.now(now - 1); await f.manager.cleanupApprovedTrash(async () => {}); expect(f.manager.listTrash()).toHaveLength(1)
    f.now(now + 1001); await f.manager.cleanupApprovedTrash(id => f.ports.usage.assertUnused(id))
    expect(f.manager.listTrash()).toEqual([]); expect(await f.manager.inspectTrashPurge(purgeId)).toMatchObject({ status: 'deleted' })
  })
  it('rechecks cold/native facts after safety-copy preparation and keeps the complete source on a late use', async () => {
    const f = await fixture(); let reads = 0
    const result = await f.manager.purgeProfile(f.archive.id, f.archive.revision, mintObjectId(), async () => { if (++reads > 1) throw new Error('A saved Browser now references this Profile') })
    expect(reads).toBe(2); expect(result.purge.status).toBe('failed')
    expect(fault.deleting).not.toContain(f.data)
    expect(await readFile(join(f.data, 'nested', 'site.data'), 'utf8')).toBe('complete original site data')
  })
  it('keeps unknown store and usage reads from deleting data or manufacturing an empty replacement', async () => {
    const f = await fixture(), result = await f.manager.purgeProfile(f.archive.id, f.archive.revision, mintObjectId(), async () => { throw new Error('Saved Tabs cannot be read') })
    expect(result.purge.status).toBe('waiting-for-restart'); expect(fault.deleting).not.toContain(f.data)
    await unlink(f.path)
    await expect(f.manager.cleanupApprovedTrash(async () => {})).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.data, 'cookies.bin'))).toEqual(Buffer.from([3, 8, 1, 0]))
  })
  it('serves the real public dispatcher/strict codecs with exact targets and authenticated destructive authority', async () => {
    const f = await fixture(), purgeId = mintObjectId(), request = { schemaVersion: 5 as const, requestId: 'request', ...parseBrowserProfileControlPayload({ operation: 'browser.profile.trash.purge', archiveId: f.archive.id, expectedRevision: f.archive.revision, purgeId }, ['operation']) }
    await expect(executeBrowserProfileControl(request as any, f.ports, { kind: 'agent', verified: true, id: 'caller' })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DELETE_REQUIRES_PERSON' })
    const result = await executeBrowserProfileControl(request as any, f.ports, person)
    const { operation: _operation, ...body } = result
    const parsed = parseBrowserProfileControlResult('browser.profile.trash.purge', body)
    expect(() => parseBrowserProfileControlResult('browser.profile.trash.purge', { ...body, purge: { ...(body as any).purge, credentialCleanup: 'success' } })).toThrow('Independent cleanup receipt is invalid')
    expect(() => parseBrowserProfileControlResult('browser.profile.trash.purge', { ...body, purge: { ...(body as any).purge, safetyCopy: '/private-data' } })).toThrow()
    assertBrowserProfileControlTarget(request as any, { operation: request.operation, ...parsed } as any)
    expect(parsed).toMatchObject({ purge: { purgeId, status: 'deleted' } })
    expect(() => assertBrowserProfileControlTarget(request as any, { operation: request.operation, ...parsed, purge: { ...(parsed as any).purge, archiveId: 'wrong-archive' } } as any)).toThrow('another original action')
  })
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
