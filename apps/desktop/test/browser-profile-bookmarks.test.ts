import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fault = vi.hoisted(() => ({ failWrite: false, failDirectory: false, root: '' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (fault.failWrite && String(args[0]).endsWith('.tmp')) { fault.failWrite = false; throw Error('Private write failure token=never-public') }
    const file = await fs.open(...args)
    if (fault.failDirectory && String(args[0]) === fault.root) { file.sync = async () => { fault.failDirectory = false; throw Error('Private directory fsync failure') } }
    return file
  } }
})
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, BrowserWindow: class {}, session: { fromPartition: () => { throw Error('No implicit Session') } }, webContents: { getAllWebContents: () => [] } }))
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { openBrowserProfileBookmark, BrowserProfileBookmarkRefused } from '../src/main/browser-profile-bookmark-open.js'
import { registerBrowserProfileEditorIpc } from '../src/main/browser-profile-editor-ipc.js'
import { executeBrowserProfileControl } from '../src/main/browser-profile-control.js'
import { assertBrowserAutomation } from '../src/main/browser-automation-gate.js'
import { emitWebloc } from '../src/shared/bookmark-file.js'
import { parseBrowserProfileBookmarkPayload, parseBrowserProfileBookmarkResult, assertBrowserProfileBookmarkTarget } from '../../../packages/core/src/browser-profile-bookmarks.js'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); fault.failWrite = false; fault.failDirectory = false; await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-profile-bookmarks-')); roots.push(root); fault.root = root
  const path = join(root, 'profiles.json'), store = new BrowserProfileStore(path), native = vi.fn(() => { throw Error('No implicit native Session') })
  const manager = new BrowserProfileManager(store, { prepare: () => undefined, nativeSession: native } as never, () => root)
  await manager.initialize(); const profile = manager.listProfiles()[0]!, other = await manager.createProfile('Other Profile', crypto.randomUUID(), profileCreationTestActor)
  const list = (folderId: string | null = null, operationId?: string) => manager.bookmarks.list(profile.id, folderId, operationId)
  let serial = 0
  const edit = async (change: Parameters<typeof manager.bookmarks.edit>[3]) => manager.bookmarks.edit(profile.id, (await list()).revision, `edit-${++serial}`, change)
  const save = async (url = 'https://generic.invalid/search?q=exact+query#route', folderId: string | null = null) => edit({ kind: 'save', title: 'Original', url, folderId })
  return { root, path, store, manager, profile, other, native, list, edit, save }
}

describe('managed Profile bookmarks use the original metadata, exact scope and Browser owner', () => {
  it('preserves full URL, exact IDs and revision across original Profile owner reconstruction without native Sessions', async () => {
    const f = await fixture(), url = 'https://account:secret@generic.invalid/search?token=exact+query#spa-route', saved = await f.save(url)
    expect(saved.receipt.createdIds).toHaveLength(1); expect(JSON.stringify(saved)).not.toContain(url); expect(JSON.stringify(saved)).not.toContain('secret')
    const before = await f.list(), reboot = new BrowserProfileManager(new BrowserProfileStore(f.path), { prepare: () => undefined, nativeSession: f.native } as never, () => f.root)
    await reboot.initialize(); expect(await reboot.bookmarks.list(f.profile.id, null, saved.receipt.operationId)).toEqual({ ...before, receipt: saved.receipt })
    expect(before.bookmarks[0]).toMatchObject({ id: saved.receipt.entryId, url }); expect(f.native).not.toHaveBeenCalled()
    expect((await reboot.bookmarks.list(f.other.id, null)).bookmarks).toEqual([])
  })
  it('empty-library export bookkeeping preserves the original Profile settings token', async () => {
    const f = await fixture(), before = f.manager.listProfiles().find(p => p.id === f.profile.id)!
    await f.manager.bookmarks.export(f.profile.id, null, 'empty', 'empty-library-export', join(f.root, 'empty.html'))
    expect(f.manager.listProfiles().find(p => p.id === f.profile.id)!.revision).toBe(before.revision)
    await expect(f.manager.updateProfile(f.profile.id, { notes: 'Kept settings draft' }, before.revision)).resolves.toMatchObject({ notes: 'Kept settings draft' })
  })
  it('serializes stale mutations through the original config queue and preserves unrelated Profile settings', async () => {
    const f = await fixture(), r = (await f.list()).revision
    const results = await Promise.allSettled(['one', 'two'].map(title => f.manager.bookmarks.edit(f.profile.id, r, `parallel-${title}`, { kind: 'save', folderId: null, title, url: `https://generic.invalid/${title}` })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect((await f.list()).bookmarks).toHaveLength(1)
    const p = f.manager.listProfiles().find(p => p.id === f.profile.id)!
    await f.manager.updateProfile(p.id, { notes: 'Original notes' }, p.revision)
    const saved = await f.save('https://generic.invalid/another'); expect(saved.receipt.status).toBe('completed')
    expect(f.manager.listProfiles().find(p => p.id === f.profile.id)!.notes).toBe('Original notes')
  })
  it('edits and moves exact identities without losing address query/hash; unrelated same-title entries survive', async () => {
    const f = await fixture(), a = await f.save(), folder = await f.edit({ kind: 'create-folder', parentId: null, label: 'Folder' }), id = folder.receipt.entryId!
    const moved = await f.edit({ kind: 'save', id: a.receipt.entryId, folderId: id, title: 'Renamed' })
    const contents = await f.list(id); expect(contents.bookmarks[0]).toMatchObject({ id: a.receipt.entryId, title: 'Renamed', url: 'https://generic.invalid/search?q=exact+query#route' }); expect(contents.ancestors.map(f => f.id)).toEqual([id]); expect(contents.revision).toBe(moved.revision)
    await f.save('https://generic.invalid/other'); await f.edit({ kind: 'remove', id: a.receipt.entryId! })
    expect((await f.list()).bookmarks).toHaveLength(1); expect((await f.list(id)).bookmarks).toEqual([])
  })
  it('rejects wrong Profile/folder and cyclic moves only for that operation, retaining the source library', async () => {
    const f = await fixture(), first = await f.edit({ kind: 'create-folder', parentId: null, label: 'One' }), id = first.receipt.entryId!, child = await f.edit({ kind: 'create-folder', parentId: id, label: 'Child' })
    await expect(f.edit({ kind: 'move-folder', id, parentId: child.receipt.entryId! })).rejects.toThrow('descendants')
    await expect(f.manager.bookmarks.edit(f.other.id, 'empty', 'wrong-profile', { kind: 'save', folderId: id, title: 'Wrong', url: 'https://generic.invalid/' })).rejects.toThrow('exact bookmark folder')
    await expect(f.edit({ kind: 'remove-folder', id })).rejects.toThrow('still contains')
    await f.save('https://generic.invalid/healthy'); expect((await f.list()).bookmarks).toHaveLength(1)
  })
  it('imports real Netscape folder structure, entity text and exact URLs; duplicate conflicts never overwrite originals', async () => {
    const f = await fixture(), original = await f.save('https://generic.invalid/one?a=1&b=2#route'), path = join(f.root, 'private-token-source.html')
    await writeFile(path, '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://generic.invalid/one?a=1&amp;b=2#route">Replace original</A><DT><H3>Research &amp; Work</H3><DL><p><DT><A HREF="https://alternate.invalid/?term=a&amp;view=b#panel">Child &lt;title&gt;</A><DT><A HREF="javascript:alert(1)">Unsupported</A></DL><p><DT><A HREF="https://generic.invalid/two">Two</A></DL><p>')
    const imported = await f.manager.bookmarks.import(f.profile.id, null, (await f.list()).revision, 'import-original', path)
    expect(imported.receipt.conflicts.map(c => c.reason)).toEqual(['duplicate', 'unsupported-address']); expect(imported.receipt.createdIds).toHaveLength(3)
    expect(JSON.stringify(imported)).not.toMatch(/private-token|term=a|view=b|alert/)
    const root = await f.list(); expect(root.bookmarks.find(b => b.id === original.receipt.entryId)?.title).toBe('Original'); expect(root.folders[0]?.label).toBe('Research & Work')
    expect((await f.list(root.folders[0]!.id)).bookmarks[0]).toMatchObject({ title: 'Child <title>', url: 'https://alternate.invalid/?term=a&view=b#panel' })
  })
  it('exports scoped standard Netscape HTML without overwriting any existing file and roundtrips through the same owner', async () => {
    const f = await fixture(), folder = await f.edit({ kind: 'create-folder', parentId: null, label: 'Exact folder' }), id = folder.receipt.entryId!, url = 'https://generic.invalid/?q=<exact>&token=secret#panel'
    await f.save(url, id); await f.save('https://generic.invalid/outside')
    const path = join(f.root, 'export.html'), r = (await f.list()).revision
    expect((await f.manager.bookmarks.export(f.profile.id, id, r, 'export-original', path)).receipt.status).toBe('completed')
    const html = await readFile(path, 'utf8'); expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>'); expect(html).toContain('q=&lt;exact&gt;&amp;token=secret#panel'); expect(html).not.toContain('outside')
    const refused = await f.manager.bookmarks.export(f.profile.id, id, r, 'export-no-overwrite', path); expect(refused.receipt.status).toBe('failed'); expect(await readFile(path, 'utf8')).toBe(html)
    const imported = await f.manager.bookmarks.import(f.other.id, null, 'empty', 'roundtrip', path); expect(imported.receipt.createdIds).toHaveLength(1)
    expect((await f.manager.bookmarks.list(f.other.id, null)).bookmarks[0]?.url).toBe(url)
  })
  it.each(['webloc', 'url'] as const)('consumes the original standard %s reader while keeping Workspace source bytes intact', async kind => {
    const f = await fixture(), url = 'https://generic.invalid/?q=one&key=exact#route', path = join(f.root, `Workspace.${kind}`), bytes = kind === 'webloc' ? emitWebloc(url) : `[InternetShortcut]\r\nURL=${url}\r\n`
    await writeFile(path, bytes)
    const saved = await f.manager.bookmarks.import(f.profile.id, null, 'empty', 'standard-link', path)
    expect(saved.receipt.createdIds).toHaveLength(1); expect((await f.list()).bookmarks[0]?.url).toBe(url); expect(await readFile(path, 'utf8')).toBe(bytes)
  })
  it('never leaks source filename/URL through failed import, and the library remains usable', async () => {
    const f = await fixture(), path = join(f.root, 'credentials-sensitive-token.html')
    await expect(f.manager.bookmarks.import(f.profile.id, null, 'empty', 'private-source', path)).rejects.toThrow('source could not be read')
    try { await f.manager.bookmarks.import(f.profile.id, null, 'empty', 'private-source-2', path) } catch (e) { expect(String(e)).not.toMatch(/credentials-sensitive|amx-profile|token=/) }
    await f.save(); expect((await f.list()).bookmarks).toHaveLength(1)
  })
  it('persists pending source binding before opening, releases config queue, and does not replay after owner reconstruction', async () => {
    const f = await fixture(), saved = await f.save(), bookmarkId = saved.receipt.entryId!, before = (await f.list()).bookmarks[0]!
    const dispatch = vi.fn(async (url: string) => {
      expect(url).toBe(before.url); const pending = await f.list(null, 'open-original'); expect(pending.receipt).toMatchObject({ status: 'pending', entryId: bookmarkId, entryRevision: before.revision, browserId: 'exact-browser', expectedRevision: saved.revision })
      await f.edit({ kind: 'save', id: bookmarkId, folderId: null, title: 'Edited while opening' })
      throw Error('Native acted but ACK lost: token=private')
    })
    expect((await f.manager.bookmarks.open(f.profile.id, bookmarkId, 'exact-browser', saved.revision, 'open-original', dispatch)).receipt.status).toBe('pending')
    const reboot = new BrowserProfileManager(new BrowserProfileStore(f.path), { prepare: () => undefined, nativeSession: f.native } as never, () => f.root); await reboot.initialize()
    expect((await reboot.bookmarks.list(f.profile.id, null)).pending).toHaveLength(1)
    await expect(reboot.bookmarks.open(f.profile.id, bookmarkId, 'exact-browser', saved.revision, 'open-original', dispatch)).rejects.toThrow('will not be replayed')
    expect(dispatch).toHaveBeenCalledTimes(1); expect(JSON.stringify((await reboot.bookmarks.list(f.profile.id, null)).pending)).not.toContain('private')
  })
  it('before-save failure blocks native dispatch, directory ACK failure preserves original intent, and a later receipt-save failure cannot replay', async () => {
    const f = await fixture(), saved = await f.save(), id = saved.receipt.entryId!, dispatch = vi.fn(async () => {})
    fault.failWrite = true
    await expect(f.manager.bookmarks.open(f.profile.id, id, 'browser', saved.revision, 'before-save', dispatch)).rejects.toThrow(); expect(dispatch).not.toHaveBeenCalled()
    fault.failDirectory = true
    await expect(f.manager.bookmarks.open(f.profile.id, id, 'browser', saved.revision, 'directory-ack', dispatch)).rejects.toThrow(); expect(dispatch).not.toHaveBeenCalled(); expect((await f.list(null, 'directory-ack')).receipt?.status).toBe('pending')
    const native = vi.fn(async () => { fault.failWrite = true })
    await expect(f.manager.bookmarks.open(f.profile.id, id, 'browser', saved.revision, 'after-native', native)).rejects.toThrow(); expect(native).toHaveBeenCalledTimes(1)
    const second = new BrowserProfileManager(new BrowserProfileStore(f.path), { prepare: () => undefined, nativeSession: f.native } as never, () => f.root); await second.initialize()
    expect((await second.bookmarks.list(f.profile.id, null, 'after-native')).receipt?.status).toBe('pending')
    await expect(second.bookmarks.open(f.profile.id, id, 'browser', saved.revision, 'after-native', native)).rejects.toThrow('will not be replayed'); expect(native).toHaveBeenCalledTimes(1)
  })
  it('opens only the exact Profile Browser, preserving captured caller authorization after cold preparation and at actual page dispatch', async () => {
    let profileId = 'profile', allowed = true; const caller = { agentSessionId: 'original-agent' }, run = vi.fn(async (_id, _url, _op, actualCaller, authorize) => { expect(actualCaller).toEqual(caller); allowed = false; await authorize() }), navigate = vi.fn(async () => {})
    const ports = { scope: async () => ({ mode: 'normal', profileId }), prepare: vi.fn(async () => {}), authorize: async (_id: string, actual: typeof caller) => assertBrowserAutomation({ kind: 'agent', ...actual }, { automation: true, profile: { agentAccess: allowed } }), run, navigate }
    const request = { profileId: 'profile', browserId: 'browser', operationId: 'open', caller }
    profileId = 'different'; await expect(openBrowserProfileBookmark(request, 'https://generic.invalid/', ports)).rejects.toBeInstanceOf(BrowserProfileBookmarkRefused); expect(ports.prepare).not.toHaveBeenCalled()
    profileId = 'profile'; ports.prepare.mockImplementation(async () => { allowed = false }); await expect(openBrowserProfileBookmark(request, 'https://generic.invalid/', ports)).rejects.toThrow('Agents are turned off'); expect(run).not.toHaveBeenCalled()
    allowed = true; ports.prepare.mockImplementation(async () => {}); await expect(openBrowserProfileBookmark(request, 'https://generic.invalid/', ports)).rejects.toThrow('Agents are turned off'); expect(run).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled()
    await openBrowserProfileBookmark({ ...request, caller: undefined }, 'https://generic.invalid/?q=full#route', ports); expect(navigate).toHaveBeenCalledWith('browser', 'https://generic.invalid/?q=full#route')
  })
  it('distinguishes authoritative pre-commit refusals from existing intents and unknown writer failures', async () => {
    const f = await fixture()
    await expect(f.manager.bookmarks.edit(f.profile.id, 'empty', 'invalid-address', { kind: 'save', folderId: null, title: 'Original input', url: 'invalid private token' })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_BOOKMARK_REFUSED' })
    expect((await f.list(null, 'invalid-address')).receipt).toBeNull()
    const saved = await f.save()
    await expect(f.manager.bookmarks.edit(f.profile.id, 'empty', 'stale-input', { kind: 'remove', id: saved.receipt.entryId! })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_BOOKMARK_REFUSED' })
    await expect(f.manager.bookmarks.edit(f.profile.id, 'empty', saved.receipt.operationId, { kind: 'remove', id: saved.receipt.entryId! })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_BOOKMARK_ALREADY_ADMITTED' })
    await expect(f.manager.bookmarks.import(f.profile.id, null, 'empty', saved.receipt.operationId, join(f.root, 'source-no-longer-exists.html'))).rejects.toMatchObject({ code: 'BROWSER_PROFILE_BOOKMARK_ALREADY_ADMITTED' })
    await expect(f.manager.bookmarks.edit(f.profile.id, 'empty', saved.receipt.operationId, { kind: 'invalid' } as never)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_BOOKMARK_ALREADY_ADMITTED' })
    fault.failWrite = true
    try { await f.manager.bookmarks.edit(f.profile.id, saved.revision, 'unknown-writer', { kind: 'remove', id: saved.receipt.entryId! }); throw Error('Expected original writer failure') }
    catch (cause) { expect((cause as { code?: string }).code).not.toBe('BROWSER_PROFILE_BOOKMARK_REFUSED') }
    expect((await f.list()).bookmarks[0]?.id).toBe(saved.receipt.entryId)
  })
  it('strictly parses original public identities, keeps business operation separate from transport, and refuses foreign receipts', async () => {
    const f = await fixture(), saved = await f.save(), input = { profileId: f.profile.id, folderId: null, operationId: saved.receipt.operationId }
    const request = rpcControlRequest('browser.profile.bookmark.ls', input)
    expect(request.requestId).not.toBe(input.operationId); expect(request).toMatchObject(input)
    expect(() => rpcControlRequest('browser.profile.bookmark.open', { profileId: f.profile.id, bookmarkId: saved.receipt.entryId, browserId: 'browser', expectedRevision: saved.revision, operationId: 'open', caller: { agentSessionId: 'spoofed' } })).toThrow('internal Control envelope')
    const result = parseBrowserProfileBookmarkResult('browser.profile.bookmark.ls', await f.list(null, input.operationId)); expect(() => assertBrowserProfileBookmarkTarget({ operation: 'browser.profile.bookmark.ls', ...input }, result)).not.toThrow()
    expect(() => assertBrowserProfileBookmarkTarget({ operation: 'browser.profile.bookmark.ls', ...input, profileId: f.other.id }, result)).toThrow('another original Profile')
    const importRequest = { operation: 'browser.profile.bookmark.import' as const, profileId: f.profile.id, folderId: null, expectedRevision: saved.revision, operationId: 'same-import', sourcePath: 'private-input.html' }
    expect(() => assertBrowserProfileBookmarkTarget(importRequest, { operation: importRequest.operation, profileId: f.profile.id, revision: saved.revision, receipt: { ...saved.receipt, kind: 'import', operationId: 'same-import', expectedRevision: saved.revision, folderId: 'another-folder' } })).toThrow('another original Profile')
    const editRequest = { operation: 'browser.profile.bookmark.edit' as const, profileId: f.profile.id, expectedRevision: saved.revision, operationId: 'same-edit', change: { kind: 'remove' as const, id: saved.receipt.entryId! } }
    expect(() => assertBrowserProfileBookmarkTarget(editRequest, { operation: editRequest.operation, profileId: f.profile.id, revision: saved.revision, receipt: { ...saved.receipt, kind: 'edit', operationId: 'same-edit', expectedRevision: saved.revision, entryId: 'another-entry' } })).toThrow('another original Profile')
    expect(() => parseBrowserProfileBookmarkPayload({ operation: 'browser.profile.bookmark.edit', profileId: f.profile.id, expectedRevision: saved.revision, operationId: 'edit', change: { kind: 'remove', id: saved.receipt.entryId, approved: true } })).toThrow()
  })
  it('executes actual compiled CLI/RPC and five GUI result handlers through the same original owner', async () => {
    const f = await fixture(), core = await privateRpcCorePort(join(f.root, 'sessions.json'), join(f.root, 'messages.ndjson'))
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: core.clients, execute: async (request, context) => executeBrowserProfileControl(request as never, { profiles: f.manager, usage: {} as never, network: {} as never, openBookmark: async () => {} }, context?.actor) }); await server.start()
    try {
      const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' }), cli = async (method: string, input: object) => { const result = await runCompiledObjectCli(['browser', 'profile', 'bookmark', method, '--input', '-'], env, JSON.stringify(input)); expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout).result }
      const saved = await cli('edit', { profileId: f.profile.id, expectedRevision: 'empty', operationId: 'cli-original', change: { kind: 'save', folderId: null, title: 'CLI bookmark', url: 'https://generic.invalid/?q=original#route' } })
      expect(saved.receipt).toMatchObject({ operationId: 'cli-original', kind: 'edit' }); const list = await cli('ls', { profileId: f.profile.id, folderId: null, operationId: 'cli-original' }); expect(list.bookmarks[0]?.id).toBe(saved.receipt.entryId)
      const refused = await runCompiledObjectCli(['browser', 'profile', 'bookmark', 'edit', '--input', '-'], env, JSON.stringify({ profileId: f.profile.id, expectedRevision: 'empty', operationId: 'cli-refused', change: { kind: 'remove', id: saved.receipt.entryId } })); expect(refused.code).not.toBe(0); expect(JSON.parse(refused.stdout || refused.stderr).error.code).toBe('BROWSER_PROFILE_BOOKMARK_REFUSED')
      const admitted = await runCompiledObjectCli(['browser', 'profile', 'bookmark', 'edit', '--input', '-'], env, JSON.stringify({ profileId: f.profile.id, expectedRevision: 'empty', operationId: 'cli-original', change: { kind: 'remove', id: saved.receipt.entryId } })); expect(admitted.code).not.toBe(0); expect(JSON.parse(admitted.stdout || admitted.stderr).error.code).toBe('BROWSER_PROFILE_BOOKMARK_ALREADY_ADMITTED')
      const handlers = new Map<string, Function>(); registerBrowserProfileEditorIpc({ handle: (channel, handler) => { handlers.set(channel, handler) }, profiles: f.manager, openBookmark: async () => {} })
      expect(['listProfileBookmarks', 'editProfileBookmark', 'importProfileBookmarks', 'exportProfileBookmarks', 'openProfileBookmark'].every(method => handlers.has(`browser:${method}`))).toBe(true)
      const gui = await handlers.get('browser:listProfileBookmarks')!({}, f.profile.id, null, 'cli-original'); expect(gui).toEqual({ ok: true, value: list })
      const opened = await handlers.get('browser:openProfileBookmark')!({}, f.profile.id, saved.receipt.entryId, 'browser', saved.revision, 'gui-open'); expect(opened).toMatchObject({ ok: true, value: { receipt: { operationId: 'gui-open', status: 'completed', browserId: 'browser' } } })
      const help = await runCompiledObjectCli(['browser', 'profile', 'bookmark', 'open', '--help'], env); expect(help.code).toBe(0); expect(help.stdout).toContain('--input'); expect(help.stdout).toContain('never overwrites')
    } finally { await server.stop(); await core.dispose() }
  }, 30_000)
})

const profileCreationTestActor = { kind: 'user' as const, id: 'original-test-author', verified: true }
