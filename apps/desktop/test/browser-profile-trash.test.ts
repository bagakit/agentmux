import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
const diskFault = vi.hoisted(() => ({ path: '', mode: 'none' as 'none' | 'before-replace' | 'directory-sync' | 'directory-sync-and-read', readUnavailable: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    open: async (path: any, ...args: any[]) => {
      if (diskFault.mode === 'before-replace' && String(path).startsWith(diskFault.path + '.') && args[0] === 'wx') {
        diskFault.mode='none';diskFault.readUnavailable=true
        throw Object.assign(new Error('Injected original metadata temporary-file open failure'),{code:'EIO'})
      }
      const handle = await (actual.open as any)(path, ...args)
      if (diskFault.mode.startsWith('directory-sync') && String(path) === diskFault.path.slice(0, diskFault.path.lastIndexOf('/')) && args[0] === 'r') {
        const unreadable = diskFault.mode === 'directory-sync-and-read';diskFault.mode='none'
        handle.sync=async()=>{diskFault.readUnavailable=unreadable;throw Object.assign(new Error('Injected original metadata parent-directory sync failure'),{code:'EIO'})}
      }
      return handle
    },
    readFile: async (path:any,...args:any[]) => {
      if(diskFault.readUnavailable && String(path)===diskFault.path)throw Object.assign(new Error('Injected original metadata read failure'),{code:'EIO'})
      return (actual.readFile as any)(path,...args)
    }
  }
})
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: { fromPartition: () => { throw new Error('No implicit native owner') } }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore, browserProfilePartition } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileSessions } from '../src/main/browser-profile-session.js'
import { createBrowserProfileUsage } from '../src/main/browser-profile-usage.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { executeBrowserProfileControl } from '../src/main/browser-profile-control.js'
import { describeRetainedPartition, inspectRetainedPartition } from '../src/main/browser-profile-retained-data.js'
import { parseBrowserProfileControlPayload, parseBrowserProfileControlResult, assertBrowserProfileControlTarget } from '../../../packages/core/src/browser-profile-control.js'

const roots: string[] = []
afterEach(async () => { diskFault.mode='none';diskFault.readUnavailable=false;diskFault.path='';await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const approval = (profileId: string) => ({ kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId } as const)
const person = { kind: 'user', verified: true } as const
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-trash-')); roots.push(root)
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path)
  const targets = new Map<string, any>()
  let workers: Record<number, unknown> = {}, workerError = false
  const native = (id: string) => {
    if (targets.has(id)) return targets.get(id)
    const target = Object.assign(new EventEmitter(), { storagePath: join(root, 'Partitions', id),
      webRequest: {} as Record<string, any>, serviceWorkers: { getAllRunning: () => { if (workerError) throw new Error('Unavailable'); return workers } },
      setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}) })
    for (const name of ['onBeforeRequest', 'onCompleted', 'onErrorOccurred']) target.webRequest[name] = (callback: unknown) => { target.webRequest[name + 'Callback'] = callback }
    targets.set(id, target); return target
  }
  let manager: BrowserProfileManager
  const sessions = createBrowserProfileSessions({ session: id => { manager.resolvePartition(id); return native(id) }, retainedSession: native, network: () => undefined, openContents: () => [] })
  manager = new BrowserProfileManager(store, sessions, () => root); await manager.initialize()
  const profile = await manager.createProfile('Original retained Profile', crypto.randomUUID(), profileCreationTestActor), data = join(root, 'Partitions', profile.id)
  await mkdir(join(data, 'nested'), { recursive: true }); await writeFile(join(data, 'nested', 'site.data'), 'original site data')
  const usage = createBrowserProfileUsage({ open: () => [], readSaved: async () => null, nativeUse: id => manager.nativeUse(id), deleteProfile: (...args) => manager.deleteProfile(...args) })
  const token = () => manager.listProfiles().find(value => value.id === profile.id)!.revision
  return { root, path, store, manager, profile, sessions, native, usage, data, token, workers: (value: Record<number, unknown>) => { workers = value }, workerError: (value: boolean) => { workerError = value } }
}

describe('Profile recycle and exact restore on the original metadata and native owners', () => {
  it('atomically retains the full original record and untouched partition, then restores the original identity with a fresh token after restart', async () => {
    const f = await fixture(), folder = await f.manager.createFolder('Original folder', f.manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    await f.manager.updateProfile(f.profile.id, { notes: 'Original notes', tags: ['Keep'], folderId: folder.id, pinned: true, agentAccess: false,
      environment: { userAgent: 'Original UA', acceptLanguages: ['fr-FR'] }, network: { mode: 'proxy', server: 'http://proxy.example:8080' } }, f.token())
    const { proxy } = await f.manager.saveProxy({ label: 'Retained proxy asset', server: 'http://proxy.example:8080' }, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    expect(await f.manager.assignProxy(proxy.id, proxy.revision, [{ profileId: f.profile.id, expectedRevision: f.token() }])).toMatchObject([{ outcome: 'updated' }])
    const original = JSON.parse(await readFile(f.path, 'utf8')).profiles.find((p: any) => p.id === f.profile.id)
    const bytes = await readFile(join(f.data, 'nested', 'site.data')), token = f.token()
    const receipt = await f.usage.deleteProfile(f.profile.id, approval(f.profile.id), token)
    expect(f.manager.listProfiles().some(p => p.id === f.profile.id)).toBe(false)
    const metadata = JSON.parse(await readFile(f.path, 'utf8')); expect(metadata.trash[0].profile).toEqual(original)
    await expect(f.manager.deleteProxy(proxy.id, proxy.revision)).rejects.toMatchObject({ code: 'BROWSER_PROXY_IN_USE' })
    expect(f.manager.listProxies()).toEqual([proxy]); expect(f.manager.listTrashedProfiles()[0]!.proxyBinding).toEqual({ proxyId: proxy.id, revision: proxy.revision })
    expect(metadata.trash[0].data).toEqual({ partition: browserProfilePartition(f.profile.id), relativePath: `Partitions/${f.profile.id}` })
    expect(await readFile(join(f.data, 'nested', 'site.data'))).toEqual(bytes)
    expect(f.native(f.profile.id).clearStorageData).not.toHaveBeenCalled()
    expect(f.manager.listTrashedProfiles()[0]).toMatchObject({ id: f.profile.id, agentAccess: false })
    expect(f.manager.profileOfSession(f.native(f.profile.id))).toBe(f.profile.id)
    expect(f.manager.proxyOf(f.profile.id)).toEqual({ host: 'proxy.example', port: 8080 })
    const restarted = new BrowserProfileManager(new BrowserProfileStore(f.path), f.sessions, () => f.root); await restarted.initialize()
    expect(restarted.listTrash()).toEqual(f.manager.listTrash())
    const restored = await restarted.restoreProfile(receipt.archive.id, receipt.archive.revision)
    expect(restored.profile.id).toBe(f.profile.id); expect(restored.profile.revision).not.toBe(token)
    const restoredRecord = JSON.parse(await readFile(f.path, 'utf8')).profiles.find((p: any) => p.id === f.profile.id)
    expect({ ...restoredRecord, revision: token }).toEqual(original)
    expect(await readFile(join(f.data, 'nested', 'site.data'))).toEqual(bytes)
    expect(restarted.listTrash()).toEqual([])
  })

  it('keeps active identity/data on source IO, stale token and unknown native observation; healthy admission recovers after the failed operation', async () => {
    const f = await fixture(), before = await readFile(f.path, 'utf8')
    await expect(f.usage.deleteProfile(f.profile.id, approval(f.profile.id), 'stale')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    f.workerError(true)
    await expect(f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({ code: 'BROWSER_PROFILE_USAGE_UNKNOWN' })
    f.workerError(false); await symlink(join(f.root, 'outside'), join(f.data, 'link'))
    await expect(f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' })
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect(f.manager.resolvePartition(f.profile.id)).toBe(browserProfilePartition(f.profile.id))
    await rm(join(f.data, 'link'))
    await rename(f.path, f.path+'.kept')
    await expect(f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({code:'ENOENT'})
    await expect(readFile(f.path)).rejects.toMatchObject({code:'ENOENT'})
    expect(f.manager.resolvePartition(f.profile.id)).toBe(browserProfilePartition(f.profile.id))
    await rename(f.path+'.kept',f.path)
    await f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())
    expect(f.manager.listTrash()).toHaveLength(1)
  })

  it('uses the actual native request/worker/download callbacks and rejects only this recycle while their original work continues', async () => {
    const f = await fixture(), target = f.sessions.nativeSession(f.profile.id) as any
    const proceed = vi.fn(); target.webRequest.onBeforeRequestCallback({ id: 91 }, proceed)
    expect(proceed).toHaveBeenCalledWith({})
    await expect(f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE' })
    target.webRequest.onCompletedCallback({ id: 91 }); f.workers({ 7: {} })
    await expect(f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE' })
    f.workers({}); let state = 'progressing'
    const item = Object.assign(new EventEmitter(), { getState: () => state, canResume: () => true })
    target.emit('will-download', {}, item)
    await expect(f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE' })
    state = 'completed'; item.emit('done')
    expect(f.manager.nativeUse(f.profile.id)).toEqual({ status: 'idle', pages: 0, workers: 0, requests: 0, downloads: 0 })
    await f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())
    expect(target.clearStorageData).not.toHaveBeenCalled()
  })

  it('rechecks cold/native consumers inside the configuration queue, and fences a new admission while source IO yields', async () => {
    const f = await fixture(), archive = f.store.archiveProfile.bind(f.store)
    let fenced = false
    f.store.archiveProfile = async (...args) => {
      expect(f.manager.listProfiles().some(p => p.id === f.profile.id)).toBe(true)
      expect(() => f.manager.prepareSession(f.profile.id)).toThrow(/being recycled/); fenced = true
      return archive(...args)
    }
    let calls = 0
    await expect(f.manager.deleteProfile(f.profile.id, approval(f.profile.id), f.token(), async () => {
      if (++calls === 2) throw Object.assign(new Error('Late closing native owner'), { code: 'BROWSER_PROFILE_IN_USE' })
    })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE' })
    expect(f.manager.listProfiles().some(p => p.id === f.profile.id)).toBe(true)
    await f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token()); expect(fenced).toBe(true)
  })

  it('preserves unknown or referenced saved Tabs, including a Profile edit queued before recycle', async () => {
    const f = await fixture(), stale = f.token()
    const update = f.manager.updateProfile(f.profile.id, { notes: 'Earlier queued configuration' }, stale)
    const recycle = f.usage.deleteProfile(f.profile.id, approval(f.profile.id), stale)
    await update; await expect(recycle).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    const unknown = createBrowserProfileUsage({ open: () => [], readSaved: async () => { throw new Error('Unreadable original graph') }, nativeUse: id => f.manager.nativeUse(id), deleteProfile: (...args) => f.manager.deleteProfile(...args) })
    await expect(unknown.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({ code: 'BROWSER_PROFILE_USAGE_UNKNOWN' })
    const open = createBrowserProfileUsage({ open: () => [{ browserId: 'actual-closing', workspaceId: null, title: 'Closing', url: '' }], readSaved: async () => null, nativeUse: id => f.manager.nativeUse(id), deleteProfile: (...args) => f.manager.deleteProfile(...args) })
    await expect(open.deleteProfile(f.profile.id, approval(f.profile.id), f.token())).rejects.toMatchObject({ code: 'BROWSER_PROFILE_IN_USE' })
    expect(f.manager.listProfiles().find(p => p.id === f.profile.id)?.notes).toBe('Earlier queued configuration')
  })

  it('checks retained source before acquiring a replacement Session, rejects stale archive/folder conflicts and never overwrites another owner', async () => {
    const f = await fixture(), folder = await f.manager.createFolder('Later removed', f.manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    await f.manager.updateProfile(f.profile.id, { folderId: folder.id }, f.token())
    const receipt = await f.usage.deleteProfile(f.profile.id, approval(f.profile.id), f.token())
    await f.manager.deleteFolder(folder.id, f.manager.listRevision())
    await expect(f.manager.restoreProfile(receipt.archive.id, 'stale')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    await expect(f.manager.restoreProfile(receipt.archive.id, receipt.archive.revision)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_RESTORE_FOLDER_CONFLICT' })
    const saved = join(f.root, 'held-original'); await rename(f.data, saved)
    const acquire = vi.spyOn(f.sessions, 'retainedSession')
    await expect(f.manager.restoreProfile(receipt.archive.id, receipt.archive.revision, null)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' })
    expect(acquire).not.toHaveBeenCalled(); expect(f.manager.listTrash()).toHaveLength(1)
    await rename(saved, f.data)
    const restored = await f.manager.restoreProfile(receipt.archive.id, receipt.archive.revision, null)
    expect(restored.profile.folderId).toBeUndefined(); expect(restored.profile.id).toBe(f.profile.id)
    await expect(f.manager.restoreProfile(receipt.archive.id, receipt.archive.revision, null)).rejects.toThrow()
  })

  it('keeps original legacy deletion tombstones and data at startup without fabricating a recoverable archive', async () => {
    const f = await fixture(), metadata = JSON.parse(await readFile(f.path, 'utf8'))
    metadata.profiles = metadata.profiles.filter((p: any) => p.id !== f.profile.id); metadata.pendingDeletes = [f.profile.id]
    await writeFile(f.path, JSON.stringify(metadata))
    const restarted = new BrowserProfileManager(new BrowserProfileStore(f.path), f.sessions, () => f.root); await restarted.initialize()
    expect(restarted.listLegacyPendingDeletes()).toEqual([f.profile.id]); expect(restarted.listTrash()).toEqual([])
    expect(await readFile(join(f.data, 'nested', 'site.data'), 'utf8')).toBe('original site data')
    expect(f.native(f.profile.id).clearStorageData).not.toHaveBeenCalled()
  })

  it('keeps late absolute activity checkpoints on the archived record without resurrecting it or changing its tokens', async () => {
    const f = await fixture(), token = f.token(), receipt = await f.usage.deleteProfile(f.profile.id, approval(f.profile.id), token), revision = f.manager.listRevision()
    await f.manager.recordActivity(f.profile.id, { observerId: f.manager.activityObserverId, previousObserverId: null, sequence: 1, unionMs: 120, observedAt: 1000, lastUsedAt: 900, active: false, gaps: [] })
    expect(f.manager.listProfiles().some(p => p.id === f.profile.id)).toBe(false)
    expect(f.manager.listRevision()).toBe(revision)
    expect(f.manager.listTrash()[0]).toMatchObject({ revision: receipt.archive.revision, profile: { revision: token, activity: { observedRunMs: 120 } } })
    const restored = await f.manager.restoreProfile(receipt.archive.id, receipt.archive.revision)
    expect(restored.profile.activity).toMatchObject({ observedRunMs: 120 })
  })

  it('keeps the strict public codec and trusted person boundary on the same owner, including exact archive receipts', async () => {
    const f = await fixture(), ports = { profiles: f.manager, usage: f.usage, network: {} as never }
    const request = parseBrowserProfileControlPayload({ operation: 'browser.profile.delete', profileId: f.profile.id, expectedRevision: f.token() }, ['operation'])
    await expect(executeBrowserProfileControl(request as never, ports, undefined)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DELETE_REQUIRES_PERSON' })
    const result = await executeBrowserProfileControl(request as never, ports, person as never)
    assertBrowserProfileControlTarget(request, result as never)
    expect(parseBrowserProfileControlResult(result.operation, Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'operation')))).toMatchObject({ archive: { profile: { id: f.profile.id } } })
    const list = await executeBrowserProfileControl({ operation: 'browser.profile.trash.ls' } as never, ports, undefined)
    expect(list).toMatchObject({ entries: [{ id: (result as any).archive.id }], legacyPendingDeletes: [] })
    const restore = { operation: 'browser.profile.trash.restore', archiveId: (result as any).archive.id, expectedRevision: (result as any).archive.revision } as const
    await expect(executeBrowserProfileControl(restore as never, ports, undefined)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_RESTORE_REQUIRES_PERSON' })
    const restored = await executeBrowserProfileControl(restore as never, ports, person as never)
    assertBrowserProfileControlTarget(restore, restored as never)
    expect(restored).toMatchObject({ profile: { id: f.profile.id } })
    expect(() => parseBrowserProfileControlPayload({ ...restore, path: f.data }, ['operation'])).toThrow()
    expect(() => describeRetainedPartition(f.root, f.profile.id, join(f.root, '..', 'escape'))).toThrow()
    await expect(inspectRetainedPartition(f.root, { partition: browserProfilePartition(f.profile.id), relativePath: '../escape' })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_DATA_UNAVAILABLE' })
  })
  it('runs actual compiled public CLI discover/read/recycle/restore against the same Main owner and exact tokens', async () => {
    const f = await fixture(), core = await privateRpcCorePort(join(f.root, 'sessions.json'), join(f.root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => executeBrowserProfileControl(request as never, { profiles: f.manager, usage: f.usage, network: {} as never }, context?.actor) })
    await server.start()
    try {
      const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' })
      const run = async (args: string[]) => { const result = await runCompiledObjectCli(['browser', 'profile', ...args], env); expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout).result }
      const help = await runCompiledObjectCli(['browser', 'profile', 'trash', 'restore', '--help'], env)
      expect(help.code).toBe(0); expect(help.stdout).toContain('--archive'); expect(help.stdout).toContain('--expected-revision')
      const guide=await runCompiledObjectCli(['browser','--skill'],env);expect(guide.code).toBe(0);expect(guide.stdout).toContain('profile trash ls')
      const receipt = await run(['delete', '--profile', f.profile.id, '--expected-revision', f.token()])
      expect(receipt.archive.profile.id).toBe(f.profile.id)
      expect((await run(['ls'])).profiles.some((p: any) => p.id === f.profile.id)).toBe(false)
      const list = await run(['trash', 'ls']); expect(list.entries).toHaveLength(1); expect(list.entries[0].id).toBe(receipt.archive.id)
      const restored = await run(['trash', 'restore', '--archive', list.entries[0].id, '--expected-revision', list.entries[0].revision])
      expect(restored.profile.id).toBe(f.profile.id); expect(restored.profile.revision).not.toBe(f.profile.revision)
      expect((await run(['trash', 'ls'])).entries).toEqual([])
      expect(await readFile(join(f.data, 'nested', 'site.data'), 'utf8')).toBe('original site data')
    } finally { await server.stop(); await core.dispose() }
  }, 45_000)

  it('waits for a confirmed queued archive write during disposal without treating the closing cache as an empty Store', async () => {
    const f=await fixture(), archive=f.store.archiveProfile.bind(f.store)
    let release!:()=>void, entered!:()=>void
    const waiting=new Promise<void>(resolve=>{entered=resolve}), hold=new Promise<void>(resolve=>{release=resolve})
    f.store.archiveProfile=async(...args)=>{entered();await hold;return archive(...args)}
    const recycle=f.usage.deleteProfile(f.profile.id,approval(f.profile.id),f.token());await waiting
    let disposed=false;const disposing=f.manager.dispose().then(()=>{disposed=true})
    await Promise.resolve();expect(disposed).toBe(false)
    release();const receipt=await recycle;await disposing
    expect(disposed).toBe(true);expect(receipt.archive.profile.id).toBe(f.profile.id)
    const stored=await f.store.list();expect(stored.trash[0]!.profile.id).toBe(f.profile.id)
    expect(await readFile(join(f.data,'nested','site.data'),'utf8')).toBe('original site data')
  })

  it('serializes recycle behind the original native network apply and confirmed configuration write', async () => {
    const f=await fixture(), target=f.native(f.profile.id), oldToken=f.token()
    let release!:()=>void, entered!:()=>void
    const waiting=new Promise<void>(resolve=>{entered=resolve}), hold=new Promise<void>(resolve=>{release=resolve})
    target.setProxy.mockImplementationOnce(async()=>{entered();await hold})
    const editing=f.manager.updateProfile(f.profile.id,{network:{mode:'direct'}},oldToken);await waiting
    const recycling=f.usage.deleteProfile(f.profile.id,approval(f.profile.id),oldToken)
    let recycleSettled=false;void recycling.then(()=>{recycleSettled=true},()=>{recycleSettled=true})
    await new Promise(resolve=>setTimeout(resolve,10))
    expect(recycleSettled).toBe(false);expect(f.manager.listTrash()).toEqual([])
    release();await editing
    await expect(recycling).rejects.toMatchObject({code:'BROWSER_PROFILE_REVISION_CONFLICT'})
    expect(f.manager.listProfiles().find(p=>p.id===f.profile.id)?.network).toEqual({mode:'direct'})
    const result=await f.usage.deleteProfile(f.profile.id,approval(f.profile.id),f.token())
    expect(result.archive.profile.network).toEqual({mode:'direct'})
  })

  it('keeps an applied archive after a real original-writer directory ACK failure, reconciles readback, and never reports success or recreates active data', async () => {
    const f=await fixture(), oldToken=f.token();diskFault.path=f.path;diskFault.mode='directory-sync'
    await expect(f.usage.deleteProfile(f.profile.id,approval(f.profile.id),oldToken)).rejects.toMatchObject({code:'BROWSER_PROFILE_WRITE_UNCONFIRMED',message:expect.stringContaining('replacement applied')})
    expect(f.manager.listProfiles().some(p=>p.id===f.profile.id)).toBe(false)
    expect(f.manager.listTrash()).toHaveLength(1)
    const entry=f.manager.listTrash()[0]!,ports={profiles:f.manager,usage:f.usage,network:{} as never}
    const list=await executeBrowserProfileControl({operation:'browser.profile.trash.ls'} as never,ports,undefined)
    expect(list).toMatchObject({entries:[{id:entry.id,profile:{id:f.profile.id}}]})
    diskFault.mode='directory-sync-and-read'
    await expect(f.manager.restoreProfile(entry.id,entry.revision)).rejects.toMatchObject({code:'BROWSER_PROFILE_WRITE_UNCONFIRMED'})
    // A failed readback cannot discard the original producer's acknowledged replacement fact.
    expect(f.manager.listProfiles().some(p=>p.id===f.profile.id)).toBe(true)
    expect(f.manager.listProfiles().find(p=>p.id===f.profile.id)?.revision).not.toBe(oldToken)
    expect(f.manager.listTrash()).toEqual([])
    await expect(f.manager.refresh()).rejects.toMatchObject({code:'EIO'})
    diskFault.readUnavailable=false;await f.manager.refresh()
    expect(f.manager.listProfiles().some(p=>p.id===f.profile.id)).toBe(true)
    expect(await readFile(join(f.data,'nested','site.data'),'utf8')).toBe('original site data')
  })

  it('keeps a before-replace failure and unreadable original file unknown, then repairs the exact cached scope by strict read without replay or initialization', async () => {
    const f=await fixture(), before=await readFile(f.path,'utf8');diskFault.path=f.path;diskFault.mode='before-replace'
    await expect(f.usage.deleteProfile(f.profile.id,approval(f.profile.id),f.token())).rejects.toMatchObject({code:'BROWSER_PROFILE_WRITE_UNCONFIRMED',message:expect.stringContaining('did not replace')})
    expect(f.manager.listProfiles().some(p=>p.id===f.profile.id)).toBe(true)
    expect(f.manager.resolvePartition(f.profile.id)).toBe(browserProfilePartition(f.profile.id))
    const ports={profiles:f.manager,usage:f.usage,network:{} as never}
    await expect(executeBrowserProfileControl({operation:'browser.profile.trash.ls'} as never,ports,undefined)).rejects.toMatchObject({code:'EIO'})
    diskFault.readUnavailable=false;expect(await readFile(f.path,'utf8')).toBe(before)
    const stored=await f.store.archiveProfile(f.profile.id,f.token(),describeRetainedPartition(f.root,f.profile.id,f.native(f.profile.id).storagePath))
    // This simulates a confirmed original-owner update whose notification was unavailable.
    expect(f.manager.listTrash()).toEqual([])
    const current=await executeBrowserProfileControl({operation:'browser.profile.trash.ls'} as never,ports,undefined)
    expect(current).toMatchObject({entries:[{id:stored.archive.id}]})
    await rename(f.path,f.path+'.kept')
    await expect(f.manager.refresh()).rejects.toMatchObject({code:'ENOENT'})
    await expect(readFile(f.path)).rejects.toMatchObject({code:'ENOENT'})
    expect(f.manager.listTrash()).toHaveLength(1)
    await rename(f.path+'.kept',f.path)
  })

})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
