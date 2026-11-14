const { fixturePath: _hygiene_fixturePath, fixtureTime: _hygiene_fixtureTime } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockedFs = vi.hoisted(() => ({ rename: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  mockedFs.rename.mockImplementation(async (...args: Parameters<typeof actual.rename>) => {
    await actual.rename(...args)
  })
  return { ...actual, rename: mockedFs.rename }
})

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  browserProfilePartition,
  BrowserProfileStore,
  type BrowserProfileImportedSource
} from '../src/main/browser-profile-store.js'

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111'
const PROFILE_ID = '22222222-2222-4222-8222-222222222222'
const PENDING_ID = '33333333-3333-4333-8333-333333333333'

const roots: string[] = []

afterEach(async () => {
  mockedFs.rename.mockClear()
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

async function storeFixture(): Promise<{ root: string; path: string; store: BrowserProfileStore }> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-browser-profile-store-'))
  roots.push(root)
  const path = join(root, 'browser-profiles.json')
  return { root, path, store: new BrowserProfileStore(path) }
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    defaultProfileId: DEFAULT_ID,
    profiles: [{ id: DEFAULT_ID, label: 'Default', createdAt: 1, source: null }],
    pendingImports: [],
    ...overrides
  }
}

const importedSource: BrowserProfileImportedSource = {
  browserLabel: 'Chrome',
  profileLabel: 'Profile 1',
  importedAt: _hygiene_fixtureTime(-67225600000),
  importedCookies: 12,
  skippedCookies: 3
}

describe('BrowserProfileStore', () => {
  it('initializes only a missing file with one private-partition-free default Profile', async () => {
    const { path, store } = await storeFixture()

    const profiles = await store.listProfiles()
    const persisted = JSON.parse(await readFile(path, 'utf8'))

    expect(profiles).toEqual([{
      revision: expect.any(String),
      id: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{12}$/),
      label: 'Default',
      createdAt: expect.any(Number),
      isDefault: true,
      source: null
    }])
    expect(persisted).toEqual({
      version: 1,
      defaultProfileId: profiles[0]!.id,
      profiles: [{
        id: profiles[0]!.id,
        label: 'Default',
        createdAt: profiles[0]!.createdAt,
        source: null
      }],
      pendingImports: []
    })
    expect(JSON.stringify(persisted)).not.toContain('partition')
    expect(profiles[0]).not.toHaveProperty('partition')
    expect(browserProfilePartition(profiles[0]!.id)).toBe(
      `persist:agentmux-browser-profile:${profiles[0]!.id}`
    )
    expect(() => browserProfilePartition('default')).toThrow('stored object identity')
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it.each([
    ['invalid JSON', '{'],
    ['retired version', JSON.stringify(metadata({ version: 0 }))],
    ['unknown root field', JSON.stringify({ ...metadata(), legacy: true })],
    ['unknown Profile field', JSON.stringify(metadata({
      profiles: [{ id: DEFAULT_ID, label: 'Default', createdAt: 1, source: null, partition: 'persist:bad' }]
    }))],
    ['unknown imported-source field', JSON.stringify(metadata({
      profiles: [{
        id: DEFAULT_ID,
        label: 'Default',
        createdAt: 1,
        source: { ...importedSource, cookiePath: _hygiene_fixturePath("private/browser/Cookies") }
      }]
    }))],
    ['non-canonical Profile id', JSON.stringify(metadata({
      defaultProfileId: 'DEFAULT',
      profiles: [{ id: 'DEFAULT', label: 'Default', createdAt: 1, source: null }]
    }))],
    ['padded Profile label', JSON.stringify(metadata({
      profiles: [{ id: DEFAULT_ID, label: ' Default ', createdAt: 1, source: null }]
    }))],
    ['missing default Profile', JSON.stringify(metadata({ defaultProfileId: PROFILE_ID }))],
    ['duplicate Profile id', JSON.stringify(metadata({
      profiles: [
        { id: DEFAULT_ID, label: 'Default', createdAt: 1, source: null },
        { id: DEFAULT_ID, label: 'Duplicate', createdAt: 2, source: null }
      ]
    }))],
    ['pending id colliding with a Profile', JSON.stringify(metadata({
      pendingImports: [{ profileId: DEFAULT_ID, label: 'Import', startedAt: 2 }]
    }))],
    ['duplicate pending id', JSON.stringify(metadata({
      pendingImports: [
        { profileId: PENDING_ID, label: 'Import A', startedAt: 2 },
        { profileId: PENDING_ID, label: 'Import B', startedAt: 3 }
      ]
    }))],
    ['unknown pending field', JSON.stringify(metadata({
      pendingImports: [{ profileId: PENDING_ID, label: 'Import', startedAt: 2, sourcePath: _hygiene_fixturePath("private") }]
    }))]
  ])('rejects %s without replacing it or falling back to defaults', async (_name, raw) => {
    const { path, store } = await storeFixture()
    await writeFile(path, raw)

    await expect(store.listProfiles()).rejects.toBeInstanceOf(Error)
    expect(await readFile(path, 'utf8')).toBe(raw)
  })

  it('serializes concurrent Profile creation without losing either mutation', async () => {
    const { path, store } = await storeFixture()
    await store.listProfiles()

    const [{ profile: first }, { profile: second }] = await Promise.all([
      store.createProfile('Research', crypto.randomUUID(), profileCreationTestActor),
      store.createProfile('Development', crypto.randomUUID(), profileCreationTestActor)
    ])

    expect(first).toMatchObject({ label: 'Research', isDefault: false, source: null })
    expect(second).toMatchObject({ label: 'Development', isDefault: false, source: null })
    expect(first.id).not.toBe(second.id)
    expect(await store.listProfiles()).toEqual(expect.arrayContaining([first, second]))
    expect(JSON.parse(await readFile(path, 'utf8')).profiles).toHaveLength(3)
    await expect(store.createProfile(' Development ', crypto.randomUUID(), profileCreationTestActor)).rejects.toThrow('surrounding whitespace')
    expect(JSON.parse(await readFile(path, 'utf8')).profiles).toHaveLength(3)
  })

  // Full active-to-archive/restore and tombstone preservation are verified against this original Store in browser-profile-trash.test.ts.

  it('refuses metadata that lists a Profile it also records as deleted', async () => {
    const { path, store } = await storeFixture()
    const [defaultProfile] = await store.listProfiles()
    const raw = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...raw, pendingDeletes: [defaultProfile!.id] }))
    await expect(store.listProfiles()).rejects.toThrow('Deleted Browser Profile is still listed')
  })

  it('keeps the prior metadata and removes its temp file when atomic rename fails', async () => {
    const { root, path, store } = await storeFixture()
    await store.listProfiles()
    const before = await readFile(path, 'utf8')
    mockedFs.rename.mockRejectedValueOnce(new Error('rename failed'))

    await expect(store.createProfile('Will fail', crypto.randomUUID(), profileCreationTestActor)).rejects.toThrow('rename failed')

    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readdir(root)).toEqual(['browser-profiles.json'])
    await expect(store.createProfile('After failure', crypto.randomUUID(), profileCreationTestActor)).resolves.toMatchObject({ profile: { label: 'After failure' } })
  })

  it('commits a pending fresh import as one Profile transition without persisting private source data', async () => {
    const { path, store } = await storeFixture()
    const { pending } = await store.beginPendingImport('Imported work')

    expect(await store.listPendingImports()).toEqual([pending])
    expect(await store.listProfiles()).toHaveLength(1)

    const { profile: committed } = await store.commitImportedProfile(pending.profileId, importedSource)
    const persisted = JSON.parse(await readFile(path, 'utf8'))

    expect(committed).toEqual({
      id: pending.profileId,
      revision: expect.any(String),
      label: 'Imported work',
      createdAt: pending.startedAt,
      isDefault: false,
      source: importedSource
    })
    expect(await store.listPendingImports()).toEqual([])
    expect(await store.listProfiles()).toContainEqual(committed)
    expect(persisted.pendingImports).toEqual([])
    expect(persisted.profiles).toContainEqual({
      id: pending.profileId,
      label: pending.label,
      createdAt: pending.startedAt,
      source: importedSource
    })
    expect(JSON.stringify(persisted)).not.toContain('partition')
    expect(JSON.stringify(persisted)).not.toContain('sourcePath')
  })

  it('keeps skip counts per reason only when they add up to the skipped total', async () => {
    const { path, store } = await storeFixture()
    const { pending } = await store.beginPendingImport('Imported with skips')
    const before = await readFile(path, 'utf8')
    await expect(store.commitImportedProfile(pending.profileId, { ...importedSource, skippedCookies: 3, skippedByReason: { expired: 1 } }))
      .rejects.toThrow('add up to the skipped total')
    await expect(store.commitImportedProfile(pending.profileId, { ...importedSource, skippedCookies: 1, skippedByReason: { 'cookie-name': 1 } as never }))
      .rejects.toBeInstanceOf(Error)
    expect(await readFile(path, 'utf8')).toBe(before)

    const { profile } = await store.commitImportedProfile(pending.profileId, { ...importedSource, skippedCookies: 3, skippedByReason: { expired: 1, 'app-bound-encryption': 2 } })
    expect(profile.source?.skippedByReason).toEqual({ expired: 1, 'app-bound-encryption': 2 })
    expect((await store.listProfiles()).find((item) => item.id === profile.id)?.source?.skippedByReason).toEqual({ expired: 1, 'app-bound-encryption': 2 })
  })

  it('stores a parsed network route, refuses a malformed one, and clears it back to the system route', async () => {
    const { path, store } = await storeFixture()
    const [profile] = await store.listProfiles()
    const route = { mode: 'proxy' as const, server: { scheme: 'socks5' as const, host: '10.0.0.2', port: 1080 }, bypass: ['*.corp.test'] }
    const { profile: routed } = await store.updateProfile(profile!.id, { network: route }, (await store.inspectProfile(profile!.id)).profile.revision)
    expect(routed.network).toEqual(route)
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0].network).toEqual(route)
    expect(JSON.stringify(JSON.parse(await readFile(path, 'utf8')))).not.toMatch(/password|secret/)

    const before = await readFile(path, 'utf8')
    await expect(store.updateProfile(profile!.id, { network: { mode: 'proxy', server: 'http://me:pw@gw:1' } as never }, (await store.inspectProfile(profile!.id)).profile.revision)).rejects.toThrow(/user name and password/)
    expect(await readFile(path, 'utf8')).toBe(before)

    const { profile: system } = await store.updateProfile(profile!.id, { network: null }, (await store.inspectProfile(profile!.id)).profile.revision)
    expect(system.network).toBeUndefined()
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0]).not.toHaveProperty('network')
  })

  it('stores only a turned-off Agent switch, so an untouched Profile keeps the global answer', async () => {
    const { path, store } = await storeFixture()
    const [profile] = await store.listProfiles()
    const { profile: guarded } = await store.updateProfile(profile!.id, { agentAccess: false }, (await store.inspectProfile(profile!.id)).profile.revision)
    expect(guarded.agentAccess).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0].agentAccess).toBe(false)
    const { profile: open } = await store.updateProfile(profile!.id, { agentAccess: true }, (await store.inspectProfile(profile!.id)).profile.revision)
    expect(open).not.toHaveProperty('agentAccess')
    expect(JSON.parse(await readFile(path, 'utf8')).profiles[0]).not.toHaveProperty('agentAccess')
    await expect(store.updateProfile(profile!.id, { agentAccess: 'yes' as never }, (await store.inspectProfile(profile!.id)).profile.revision)).rejects.toThrow('on or off')
  })

  it('refuses metadata whose stored route the parser would not produce', async () => {
    const { path, store } = await storeFixture()
    const raw = JSON.parse(await readFile(path, 'utf8').catch(async () => { await store.listProfiles(); return await readFile(path, 'utf8') }))
    raw.profiles[0].network = { mode: 'proxy', server: { scheme: 'http', host: 'bad host', port: 80 } }
    await writeFile(path, JSON.stringify(raw))
    await expect(store.listProfiles()).rejects.toThrow('not a valid route')
  })

  it('aborts a pending fresh import without publishing a Profile', async () => {
    const { path, store } = await storeFixture()
    const { pending } = await store.beginPendingImport('Discarded import')

    await store.abortPendingImport(pending.profileId)

    expect(await store.listPendingImports()).toEqual([])
    expect(await store.listProfiles()).toHaveLength(1)
    expect(JSON.parse(await readFile(path, 'utf8')).pendingImports).toEqual([])
    await expect(store.abortPendingImport(pending.profileId)).rejects.toThrow('Unknown pending Browser Profile')
  })

  it('rejects unknown transitions and imported-source extra fields without mutating the journal', async () => {
    const { path, store } = await storeFixture()
    const { pending } = await store.beginPendingImport('Protected import')
    const before = await readFile(path, 'utf8')

    await expect(store.commitImportedProfile(PROFILE_ID, importedSource)).rejects.toThrow(
      'Unknown pending Browser Profile'
    )
    await expect(store.commitImportedProfile(pending.profileId, {
      ...importedSource,
      sourcePath: _hygiene_fixturePath("private/browser/Cookies")
    } as BrowserProfileImportedSource)).rejects.toBeInstanceOf(Error)

    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await store.listPendingImports()).toEqual([pending])
  })
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
