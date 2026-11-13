import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, session: { fromPartition: () => ({ clearStorageData: async () => {}, flushStorageData: () => {} }) }, BrowserWindow: class {} }))

import { BrowserProfileStore, BrowserProfileRevisionConflict, browserProfilePartition } from '../src/main/browser-profile-store.js'
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

    const renamed = await store.updateProfile(WORK_ID, { label: 'Northwind client', hue: 288, notes: 'Launch QA' }, 0)
    expect(renamed.revision).toBe(1)
    expect(renamed.profile).toMatchObject({ id: WORK_ID, label: 'Northwind client', hue: 288, notes: 'Launch QA', isDefault: false })
    expect(renamed.profile.source).toMatchObject({ importedCookies: 10 })
    expect(browserProfilePartition(WORK_ID)).toBe(`persist:agentmux-browser-profile:${WORK_ID}`)

    const reread = await new BrowserProfileStore(path).list()
    expect(reread.revision).toBe(1)
    expect(reread.profiles.find(p => p.id === WORK_ID)).toMatchObject({ label: 'Northwind client', hue: 288, notes: 'Launch QA' })
  })

  it('clears the hue and notes explicitly and leaves untouched fields as they were', async () => {
    const { store } = await fixture()
    await store.updateProfile(WORK_ID, { hue: 300, notes: 'x' }, 0)
    const cleared = await store.updateProfile(WORK_ID, { hue: null, notes: '' }, 1)
    expect(cleared.profile).not.toHaveProperty('hue')
    expect(cleared.profile).not.toHaveProperty('notes')
    expect(cleared.profile.label).toBe('Work')
  })

  it('refuses an edit made against an older list and changes nothing', async () => {
    const { path, store } = await fixture()
    await store.updateProfile(WORK_ID, { label: 'First' }, 0)
    const before = await readFile(path, 'utf8')
    const stale = store.updateProfile(WORK_ID, { label: 'Second' }, 0)
    await expect(stale).rejects.toBeInstanceOf(BrowserProfileRevisionConflict)
    await expect(stale).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT', currentRevision: 1 })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects a status-colored hue or an invalid label without writing', async () => {
    const { path, store } = await fixture()
    await expect(store.updateProfile(WORK_ID, { hue: 143 }, 0)).rejects.toThrow('clear of status colors')
    await expect(store.updateProfile(WORK_ID, { hue: 400 }, 0)).rejects.toBeInstanceOf(Error)
    await expect(store.updateProfile(WORK_ID, { label: ' padded ' }, 0)).rejects.toBeInstanceOf(Error)
    expect(await readFile(path, 'utf8')).toBe(existingFile)
  })

  it('moves the default without touching any Profile record, and every write advances the revision', async () => {
    const { store } = await fixture()
    expect((await store.setDefaultProfile(WORK_ID, 0)).revision).toBe(1)
    const after = await store.list()
    expect(after.profiles.map(p => [p.id, p.isDefault])).toEqual([[DEFAULT_ID, false], [WORK_ID, true]])
    await store.createProfile('Third')
    await store.deleteProfile(DEFAULT_ID)
    expect((await store.list()).revision).toBe(3)
    await expect(store.deleteProfile(WORK_ID)).rejects.toThrow('default Browser Profile cannot be deleted')
  })
})

describe('Main Browser Profile owner', () => {
  it('serves edits with the committed revision and points new Browsers at the new default', async () => {
    const { store } = await fixture()
    const manager = new BrowserProfileManager(store)
    await manager.initialize()
    expect(manager.listRevision()).toBe(0)
    expect(manager.defaultProfileId()).toBe(DEFAULT_ID)

    const updated = await manager.updateProfile(WORK_ID, { label: 'Northwind client' }, 0)
    expect(updated.label).toBe('Northwind client')
    expect(manager.listRevision()).toBe(1)
    expect(manager.listProfiles().find(p => p.id === WORK_ID)?.label).toBe('Northwind client')

    await manager.setDefaultProfile(WORK_ID, 1)
    expect(manager.defaultProfileId()).toBe(WORK_ID)
    expect(manager.listProfiles().map(p => [p.id, p.isDefault])).toEqual([[DEFAULT_ID, false], [WORK_ID, true]])
    expect(manager.listRevision()).toBe(2)

    const created = await manager.createProfile('Fresh')
    expect(manager.listRevision()).toBe(3)
    await expect(manager.updateProfile(created.id, { label: 'Late' }, 2)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(manager.listProfiles().find(p => p.id === created.id)?.label).toBe('Fresh')
    await expect(manager.setDefaultProfile('33333333-3333-4333-8333-333333333333', 3)).rejects.toThrow('Unknown Browser Profile')
  })
})
