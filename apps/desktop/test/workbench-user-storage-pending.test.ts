// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { inspectDesktopClient, observeWorkbenchUserState } from '../src/main/client-observation'
import { parseDesktopClientObservation } from '../src/shared/client-observation'
import { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY as key } from '../src/renderer/src/lib/workbench-user-storage'
import { DESKTOP_FRAGMENT_KEYS } from '../src/renderer/src/lib/desktop-user-fragments'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

const roots: string[] = [], documents: ReturnType<typeof createWorkbenchUserDocument>[] = []
let dispose: (() => void) | undefined
beforeEach(() => { vi.resetModules(); localStorage.clear() })
afterEach(async () => {
  await Promise.allSettled(documents.splice(0).map(document => document.persistent.flush()))
  dispose?.(); dispose = undefined; vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })))
})
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function native(fragments: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'amux-input-custody-')); roots.push(root)
  const user = new WorkbenchUserStateStore(join(root, 'workbench-user-state.json'))
  await user.write(JSON.stringify({ state: { draft: 'Original' }, version: 1, desktopFragments: fragments }))
  const port = { readWorkbenchState: () => user.read(), importWorkbenchState: (value: string) => user.importIfAbsent(value), writeWorkbenchState: vi.fn((value: string): Promise<unknown> => user.write(value)) }
  const document = createWorkbenchUserDocument(port, () => localStorage, () => {})
  documents.push(document); await document.hydrate()
  return { root, user, port, document, saved: async () => JSON.parse((await user.read())!) }
}

it('unused absent fragments are clean without loading settings or requesting a writer ACK', async () => {
  const f = await native()
  expect(f.document.pending()).toBe(false)
  expect(f.document.isReady('profileEnvironmentDrafts')).toBe(false)
  expect(f.document.isReady('browserProxyLibraryDrafts')).toBe(false)
  expect(f.document.hasReadFailure()).toBe(false)
  expect(f.port.writeWorkbenchState).not.toHaveBeenCalled()
})

it('unconsumed opaque native bytes survive a real root save without being parsed or marked dirty', async () => {
  const opaque = '{original opaque value; no compatible semantic reader yet'
  const f = await native({ profileEnvironmentDrafts: opaque })
  expect(f.document.pending()).toBe(false)
  expect(f.document.isReady('profileEnvironmentDrafts')).toBe(false)
  await f.document.persistent.checkpoint(key, { state: { draft: 'New root input' }, version: 1 })
  expect((await f.saved()).desktopFragments.profileEnvironmentDrafts).toBe(opaque)
  expect(f.document.isReady('profileEnvironmentDrafts')).toBe(false)
  expect(f.document.pending()).toBe(false)
})

it.each(['browserProxyLibraryDrafts', 'profileEnvironmentDrafts'] as const)('unread legacy %s stays in original custody without eager load or deletion', async name => {
  const f = await native(), raw = '{original legacy bytes not interpreted by this observation'
  localStorage.setItem(DESKTOP_FRAGMENT_KEYS[name], raw)
  expect(f.document.pending()).toBe(true)
  expect(f.document.isReady(name)).toBe(false)
  expect(localStorage.getItem(DESKTOP_FRAGMENT_KEYS[name])).toBe(raw)
  expect((await f.saved()).desktopFragments).not.toHaveProperty(name)
  expect(f.port.writeWorkbenchState).not.toHaveBeenCalled()
})

it('avatar prefix input is protected and the original on-demand load ACK hands it to native custody', async () => {
  const f = await native(), originalKey = DESKTOP_FRAGMENT_KEYS.moteAvatarSaveDrafts + 'original-target'
  localStorage.setItem('unrelated-browser-key', 'unrelated retained bytes')
  expect(f.document.pending()).toBe(false)
  localStorage.setItem(originalKey, 'Original avatar input')
  expect(f.document.pending()).toBe(true)
  await f.document.load('moteAvatarSaveDrafts', value => { expect(value).toEqual({ [originalKey]: 'Original avatar input' }) })
  expect(localStorage.getItem(originalKey)).toBeNull()
  expect(localStorage.getItem('unrelated-browser-key')).toBe('unrelated retained bytes')
  expect((await f.saved()).desktopFragments.moteAvatarSaveDrafts).toEqual({ [originalKey]: 'Original avatar input' })
  expect(f.document.pending()).toBe(false)
})

it('an unknown exact legacy read stays unconfirmed while native opaque presence does not borrow that failure', async () => {
  const f = await native()
  const original = { getItem: (name: string) => { if (name === DESKTOP_FRAGMENT_KEYS.profileEnvironmentDrafts) throw Error('Original legacy observation unavailable'); return localStorage.getItem(name) },
    removeItem: (name: string) => localStorage.removeItem(name), key: (index: number) => localStorage.key(index), get length() { return localStorage.length } } as Storage
  const port = { readWorkbenchState: () => f.user.read(), importWorkbenchState: (value: string) => f.user.importIfAbsent(value), writeWorkbenchState: (value: string) => f.user.write(value) }
  const document = createWorkbenchUserDocument(port, () => original); documents.push(document); await document.hydrate()
  expect(document.pending()).toBe(true)
  const g = await native({ profileEnvironmentDrafts: 'Already native opaque input' })
  const nativeDocument = createWorkbenchUserDocument({ ...port, readWorkbenchState: () => g.user.read() }, () => original)
  documents.push(nativeDocument); await nativeDocument.hydrate()
  expect(nativeDocument.pending()).toBe(false)
})

it('on-demand import remains pending through its actual native ACK and only then releases exact legacy bytes', async () => {
  const f = await native(), entered = barrier(), release = barrier(), raw = 'Original input'
  localStorage.setItem(DESKTOP_FRAGMENT_KEYS.profileEnvironmentDrafts, raw)
  f.port.writeWorkbenchState.mockImplementationOnce(async value => { entered.resolve(); await release.promise; return f.user.write(value) })
  const loading = f.document.load('profileEnvironmentDrafts', value => { expect(value).toBe(raw) })
  try {
    await entered.promise
    expect(f.document.pending()).toBe(true)
    expect(f.document.isReady('profileEnvironmentDrafts')).toBe(false)
    expect(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.profileEnvironmentDrafts)).toBe(raw)
    expect((await f.saved()).desktopFragments).not.toHaveProperty('profileEnvironmentDrafts')
  } finally { release.resolve(); await loading }
  expect(f.document.pending()).toBe(false)
  expect(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.profileEnvironmentDrafts)).toBeNull()
})

it('ready fragment edits stay pending after weak ACK and recover only through the same real writer', async () => {
  const f = await native({ profileEnvironmentDrafts: null })
  await f.document.load('profileEnvironmentDrafts', () => {})
  f.document.write('profileEnvironmentDrafts', 'Current authored input')
  expect(f.document.pending()).toBe(true)
  let allowRealACK = false
  f.port.writeWorkbenchState.mockImplementation(async value => allowRealACK ? f.user.write(value) : {})
  try {
    await expect(f.document.checkpoint('profileEnvironmentDrafts')).rejects.toThrow('acknowledgement did not confirm')
    expect(f.document.pending()).toBe(true)
    expect((await f.saved()).desktopFragments.profileEnvironmentDrafts).toBeNull()
  } finally { allowRealACK = true; await f.document.checkpoint('profileEnvironmentDrafts') }
  expect(f.document.pending()).toBe(false)
  expect((await f.saved()).desktopFragments.profileEnvironmentDrafts).toBe('Current authored input')
})

it('an old fragment ACK cannot confirm a newer edit that is still awaiting its own native writer', async () => {
  const f = await native({ browserProxyLibraryDrafts: null }), first = barrier(), second = barrier(), releaseFirst = barrier(), releaseSecond = barrier()
  await f.document.load('browserProxyLibraryDrafts', () => {})
  f.port.writeWorkbenchState.mockImplementationOnce(async value => { first.resolve(); await releaseFirst.promise; return f.user.write(value) })
    .mockImplementationOnce(async value => { second.resolve(); await releaseSecond.promise; return f.user.write(value) })
  f.document.write('browserProxyLibraryDrafts', 'First captured input')
  const saving = f.document.checkpoint('browserProxyLibraryDrafts')
  try {
    await first.promise
    f.document.write('browserProxyLibraryDrafts', 'Newer current input')
    releaseFirst.resolve(); await second.promise
    expect(f.document.pending()).toBe(true)
    expect((await f.saved()).desktopFragments.browserProxyLibraryDrafts).toBe('First captured input')
  } finally { releaseFirst.resolve(); releaseSecond.resolve(); await saving; await f.document.persistent.flush() }
  expect(f.document.pending()).toBe(false)
  expect((await f.saved()).desktopFragments.browserProxyLibraryDrafts).toBe('Newer current input')
})

it('durable invalid opaque members keep read diagnostics separate until every failed original member is repaired', async () => {
  const f = await native({ profileEnvironmentDrafts: '{bad-A', browserProxyLibraryDrafts: '{bad-B' })
  for (const name of ['profileEnvironmentDrafts', 'browserProxyLibraryDrafts'] as const) await expect(f.document.load(name, raw => { JSON.parse(raw!) })).rejects.toThrow()
  expect(f.document.pending()).toBe(false)
  expect(f.document.hasReadFailure()).toBe(true)
  const repair = async (name: string) => { const value = await f.saved(); value.desktopFragments[name] = '{}'; await f.user.write(JSON.stringify(value)) }
  await repair('browserProxyLibraryDrafts'); await f.document.load('browserProxyLibraryDrafts', raw => { JSON.parse(raw!) })
  expect(f.document.hasReadFailure()).toBe(true)
  await repair('profileEnvironmentDrafts'); await f.document.load('profileEnvironmentDrafts', raw => { JSON.parse(raw!) })
  expect(f.document.hasReadFailure()).toBe(false)
  expect(f.document.pending()).toBe(false)
})

async function desktop(fragments: Record<string, unknown> = {}) {
  const f = await native(fragments), { useAppStore: store, prepareRendererUpdate } = await import('../src/renderer/src/store')
  await f.user.write(JSON.stringify({ state: { agentComposerDrafts: { 'original-region': 'Original unsent draft' } }, version: 1, desktopFragments: fragments }))
  const { api } = await import('../src/renderer/src/lib/api'), { desktopUserDocument } = await import('../src/renderer/src/lib/desktop-user-state')
  documents.push(desktopUserDocument)
  const { AgentMuxSpatialStateStore } = await import('@agentmux/core/spatial-state')
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
  const { createWorkspaceLayout } = await import('@agentmux/layout')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state')
  const config: any = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private pending review' }], executors: {},
    workspaces: [{ id: 'original-workspace', name: 'Private', hostId: 'local', path: f.root, kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: any = { id: 'original-agent', kind: 'agent', providerId: 'codex', executorId: 'original-executor', hostId: 'local', workspacePath: f.root, label: 'Original Agent', createdAt: 1, updatedAt: 1,
    processState: 'running', agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null, status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-agent', run: { runId: 'original-run' } } }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', workspaceId: 'original-workspace', sessionId: session.id, phase: 'attached' })
  store.setState({ config, tabs: { [tab.id]: tab }, layouts: { 'original-workspace': createWorkspaceLayout('original-group', [tab.id]) }, sessions: [session], activeWorkspaceId: 'original-workspace' })
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'spatial.json')); await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => f.user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => f.user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => f.user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await f.user.read() })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout()); vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener)); vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  dispose = await store.getState().initialize(); await prepareRendererUpdate('quit')
  const renderer = { kind: 'bundled', id: 'b'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-runtime' } } as const
  const inspect = async () => {
    const result = await inspectDesktopClient({ schemaVersion: 5, requestId: 'original-pending-observation', operation: 'inspect.client' }, {
      pid: 123, package: null, renderer: () => renderer, generation: () => 1, runtimes: () => [], execute: request => store.getState().executeControl(request),
      storage: async () => ({ ...await observeWorkbenchUserState(f.user), spatialRevision: (await spatial.readForLayout())?.revision ?? null }) })
    if (result.operation !== 'inspect.client') throw Error('Original observation did not answer its request')
    return parseDesktopClientObservation(result.observation)
  }
  return { ...f, store, api, document: desktopUserDocument, prepareRendererUpdate, inspect }
}

it('real root-save recovery clears its warning without consuming unused settings', async () => {
  const f = await desktop()
  expect((await f.inspect()).workbench.persistence?.userStatePending).toBe(false)
  expect(f.document.isReady('profileEnvironmentDrafts')).toBe(false)
  vi.mocked(f.api.ui.writeWorkbenchState).mockRejectedValueOnce(Error('Original native write unconfirmed'))
  await expect(f.prepareRendererUpdate('quit')).rejects.toThrow('Original native write unconfirmed')
  expect(f.store.getState().workbenchSaveWarning).toBeTruthy()
  await f.prepareRendererUpdate('quit')
  expect(f.store.getState().workbenchSaveWarning).toBeNull()
  expect((await f.inspect()).workbench.persistence?.userStatePending).toBe(false)
  expect((await f.saved()).state.agentComposerDrafts['original-region']).toBe('Original unsent draft')
})

it('real root ACK cannot clear legacy custody warning; the original settings reader and ACK resolve it in-band', async () => {
  const f = await desktop(), raw = JSON.stringify({ schema: 'agentmux.profile-environment-drafts.v1', profiles: {} })
  localStorage.setItem(DESKTOP_FRAGMENT_KEYS.profileEnvironmentDrafts, raw)
  f.store.getState().reportWorkbenchSaveFailure(Error('Original legacy input remains unconfirmed'), 'local-storage')
  await f.prepareRendererUpdate('quit')
  expect(f.document.pending()).toBe(true)
  expect((await f.inspect()).workbench.persistence?.userStatePending).toBe(true)
  expect(f.store.getState().workbenchSaveWarning).toContain('Original legacy input')
  expect(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.profileEnvironmentDrafts)).toBe(raw)
  const { profileEnvironmentDrafts } = await import('../src/renderer/src/lib/browser-profile-environment-drafts')
  await profileEnvironmentDrafts.load(); await f.prepareRendererUpdate('quit')
  expect(f.document.pending()).toBe(false)
  expect((await f.inspect()).workbench.persistence?.userStatePending).toBe(false)
  expect(f.store.getState().workbenchSaveWarning).toBeNull()
  expect(localStorage.getItem(DESKTOP_FRAGMENT_KEYS.profileEnvironmentDrafts)).toBeNull()
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  expect((await f.saved()).state.agentComposerDrafts['original-region']).toBe('Original unsent draft')
})

it('repairing member B cannot clear the real read warning for A through an unrelated root ACK', async () => {
  const f = await desktop({ profileEnvironmentDrafts: '{bad-A', browserProxyLibraryDrafts: '{bad-B' })
  let originalA: unknown
  for (const name of ['profileEnvironmentDrafts', 'browserProxyLibraryDrafts'] as const) {
    try { await f.document.load(name, raw => { JSON.parse(raw!) }); throw Error('Original invalid member unexpectedly parsed') }
    catch (error) { expect(error).toBeInstanceOf(SyntaxError); if (name === 'profileEnvironmentDrafts') originalA = error }
  }
  expect(f.document.pending()).toBe(false)
  expect((await f.inspect()).workbench.persistence?.userStatePending).toBe(false)
  f.store.getState().reportWorkbenchSaveFailure(originalA, 'local-storage')
  const originalWarning = f.store.getState().workbenchSaveWarning
  const repair = async (name: 'profileEnvironmentDrafts' | 'browserProxyLibraryDrafts') => {
    const value = await f.saved(); value.desktopFragments[name] = '{}'; await f.user.write(JSON.stringify(value))
    await f.document.load(name, raw => { JSON.parse(raw!) })
  }
  await repair('browserProxyLibraryDrafts'); await f.prepareRendererUpdate('quit')
  expect(f.document.hasReadFailure()).toBe(true)
  expect(f.document.pending()).toBe(false)
  expect((await f.inspect()).workbench.persistence?.userStatePending).toBe(false)
  expect(f.store.getState().workbenchSaveWarning).toBe(originalWarning)
  await repair('profileEnvironmentDrafts'); await f.prepareRendererUpdate('quit')
  expect(f.document.hasReadFailure()).toBe(false)
  expect(f.store.getState().workbenchSaveWarning).toBeNull()
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  expect((await f.saved()).state.agentComposerDrafts['original-region']).toBe('Original unsent draft')
})
