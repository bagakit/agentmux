import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: { fromPartition: () => { throw new Error('Library read must not create a native Session') } }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileProxyAuth } from '../src/main/browser-profile-proxy-auth.js'
import { createBrowserProfileSessions } from '../src/main/browser-profile-session.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { parseBrowserProfileControlPayload, assertBrowserProfileControlTarget } from '../../../packages/core/src/browser-profile-control.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proxy-library-')); roots.push(root)
  const path = join(root, 'profiles.json'), native = new Map<string, { setProxy: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> }>()
  let manager!: BrowserProfileManager
  const sessions = createBrowserProfileSessions({ network: id => manager.listProfiles().find(profile => profile.id === id)?.network,
    session: id => { if (!native.has(id)) native.set(id, { setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) }); return native.get(id)! as never }, openContents: () => [] })
  const store = new BrowserProfileStore(path)
  manager = new BrowserProfileManager(store, sessions)
  await manager.initialize()
  return { root, path, store, manager, sessions, native, id: manager.defaultProfileId() }
}
const items = (manager: BrowserProfileManager, ids: string[]) => ids.map(profileId => ({ profileId, expectedRevision: manager.listProfiles().find(profile => profile.id === profileId)!.revision }))
const edit = { label: 'Local proxy', server: 'http://proxy.example:8080', notes: 'User chosen configuration' }

describe('stable proxy assets on the original Profile and native route owners', () => {
  it('keeps original IDs, pinned versions and routes across independent asset edits and a fresh owner read', async () => {
    const { manager, path, id, native } = await fixture(), other = await manager.createProfile('Independent', crypto.randomUUID(), profileCreationTestActor)
    const { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor }), initial = items(manager, [id])
    expect(manager.listProfiles()[0]!.networkApplication).toBeUndefined()
    expect(native.size).toBe(0)
    const result = await manager.assignProxy(proxy.id, proxy.revision, initial)
    expect(result).toMatchObject([{ profileId: id, expectedRevision: initial[0]!.expectedRevision, outcome: 'updated', profile: { proxyBinding: { proxyId: proxy.id, revision: proxy.revision }, networkApplication: { status: 'applied' } } }])
    expect(native.get(id)!.setProxy).toHaveBeenLastCalledWith({ mode: 'fixed_servers', proxyRules: edit.server, proxyBypassRules: '' })
    const bound = structuredClone(manager.listProfiles().find(profile => profile.id === id)!)
    const { proxy: changed } = await manager.saveProxy({ ...edit, server: 'socks5://other.example:1080' }, proxy.id, proxy.revision)
    expect(changed.id).toBe(proxy.id); expect(changed.revision).not.toBe(proxy.revision)
    expect(manager.listProfiles().find(profile => profile.id === id)).toEqual(bound)
    expect(native.get(id)!.setProxy).toHaveBeenCalledTimes(1); expect(native.has(other.id)).toBe(false)
    const restarted = new BrowserProfileManager(new BrowserProfileStore(path), { prepare: async () => {}, apply: async () => {}, observe: () => {} } as never)
    await restarted.initialize()
    expect(restarted.listProxies()).toEqual([changed]); expect(restarted.listProfiles().find(profile => profile.id === id)).toMatchObject({ id, network: bound.network, proxyBinding: bound.proxyBinding })
    const copy = await manager.copyProfile(id, 'Copy settings', bound.revision, crypto.randomUUID(), profileCreationTestActor)
    expect(copy).toMatchObject({ proxyBinding: bound.proxyBinding, network: bound.network, source: null }); expect(native.has(copy.id)).toBe(false)
    await expect(manager.deleteProxy(proxy.id, changed.revision)).rejects.toMatchObject({ code: 'BROWSER_PROXY_IN_USE' })
    const external = manager.listProxies(); external[0]!.label = 'Caller mutation'; expect(manager.listProxies()[0]!.label).toBe(edit.label)
  })

  it('freezes ordered exact selections, continues partial conflicts and never adds a later matching Profile', async () => {
    const { manager, id, native } = await fixture(), second = await manager.createProfile('Same name', crypto.randomUUID(), profileCreationTestActor), third = await manager.createProfile('Same name', crypto.randomUUID(), profileCreationTestActor)
    const { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor }), selected = items(manager, [id, second.id])
    await manager.updateProfile(second.id, { notes: 'Newer original input' }, selected[1]!.expectedRevision)
    const results = await manager.assignProxy(proxy.id, proxy.revision, selected)
    expect(results.map(row => [row.profileId, row.expectedRevision, row.outcome])).toEqual([[id, selected[0]!.expectedRevision, 'updated'], [second.id, selected[1]!.expectedRevision, 'failed']])
    expect(results[1]).toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(native.has(second.id)).toBe(false); expect(native.has(third.id)).toBe(false)
    expect(manager.listProfiles().find(profile => profile.id === second.id)).toMatchObject({ notes: 'Newer original input' })
    expect(manager.listProfiles().find(profile => profile.id === third.id)!.proxyBinding).toBeUndefined()
    await expect(manager.assignProxy(proxy.id, proxy.revision, [...selected, selected[0]!])).rejects.toThrow()
  })

  it('rechecks an asset changed while native apply awaits, then rolls the original route back without publishing a false binding', async () => {
    const { manager, native, id } = await fixture(), { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    manager.prepareSession(id); const target = native.get(id)!, hold = gate(), entered = gate()
    target.setProxy.mockImplementationOnce(async () => { entered.release(); await hold.promise })
    const pending = manager.assignProxy(proxy.id, proxy.revision, items(manager, [id]))
    await entered.promise
    expect(manager.listProfiles()[0]!.proxyBinding).toBeUndefined()
    await manager.saveProxy({ ...edit, label: 'Changed before commit' }, proxy.id, proxy.revision)
    hold.release()
    expect(await pending).toMatchObject([{ outcome: 'failed', code: 'BROWSER_PROXY_REVISION_CONFLICT' }])
    expect(target.setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    expect(manager.listProfiles()[0]!).not.toHaveProperty('network'); expect(manager.listProfiles()[0]!).not.toHaveProperty('proxyBinding')
  })

  it('serializes same-Profile edits, preserves independent Profiles and clears provenance only on explicit manual route edits', async () => {
    const { manager, native, id } = await fixture(), second = await manager.createProfile('Other', crypto.randomUUID(), profileCreationTestActor), { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    manager.prepareSession(id); const hold = gate(), entered = gate(), target = native.get(id)!
    target.setProxy.mockImplementationOnce(async () => { entered.release(); await hold.promise })
    const before = items(manager, [id])[0]!, first = manager.assignProxy(proxy.id, proxy.revision, [before]); await entered.promise
    const stale = manager.updateProfile(id, { notes: 'Concurrent stale edit' }, before.expectedRevision)
    await manager.updateProfile(second.id, { notes: 'Independent input' }, second.revision)
    expect(manager.listProfiles().find(profile => profile.id === second.id)!.notes).toBe('Independent input')
    hold.release(); await first; await expect(stale).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    const current = manager.listProfiles().find(profile => profile.id === id)!
    await manager.updateProfile(id, { network: current.network! }, current.revision)
    expect(manager.listProfiles().find(profile => profile.id === id)!.proxyBinding).toBeUndefined()
    await manager.deleteProxy(proxy.id, proxy.revision); expect(manager.listProxies()).toEqual([])
    expect(manager.listProfiles().find(profile => profile.id === id)!.network).toEqual(current.network)
  })

  it('keeps a route whose setProxy or connection-close ACK is unknown distinct from confirmed native configuration', async () => {
    const { manager, native, id } = await fixture(), { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    manager.prepareSession(id); const target = native.get(id)!
    expect(manager.listProfiles()[0]!.networkApplication!.status).toBe('unknown')
    target.closeAllConnections.mockRejectedValue(new Error('Native close reply unavailable'))
    expect(await manager.assignProxy(proxy.id, proxy.revision, items(manager, [id]))).toMatchObject([{ outcome: 'failed' }])
    expect(manager.listProfiles()[0]!.networkApplication!.status).toBe('unknown')
    expect(manager.listProfiles()[0]!.proxyBinding).toBeUndefined()
    expect(manager.listProfiles()[0]!.id).toBe(id)
  })

  it('observes a committed original file after a lost write ACK without publishing the old cached binding or replaying native apply', async () => {
    const { manager, store, id, native } = await fixture(), { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    const write = store.updateProfile.bind(store)
    vi.spyOn(store, 'updateProfile').mockImplementationOnce(async (...args) => { await write(...args); throw Object.assign(new Error('The original metadata write acknowledgement was lost. Inspect the original Profile before retrying.'), { code: 'PROFILE_WRITE_UNCONFIRMED' }) })
    const result = await manager.assignProxy(proxy.id, proxy.revision, items(manager, [id]))
    expect(result).toMatchObject([{ outcome: 'failed', code: 'PROFILE_WRITE_UNCONFIRMED' }])
    const observed = await store.inspectProfile(id)
    expect(manager.listProfiles()[0]!.proxyBinding).toEqual(observed.profile.proxyBinding)
    expect(manager.listProfiles()[0]!.revision).toBe(observed.profile.revision)
    expect(manager.listProfiles()[0]!.networkApplication?.status).toBe('applied')
    expect(native.get(id)!.setProxy).toHaveBeenCalledTimes(1)
    expect(store.updateProfile).toHaveBeenCalledTimes(1)
  })

  it('never initializes a missing original catalog while reconciling an unconfirmed proxy write', async () => {
    const { manager, store, path, native, id } = await fixture(), { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    const original = await readFile(path)
    vi.spyOn(store, 'saveProxy').mockImplementationOnce(async () => { await rename(path, path + '.held'); throw new Error('Original proxy write acknowledgement unavailable') })
    await expect(manager.saveProxy({ ...edit, label: 'Unconfirmed edit' }, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_WRITE_UNCONFIRMED' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(manager.listProfiles()[0]!.id).toBe(id); expect(manager.listProxies()).toEqual([proxy]); expect(native.size).toBe(0)
    expect(await readFile(path + '.held')).toEqual(original)
    await rename(path + '.held', path)
    const repaired = await store.saveProxy({ ...edit, label: 'Explicitly repaired original asset' }, proxy.id, proxy.revision)
    const reply = await executeBrowserProfileControl({ operation: 'browser.profile.proxy.ls' }, { profiles: manager, usage: {} as never, network: {} as never }, undefined)
    expect(reply).toMatchObject({ proxies: [repaired.proxy] }); expect(manager.listProxies()).toEqual([repaired.proxy])
  })

  it('pins an older credential to the original endpoint before the actual Profile owner applies another asset', async () => {
    const { root, manager, native, id } = await fixture()
    const authPath = join(root, 'credentials.json')
    const ports = { path: authPath, crypto: { available: () => true, encrypt: (text: string) => Buffer.from('encrypted:' + Buffer.from(text).toString('base64')), decrypt: (bytes: Buffer) => Buffer.from(bytes.toString().slice(10), 'base64').toString() }, profileOfSession: (target: unknown) => native.get(id) === target ? id : null, proxyOf: (profileId: string) => manager.proxyOf(profileId), report: () => {} }
    const originalAuth = createBrowserProfileProxyAuth(ports)
    await manager.updateProfile(id, { network: { mode: 'proxy', server: edit.server } }, items(manager, [id])[0]!.expectedRevision)
    await originalAuth.set(id, { username: 'saved-person', password: 'retained-private-credential' })
    const oldRecord = JSON.parse(await readFile(authPath, 'utf8')); delete oldRecord.profiles[id].proxy; await writeFile(authPath, JSON.stringify(oldRecord))
    const auth = createBrowserProfileProxyAuth(ports)
    manager.bindProxyCredentialsBeforeNetworkChange = profileId => auth.bindCurrentProxy(profileId)
    const { proxy } = await manager.saveProxy({ label: 'Replacement', server: 'http://replacement.example:8181' }, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    expect(await manager.assignProxy(proxy.id, proxy.revision, items(manager, [id]))).toMatchObject([{ outcome: 'updated' }])
    const stored = JSON.parse(await readFile(authPath, 'utf8'))
    expect(stored.profiles[id].proxy).toEqual({ host: 'proxy.example', port: 8080 })
    expect(await readFile(authPath, 'utf8')).not.toContain('retained-private-credential')
    const callback = vi.fn()
    expect(await auth.answer({ session: native.get(id), isDestroyed: () => false } as never, { isProxy: true, host: 'replacement.example', port: 8181 }, callback)).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(stored.profiles[id].password).toBe(oldRecord.profiles[id].password)
  })

  it('preserves unreadable source bytes and does not mint a substitute library or send a native request', async () => {
    const { manager, path, native, id } = await fixture(), { proxy } = await manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor }), selected = items(manager, [id])
    const bytes = '{retain original unreadable library bytes'; await writeFile(path, bytes)
    await expect(manager.saveProxy(edit, undefined, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })).rejects.toThrow(); await expect(manager.deleteProxy(proxy.id, proxy.revision)).rejects.toThrow()
    expect(await manager.assignProxy(proxy.id, proxy.revision, selected)).toMatchObject([{ outcome: 'failed' }])
    expect(await readFile(path, 'utf8')).toBe(bytes); expect(native.size).toBe(0)
    expect(manager.listProxies()).toEqual([proxy])
  })

  it('runs distinct compiled CLI asset CRUD and exact assignment through original RPC/Main owners', async () => {
    const { root, manager, id, native } = await fixture(), other = await manager.createProfile('CLI other', crypto.randomUUID(), profileCreationTestActor)
    const core = await privateRpcCorePort(join(root, 'sessions.json'), join(root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients, execute: async (request, context) => {
      if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected operation')
      return executeBrowserProfileControl(request, { profiles: manager, usage: {} as never, network: {} as never }, context?.actor)
    } })
    await server.start()
    try {
      const env = objectCliEnvironment(root, { NODE_NO_WARNINGS: '1' }), run = async (args: string[]) => { const reply = await runCompiledObjectCli(['browser', 'profile', ...args], env); expect(reply.code, reply.stderr).toBe(0); return JSON.parse(reply.stdout).result }
      expect((await run(['proxy', 'ls'])).proxies).toEqual([])
      const created = await run(['proxy', 'create', '--operation-id', 'proxy-cli-original', '--edit', JSON.stringify(edit)]), proxy = manager.listProxies().find(value => value.id === created.creation.receipt.createdId)!, selected = items(manager, [id, other.id])
      await manager.updateProfile(other.id, { notes: 'Newer edit' }, selected[1]!.expectedRevision)
      const receipt = await run(['proxy', 'assign', '--proxy', proxy.id, '--expected-revision', proxy.revision, '--items', JSON.stringify(selected)])
      expect(receipt.results.map((row: any) => [row.profileId, row.outcome])).toEqual([[id, 'updated'], [other.id, 'failed']])
      expect(native.has(id), 'Assignment must reach the original native session').toBe(true)
      expect(native.get(id)!.setProxy).toHaveBeenLastCalledWith({ mode: 'fixed_servers', proxyRules: edit.server, proxyBypassRules: '' })
      const updated = (await run(['proxy', 'update', '--proxy', proxy.id, '--expected-revision', proxy.revision, '--edit', JSON.stringify({ ...edit, label: 'CLI renamed' })])).proxy
      expect((await run(['proxy', 'ls'])).proxies).toEqual([updated])
      const current = manager.listProfiles().find(profile => profile.id === id)!
      await manager.updateProfile(id, { network: null }, current.revision)
      await run(['proxy', 'delete', '--proxy', proxy.id, '--expected-revision', updated.revision]); expect(manager.listProxies()).toEqual([])
      expect((await runCompiledObjectCli(['browser', 'profile', 'proxy', 'assign', '--help'], env)).stdout).toContain('never a query')
      expect((await runCompiledObjectCli(['browser', '--skill'], env)).stdout).toContain('proxy assign --proxy ID')
      expect(() => parseBrowserProfileControlPayload({ operation: 'browser.profile.proxy.create', operationId: 'malformed-proxy-original', edit: { ...edit, password: 'do-not-echo' } }, ['operation'])).toThrow(/unsupported fields/)
      expect(() => assertBrowserProfileControlTarget({ operation: 'browser.profile.proxy.assign', proxyId: proxy.id, expectedRevision: proxy.revision, items: selected }, { operation: 'browser.profile.proxy.assign', ...receipt, proxyId: 'wrong-original-id' })).toThrow(/exact asset/)
    } finally { await server.stop(); await core.dispose() }
  }, 45_000)
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
