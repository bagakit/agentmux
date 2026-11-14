import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable, PassThrough } from 'node:stream'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
const network = vi.hoisted(() => ({ routes: new Map<string, { bytes: Buffer; body?: any; status?: number; location?: string }>(), calls: [] as { url: string; headers: Record<string, string> }[] }))
vi.mock('node:https', () => ({ request: (url: string, options: any, receive: any) => {
  const pending = new EventEmitter() as any; pending.setTimeout = () => pending; pending.destroy = () => pending
  pending.end = () => { network.calls.push({ url, headers: options.headers }); queueMicrotask(() => {
    const route = network.routes.get(url) ?? { bytes: Buffer.alloc(0), status: 404 }, body = route.body ?? Readable.from([route.bytes]) as any
    body.statusCode = route.status ?? 200; body.headers = { ...(route.body ? {} : { 'content-length': String(route.bytes.length) }), ...(route.location ? { location: route.location } : {}), 'set-cookie': 'private-server-cookie=never-forward' }; receive(body)
  }) }; return pending
} }))
import { BrowserProfileExtensions } from '../src/main/browser-profile-extensions.js'
import { parseBrowserProfileExtensionPayload, parseBrowserProfileExtensionResult, type BrowserProfileExtensionInputSource } from '../../../packages/core/src/browser-profile-extensions.js'
import { extensionManifestCandidate } from '../src/main/browser-profile-extension-online.js'
const roots: string[] = []
const identity = generateKeyPairSync('rsa', { modulusLength: 2048 }), key = identity.publicKey.export({ type: 'spki', format: 'der' })
const nativeId = createHash('sha256').update(key).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)))
function packageBytes(version = '1.0.0', signed = false, extra = {}) {
  const bytes = Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify({ manifest_version: 3, name: 'Online fixture', version, key: key.toString('base64'), permissions: ['storage'], ...extra })), 'content.js': strToU8('void 0') }))
  if (!signed) return bytes
  const signature = sign('sha1', bytes, identity.privateKey), header = Buffer.alloc(16)
  header.write('Cr24'); header.writeUInt32LE(2, 4); header.writeUInt32LE(key.length, 8); header.writeUInt32LE(signature.length, 12)
  return Buffer.concat([header, key, signature, bytes])
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-extension-online-unit-')); roots.push(root)
  let current: any = { profileRevision: 'r1', records: [], receipts: [], pending: [] }, consent = false
  const resources = { roots: 0, sessions: 0, preparations: 0 }
  const loads: any[] = [], confirmations: any[] = [], live = new Map<string, any>()
  const owner = new BrowserProfileExtensions({ root: () => { resources.roots++; return root }, read: async () => structuredClone(current), change: async (_id, action) => action(),
    prepareSession: async () => { resources.preparations++ }, existingSession: () => session as any, session: () => { resources.sessions++; return session as any },
    begin: async (_id, _rev, intent) => { current.pending.push(intent) },
    commit: async (_id, _rev, records, receipt) => { current = { profileRevision: 'r2', records, receipts: [...current.receipts, receipt], pending: [] }; return current } })
  const session = { extensions: { getExtension: (id: string) => live.get(id), getAllExtensions: () => [...live.values()], removeExtension: (id: string) => live.delete(id),
    loadExtension: async (path: string) => { const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')); const result = { id: nativeId, path, version: manifest.version }; loads.push(result); live.set(nativeId, result); return result } } }
  owner.setConfirmationHandler(async request => { confirmations.push(request); return consent })
  const prepare = (source: BrowserProfileExtensionInputSource, operationId = 'original-online-prepare') => owner.review('profile', current.profileRevision, operationId, source)
  return { owner, prepare, loads, confirmations, resources, consent: (value = true) => { consent = value }, current: () => current }
}
afterEach(async () => { vi.restoreAllMocks(); network.routes.clear(); network.calls.length = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe('explicit checks and updates of one retained extension source', () => {
  const manifestUrl = 'https://updates.invalid/source.xml?signature=private-exact-source'
  const packageUrl = 'https://packages.invalid/signed.crx'
  const xml = (version: string) => Buffer.from(`<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${nativeId}"><updatecheck codebase="${packageUrl}" version="${version}"/></app></gupdate>`)
  async function installed() {
    const f = await fixture()
    network.routes.set(manifestUrl, { bytes: xml('1.0.0') }); network.routes.set(packageUrl, { bytes: packageBytes('1.0.0', true) })
    const review = await f.prepare({ kind: 'update-manifest', url: manifestUrl, addonId: nativeId }); f.consent()
    await f.owner.apply('profile', review.expectedRevision, review.reviewId)
    return { ...f, extensionId: review.extensionId }
  }
  it('checks only the exact manifest and version, without package, staging, native load or approval', async () => {
    const f = await installed(), resources = { ...f.resources }, loads = f.loads.length, approvals = f.confirmations.length
    network.calls.length = 0; network.routes.set(manifestUrl, { bytes: xml('2.0.0') })
    const check = await f.owner.check('profile', f.extensionId)
    expect(check).toMatchObject({ status: 'update-available', extensionId: f.extensionId, currentVersion: '1.0.0', candidateVersion: '2.0.0', source: { origin: 'https://updates.invalid' } })
    expect(network.calls.map(call => call.url)).toEqual([manifestUrl])
    expect(f.resources).toEqual(resources); expect(f.loads).toHaveLength(loads); expect(f.confirmations).toHaveLength(approvals)
    expect(JSON.stringify(check)).not.toContain('private-exact-source')
    expect(parseBrowserProfileExtensionResult('browser.profile.extension.check', check)).toMatchObject({ status: 'update-available', extensionId: f.extensionId })
  })
  it('distinguishes no newer candidate, protocol no-update, source failure and missing original source', async () => {
    const f = await installed()
    network.routes.set(manifestUrl, { bytes: xml('1') }); expect((await f.owner.check('profile', f.extensionId)).status).toBe('current')
    network.routes.set(manifestUrl, { bytes: Buffer.from(`<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${nativeId}"><updatecheck status="noupdate"/></app></gupdate>`) })
    expect((await f.owner.check('profile', f.extensionId)).status).toBe('current')
    network.routes.set(manifestUrl, { bytes: Buffer.from(JSON.stringify({ addons: { [nativeId]: { updates: [] } } })) })
    expect((await f.owner.check('profile', f.extensionId)).status).toBe('current')
    network.routes.set(manifestUrl, { bytes: Buffer.alloc(0), status: 503 })
    expect((await f.owner.check('profile', f.extensionId)).status).toBe('unknown')
    delete f.current().records[0].acquisition
    f.current().records[0].source.updateUrl = 'https://display.invalid/stripped'
    network.calls.length = 0
    expect((await f.owner.check('profile', f.extensionId)).status).toBe('manual'); expect(network.calls).toEqual([])
    await expect(f.owner.review('profile', f.current().profileRevision, 'missing-retained-source', { kind: 'installed-update' }, f.extensionId)).rejects.toThrow('no retained update manifest')
  })
  it.each(['metadata', 'pending'] as const)('does not publish a candidate after original %s changes during the held manifest read', async change => {
    const f = await installed(), body = new PassThrough(), bytes = xml('2.0.0')
    network.calls.length = 0; network.routes.set(manifestUrl, { bytes, body })
    const pending = f.owner.check('profile', f.extensionId); body.write(bytes.subarray(0, 1))
    await vi.waitFor(() => expect(network.calls).toHaveLength(1))
    if (change === 'metadata') f.current().profileRevision = 'changed-by-person'
    else f.current().pending.push({ operationId: 'original-native-unknown', extensionId: f.extensionId, kind: 'update' })
    body.end(bytes.subarray(1))
    expect(await pending).toMatchObject({ status: 'unknown', profileRevision: 'r2' })
    expect(network.calls.map(call => call.url)).toEqual([manifestUrl])
  })
  it('keeps an unconfirmed original native change unknown instead of relabeling its saved version current', async () => {
    const f = await installed(), resources = { ...f.resources }
    f.current().pending.push({ operationId: 'original-native-unknown', extensionId: f.extensionId, kind: 'update' })
    network.calls.length = 0
    expect(await f.owner.check('profile', f.extensionId)).toMatchObject({ status: 'unknown', currentVersion: '1.0.0', reason: expect.stringContaining('remains unconfirmed') })
    expect(network.calls).toEqual([]); expect(f.resources).toEqual(resources)
    expect(f.current().pending[0].operationId).toBe('original-native-unknown')
    const originalPending = structuredClone(f.current().pending), loads = f.loads.length, approvals = f.confirmations.length
    network.routes.set(manifestUrl, { bytes: xml('2.0.0') }); network.routes.set(packageUrl, { bytes: packageBytes('2.0.0', true) })
    const prepared = await f.owner.review('profile', f.current().profileRevision, 'another-installed-update', { kind: 'installed-update' }, f.extensionId)
    expect(prepared).toMatchObject({ reviewId: 'another-installed-update', extensionId: f.extensionId, previousVersion: '1.0.0', version: '2.0.0' })
    expect(f.current().pending).toEqual(originalPending); expect(f.loads).toHaveLength(loads); expect(f.confirmations).toHaveLength(approvals)
  })
  it('prepares the exact installed source and added permissions, keeps cancelled bytes and rejects a non-newer package', async () => {
    const f = await installed(), loads = f.loads.length
    network.routes.set(manifestUrl, { bytes: xml('2.0.0') }); network.routes.set(packageUrl, { bytes: packageBytes('2.0.0', true, { permissions: ['storage', 'tabs'] }) })
    const review = await f.owner.review('profile', f.current().profileRevision, 'original-installed-update', { kind: 'installed-update' }, f.extensionId)
    expect(review).toMatchObject({ extensionId: f.extensionId, previousVersion: '1.0.0', version: '2.0.0', addedPermissions: ['API: tabs'] })
    f.consent(false); expect((await f.owner.apply('profile', review.expectedRevision, review.reviewId)).outcome).toBe('cancelled')
    expect(f.loads).toHaveLength(loads); expect(f.current().records[0].version).toBe('1.0.0')
    f.consent(); await f.owner.apply('profile', review.expectedRevision, review.reviewId)
    expect(f.current().records[0]).toMatchObject({ id: f.extensionId, version: '2.0.0', acquisition: { url: manifestUrl } })
    await expect(f.owner.review('profile', f.current().profileRevision, 'not-newer', { kind: 'installed-update' }, f.extensionId)).rejects.toThrow('no newer version')
    expect(() => parseBrowserProfileExtensionPayload({ operation: 'browser.profile.extension.prepare', profileId: 'profile', expectedRevision: 'r2', operationId: 'missing-target', source: { kind: 'installed-update' } })).toThrow()
  })
})
describe('original Profile extension online preparation', () => {
  it('freezes explicit HTTPS bytes, exposes safe provenance, and still requires the original trusted confirmation', async () => {
    const f = await fixture(), url = 'https://packages.invalid/private-token.zip?signature=source-secret'; network.routes.set(url, { bytes: packageBytes() })
    const source = { kind: 'package-url' as const, url }, review = await f.prepare(source)
    expect(f.loads).toEqual([]); expect(review.source.retrieval).toMatchObject({ kind: 'package-url', origin: 'https://packages.invalid' })
    expect(JSON.stringify(review)).not.toMatch(/source-secret|private-token/)
    expect(parseBrowserProfileExtensionResult('browser.profile.extension.prepare', { review })).toMatchObject({ review })
    network.routes.set(url, { bytes: packageBytes('9.0.0') })
    expect(await f.prepare(source)).toEqual(review); expect(network.calls).toHaveLength(1)
    expect(await f.owner.apply('profile', 'r1', review.reviewId)).toMatchObject({ outcome: 'cancelled' }); expect(f.loads).toEqual([])
    f.consent(); expect(await f.owner.apply('profile', 'r1', review.reviewId)).toMatchObject({ outcome: 'applied' })
    expect(f.loads[0].version).toBe('1.0.0'); expect(f.confirmations.at(-1).onlineSource).toBe(url)
    expect(JSON.stringify(await f.owner.list('profile'))).not.toMatch(/source-secret|private-token|acquisition/)
  })
  it('shares the original in-flight acquisition only with the same exact request', async () => {
    const f = await fixture(), url = 'https://packages.invalid/held.zip', body = new PassThrough(), source = { kind: 'package-url' as const, url }
    network.routes.set(url, { bytes: Buffer.alloc(0), body })
    const first = f.prepare(source), second = f.prepare(source)
    try {
      await expect(f.prepare({ ...source, url: 'https://packages.invalid/other.zip' })).rejects.toThrow(/different request/)
    } finally { body.end(packageBytes()) }
    expect(await second).toEqual(await first); expect(network.calls).toHaveLength(1); expect(f.loads).toEqual([])
  })
  it('selects exact signed Chromium XML identity, follows HTTPS redirects without Cookie, and rejects identity/version changes', async () => {
    const f = await fixture(), url = 'https://updates.invalid/feed.xml', pkg = 'https://packages.invalid/addon.crx'
    const xml = (id = nativeId, v = '1.0.0') => Buffer.from(`<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${id}"><updatecheck codebase="${pkg}" version="${v}"/></app></gupdate>`)
    network.routes.set(url, { bytes: xml() }); network.routes.set(pkg, { bytes: Buffer.alloc(0), status: 302, location: 'https://mirror.invalid/object.crx' }); network.routes.set('https://mirror.invalid/object.crx', { bytes: packageBytes('1.0.0', true) })
    const review = await f.prepare({ kind: 'update-manifest', url, addonId: nativeId }); expect(review.source.signature).toBe('package-verified')
    expect(review.source.retrieval).toMatchObject({ format: 'chromium-xml', origin: 'https://mirror.invalid' }); expect(network.calls.every(call => !Object.keys(call.headers).some(key => /cookie|authorization/i.test(key)))).toBe(true)
    await expect(f.prepare({ kind: 'update-manifest', url, addonId: 'a'.repeat(32) }, 'wrong-id')).rejects.toThrow(/exact add-on ID/)
    network.routes.set(url, { bytes: xml(nativeId, '2.0.0') }); await expect(f.prepare({ kind: 'update-manifest', url, addonId: nativeId }, 'wrong-version')).rejects.toThrow(/version differs/)
    expect(f.loads).toEqual([])
  })
  it('reads WebExtensions JSON updates and verifies its declared digest and embedded add-on ID', async () => {
    const f = await fixture(), url = 'https://updates.invalid/updates.json', pkg = 'https://packages.invalid/addon.xpi', bytes = packageBytes('2.0.0', false, { browser_specific_settings: { gecko: { id: 'fixture@example.invalid' } } })
    const definition = (hash: string) => Buffer.from(JSON.stringify({ addons: { 'fixture@example.invalid': { updates: [{ version: '2.0.0', update_link: pkg, update_hash: 'sha256:' + hash }] } } }))
    network.routes.set(url, { bytes: definition(createHash('sha256').update(bytes).digest('hex')) }); network.routes.set(pkg, { bytes })
    expect((await f.prepare({ kind: 'update-manifest', url, addonId: 'fixture@example.invalid' })).source.retrieval?.format).toBe('webextensions-json')
    network.routes.set(url, { bytes: definition('0'.repeat(64)) }); await expect(f.prepare({ kind: 'update-manifest', url, addonId: 'fixture@example.invalid' }, 'bad-hash')).rejects.toThrow(/manifest hash/)
    expect(f.loads).toEqual([])
  })
  it('preserves original state on HTTP, bad package, redirect downgrade, oversized parsing input and reused-operation target changes', async () => {
    const f = await fixture(), source = { kind: 'package-url' as const, url: 'https://packages.invalid/one.zip' }
    await expect(f.prepare(source)).rejects.toThrow(/HTTP 404/)
    network.routes.set(source.url, { bytes: Buffer.from('not a package') }); await expect(f.prepare(source)).rejects.toThrow()
    network.routes.set(source.url, { bytes: Buffer.alloc(0), status: 302, location: 'http://packages.invalid/insecure.zip' }); await expect(f.prepare(source)).rejects.toThrow()
    network.routes.set(source.url, { bytes: packageBytes() }); await f.prepare(source)
    await expect(f.prepare({ ...source, url: 'https://packages.invalid/two.zip' })).rejects.toThrow(/different request/)
    vi.spyOn(process, 'availableMemory').mockReturnValue(1024)
    network.routes.set('https://updates.invalid/large', { bytes: Buffer.alloc(2048) })
    await expect(f.prepare({ kind: 'update-manifest', url: 'https://updates.invalid/large', addonId: nativeId }, 'large')).rejects.toThrow(/parsing memory/)
    expect(f.loads).toEqual([]); expect(f.current().records).toEqual([])
  })
  it('keeps parsing available from the measured heap when OS free-memory observation is unknown', async () => {
    const f = await fixture(), url = 'https://updates.invalid/unknown-memory.json', pkg = 'https://packages.invalid/known.zip'
    network.routes.set(url, { bytes: Buffer.from(JSON.stringify({ addons: { exact: { updates: [{ version: '1.0.0', update_link: pkg }] } } })) })
    network.routes.set(pkg, { bytes: packageBytes('1.0.0', false, { browser_specific_settings: { gecko: { id: 'exact' } } }) })
    vi.spyOn(process, 'availableMemory').mockReturnValue(0)
    expect((await f.prepare({ kind: 'update-manifest', url, addonId: 'exact' })).version).toBe('1.0.0')
    expect(f.loads).toEqual([])
  })
  it('rejects extra approval flags, insecure/credentialed URLs, malformed XML and unsupported/ambiguous version entries', () => {
    const base = { operation: 'browser.profile.extension.prepare', profileId: 'p', operationId: 'o', expectedRevision: 'r' }
    for (const source of [{ kind: 'package-url', url: 'http://x.invalid/a' }, { kind: 'package-url', url: 'https://user:secret@x.invalid/a' }, { kind: 'package-url', url: 'https://x.invalid/a', approved: true }]) expect(() => parseBrowserProfileExtensionPayload({ ...base, source })).toThrow()
    expect(() => parseBrowserProfileExtensionPayload({ ...base, sourcePath: '/legacy', source: { kind: 'local', path: '/exact' } })).toThrow()
    expect(() => extensionManifestCandidate(Buffer.from('<gupdate>'), 'https://x.invalid/a', nativeId)).toThrow()
    const json = (updates: any[]) => Buffer.from(JSON.stringify({ addons: { exact: { updates } } }))
    expect(() => extensionManifestCandidate(json([{ version: '1.0beta', update_link: 'https://x.invalid/a' }]), 'https://x.invalid/feed', 'exact')).toThrow(/numeric/)
    expect(() => extensionManifestCandidate(json([{ version: '1', update_link: 'https://x.invalid/a' }, { version: '1.0', update_link: 'https://x.invalid/b' }]), 'https://x.invalid/feed', 'exact')).toThrow(/ambiguous/)
  })
})
