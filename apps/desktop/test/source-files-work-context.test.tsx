// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxControlServer, connectAgentMuxRpc, readSpaceSnapshot } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { sourceFilesHosts } from './helpers/source-files-hosts'
import { sourceFilesIpcBridge } from './helpers/source-files-ipc-bridge'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import type { AppConfig } from '../src/shared/contracts'
vi.mock('electron', () => ({ app: { getPath: () => 'unused-private-app-root' } }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

async function fixture() {
  vi.resetModules(); window.localStorage.clear(); vi.stubGlobal('crypto', webcrypto)
  const hosts = await sourceFilesHosts(cleanup), source = hosts.sources[1]!
  hosts.routes.set('local', hosts.routes.get(source.id)!)
  const bridge = sourceFilesIpcBridge(hosts.runtime, cleanup)
  const inspected = await source.rpc.call('space.folder.inspect', { runtimeId: source.identity.runtimeId, path: source.project })
  const saved = await source.rpc.call('space.folder.register', { runtimeId: source.identity.runtimeId, directory: inspected.resource! })
  const snapshot = await readSpaceSnapshot(source.rpc, saved.reference)
  const zone = snapshot.scope.zones.find(item => item.zoneId === saved.zoneId)!
  await source.rpc.call('space.apply', { reference: saved.reference, expectedRevision: snapshot.revision, changes: {
    zones: [{ ...zone, zoneId: 'other-working-position' }],
    bindings: [...snapshot.scope.bindings, { spaceId: saved.reference.spaceId, zoneId: 'other-working-position' }]
  } })
  await writeFile(join(source.project, 'next.txt'), 'Another file in the original resource')
  const { api } = await import('../src/renderer/src/lib/api')
  const { useAppStore: store, currentCoreSpatialGraph } = await import('../src/renderer/src/store')
  const workspace = { id: saved.workspaceId, hostId: 'local', path: source.project, name: 'Original project', kind: 'folder' as const }
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private original Source' }], executors: {}, workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const initial = store.getState(); cleanup.push(() => store.setState(initial, true))
  store.setState({ config, tabs: {}, documents: {}, layouts: { [workspace.id]: createWorkspaceLayout('file-group', []) }, activeWorkspaceId: workspace.id })
  const spatial = new AgentMuxSpatialStateStore(join(hosts.root, 'desktop-spatial.json'))
  const originalGraph = await new AgentMuxSpatialStateStore(join(source.state, 'spatial.json')).read()
  await spatial.commit({ expectedRevision: 0, graph: originalGraph!.graph })
  const user = new WorkbenchUserStateStore(join(hosts.root, 'desktop-user.json'))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  vi.spyOn(api.sourceFiles, 'resolve').mockImplementation(bridge.files.resolve)
  vi.spyOn(api.sourceFiles, 'call').mockImplementation(bridge.files.call)
  vi.spyOn(api.sourceFiles, 'watch').mockImplementation(bridge.files.watch)
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(bridge.spaces.call)
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  cleanup.push(await store.getState().initialize())
  await vi.waitFor(() => expect(currentCoreSpatialGraph()?.zones.some(item => item.zoneId === 'other-working-position')).toBe(true))
  store.setState({ layouts: { [workspace.id]: createWorkspaceLayout('file-group', []) }, workbenchSpaceSelection: { spaceId: saved.reference.spaceId, zoneId: saved.zoneId, workspaceId: workspace.id,
    topicId: null, tabId: null, regionId: null, groupId: null }, sourceFilesInputs: { selections: {}, pending: {}, creations: {}, folderRequests: {} } })
  const control = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation() {}, sendRequest(request) {
    void store.getState().executeControl(request).then(result => control.accept({ requestId: request.requestId, ok: true, result }),
      error => control.accept({ requestId: request.requestId, ok: false, error: { code: 'CONTROL_FAILED', message: String(error) } }))
  } })
  cleanup.push(() => control.dispose())
  const server = new AgentMuxControlServer({ execute: (request, _name, context) => control.execute(request, context?.signal) }, join(hosts.root, 'desktop-control.sock'))
  await server.start(); cleanup.push(() => server.stop())
  const publicApi = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => publicApi.dispose())
  return { ...hosts, source, saved, workspace, store, api, bridge, publicApi,
    focus: (zoneId: string) => publicApi.call('app.focus', { target: { kind: 'space', spaceId: saved.reference.spaceId, zoneId }, inputPolicy: 'preserve' }) }
}

it.each([false, true])('public Work navigation changes Files while an opened document retains its original Source; visible consumer=%s', async automatic => {
  const f = await fixture(), id = f.workspace.id
  await expect(f.store.getState().resolveFilesSource(id)).resolves.toMatchObject({ status: 'located', locator: { mount: { zoneId: f.saved.zoneId } } })
  await f.store.getState().openFile('original.txt', 'file-group', undefined, id)
  const original = f.store.getState().documents[id + '\0original.txt']!
  expect(original, JSON.stringify({ layouts: f.store.getState().layouts[id], error: f.store.getState().error, tabs: Object.keys(f.store.getState().tabs) })).toBeDefined()
  expect(original.readSource?.query.zoneId).toBe(f.saved.zoneId)
  if (automatic) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const { SourceFilesAccess } = await import('../src/renderer/src/components/SourceFilesAccess')
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
    cleanup.push(async () => { await act(async () => root.unmount()); container.remove() })
    await act(async () => root.render(createElement(SourceFilesAccess, { workspace: f.workspace, visible: true })))
  }
  const result = await f.focus('other-working-position')
  expect(result.navigation.selection.space?.zoneId).toBe('other-working-position')
  if (automatic) await vi.waitFor(() => expect(f.store.getState().sourceFilesInputs.selections[id]?.locator?.mount.zoneId).toBe('other-working-position'))
  else await expect(f.store.getState().resolveFilesSource(id)).resolves.toMatchObject({ status: 'located', locator: { mount: { zoneId: 'other-working-position' } } })
  const { readWorkspaceDirectory } = await import('../src/renderer/src/lib/source-files-discovery')
  expect((await readWorkspaceDirectory(id, '', f.store.getState)).entries.map(entry => entry.name)).toContain('next.txt')
  expect(f.api.sourceFiles.call).toHaveBeenLastCalledWith(expect.anything(), 'file.list', expect.objectContaining({ zoneId: 'other-working-position', mode: 'directory' }))
  await f.store.getState().openFile('next.txt', 'file-group', undefined, id)
  expect(f.store.getState().documents[id + '\0next.txt']?.readSource?.query.zoneId).toBe('other-working-position')
  expect(f.store.getState().documents[id + '\0original.txt']).toBe(original)
  await f.store.getState().refreshDocument(id, 'original.txt')
  expect(f.store.getState().documents[id + '\0original.txt']?.readSource).toEqual(original.readSource)
  expect(vi.mocked(f.api.sourceFiles.call).mock.calls.filter(call => call[1] === 'file.read').at(-1)?.[2]).toMatchObject({ zoneId: f.saved.zoneId })
  const tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  f.store.getState().updateDocument(tab.id, 'Edited original document after Work navigation')
  await f.store.getState().saveDocument(tab.id)
  expect(vi.mocked(f.api.sourceFiles.call).mock.calls.filter(call => call[1] === 'file.write').at(-1)?.[2]).toMatchObject({ zoneId: f.saved.zoneId })
  expect(await readFile(join(f.source.project, 'original.txt'), 'utf8')).toBe('Edited original document after Work navigation')
  expect(f.store.getState().documents[id + '\0original.txt']?.readSource).toEqual(original.readSource)
}, 60000)

it('a late Files observation cannot replace a later public Work choice and true ambiguity never selects a first Source', async () => {
  const f = await fixture(), id = f.workspace.id
  await f.store.getState().resolveFilesSource(id)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(yes => { release = yes }), started = new Promise<void>(yes => { entered = yes })
  cleanup.push(() => release())
  vi.mocked(f.api.sourceFiles.resolve).mockImplementationOnce(async (...args) => {
    const result = await f.bridge.files.resolve(...args); entered(); await gate; return result
  })
  const pending = f.store.getState().resolveFilesSource(id)
  await started
  const heldSelection = f.store.getState().sourceFilesInputs.selections[id]
  await f.focus('other-working-position')
  release()
  await expect(pending).resolves.toMatchObject({ status: 'unconfirmed', issue: { code: 'SOURCE_FILES_SELECTION_CHANGED' } })
  expect(f.store.getState().sourceFilesInputs.selections[id]).toBe(heldSelection)
  await expect(f.store.getState().resolveFilesSource(id)).resolves.toMatchObject({ status: 'located', locator: { mount: { zoneId: 'other-working-position' } } })
  expect(f.store.getState().workbenchSpaceSelection?.zoneId).toBe('other-working-position')
  f.store.setState(state => ({ workbenchSpaceSelection: null, sourceFilesInputs: { ...state.sourceFilesInputs, selections: {} } }))
  await expect(f.store.getState().resolveFilesSource(id)).resolves.toMatchObject({ status: 'selection-required', registrations: expect.any(Array) })
  expect(f.store.getState().sourceFilesInputs.selections[id]).toBeUndefined()
}, 60000)

it('changing Work preserves an unconfirmed original folder registration without replaying it', async () => {
  const f = await fixture(), id = f.workspace.id
  await f.store.getState().resolveFilesSource(id)
  const inspected = await f.source.rpc.call('space.folder.inspect', { runtimeId: f.source.identity.runtimeId, path: f.source.project })
  const packet = { runtimeId: f.source.identity.runtimeId, directory: inspected.resource! }
  await expect(f.store.getState().useFilesSourceFolder(id, packet)).rejects.toThrow('Several original Folder resources')
  expect(f.store.getState().sourceFilesInputs.selections[id]?.registrationStatus).toBe('unknown')
  const calls = vi.mocked(f.api.spaceMounts.call).mock.calls.filter(call => call[0] === 'register').length
  await f.focus('other-working-position')
  await expect(f.store.getState().resolveFilesSource(id)).resolves.toMatchObject({ status: 'located', locator: { mount: { zoneId: 'other-working-position' } } })
  expect(Object.values(f.store.getState().sourceFilesInputs.folderRequests)).toEqual([expect.objectContaining({ packet })])
  expect(vi.mocked(f.api.spaceMounts.call).mock.calls.filter(call => call[0] === 'register')).toHaveLength(calls)
  expect(f.store.getState().sourceFilesInputs.pending).toEqual({})
}, 60000)
