import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, session: { fromPartition: () => ({ clearStorageData: async () => {}, flushStorageData: () => {} }) }, BrowserWindow: class {} }))

import { BrowserProfileStore, BrowserProfileConfigurationConflict, browserProfilePartition } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111'
const WORK_ID = '22222222-2222-4222-8222-222222222222'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

// The exact file shape every existing install has on disk today: no revision, hue or notes.
const existingFile = JSON.stringify({
  version: 1,
  defaultProfileId: DEFAULT_ID,
  profiles: [
    { id: DEFAULT_ID, label: 'Default', createdAt: 1, source: null },
    { id: WORK_ID, label: 'Work', createdAt: 2, source: { browserLabel: 'Chrome', profileLabel: 'Person 1', importedAt: 3, importedCookies: 10, skippedCookies: 2 } }
  ],
  pendingImports: []
}, null, 2) + '\n'

async function fixture(contents = existingFile) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-browser-profile-edits-'))
  roots.push(root)
  const path = join(root, 'browser-profiles.json')
  await writeFile(path, contents)
  return { path, store: new BrowserProfileStore(path) }
}

describe('Browser Profile identity edits', () => {
  it('reads an existing file unchanged and keeps every id and partition through edits', async () => {
    const { path, store } = await fixture()
    expect(await readFile(path, 'utf8')).toBe(existingFile)
    const first = await store.list()
    expect(first.revision).toBe(0)
    expect(first.profiles.map(p => [p.id, p.label, p.isDefault])).toEqual([[DEFAULT_ID, 'Default', true], [WORK_ID, 'Work', false]])
    expect(await readFile(path, 'utf8')).toBe(existingFile)

    const renamed = await store.updateProfile(WORK_ID, { label: 'Northwind client', hue: 288, notes: 'Launch QA' }, (await store.inspectProfile(WORK_ID)).profile.revision)
    expect(renamed.snapshot.revision).toBe(1)
    expect(renamed.snapshot.profiles.find(p => p.id === WORK_ID)).toMatchObject({ label: 'Northwind client', hue: 288, notes: 'Launch QA' })
    expect(renamed.profile).toMatchObject({ id: WORK_ID, label: 'Northwind client', hue: 288, notes: 'Launch QA', isDefault: false })
    expect(renamed.profile.source).toMatchObject({ importedCookies: 10 })
    expect(browserProfilePartition(WORK_ID)).toBe(`persist:agentmux-browser-profile:${WORK_ID}`)

    const reread = await new BrowserProfileStore(path).list()
    expect(reread.revision).toBe(1)
    expect(reread.profiles.find(p => p.id === WORK_ID)).toMatchObject({ label: 'Northwind client', hue: 288, notes: 'Launch QA' })
  })

  it('clears the hue and notes explicitly and leaves untouched fields as they were', async () => {
    const { store } = await fixture()
    await store.updateProfile(WORK_ID, { hue: 300, notes: 'x' }, (await store.inspectProfile(WORK_ID)).profile.revision)
    const cleared = await store.updateProfile(WORK_ID, { hue: null, notes: '' }, (await store.inspectProfile(WORK_ID)).profile.revision)
    expect(cleared.profile).not.toHaveProperty('hue')
    expect(cleared.profile).not.toHaveProperty('notes')
    expect(cleared.profile.label).toBe('Work')
  })

  it('refuses an edit made against an older list and changes nothing', async () => {
    const { path, store } = await fixture()
    await store.updateProfile(WORK_ID, { label: 'First' }, (await store.inspectProfile(WORK_ID)).profile.revision)
    const before = await readFile(path, 'utf8')
    const stale = store.updateProfile(WORK_ID, { label: 'Second' }, 'stale-profile-token')
    await expect(stale).rejects.toBeInstanceOf(BrowserProfileConfigurationConflict)
    await expect(stale).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT', currentRevision: expect.any(String) })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects a status-colored hue or an invalid label without writing', async () => {
    const { path, store } = await fixture()
    await expect(store.updateProfile(WORK_ID, { hue: 143 }, (await store.inspectProfile(WORK_ID)).profile.revision)).rejects.toThrow('clear of status colors')
    await expect(store.updateProfile(WORK_ID, { hue: 400 }, (await store.inspectProfile(WORK_ID)).profile.revision)).rejects.toBeInstanceOf(Error)
    await expect(store.updateProfile(WORK_ID, { label: ' padded ' }, (await store.inspectProfile(WORK_ID)).profile.revision)).rejects.toBeInstanceOf(Error)
    expect(await readFile(path, 'utf8')).toBe(existingFile)
  })

  it('moves the default without touching any Profile record, and every write returns the whole committed list', async () => {
    const { store } = await fixture()
    // Moving the default names its target only; an older list cannot make it conflict.
    await store.updateProfile(WORK_ID, { label: 'Work client' }, (await store.inspectProfile(WORK_ID)).profile.revision)
    const moved = await store.setDefaultProfile(WORK_ID)
    expect(moved).toEqual({ revision: 2, sequence: 2, activitySources: {}, defaultProfileId: WORK_ID, folders: [], views: [], proxyAssets: [], purgeReceipts: [], trash: [], legacyPendingDeletes: [], profiles: (await store.list()).profiles })
    expect(moved.profiles.map(p => [p.id, p.label, p.isDefault])).toEqual([[DEFAULT_ID, 'Default', false], [WORK_ID, 'Work client', true]])
    const created = await store.createProfile('Third', crypto.randomUUID(), profileCreationTestActor)
    expect(created.snapshot.revision).toBe(3)
    expect(created.snapshot.profiles.map(p => p.id)).toEqual([DEFAULT_ID, WORK_ID, created.profile.id])
    const archived = await store.archiveProfile(DEFAULT_ID, (await store.inspectProfile(DEFAULT_ID)).profile.revision, { partition: browserProfilePartition(DEFAULT_ID), relativePath: `Partitions/${DEFAULT_ID}` })
    expect(archived.snapshot).toEqual(await store.list())
    expect(archived.snapshot.revision).toBe(4)
    await expect(store.archiveProfile(WORK_ID, (await store.inspectProfile(WORK_ID)).profile.revision, { partition: browserProfilePartition(WORK_ID), relativePath: `Partitions/${WORK_ID}` })).rejects.toThrow('default Browser Profile cannot be recycled')
    await expect(store.setDefaultProfile('33333333-3333-4333-8333-333333333333')).rejects.toThrow('Unknown Browser Profile')
    expect((await store.list()).revision).toBe(4)
  })
})

describe('Main Browser Profile owner', () => {
  it('serves edits with the committed revision and points new Browsers at the new default', async () => {
    const { store } = await fixture()
    const manager = new BrowserProfileManager(store)
    await manager.initialize()
    expect(manager.listRevision()).toBe(0)
    expect(manager.defaultProfileId()).toBe(DEFAULT_ID)

    const updated = await manager.updateProfile(WORK_ID, { label: 'Northwind client' }, manager.listProfiles().find(profile => profile.id === WORK_ID)!.revision)
    expect(updated.label).toBe('Northwind client')
    expect(manager.listRevision()).toBe(1)
    expect(manager.listProfiles().find(p => p.id === WORK_ID)?.label).toBe('Northwind client')

    await manager.setDefaultProfile(WORK_ID)
    expect(manager.defaultProfileId()).toBe(WORK_ID)
    expect(manager.listProfiles().map(p => [p.id, p.isDefault])).toEqual([[DEFAULT_ID, false], [WORK_ID, true]])
    expect(manager.listRevision()).toBe(2)

    const created = await manager.createProfile('Fresh', crypto.randomUUID(), profileCreationTestActor)
    expect(manager.listRevision()).toBe(3)
    await expect(manager.updateProfile(created.id, { label: 'Late' }, 'stale-profile-token')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(manager.listProfiles().find(p => p.id === created.id)?.label).toBe('Fresh')
    await expect(manager.setDefaultProfile('33333333-3333-4333-8333-333333333333')).rejects.toThrow('Unknown Browser Profile')
  })

  it('announces each committed list once, in revision order, and never for a read or a refused write', async () => {
    const { store } = await fixture()
    const manager = new BrowserProfileManager(store)
    const heard: Array<{ revision: number; defaultProfileId: string; profiles: { id: string; label: string; isDefault: boolean }[] }> = []
    manager.onChange(snapshot => heard.push(snapshot))
    await manager.initialize()
    expect(manager.listProfiles()).toHaveLength(2)
    expect(heard).toEqual([])

    await manager.updateProfile(WORK_ID, { label: 'Northwind client' }, manager.listProfiles().find(profile => profile.id === WORK_ID)!.revision)
    await manager.setDefaultProfile(WORK_ID)
    const created = await manager.createProfile('Fresh', crypto.randomUUID(), profileCreationTestActor)
    await expect(manager.updateProfile(WORK_ID, { label: 'Late' }, 'stale-profile-token')).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    // Full native recycle publication is exercised by the original T014 Native/IPC consumers.
    await manager.updateProfile(created.id, { notes: 'Original identity retained' }, created.revision)

    expect(heard.map(snapshot => snapshot.revision)).toEqual([1, 2, 3, 4])
    // Each announcement is the whole committed list, exactly what a fresh read returns at that revision.
    expect(heard[1]).toEqual({ revision: 2, sequence: 2, activitySources: {}, defaultProfileId: WORK_ID, folders: [], views: [], proxyAssets: [], trash: [], legacyPendingDeletes: [], profiles: [
      expect.objectContaining({ id: DEFAULT_ID, label: 'Default', isDefault: false }),
      expect.objectContaining({ id: WORK_ID, label: 'Northwind client', isDefault: true })] })
    expect(heard[2]!.profiles.map(p => p.id)).toEqual([DEFAULT_ID, WORK_ID, created.id])
    const last = heard.at(-1)!
    expect({ revision: last.revision, profiles: last.profiles }).toEqual(await store.list().then(({ revision, profiles }) => ({ revision, profiles })))
    expect(manager.listProfiles()).toEqual(last.profiles)
    expect(manager.listRevision()).toBe(4)
  })
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
