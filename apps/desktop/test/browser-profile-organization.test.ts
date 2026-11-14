import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ get: vi.fn(() => { throw new Error('Organization metadata cannot acquire a native website session') }) }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: { fromPartition: native.get }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { normalizeBrowserProfileTags, parseBrowserProfileControlPayload, parseBrowserProfileControlResult, assertBrowserProfileControlTarget } from '../../../packages/core/src/browser-profile-control.js'

const roots: string[] = []
afterEach(async () => { native.get.mockClear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-org-')); roots.push(root)
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path), manager = new BrowserProfileManager(store)
  await manager.initialize()
  return { root, path, store, manager, id: manager.defaultProfileId() }
}

describe('Profile organization on the original metadata owner', () => {
  it('keeps a growing tag collection instead of treating the 65th saved name as corruption', async () => {
    const { manager, path, id } = await fixture()
    const tags = Array.from({ length: 80 }, (_, index) => `Tag ${index + 1}`)
    const payload = parseBrowserProfileControlPayload({ operation: 'browser.profile.update', profileId: id, expectedRevision: manager.listProfiles().find(value => value.id === id)!.revision, edit: { tags } }, ['operation'])
    if (payload.operation !== 'browser.profile.update') throw new Error('Expected update')
    await manager.updateProfile(id, payload.edit, manager.listProfiles().find(profile => profile.id === id)!.revision)
    const next = new BrowserProfileManager(new BrowserProfileStore(path)); await next.initialize()
    expect(next.listProfiles()[0]!.tags).toEqual(tags)
    expect(native.get).not.toHaveBeenCalled()
  })

  it('persists canonical tags, stable folder identity, pinning and empty folders across a new original owner', async () => {
    const { manager, path, id } = await fixture()
    const folder = await manager.createFolder('Research', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    const empty = await manager.createFolder('Empty folder', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    await manager.updateProfile(id, { tags: [' Work ', 'Work', 'cafe\u0301', 'café'], folderId: folder.id, pinned: true }, manager.listProfiles().find(profile => profile.id === id)!.revision)
    expect(manager.listProfiles()[0]).toMatchObject({ tags: ['Work', 'café'], folderId: folder.id, pinned: true })
    await manager.renameFolder(folder.id, 'Research renamed', manager.listRevision())
    expect(manager.listFolders()).toEqual([{ id: folder.id, label: 'Research renamed' }, empty])
    const restarted = new BrowserProfileManager(new BrowserProfileStore(path)); await restarted.initialize()
    expect(restarted.listProfiles()[0]).toMatchObject({ id, tags: ['Work', 'café'], folderId: folder.id, pinned: true })
    expect(restarted.listFolders()).toEqual(manager.listFolders())
    expect(native.get).not.toHaveBeenCalled()
  })

  it('atomically deletes only a folder and its exact references, retaining all Profiles and unrelated metadata', async () => {
    const { manager, path, id } = await fixture()
    const work = await manager.createProfile('Work', crypto.randomUUID(), profileCreationTestActor), another = await manager.createProfile('Another', crypto.randomUUID(), profileCreationTestActor), other = await manager.createProfile('Other', crypto.randomUUID(), profileCreationTestActor)
    const folder = await manager.createFolder('Assigned', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor), retained = await manager.createFolder('Retained', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    await manager.updateProfile(work.id, { folderId: folder.id, tags: ['keep'], pinned: true, notes: 'Keep original purpose' }, manager.listProfiles().find(profile => profile.id === work.id)!.revision)
    await manager.updateProfile(another.id, { folderId: folder.id }, manager.listProfiles().find(profile => profile.id === another.id)!.revision)
    await manager.updateProfile(other.id, { folderId: retained.id }, manager.listProfiles().find(profile => profile.id === other.id)!.revision)
    const before = JSON.parse(await readFile(path, 'utf8')), revision = manager.listRevision()
    const result = await manager.deleteFolder(folder.id, revision)
    const after = JSON.parse(await readFile(path, 'utf8'))
    expect(result).toEqual({ folderId: folder.id, unassignedProfileIds: [work.id, another.id] })
    expect(after.revision).toBe(revision + 1)
    expect(after.defaultProfileId).toBe(id)
    expect(after.profiles.map((value: any) => value.id)).toEqual(before.profiles.map((value: any) => value.id))
    for (const original of before.profiles) {
      const expected = { ...original }; if (expected.folderId === folder.id) { delete expected.folderId; expected.revision = expect.any(String) }
      expect(after.profiles.find((value: any) => value.id === original.id)).toEqual(expected)
    }
    expect(manager.listFolders()).toEqual([retained])
    expect(native.get).not.toHaveBeenCalled()
  })

  it('copies tags and the same folder reference without pinning the new identity or altering the source', async () => {
    const { manager, path, id } = await fixture()
    const folder = await manager.createFolder('Shared organization', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    await manager.updateProfile(id, { tags: ['Source tag'], folderId: folder.id, pinned: true, agentAccess: false }, manager.listProfiles().find(profile => profile.id === id)!.revision)
    const source = manager.listProfiles()[0], copied = await manager.copyProfile(id, 'Copy', manager.listProfiles().find(profile => profile.id === id)!.revision, crypto.randomUUID(), profileCreationTestActor)
    expect(copied).toMatchObject({ tags: ['Source tag'], folderId: folder.id, agentAccess: false })
    expect(copied.pinned).toBeUndefined(); expect(copied.id).not.toBe(id)
    expect(manager.listProfiles().find(value => value.id === id)).toEqual(source)
    copied.tags!.push('external mutation')
    expect(manager.listProfiles().find(value => value.label === 'Copy')!.tags).toEqual(['Source tag'])
    await manager.deleteFolder(folder.id, manager.listRevision())
    expect(manager.listProfiles().map(value => value.folderId)).toEqual([undefined, undefined])
    expect(JSON.parse(await readFile(path, 'utf8')).profiles).toHaveLength(2)
    expect(native.get).not.toHaveBeenCalled()
  })

  it('refuses foreign and stale folder edits without writing or widening their scope', async () => {
    const { manager, path, id } = await fixture(), revision = manager.listRevision()
    const folder = await manager.createFolder('Original', revision, crypto.randomUUID(), profileCreationTestActor)
    const bytes = await readFile(path, 'utf8')
    await expect(manager.renameFolder(folder.id, 'Stale', revision)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    await expect(manager.updateProfile(id, { folderId: 'foreignFolder' }, manager.listProfiles().find(profile => profile.id === id)!.revision)).rejects.toThrow()
    await expect(manager.deleteFolder('foreignFolder', manager.listRevision())).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await manager.updateProfile(id, { tags: ['Temporary'], folderId: folder.id, pinned: true }, manager.listProfiles().find(profile => profile.id === id)!.revision)
    await manager.updateProfile(id, { tags: [], folderId: null, pinned: false }, manager.listProfiles().find(profile => profile.id === id)!.revision)
    expect(manager.listProfiles()[0].tags).toBeUndefined(); expect(manager.listProfiles()[0].folderId).toBeUndefined(); expect(manager.listProfiles()[0].pinned).toBeUndefined()
  })

  it('preserves unreadable original organization bytes and never creates substitute metadata for a missing edit source', async () => {
    const { manager, path, id } = await fixture()
    const folder = await manager.createFolder('Saved', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    const original = JSON.parse(await readFile(path, 'utf8')); original.profiles[0].folderId = 'missingFolder'
    const bytes = JSON.stringify(original); await writeFile(path, bytes)
    await expect(manager.deleteFolder(folder.id, manager.listRevision())).rejects.toThrow()
    await expect(manager.updateProfile(id, { tags: ['No substitute'] }, manager.listProfiles().find(profile => profile.id === id)!.revision)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(manager.resolvePartition(id)).toContain(id)
    await rm(path)
    await expect(manager.createFolder('No replacement', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(manager.updateProfile(id, { pinned: true }, manager.listProfiles().find(profile => profile.id === id)!.revision)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(native.get).not.toHaveBeenCalled()
  })

  it('strictly checks organization inputs, canonical returned tags and exact folder receipts', () => {
    expect(normalizeBrowserProfileTags([' One ', 'One', 'cafe\u0301', 'café'])).toEqual(['One', 'café'])
    for (const tags of [null, [''], ['x\ny'], [2]]) expect(() => normalizeBrowserProfileTags(tags)).toThrow()
    const rename = { operation: 'browser.profile.folder.rename' as const, folderId: 'folder-1', label: 'Same folder', expectedRevision: 2 }
    expect(parseBrowserProfileControlPayload(rename, ['operation'])).toEqual(rename)
    expect(() => parseBrowserProfileControlPayload({ ...rename, deleteProfiles: true }, ['operation'])).toThrow()
    const profile = { revision: 'source-token', id: 'profile-1', label: 'Original', createdAt: 1, isDefault: true, source: null, folderId: 'folder-1', tags: ['Work'], pinned: true }
    expect(parseBrowserProfileControlResult('browser.profile.ls', { revision: 1, sequence: 1, profiles: [profile], views: [], folders: [{ id: 'folder-1', label: 'Work' }] })).toMatchObject({ folders: [{ id: 'folder-1' }] })
    expect(() => parseBrowserProfileControlResult('browser.profile.ls', { revision: 1, sequence: 1, profiles: [profile], views: [], folders: [], views: [] })).toThrow()
    expect(() => parseBrowserProfileControlResult('browser.profile.ls', { revision: 1, sequence: 1, profiles: [{ ...profile, tags: [' Work '] }], views: [], folders: [{ id: 'folder-1', label: 'Work' }] })).toThrow()
    expect(() => assertBrowserProfileControlTarget(rename, { operation: rename.operation, revision: 3, folder: { id: 'other-folder', label: rename.label } })).toThrow()
    expect(() => assertBrowserProfileControlTarget(rename, { operation: 'browser.profile.folder.create', revision: 3, folder: { id: rename.folderId, label: rename.label } })).toThrow()
    expect(() => assertBrowserProfileControlTarget({ operation: 'browser.profile.copy', profileId: profile.id, label: 'Copy', expectedRevision: 'source-token' }, {
      operation: 'browser.profile.copy', revision: 2, sourceProfileId: profile.id, profile: { ...profile, id: 'new-profile', label: 'Copy', isDefault: false }
    })).toThrow()
  })

  it('runs folder creation, assignment, rename, copy and deletion through actual compiled CLI/public service/original owners', async () => {
    const { root, manager, id } = await fixture()
    const core = await privateRpcCorePort(join(root, 'sessions.json'), join(root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => { if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected operation'); return executeBrowserProfileControl(request,
        { profiles: manager, usage: { usage: async () => ({ complete: true, browsers: [] }) } as never, network: {} as never }, context?.actor) } })
    await server.start()
    try {
      const env = objectCliEnvironment(root, { NODE_NO_WARNINGS: '1' })
      const run = async (args: string[]) => { const reply = await runCompiledObjectCli(['browser', 'profile', ...args], env); expect(reply.code, reply.stderr).toBe(0); return JSON.parse(reply.stdout).result }
      const folderId = (await run(['folder', 'create', '--operation-id', 'cli-folder-original', '--label', 'CLI folder', '--expected-revision', String(manager.listRevision())])).creation.receipt.createdId
      const folder = manager.listFolders().find(value => value.id === folderId)!
      expect((await run(['ls'])).folders).toEqual([folder])
      await run(['update', '--profile', id, '--expected-revision', manager.listProfiles().find(value => value.id === id)!.revision, '--tags', '[" CLI ","CLI","Release"]', '--folder', folder.id, '--pin'])
      expect((await run(['inspect', '--profile', id])).profile).toMatchObject({ tags: ['CLI', 'Release'], folderId: folder.id, pinned: true })
      const renamed = await run(['folder', 'rename', '--folder', folder.id, '--label', 'Renamed folder', '--expected-revision', String(manager.listRevision())])
      expect(renamed.folder).toEqual({ id: folder.id, label: 'Renamed folder' })
      const copyId = (await run(['copy', '--operation-id', 'cli-copy-original', '--profile', id, '--label', 'CLI copy', '--expected-revision', manager.listProfiles().find(value => value.id === id)!.revision])).creation.receipt.createdId
      const copy = manager.listProfiles().find(value => value.id === copyId)!
      expect(copy).toMatchObject({ folderId: folder.id, tags: ['CLI', 'Release'] }); expect(copy.pinned).toBeUndefined()
      const removed = await run(['folder', 'delete', '--folder', folder.id, '--expected-revision', String(manager.listRevision())])
      expect(removed).toMatchObject({ folderId: folder.id, deleted: true, unassignedProfileIds: [id, copy.id] })
      const list = await run(['ls']); expect(list.profiles).toHaveLength(2); expect(list.folders).toEqual([])
      expect(list.profiles.every((value: any) => value.folderId === undefined)).toBe(true)
      const before = manager.listRevision(), refused = await runCompiledObjectCli(['browser', 'profile', 'update', '--profile', id, '--expected-revision', String(before), '--pin', '--unpin'], env)
      expect(refused.code).not.toBe(0); expect(manager.listRevision()).toBe(before)
      const help = await runCompiledObjectCli(['browser', 'profile', 'folder', 'delete', '--help'], env)
      expect(help.stdout).toContain('No Profile, Browser or website data is deleted')
      const skill = await runCompiledObjectCli(['browser', '--skill'], env); expect(skill.stdout).toContain('browser profile folder')
    } finally { await server.stop(); await core.dispose() }
    expect(native.get).not.toHaveBeenCalled()
  }, 40_000)
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
