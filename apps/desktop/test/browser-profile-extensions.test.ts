import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import { writeFileSync, renameSync, symlinkSync } from 'node:fs'
const sourceRace = vi.hoisted(() => ({ swap: undefined as undefined | (() => void), beforeCopy: undefined as undefined | (() => void), failDirectory: undefined as string | undefined }))
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); const before = (target: unknown) => { if (String(target).endsWith('.package-snapshot') && sourceRace.beforeCopy) { const swap = sourceRace.beforeCopy; sourceRace.beforeCopy = undefined; swap() } }; return { ...fs, open: async (...args: Parameters<typeof fs.open>) => { const handle = await fs.open(...args); if (String(args[0]) === sourceRace.failDirectory) { handle.sync = async () => { sourceRace.failDirectory = undefined; throw Error('Private directory fsync acknowledgement lost') } } return handle }, copyFile: async (...args: Parameters<typeof fs.copyFile>) => { before(args[1]); return fs.copyFile(...args) }, cp: async (...args: Parameters<typeof fs.cp>) => { before(args[1]); return fs.cp(...args) } } })
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, createReadStream: (...args: Parameters<typeof fs.createReadStream>) => { const stream = fs.createReadStream(...args); if (sourceRace.swap) { const swap = sourceRace.swap; sourceRace.swap = undefined; stream.once('end', swap) } return stream } } })
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: { fromPartition: () => { throw Error('No implicit Session') } }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { createBrowserProfileSessions } from '../src/main/browser-profile-session.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { parseBrowserProfileControlPayload, parseBrowserProfileControlResult, assertBrowserProfileControlTarget } from '../../../packages/core/src/browser-profile-control.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { executeBrowserProfileControl } from '../src/main/browser-profile-control.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); sourceRace.swap = undefined; sourceRace.beforeCopy = undefined; sourceRace.failDirectory = undefined; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const identity = generateKeyPairSync('rsa', { modulusLength: 2048 }), key = identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-profile-extensions-')); roots.push(root)
  const store = new BrowserProfileStore(join(root, 'profiles.json')), targets = new Map<string, any>(), loadedCalls: { profileId: string; path: string; version: string }[] = []
  let failLoad: 'before' | 'after' | undefined, consent = true, prepared = 0
  const native = (profileId: string) => {
    if (targets.has(profileId)) return targets.get(profileId)
    const extensions = new Map<string, any>()
    const value = Object.assign(new EventEmitter(), { storagePath: join(root, 'Partitions', profileId), webRequest: {}, serviceWorkers: { getAllRunning: () => ({}) }, setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}),
      extensions: { getExtension: (id: string) => extensions.get(id) ?? null, getAllExtensions: () => [...extensions.values()], removeExtension: vi.fn((id: string) => { extensions.delete(id) }),
        loadExtension: vi.fn(async (path: string, options: { allowFileAccess: boolean }) => {
          expect(options.allowFileAccess).toBe(false)
          const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')), id = createHash('sha256').update(manifest.key).digest('hex').slice(0, 32)
          loadedCalls.push({ profileId, path, version: manifest.version }); const fault = failLoad; failLoad = undefined
          if (fault === 'before') throw Error('Private native failure')
          const extension = { id, path, version: manifest.version, name: manifest.name, manifest }; extensions.set(id, extension)
          if (fault === 'after') throw Error('Private native acknowledgement lost')
          return extension
        }) } })
    targets.set(profileId, value); return value
  }
  const sessions = createBrowserProfileSessions({ session: native, network: () => undefined, openContents: () => [] })
  const manager = new BrowserProfileManager(store, sessions, () => root); await manager.initialize()
  const profile = manager.listProfiles()[0]!, other = await manager.createProfile('Independent Profile', crypto.randomUUID(), profileCreationTestActor)
  const reviews: any[] = []
  manager.extensions.setConfirmationHandler(async review => { reviews.push(structuredClone(review)); return consent })
  const token = () => manager.listProfiles().find(item => item.id === profile.id)!.revision
  const source = async (version = '1.0.0', permissions = ['storage'], suppliedKey: string | undefined = key) => {
    const path = join(root, `package-${++prepared}`); await mkdir(path)
    await writeFile(join(path, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Form helper', version, permissions, host_permissions: ['https://forms.invalid/*'],
      content_scripts: [{ matches: ['https://forms.invalid/*'], js: ['content.js'] }], ...(suppliedKey ? { key: suppliedKey } : {}), update_url: 'https://package-user:package-secret@updates.invalid/package.xml?token=package-token#private', homepage_url: 'https://project.invalid/?token=homepage-token' }))
    await writeFile(join(path, 'content.js'), `document.documentElement.dataset.extensionVersion=${JSON.stringify(version)}`)
    return path
  }
  let operation = 0
  const prepare = async (path: string, extensionId?: string) => manager.extensions.review(profile.id, token(), `original-operation-${++operation}`, { kind: 'local', path }, extensionId)
  const install = async (path: string, extensionId?: string) => { const review = await prepare(path, extensionId); return manager.extensions.apply(profile.id, review.expectedRevision, review.reviewId) }
  return { root, store, manager, profile, other, targets, loadedCalls, reviews, token, source, prepare, install,
    setConsent: (value: boolean) => { consent = value }, failLoad: (value: typeof failLoad) => { failLoad = value }, native }
}

describe('Profile extensions share the original configuration and native Session owners', () => {
  it('prepares without executing code and requires actual host human confirmation for source and permission changes', async () => {
    const f = await fixture(), path = await f.source(), review = await f.prepare(path)
    expect(f.targets.has(f.other.id)).toBe(false); expect(f.loadedCalls).toEqual([])
    expect(review).toMatchObject({ source: { kind: 'directory', updateUrl: 'https://updates.invalid/package.xml' }, permissions: { api: ['storage'], hosts: ['https://forms.invalid/*'], fileAccess: false } })
    f.setConsent(false)
    expect(await f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).toMatchObject({ outcome: 'cancelled', receipt: null })
    expect(f.loadedCalls).toEqual([]); expect((await f.manager.extensions.list(f.profile.id)).extensions).toEqual([])
    f.setConsent(true)
    const saved = await f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)
    expect(saved).toMatchObject({ outcome: 'applied', receipt: { operationId: review.reviewId, extensionId: review.extensionId, kind: 'install' }, application: { state: 'loaded' } })
    expect(f.reviews).toHaveLength(2); expect(f.reviews.at(-1).localSourcePath).toBe(path); expect(f.loadedCalls).toHaveLength(1); expect(f.targets.has(f.other.id)).toBe(false)
    const installed = (await f.manager.extensions.list(f.profile.id)).extensions[0]!
    expect(installed).toMatchObject({ id: review.extensionId, sha256: review.sha256, source: { label: 'Unpacked extension' }, application: { state: 'loaded' } })
    expect(installed).not.toHaveProperty('key'); expect(installed).not.toHaveProperty('reviewId')
    expect(JSON.stringify({ review, installed })).not.toMatch(/package-secret|package-token|homepage-token|package-user/)
    expect(JSON.stringify(installed)).not.toContain(f.root)
    expect(await readFile(join(f.loadedCalls[0]!.path, 'manifest.json'), 'utf8')).toContain('package-token')
    expect(f.loadedCalls[0]!.path).not.toBe(path)
  })
  it('updates the exact extension identity while preserving unrelated installed extensions and exposing added scope', async () => {
    const f = await fixture(), first = await f.install(await f.source())
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const independent = await f.install(await f.source('1.0.0', ['storage'], otherKey)), extensionId = first.receipt!.extensionId
    const review = await f.prepare(await f.source('2.0.0', ['storage', 'tabs']), extensionId)
    expect(review).toMatchObject({ extensionId, previousVersion: '1.0.0', addedPermissions: ['API: tabs'] })
    await f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)
    const list = await f.manager.extensions.list(f.profile.id)
    expect(list.extensions).toHaveLength(2); expect(list.extensions.find(item => item.id === independent.receipt!.extensionId)?.version).toBe('1.0.0')
    expect(list.extensions.find(item => item.id === extensionId)).toMatchObject({ version: '2.0.0', application: { state: 'loaded' } })
    expect(f.reviews.at(-1).kind).toBe('update'); expect(f.targets.has(f.other.id)).toBe(false)
  })
  it.each(['before', 'after'] as const)('preserves the previous native version after an update fails %s the native acknowledgement', async fault => {
    const f = await fixture(), installed = await f.install(await f.source()), original = (await f.manager.extensions.list(f.profile.id)).extensions[0]!
    f.failLoad(fault)
    await expect(f.install(await f.source('2.0.0'), installed.receipt!.extensionId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    const restored = (await f.manager.extensions.list(f.profile.id)).extensions[0]!
    expect(restored).toMatchObject({ id: original.id, nativeId: original.nativeId, version: '1.0.0', sha256: original.sha256, application: { state: 'loaded' } })
    expect(f.native(f.profile.id).extensions.getExtension(original.nativeId).version).toBe('1.0.0')
    expect(f.targets.has(f.other.id)).toBe(false)
  })
  it.each(['before', 'after'] as const)('reconciles an extension metadata write failure %s durable commit without guessing or replacing the original request', async fault => {
    const f = await fixture(), installed = await f.install(await f.source()), id = installed.receipt!.extensionId, review = await f.prepare(await f.source('2.0.0'), id)
    const save = f.store.setExtensions.bind(f.store)
    vi.spyOn(f.store, 'setExtensions').mockImplementationOnce(async (...args) => { if (fault === 'before') throw Error('Private write failed'); await save(...args); throw Error('Private write reply lost') })
    await expect(f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    const list = await f.manager.extensions.list(f.profile.id, review.reviewId)
    expect(list.extensions[0]).toMatchObject({ id, version: fault === 'before' ? '1.0.0' : '2.0.0', application: { state: 'loaded' } })
    expect(list.receipt?.operationId ?? null).toBe(fault === 'before' ? null : review.reviewId)
    expect(list.pending).toHaveLength(fault === 'before' ? 1 : 0)
    const replacement = new BrowserProfileManager(new BrowserProfileStore(join(f.root, 'profiles.json')), f.manager.sessions, () => f.root); await replacement.initialize()
    replacement.extensions.setConfirmationHandler(async () => { throw Error('Unknown original operation must not prompt again') })
    if (fault === 'before') {
      expect((await replacement.extensions.list(f.profile.id, review.reviewId)).pending[0]).toMatchObject({ operationId: review.reviewId, sha256: review.sha256, version: '2.0.0', previousSha256: list.extensions[0]!.sha256 })
      await expect(replacement.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    }
    const calls = f.loadedCalls.length
    if (fault === 'after') expect(await f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).toMatchObject({ receipt: { operationId: review.reviewId } })
    else await expect(f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    expect(f.loadedCalls.length).toBe(calls)
  })
  it('refuses changed identity and stale configuration while retaining the healthy original extension', async () => {
    const f = await fixture(), installed = await f.install(await f.source()), original = (await f.manager.extensions.list(f.profile.id)).extensions[0]!
    const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    await expect(f.prepare(await f.source('2.0.0', ['storage'], wrong), original.id)).rejects.toThrow('different extension identity')
    const review = await f.prepare(await f.source('2.0.0'), original.id)
    const updated = await f.manager.updateProfile(f.profile.id, { notes: 'Independent authored note' }, f.token())
    await expect(f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_CONFIGURATION_CONFLICT' })
    expect((await f.manager.extensions.list(f.profile.id)).extensions[0]).toMatchObject({ id: installed.receipt!.extensionId, version: '1.0.0', application: { state: 'loaded' } })
    expect(f.manager.listProfiles().find(profile => profile.id === updated.id)?.notes).toBe('Independent authored note'); expect(f.loadedCalls).toHaveLength(1)
  })
  it('rechecks reviewed package bytes and the exact Profile after human confirmation before dispatching code', async () => {
    const f = await fixture(), installed = await f.install(await f.source()), review = await f.prepare(await f.source('2.0.0'), installed.receipt!.extensionId)
    const staging = join(f.loadedCalls[0]!.path, '..', '..', '.staging')
    const candidates = await readdir(staging)
    expect(candidates.length).toBeGreaterThan(0)
    await writeFile(join(staging, candidates[0]!, 'content.js'), 'changed after review')
    await expect(f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toThrow('reviewed package bytes changed')
    expect(f.loadedCalls).toHaveLength(1)
    const fresh = await f.prepare(await f.source('3.0.0'), installed.receipt!.extensionId)
    f.manager.extensions.setConfirmationHandler(async () => { await f.store.updateProfile(f.profile.id, { notes: 'Human authored while dialog open' }, f.token()); return true })
    await expect(f.manager.extensions.apply(f.profile.id, fresh.expectedRevision, fresh.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_CONFIGURATION_CONFLICT' })
    expect(f.loadedCalls).toHaveLength(1)
    expect((await f.manager.extensions.list(f.profile.id)).extensions[0]).toMatchObject({ version: '1.0.0', application: { state: 'loaded' } })
  })
  it('restores the exact old native extension when removal metadata cannot be saved and does not replay an unknown removal', async () => {
    const f = await fixture(), installed = await f.install(await f.source()), original = (await f.manager.extensions.list(f.profile.id)).extensions[0]!
    vi.spyOn(f.store, 'setExtensions').mockRejectedValueOnce(Error('Private write failed'))
    const revision = f.token()
    await expect(f.manager.extensions.remove(f.profile.id, revision, original.id, 'unknown-removal')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    expect((await f.manager.extensions.list(f.profile.id, 'unknown-removal'))).toMatchObject({ receipt: null, extensions: [{ id: original.id, application: { state: 'loaded' } }] })
    const removals = f.native(f.profile.id).extensions.removeExtension.mock.calls.length
    await expect(f.manager.extensions.remove(f.profile.id, revision, original.id, 'unknown-removal')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    expect(f.native(f.profile.id).extensions.removeExtension.mock.calls).toHaveLength(removals)
    const replacement = new BrowserProfileManager(new BrowserProfileStore(join(f.root, 'profiles.json')), f.manager.sessions, () => f.root); await replacement.initialize()
    replacement.extensions.setConfirmationHandler(async () => { throw Error('Unknown original removal must not prompt again') })
    await expect(replacement.extensions.remove(f.profile.id, revision, original.id, 'unknown-removal')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    expect(f.native(f.profile.id).extensions.removeExtension.mock.calls).toHaveLength(removals)
    expect(installed.receipt).toBeTruthy()
  })
  it('removes only the approved exact extension and retains its package and original Profile data', async () => {
    const f = await fixture(), installed = await f.install(await f.source()), original = (await f.manager.extensions.list(f.profile.id)).extensions[0]!, packagePath = f.loadedCalls[0]!.path
    f.setConsent(false)
    expect(await f.manager.extensions.remove(f.profile.id, f.token(), original.id, 'original-removal')).toMatchObject({ outcome: 'cancelled' })
    expect(f.native(f.profile.id).extensions.getExtension(original.nativeId)).toBeTruthy()
    f.setConsent(true)
    const receipt = await f.manager.extensions.remove(f.profile.id, f.token(), original.id, 'original-removal')
    expect(receipt).toMatchObject({ outcome: 'applied', receipt: { kind: 'remove', operationId: 'original-removal', extensionId: original.id } })
    expect((await f.manager.extensions.list(f.profile.id, 'original-removal')).extensions).toEqual([])
    expect(f.native(f.profile.id).extensions.getExtension(original.nativeId)).toBeNull(); expect(await readFile(join(packagePath, 'manifest.json'), 'utf8')).toContain('1.0.0')
    expect(f.manager.listProfiles().find(profile => profile.id === f.profile.id)?.revision).not.toBe(installed.profileRevision)
  })
  it('loads approved original package bytes after owner recreation and reports local tampering without disabling Browser preparation', async () => {
    const f = await fixture(), installed = await f.install(await f.source()), original = (await f.manager.extensions.list(f.profile.id)).extensions[0]!
    const replacement = new BrowserProfileManager(new BrowserProfileStore(join(f.root, 'profiles.json')), f.manager.sessions, () => f.root); await replacement.initialize()
    expect((await replacement.extensions.list(f.profile.id)).extensions[0]).toMatchObject({ id: original.id, nativeId: original.nativeId })
    await writeFile(join(f.loadedCalls[0]!.path, 'content.js'), 'changed package bytes')
    expect(await replacement.extensions.load(f.profile.id, installed.receipt!.extensionId)).toMatchObject({ application: { state: 'failed' } })
    await expect(Promise.resolve(replacement.prepareSession(f.profile.id))).resolves.toBeUndefined()
    expect(replacement.listProfiles().some(profile => profile.id === f.other.id)).toBe(true)
  })
  it('accepts ZIP and verified CRX package sources without trusting a publisher or reading unsafe archive paths', async () => {
    const f = await fixture(), path = await f.source(), manifest = await readFile(join(path, 'manifest.json')), code = await readFile(join(path, 'content.js'))
    const zip = Buffer.from(zipSync({ 'manifest.json': manifest, 'content.js': code })), zipPath = join(f.root, 'extension.zip'); await writeFile(zipPath, zip)
    const zipReview = await f.prepare(zipPath); expect(zipReview.source).toMatchObject({ kind: 'zip', signature: 'not-verified' })
    const header = Buffer.alloc(16), publicKey = Buffer.from(key, 'base64'), signature = sign('sha1', zip, identity.privateKey)
    header.write('Cr24'); header.writeUInt32LE(2, 4); header.writeUInt32LE(publicKey.length, 8); header.writeUInt32LE(signature.length, 12)
    const crxPath = join(f.root, 'extension.crx'); await writeFile(crxPath, Buffer.concat([header, publicKey, signature, zip]))
    const crxReview = await f.prepare(crxPath); expect(crxReview.source).toMatchObject({ kind: 'crx', signature: 'package-verified' }); expect(crxReview.permissions).toEqual(zipReview.permissions)
    const corrupt = Buffer.concat([header, publicKey, signature, zip]); corrupt[corrupt.length - 1]! ^= 1; await writeFile(crxPath, corrupt)
    await expect(f.prepare(crxPath)).rejects.toThrow('signature does not match')
    const varint = (value: number): Buffer => { const bytes: number[] = []; do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)) } while (value); return Buffer.from(bytes) }
    const field = (number: number, value: Buffer): Buffer => Buffer.concat([varint(number * 8 + 2), varint(value.length), value])
    const signedData = field(1, createHash('sha256').update(publicKey).digest().subarray(0, 16)), length = Buffer.alloc(4); length.writeUInt32LE(signedData.length)
    const signed = Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signedData, zip])
    const crx3header = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, sign('sha256', signed, identity.privateKey))])), field(10000, signedData)])
    const preamble = Buffer.alloc(12); preamble.write('Cr24'); preamble.writeUInt32LE(3, 4); preamble.writeUInt32LE(crx3header.length, 8)
    const crx3 = Buffer.concat([preamble, crx3header, zip]); await writeFile(crxPath, crx3)
    expect((await f.prepare(crxPath)).source.signature).toBe('package-verified')
    crx3[crx3.length - 1]! ^= 1; await writeFile(crxPath, crx3)
    await expect(f.prepare(crxPath)).rejects.toThrow('signature does not match')
    const bad = join(f.root, 'unsafe.zip'); await writeFile(bad, zipSync({ '../escape.js': strToU8('bad') }))
    await expect(f.prepare(bad)).rejects.toThrow('unsafe'); expect(f.loadedCalls).toEqual([])
    await symlink(path, join(f.root, 'linked-source')); await expect(f.prepare(join(f.root, 'linked-source'))).rejects.toThrow('without a symbolic link')
  })
  it('rejects contradictory and misattributed public receipts instead of upgrading unknown facts to success', () => {
    const base = { profileId: 'exact-profile', profileRevision: 'current-revision', outcome: 'applied', receipt: null }
    expect(() => parseBrowserProfileControlResult('browser.profile.extension.apply', base)).toThrow()
    const receipt = { operationId: 'original-review', profileId: 'exact-profile', extensionId: 'exact-extension', kind: 'remove', sha256: 'a'.repeat(64) }
    expect(() => parseBrowserProfileControlResult('browser.profile.extension.apply', { ...base, receipt })).toThrow()
    expect(() => parseBrowserProfileControlResult('browser.profile.extension.remove', { ...base, outcome: 'cancelled', receipt })).toThrow()
    const request = { operation: 'browser.profile.extension.remove', profileId: 'exact-profile', expectedRevision: 'current-revision', extensionId: 'exact-extension', operationId: 'original-review' } as const
    const result = parseBrowserProfileControlResult(request.operation, { ...base, receipt: { ...receipt, extensionId: 'another-extension' } })
    expect(() => assertBrowserProfileControlTarget(request, result)).toThrow()
  })
  it.each(['before', 'after'] as const)('does not dispatch native code when the durable intent write fails %s its storage acknowledgement', async fault => {
    const f = await fixture(), review = await f.prepare(await f.source()), begin = f.store.beginExtensionChange.bind(f.store)
    vi.spyOn(f.store, 'beginExtensionChange').mockImplementationOnce(async (...args) => { if (fault === 'after') await begin(...args); throw Error('Private intent write acknowledgement lost') })
    await expect(f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    expect(f.loadedCalls).toEqual([])
    const list = await f.manager.extensions.list(f.profile.id, review.reviewId)
    expect(list.receipt).toBeNull(); expect(list.pending).toHaveLength(fault === 'after' ? 1 : 0)
    if (fault === 'after') {
      const replacement = new BrowserProfileManager(new BrowserProfileStore(join(f.root, 'profiles.json')), f.manager.sessions, () => f.root); await replacement.initialize()
      replacement.extensions.setConfirmationHandler(async () => { throw Error('The original pending request must not prompt again') })
      await expect(replacement.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
      expect(f.loadedCalls).toEqual([])
    }
  })
  it('requires original metadata directory durability before dispatch and keeps a missing acknowledgement pending', async () => {
    const f = await fixture(), review = await f.prepare(await f.source())
    sourceRace.failDirectory = f.root
    await expect(f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED' })
    expect(sourceRace.failDirectory).toBeUndefined(); expect(f.loadedCalls).toEqual([])
    expect((await f.manager.extensions.list(f.profile.id, review.reviewId)).pending).toMatchObject([{ operationId: review.reviewId, sha256: review.sha256 }])
    expect(f.manager.listProfiles().some(profile => profile.id === f.other.id)).toBe(true)
  })
  it('keeps local source names and owned filesystem errors inside the trusted Main confirmation boundary', async () => {
    const f = await fixture(), original = await f.source(), sensitive = join(f.root, 'customer-private-token-FILENAME_SECRET')
    await rename(original, sensitive)
    const review = await f.prepare(sensitive)
    expect(JSON.stringify(review)).not.toContain('FILENAME_SECRET')
    await f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)
    expect(f.reviews.at(-1).localSourcePath).toBe(sensitive)
    expect(JSON.stringify(await f.manager.extensions.list(f.profile.id))).not.toContain('FILENAME_SECRET')
    const next = await f.prepare(await f.source('2.0.0'), review.extensionId)
    const owned = join(f.native(f.profile.id).storagePath, 'AgentMux Extensions')
    await rm(join(owned, review.extensionId, next.sha256), { recursive: true, force: true })
    const folder = join(owned, review.extensionId), retained = folder + '-preserved'; await rename(folder, retained); await writeFile(folder, 'blocks owned directory creation')
    const cause = await f.manager.extensions.apply(f.profile.id, next.expectedRevision, next.reviewId).catch(error => error)
    expect(cause).toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_SOURCE_UNAVAILABLE' }); expect(cause.message).not.toContain(f.root)
    await rm(folder); await rename(retained, folder)
    const staging = join(owned, '.staging'); await rm(staging, { recursive: true, force: true }); await writeFile(staging, 'blocks staging creation')
    const staged = await f.prepare(await f.source('3.0.0'), review.extensionId).catch(error => error)
    expect(staged).toMatchObject({ code: 'BROWSER_PROFILE_EXTENSION_SOURCE_UNAVAILABLE' }); expect(staged.message).not.toContain(f.root)
    expect(f.loadedCalls).toHaveLength(1)
  })
  it.each([[2, false], [3, false], [2, true], [3, true]] as const)('verifies and extracts one owned CRX%s snapshot when source changes between reads (lstat-to-copy symlink=%s)', async (version, symlinkRace) => {
    const f = await fixture(), source = await f.source(), files = { 'manifest.json': await readFile(join(source, 'manifest.json')), 'content.js': Buffer.from('approved original code') }
    const zip = Buffer.from(zipSync(files)), replacement = Buffer.from(zipSync({ ...files, 'content.js': Buffer.from('unsigned replacement code') }))
    const publicKey = Buffer.from(key, 'base64'); let prefix: Buffer
    if (version === 2) { const signature = sign('sha1', zip, identity.privateKey), header = Buffer.alloc(16); header.write('Cr24'); header.writeUInt32LE(2, 4); header.writeUInt32LE(publicKey.length, 8); header.writeUInt32LE(signature.length, 12); prefix = Buffer.concat([header, publicKey, signature]) }
    else {
      const varint = (value: number): Buffer => { const result: number[] = []; do { const next = value % 128; value = Math.floor(value / 128); result.push(next | (value ? 128 : 0)) } while (value); return Buffer.from(result) }
      const field = (tag: number, data: Buffer) => Buffer.concat([varint(tag * 8 + 2), varint(data.length), data])
      const signed = field(1, createHash('sha256').update(publicKey).digest().subarray(0, 16)), length = Buffer.alloc(4); length.writeUInt32LE(signed.length)
      const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signed, zip]), identity.privateKey)
      const proof = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), field(10000, signed)]), header = Buffer.alloc(12); header.write('Cr24'); header.writeUInt32LE(3, 4); header.writeUInt32LE(proof.length, 8); prefix = Buffer.concat([header, proof])
    }
    const path = join(f.root, 'sensitive-SNAPSHOT_SECRET.crx'); await writeFile(path, Buffer.concat([prefix, zip]))
    const original = path + '.original'
    if (symlinkRace) sourceRace.beforeCopy = () => { renameSync(path, original); symlinkSync(original, path) }
    sourceRace.swap = () => writeFileSync(symlinkRace ? original : path, Buffer.concat([prefix, replacement]))
    const review = await f.prepare(path)
    expect(sourceRace.swap).toBeUndefined(); expect(sourceRace.beforeCopy).toBeUndefined(); expect(review.source).toMatchObject({ signature: 'package-verified', label: 'CRX package' }); expect(JSON.stringify(review)).not.toContain('SNAPSHOT_SECRET')
    await f.manager.extensions.apply(f.profile.id, review.expectedRevision, review.reviewId)
    expect(await readFile(join(f.loadedCalls[0]!.path, 'content.js'), 'utf8')).toBe('approved original code')
    expect(f.loadedCalls).toHaveLength(1)
  })
  it('consumes the actual compiled CLI/RPC and original Manager; request text cannot supply human approval', async () => {
    const f = await fixture(), core = await privateRpcCorePort(join(f.root, 'sessions.json'), join(f.root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => executeBrowserProfileControl(request as never, { profiles: f.manager, usage: {} as never, network: {} as never }, context?.actor) })
    await server.start()
    try {
      const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' }), path = await f.source()
      const cli = async (args: string[]) => { const result = await runCompiledObjectCli(['browser', 'profile', 'extension', ...args], env); expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout).result }
      const prepared = await cli(['prepare', '--profile', f.profile.id, '--expected-revision', f.token(), '--operation-id', 'compiled-review', '--source', path])
      expect(prepared.review).toMatchObject({ profileId: f.profile.id, reviewId: 'compiled-review' }); expect(f.loadedCalls).toEqual([])
      f.setConsent(false)
      expect(await cli(['apply', '--profile', f.profile.id, '--expected-revision', f.token(), '--review', 'compiled-review'])).toMatchObject({ outcome: 'cancelled' })
      f.setConsent(true)
      await cli(['apply', '--profile', f.profile.id, '--expected-revision', f.token(), '--review', 'compiled-review'])
      const read = await cli(['ls', '--profile', f.profile.id, '--operation-id', 'compiled-review'])
      expect(read.extensions).toHaveLength(1); expect(read.receipt).toMatchObject({ operationId: 'compiled-review', kind: 'install' })
      expect(f.loadedCalls).toHaveLength(1)
      expect(() => parseBrowserProfileControlPayload({ operation: 'browser.profile.extension.apply', profileId: f.profile.id, expectedRevision: f.token(), reviewId: 'compiled-review', approved: true }, [])).toThrow()
      const request = parseBrowserProfileControlPayload({ operation: 'browser.profile.extension.ls', profileId: f.other.id }, [])
      const result = { operation: request.operation, ...parseBrowserProfileControlResult(request.operation, read) } as any
      expect(() => assertBrowserProfileControlTarget(request, result)).toThrow('another original request or Profile')
      const help = await runCompiledObjectCli(['browser', 'profile', 'extension', 'apply', '--help'], env)
      expect(help.code).toBe(0); expect(help.stdout).toContain('--review'); expect(help.stdout).toContain('cannot supply approval')
    } finally { await server.stop(); await core.dispose() }
  }, 30_000)
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
