import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  const sessions = new Map<string, any>()
  const get = vi.fn((id: string) => {
    if (!sessions.has(id)) { const target = { ua: 'Native/150', getUserAgent() { return this.ua },
      setUserAgent: vi.fn((ua: string) => { target.ua = ua }), setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) }; sessions.set(id, target) }
    return sessions.get(id)
  })
  return { sessions, get }
})
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {},
  session: { fromPartition: native.get }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileProxyAuth } from '../src/main/browser-profile-proxy-auth.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'
import { assertBrowserProfileControlTarget, parseBrowserProfileControlPayload, parseBrowserProfileControlResult } from '../../../packages/core/src/browser-profile-control.js'

const roots: string[] = []
afterEach(async () => { native.sessions.clear(); native.get.mockClear(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-copy-')); roots.push(root)
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path), manager = new BrowserProfileManager(store)
  await manager.initialize()
  return { root, path, store, manager, id: manager.defaultProfileId() }
}

describe('copying saved Profile settings into a new identity', () => {
  it('uses one atomic metadata commit and copies configuration without import history or changing the original record', async () => {
    const { path, store, manager, id } = await fixture()
    const environment = { userAgent: 'Saved/1', acceptLanguages: ['fr-FR'] }
    await manager.updateProfile(id, { hue: 270, notes: 'Original purpose', network: { mode: 'proxy', server: 'socks5://localhost:1080', bypass: ['localhost'] }, environment, agentAccess: false }, manager.listProfiles().find(profile => profile.id === id)!.revision)
    const file = JSON.parse(await readFile(path, 'utf8'))
    file.profiles[0].source = { browserLabel: 'Imported browser', profileLabel: 'Original import', importedAt: 1, importedCookies: 3, skippedCookies: 0 }
    await writeFile(path, JSON.stringify(file))
    const authPath = join(path, '..', 'proxy-auth.json'), credentialBytes = JSON.stringify({ version: 1, profiles: { [id]: { username: 'original-user', password: 'opaque-envelope' } } })
    await writeFile(authPath, credentialBytes)
    const auth = createBrowserProfileProxyAuth({ path: authPath, crypto: { available: () => false, encrypt: () => { throw new Error('No encryption required') }, decrypt: () => { throw new Error('No decryption required') } },
      profileOfSession: () => null, proxyOf: profileId => manager.proxyOf(profileId), report: vi.fn() })
    expect(await auth.username(id)).toBe('original-user')
    const before = structuredClone(file.profiles[0]), revision = file.revision
    const { profile, snapshot } = await store.copyProfile(id, 'Independent copy', (await store.inspectProfile(id)).profile.revision, crypto.randomUUID(), profileCreationTestActor)
    expect(profile).toMatchObject({ label: 'Independent copy', hue: 270, notes: 'Original purpose', network: before.network, environment, agentAccess: false, source: null, isDefault: false })
    expect(profile.id).not.toBe(id)
    expect(await auth.username(profile.id)).toBeNull()
    expect(await auth.username(id)).toBe('original-user')
    expect(await readFile(authPath, 'utf8')).toBe(credentialBytes)
    expect(snapshot.revision).toBe(revision + 1)
    expect(snapshot.defaultProfileId).toBe(id)
    expect(JSON.parse(await readFile(path, 'utf8')).profiles).toEqual([before, expect.objectContaining({ id: profile.id, source: null })])
    expect(await readFile(path, 'utf8')).not.toContain('environmentApplication')
    profile.environment!.acceptLanguages!.push('de-DE')
    expect((await store.list()).profiles.find(value => value.id === profile.id)!.environment).toEqual(environment)
  })

  it('refuses stale or absent source identities before writing and preserves unreadable original bytes', async () => {
    const { path, store, id } = await fixture(), list = await store.list()
    const attempted = await Promise.allSettled([store.copyProfile(id, 'First', (await store.inspectProfile(id)).profile.revision, crypto.randomUUID(), profileCreationTestActor), store.copyProfile(id, 'Stale second', 'stale-profile-token', crypto.randomUUID(), profileCreationTestActor)])
    expect(attempted[0].status).toBe('fulfilled'); expect(attempted[1]).toMatchObject({ status: 'rejected', reason: { code: 'BROWSER_PROFILE_REVISION_CONFLICT' } })
    const confirmed = await readFile(path, 'utf8')
    await expect(store.copyProfile('foreignSource', 'Missing', 'foreign-source-token', crypto.randomUUID(), profileCreationTestActor)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(confirmed)
    await writeFile(path, 'original unknown Profile bytes')
    await expect(store.copyProfile(id, 'No substitute', list.profiles[0]!.revision, crypto.randomUUID(), profileCreationTestActor)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('original unknown Profile bytes')
    await rm(path)
    await expect(store.copyProfile(id, 'No substitute default', list.profiles[0]!.revision, crypto.randomUUID(), profileCreationTestActor)).rejects.toThrow()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adopts the new identity without preparing any native session or inheriting environment application', async () => {
    const { manager, path, id } = await fixture()
    await manager.updateProfile(id, { environment: { userAgent: 'Current/1' } }, manager.listProfiles().find(profile => profile.id === id)!.revision)
    expect(manager.listProfiles()[0].environmentApplication?.status).toBe('applied')
    const before = manager.listProfiles()[0], calls = native.get.mock.calls.length, revision = manager.listRevision(), changed = vi.fn()
    manager.onChange(changed)
    const copied = await manager.copyProfile(id, 'New session later', manager.listProfiles().find(profile => profile.id === id)!.revision, crypto.randomUUID(), profileCreationTestActor)
    expect(native.get).toHaveBeenCalledTimes(calls)
    expect(copied.environmentApplication).toBeUndefined()
    expect(manager.listProfiles().find(value => value.id === copied.id)?.environmentApplication?.status).toBe('not-applied')
    expect(manager.listProfiles().find(value => value.id === id)).toEqual(before)
    expect(changed).toHaveBeenCalledOnce()
    const restarted = new BrowserProfileManager(new BrowserProfileStore(path)); await restarted.initialize()
    expect(restarted.resolvePartition(copied.id)).not.toBe(restarted.resolvePartition(id))
    expect(restarted.listProfiles().find(value => value.id === copied.id)).toMatchObject({ label: 'New session later', environment: { userAgent: 'Current/1' }, source: null })
  })

  it('strictly rejects copied authority inputs and mismatched source/new identity receipts', () => {
    const request = { operation: 'browser.profile.copy' as const, operationId: 'copy-original', profileId: 'source-id', label: 'New', expectedRevision: 'source-token' }
    expect(parseBrowserProfileControlPayload(request, ['operation'])).toEqual(request)
    for (const value of [{ ...request, expectedRevision: -1 }, { ...request, agentAccess: true }, { ...request, partition: 'persist:source' }, { ...request, environmentApplication: { status: 'applied' } }]) {
      expect(() => parseBrowserProfileControlPayload(value, ['operation'])).toThrow()
    }
    const receipt = { operationId: request.operationId, actor: profileCreationTestActor, action: request.operation, requestDigest: 'sha256:' + 'a'.repeat(64), createdId: 'new-id', createdKind: 'profile' as const, committedAt: 2, source: { profileId: request.profileId, expectedRevision: request.expectedRevision } }
    const copied = { operation: request.operation, revision: 4, creation: { operationId: request.operationId, receipt, current: { state: 'present' as const, createdId: 'new-id' }, durability: 'confirmed' as const } }
    expect(parseBrowserProfileControlResult(request.operation, { revision: 4, creation: copied.creation })).toMatchObject({ creation: { receipt: { createdId: 'new-id' } } })
    expect(() => assertBrowserProfileControlTarget(request, copied)).not.toThrow()
    for (const changed of [{ ...receipt, source: { ...receipt.source, profileId: 'wrong-source' } }, { ...receipt, createdId: request.profileId }, { ...receipt, source: { ...receipt.source, expectedRevision: 'later-source' } }]) {
      expect(() => assertBrowserProfileControlTarget(request, { ...copied, creation: { ...copied.creation, receipt: changed } })).toThrow()
    }
  })

  it('runs the compiled CLI through the public service into the original manager, with discoverable strict copy and new-profile editing', async () => {
    const { root, path, manager, id } = await fixture()
    await manager.updateProfile(id, { notes: 'Saved original', environment: { userAgent: 'PublicCopy/1' }, agentAccess: false }, manager.listProfiles().find(profile => profile.id === id)!.revision)
    const core = await privateRpcCorePort(join(root, 'sessions.json'), join(root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => {
        if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected operation')
        return executeBrowserProfileControl(request, { profiles: manager, usage: { usage: async () => ({ complete: true, browsers: [] }) } as never, network: {} as never }, context?.actor)
      } })
    await server.start()
    try {
      const env = objectCliEnvironment(root, { NODE_NO_WARNINGS: '1' })
      const run = async (args: string[]) => { const output = await runCompiledObjectCli(['browser', 'profile', ...args], env); expect(output.code, output.stderr).toBe(0); return objectCliReceipt(JSON.parse(output.stdout)).result as any }
      const revision = manager.listProfiles().find(value => value.id === id)!.revision, result = await run(['copy', '--operation-id', 'public-copy-original', '--profile', id, '--expected-revision', String(revision), '--label', 'Public copy'])
      expect(result.creation.receipt.source.profileId).toBe(id)
      const copiedId = result.creation.receipt.createdId
      expect(manager.listProfiles().find(value => value.id === copiedId)).toMatchObject({ label: 'Public copy', notes: 'Saved original', agentAccess: false })
      expect(copiedId).not.toBe(id)
      expect((await run(['ls'])).profiles.map((value: any) => value.id)).toContain(copiedId)
      expect((await run(['inspect', '--profile', copiedId])).profile).toMatchObject({ id: copiedId, environmentApplication: { status: 'not-applied' } })
      await run(['update', '--profile', copiedId, '--expected-revision', manager.listProfiles().find(value => value.id === copiedId)!.revision, '--notes', 'Only copied Profile changes'])
      expect(manager.listProfiles().find(value => value.id === id)?.notes).toBe('Saved original')
      await manager.updateProfile(id, { notes: 'A real source configuration change' }, manager.listProfiles().find(value => value.id === id)!.revision)
      const stale = await runCompiledObjectCli(['browser', 'profile', 'copy', '--operation-id', 'stale-source-original', '--profile', id, '--expected-revision', String(revision), '--label', 'Refused stale copy'], env)
      expect(stale.code).not.toBe(0); expect(manager.listProfiles()).toHaveLength(2)
      const help = await runCompiledObjectCli(['browser', 'profile', 'copy', '--help'], env)
      expect(help.stdout).toContain('--profile ID --expected-revision TOKEN --label TEXT'); expect(help.stdout).toContain('No site data')
      const groupHelp = await runCompiledObjectCli(['browser', 'profile', '--help'], env)
      expect(groupHelp.code).toBe(0); expect(groupHelp.stdout).toContain('copy')
      const skill = await runCompiledObjectCli(['browser', '--skill'], env)
      expect(skill.code).toBe(0); expect(skill.stdout).toContain('browser profile copy')
      const beforeWhitespace = await readFile(path, 'utf8'), beforeRevision = manager.listRevision()
      const whitespace = await runCompiledObjectCli(['browser', 'profile', 'copy', '--operation-id', 'explicit-copy-validation', '--profile', id, '--expected-revision', manager.listProfiles().find(value => value.id === id)!.revision, '--label', ' Copy '], env)
      expect(whitespace.code).not.toBe(0); expect(JSON.parse(whitespace.stderr).error.code).toBe('INVALID_CONTROL_REQUEST')
      expect(manager.listRevision()).toBe(beforeRevision); expect(await readFile(path, 'utf8')).toBe(beforeWhitespace)
      const rejected = await runCompiledObjectCli(['browser', 'profile', 'copy', '--profile', id, '--expected-revision', manager.listProfiles().find(value => value.id === id)!.revision, '--label', 'No grants', '--agent-access', 'true'], env)
      expect(rejected.code).not.toBe(0); expect(manager.listProfiles()).toHaveLength(2)
    } finally { await server.stop(); await core.dispose() }
  }, 30_000)
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
