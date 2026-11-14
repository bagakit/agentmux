import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ get: vi.fn(() => { throw new Error('A library query or metadata batch cannot acquire a website session') }) }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: { fromPartition: native.get }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../src/main/browser-profile-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { queryBrowserProfiles, parseBrowserProfileQuery, parseBrowserProfileSelection, parseBrowserProfileBulkAction } from '../../../packages/core/src/browser-profile-library.js'
import { parseBrowserProfileControlPayload, parseBrowserProfileControlResult, assertBrowserProfileControlTarget } from '../../../packages/core/src/browser-profile-control.js'

const roots: string[] = []
afterEach(async () => { native.get.mockClear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'profile-views-')); roots.push(root)
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path), manager = new BrowserProfileManager(store, { prepare: async () => {}, apply: async () => {}, observe: () => {} } as never)
  await manager.initialize()
  return { root, path, store, manager, id: manager.defaultProfileId() }
}
const selected = (manager: BrowserProfileManager, ids: string[]) => ids.map(profileId => ({ profileId, expectedRevision: manager.listProfiles().find(profile => profile.id === profileId)!.revision }))

describe('Profile query, saved views and exact metadata batches on original owners', () => {
  it('filters native observation status, tag, saved proxy route and last observed time without inventing absent history', async () => {
    const { manager, store, id } = await fixture(), now = 1_800_000_000_000
    const idle = await manager.createProfile('Same name', crypto.randomUUID(), profileCreationTestActor), unknown = await manager.createProfile('Same name', crypto.randomUUID(), profileCreationTestActor)
    await manager.updateProfile(id, { tags: ['Work'], network: { mode: 'proxy', server: { scheme: 'http', host: 'proxy.example', port: 8080 } } }, selected(manager, [id])[0]!.expectedRevision)
    // Exercise the original absolute checkpoint path; no renderer-derived timing or fake runtime table.
    await manager.recordActivity(id, { observerId: manager.activityObserverId, previousObserverId: null, sequence: 1, unionMs: 100, observedAt: now, lastUsedAt: now - 100, active: true, gaps: [] })
    await manager.recordActivity(idle.id, { observerId: manager.activityObserverId, previousObserverId: null, sequence: 1, unionMs: 200, observedAt: now, lastUsedAt: now - 40 * 86_400_000, active: false, gaps: [] })
    expect(queryBrowserProfiles(manager.listProfiles(), [], { status: 'unknown' }, now).map(profile => profile.id)).toEqual([unknown.id])
    expect(queryBrowserProfiles(manager.listProfiles(), [], { status: 'idle' }, now).map(profile => profile.id)).toEqual([idle.id])
    expect(queryBrowserProfiles(manager.listProfiles(), [], { tag: 'Work', route: 'proxy', status: 'running', lastUsed: 'week' }, now).map(profile => profile.id)).toEqual([id])
    expect(queryBrowserProfiles(manager.listProfiles(), [], { lastUsed: 'month' }, now).map(profile => profile.id)).toEqual([id])
    expect(queryBrowserProfiles(manager.listProfiles(), [], { lastUsed: 'unknown' }, now).map(profile => profile.id)).toEqual([unknown.id])
    expect(queryBrowserProfiles(manager.listProfiles(), [], { lastUsed: 'day' }, now - 10_000)).toEqual([])
    expect(queryBrowserProfiles(manager.listProfiles(), [], { sort: 'observed-time' }, now).map(profile => profile.id)).toEqual([idle.id, id, unknown.id])
    await manager.updateProfile(unknown.id, { pinned: true }, selected(manager, [unknown.id])[0]!.expectedRevision)
    expect(queryBrowserProfiles(manager.listProfiles(), [], { sort: 'observed-time' }, now).map(profile => profile.id)).toEqual([unknown.id, idle.id, id])
    expect((await store.list()).profiles).toHaveLength(3)
    expect(native.get).not.toHaveBeenCalled()
  })

  it('keeps named query identity and exact folder scope across restart, without copying selection or changing Profile tokens', async () => {
    const { manager, path, id } = await fixture(), folder = await manager.createFolder('Review', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    const token = selected(manager, [id])[0]!.expectedRevision
    const { view } = await manager.saveView('Proxy review', { folderId: folder.id, route: 'proxy', sort: 'recent' }, manager.listRevision(), undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    view.query.search = 'caller mutation'
    expect(manager.listViews()[0]!.query.search).toBeUndefined()
    expect(selected(manager, [id])[0]!.expectedRevision).toBe(token)
    const restarted = new BrowserProfileManager(new BrowserProfileStore(path)); await restarted.initialize()
    const original = restarted.listViews()[0]!
    expect(original).toMatchObject({ id: view.id, label: 'Proxy review', query: { folderId: folder.id, route: 'proxy', sort: 'recent' } })
    await restarted.deleteFolder(folder.id, restarted.listRevision())
    expect(() => queryBrowserProfiles(restarted.listProfiles(), restarted.listFolders(), original.query, Date.now())).toThrow(/folder.*no longer available/)
    expect(restarted.listViews()).toEqual([original])
    expect(restarted.listProfiles()).toHaveLength(1)
    await restarted.saveView('Restored scope', { route: 'proxy' }, restarted.listRevision(), view.id)
    expect(restarted.listViews()[0]).toMatchObject({ id: view.id, label: 'Restored scope' })
    await restarted.deleteView(view.id, restarted.listRevision())
    expect(restarted.listViews()).toEqual([]); expect(restarted.listProfiles()[0]!.id).toBe(id)
  })

  it('reads semantically identical saved views after real JSON key reordering without changing original Profile data or bytes', async () => {
    const { manager, path, id } = await fixture()
    const other = await manager.createProfile('Retained second Profile', crypto.randomUUID(), profileCreationTestActor)
    await manager.updateProfile(id, { tags: ['Keep'], notes: 'Retain this configuration' }, selected(manager, [id])[0]!.expectedRevision)
    const { view } = await manager.saveView('Unknown first', { status: 'unknown', sort: 'name' }, manager.listRevision(), undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    const expectedProfiles = manager.listProfiles(), expectedPartition = manager.resolvePartition(id)
    const original = JSON.parse(await readFile(path, 'utf8'))
    // Both the view and its query have a different legal JSON insertion order.
    original.views[0] = { query: { sort: 'name', status: 'unknown' }, label: view.label, id: view.id }
    const reordered = JSON.stringify(original, null, 3) + '\n'; await writeFile(path, reordered)
    const store = new BrowserProfileStore(path), snapshot = await store.list()
    expect(snapshot.views).toEqual([view]); expect(snapshot.profiles).toEqual(expectedProfiles)
    const restarted = new BrowserProfileManager(new BrowserProfileStore(path)); await restarted.initialize()
    expect(restarted.listViews()).toEqual([view]); expect(restarted.listProfiles()).toEqual(expectedProfiles)
    expect(restarted.resolvePartition(id)).toBe(expectedPartition)
    expect(restarted.listProfiles().some(profile => profile.id === other.id)).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(reordered)
    original.views[0].query.permission = 'allow'
    const bad = JSON.stringify(original); await writeFile(path, bad)
    await expect(new BrowserProfileStore(path).list()).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bad)
    expect(restarted.resolvePartition(id)).toBe(expectedPartition)
    await rm(path)
    await expect(restarted.saveView('No empty replacement', {}, restarted.listRevision(), undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the exact view commit revision through Manager and public service despite a later confirmed collection write before its ACK', async () => {
    const { manager, store } = await fixture(), before = manager.listRevision()
    const save = store.createIdentity.bind(store)
    store.createIdentity = async (...args) => {
      const saved = await save(...args)
      if (args[0].operation === 'browser.profile.view.create') await manager.createProfile('Later independent collection commit', crypto.randomUUID(), profileCreationTestActor)
      return saved
    }
    const receipt = await executeBrowserProfileControl({ operation: 'browser.profile.view.create', operationId: 'exact-view-original', label: 'Exact ACK', query: { sort: 'name' }, expectedRevision: before },
      { profiles: manager, usage: {} as never, network: {} as never }, profileCreationTestActor)
    expect(receipt).toMatchObject({ operation: 'browser.profile.view.create', revision: before + 1, creation: { receipt: { operationId: 'exact-view-original', createdKind: 'view' } } })
    expect(manager.listRevision()).toBe(before + 2)
    expect(receipt.revision).not.toBe(manager.listRevision())
  })

  it('leaves view/folder configuration CAS and Profile tokens unchanged by activity checkpoints', async () => {
    const { manager, id } = await fixture(), revision = manager.listRevision(), token = selected(manager, [id])[0]!.expectedRevision, sequence = manager.listSequence()
    await manager.recordActivity(id, { observerId: manager.activityObserverId, previousObserverId: null, sequence: 1, unionMs: 20, observedAt: 100, lastUsedAt: 90, active: true, gaps: [] })
    expect(manager.listSequence()).toBe(sequence + 1); expect(manager.listRevision()).toBe(revision)
    await manager.saveView('Known usage', { lastUsed: 'week' }, revision, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })
    expect(selected(manager, [id])[0]!.expectedRevision).toBe(token)
    const bytes = await manager.listViews()
    await expect(manager.saveView('Stale', {}, revision, undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(manager.listViews()).toEqual(bytes)
  })

  it('freezes accurate IDs/tokens, continues partial failures, preserves original tags and never adds a newly matching Profile', async () => {
    const { manager, id } = await fixture(), second = await manager.createProfile('Same name', crypto.randomUUID(), profileCreationTestActor), third = await manager.createProfile('Same name', crypto.randomUUID(), profileCreationTestActor)
    await manager.updateProfile(id, { tags: ['Original'] }, selected(manager, [id])[0]!.expectedRevision)
    const items = selected(manager, [id, second.id]), beforeThird = manager.listProfiles().find(profile => profile.id === third.id)
    await manager.updateProfile(second.id, { notes: 'newer independent draft' }, selected(manager, [second.id])[0]!.expectedRevision)
    const results = await manager.bulkUpdate(items, { kind: 'add-tag', tag: ' Work ' })
    expect(results.map(item => [item.profileId, item.expectedRevision, item.outcome])).toEqual([[id, items[0]!.expectedRevision, 'updated'], [second.id, items[1]!.expectedRevision, 'failed']])
    expect(results[1]).toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(manager.listProfiles().find(profile => profile.id === id)!.tags).toEqual(['Original', 'Work'])
    expect(manager.listProfiles().find(profile => profile.id === second.id)).toMatchObject({ notes: 'newer independent draft' })
    expect(manager.listProfiles().find(profile => profile.id === third.id)).toEqual(beforeThird)
    const reverse = await manager.bulkUpdate([items[1]!, ...selected(manager, [id])], { kind: 'pin', pinned: true })
    expect(reverse.map(item => item.outcome)).toEqual(['failed', 'updated'])
    expect(manager.listProfiles().find(profile => profile.id === id)!.pinned).toBe(true)
    expect(native.get).not.toHaveBeenCalled()
  })

  it('moves and removes tags through original queued edits without clearing notes, routes, default or unrelated config', async () => {
    const { manager, id } = await fixture(), other = await manager.createProfile('Other', crypto.randomUUID(), profileCreationTestActor), folder = await manager.createFolder('Shared', manager.listRevision(), crypto.randomUUID(), profileCreationTestActor)
    await manager.updateProfile(id, { notes: 'Keep notes', tags: ['Keep', 'Remove'], agentAccess: false }, selected(manager, [id])[0]!.expectedRevision)
    await manager.bulkUpdate(selected(manager, [id, other.id]), { kind: 'move', folderId: folder.id })
    await manager.bulkUpdate(selected(manager, [id]), { kind: 'remove-tag', tag: 'Remove' })
    expect(manager.listProfiles().find(profile => profile.id === id)).toMatchObject({ folderId: folder.id, tags: ['Keep'], notes: 'Keep notes', isDefault: true, agentAccess: false })
    await manager.bulkUpdate(selected(manager, [id, other.id]), { kind: 'move', folderId: null })
    expect(manager.listProfiles().every(profile => profile.folderId === undefined)).toBe(true)
  })

  it('rejects empty, duplicate and unsupported batch inputs before any write; unknown original bytes stay intact', async () => {
    const { manager, path, id } = await fixture(), items = selected(manager, [id]), before = await readFile(path, 'utf8')
    for (const input of [[], [...items, ...items], [{ profileId: id }]]) await expect(manager.bulkUpdate(input as never, { kind: 'pin', pinned: true })).rejects.toThrow()
    for (const action of [{ kind: 'delete' }, { kind: 'pin', pinned: true, network: {} }, { kind: 'add-tag', tag: '' }]) await expect(manager.bulkUpdate(items, action as never)).rejects.toThrow()
    await expect(manager.bulkUpdate(items, { kind: 'move', folderId: 'unavailable' })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(before)
    await writeFile(path, '{ original unreadable bytes')
    await expect(manager.saveView('Retained', {}, manager.listRevision(), undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })).rejects.toThrow()
    expect(await manager.bulkUpdate(items, { kind: 'pin', pinned: true })).toMatchObject([{ profileId: id, outcome: 'failed' }])
    expect(await readFile(path, 'utf8')).toBe('{ original unreadable bytes')
    await rm(path)
    await expect(manager.saveView('No substitute', {}, manager.listRevision(), undefined, { operationId: crypto.randomUUID(), actor: profileCreationTestActor })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('strictly preserves query/view identity and every partial result, rejecting unsolicited control fields', () => {
    for (const value of [{ status: 'never' }, { lastUsed: 'unused' }, { selected: ['another'] }]) expect(() => parseBrowserProfileQuery(value)).toThrow()
    expect(() => parseBrowserProfileSelection([])).toThrow(); expect(() => parseBrowserProfileBulkAction({ kind: 'move', folderId: null, grant: true })).toThrow()
    expect(() => parseBrowserProfileControlPayload({ operation: 'browser.profile.ls', query: {}, viewId: 'v-one' }, ['operation'])).toThrow()
    const request = { operation: 'browser.profile.bulk-update' as const, items: [{ profileId: 'p-one', expectedRevision: 'exact-token' }], action: { kind: 'pin' as const, pinned: true } }
    const result = { operation: request.operation, revision: 2, results: [{ profileId: 'p-one', expectedRevision: 'exact-token', outcome: 'failed' as const, code: 'BROWSER_PROFILE_REVISION_CONFLICT', message: 'Kept original' }] }
    expect(parseBrowserProfileControlResult(request.operation, { revision: result.revision, results: result.results })).toEqual({ revision: result.revision, results: result.results })
    expect(() => assertBrowserProfileControlTarget(request, { ...result, results: [] })).toThrow()
    expect(() => assertBrowserProfileControlTarget(request, { ...result, results: [{ ...result.results[0]!, expectedRevision: 'other-token' }] })).toThrow()
  })

  it('runs actual compiled CLI query, saved-view create/update/delete and exact partial bulk calls through original Main owners', async () => {
    const { root, manager, id } = await fixture(), other = await manager.createProfile('CLI other', crypto.randomUUID(), profileCreationTestActor)
    const core = await privateRpcCorePort(join(root, 'sessions.json'), join(root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      execute: async (request, context) => { if (!isBrowserProfileControlRequest(request)) throw new Error('Unexpected operation'); return executeBrowserProfileControl(request,
        { profiles: manager, usage: { usage: async () => ({ complete: true, browsers: [] }) } as never, network: {} as never }, context?.actor) } })
    await server.start()
    try {
      const env = objectCliEnvironment(root, { NODE_NO_WARNINGS: '1' })
      const run = async (args: string[]) => { const reply = await runCompiledObjectCli(['browser', 'profile', ...args], env); expect(reply.code, reply.stderr).toBe(0); return JSON.parse(reply.stdout).result }
      const list = await run(['ls']); expect(list.views).toEqual([])
      const savedId = (await run(['view', 'create', '--operation-id', 'cli-view-original', '--label', 'CLI view', '--query', '{"status":"unknown","sort":"name"}', '--expected-revision', String(list.revision)])).creation.receipt.createdId
      const saved = manager.listViews().find(value => value.id === savedId)!
      expect((await run(['ls', '--view', saved.id])).filter).toMatchObject({ viewId: saved.id, query: saved.query })
      const items = selected(manager, [id, other.id]); await manager.updateProfile(other.id, { notes: 'external update' }, items[1]!.expectedRevision)
      const receipt = await run(['bulk-update', '--items', JSON.stringify(items), '--action', '{"kind":"add-tag","tag":"CLI"}'])
      expect(receipt.results.map((item: any) => [item.profileId, item.outcome])).toEqual([[id, 'updated'], [other.id, 'failed']])
      const filtered = await run(['ls', '--query', '{"tag":"CLI"}']); expect(filtered.profiles.map((profile: any) => profile.id)).toEqual([id])
      const noDefault = await run(['ls', '--query', '{"search":"CLI other"}']); expect(noDefault.profiles.map((profile: any) => profile.id)).toEqual([other.id])
      const empty = await run(['ls', '--query', '{"tag":"No match"}']); expect(empty.profiles).toEqual([])
      await run(['view', 'update', '--view', saved.id, '--label', 'Renamed', '--query', '{"tag":"CLI"}', '--expected-revision', String(manager.listRevision())])
      expect((await run(['ls', '--view', saved.id])).profiles.map((profile: any) => profile.id)).toEqual([id])
      await run(['view', 'delete', '--view', saved.id, '--expected-revision', String(manager.listRevision())])
      expect((await run(['ls'])).views).toEqual([])
      const before = manager.listRevision(), refused = await runCompiledObjectCli(['browser', 'profile', 'bulk-update', '--items', '[]', '--action', '{"kind":"delete"}'], env)
      expect(refused.code).not.toBe(0); expect(manager.listRevision()).toBe(before)
      const help = await runCompiledObjectCli(['browser', 'profile', 'bulk-update', '--help'], env); expect(help.stdout).toContain('individually updated or failed')
      const skill = await runCompiledObjectCli(['browser', '--skill'], env); expect(skill.stdout).toContain('profile view create/update/delete')
    } finally { await server.stop(); await core.dispose() }
    expect(native.get).not.toHaveBeenCalled()
  }, 45_000)
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
