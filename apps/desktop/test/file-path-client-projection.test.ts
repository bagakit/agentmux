// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { act, createElement, Fragment, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteFileWriter } from '../../host/src/note-file-writer.js'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state.js'
import { OrdinaryWorkspaceFiles } from '../../host/src/ordinary-files.js'
import { sourceFilesHosts } from './helpers/source-files-hosts.js'
import { sourceFilesIpcBridge } from './helpers/source-files-ipc-bridge.js'
import { installFileTreeGeometry } from './helpers/file-tree-geometry.js'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import type { AppConfig } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => '/private-unused' } }))
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value, path }: { value: string; path: string }) => process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM ? createElement('textarea', { 'data-native-monaco-paint': path, value, readOnly: true }) : null }))
const native = process.env.AGENTMUX_TEST_FILE_CLIENT_NATIVE === '1'
const restartMode = process.env.AGENTMUX_TEST_FILE_CLIENT_RESTART
const business = native && !restartMode
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it.runIf(!native)('runs the shipping UserState consumer in its own private process', async () => {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.file-path-client.config.mts', '--maxWorkers=1'], {
    cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, AGENTMUX_TEST_FILE_CLIENT_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise<number | null>((yes, no) => { child.once('error', no); child.once('close', yes) })
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_EVIDENCE) await writeFile(join(process.env.AGENTMUX_TEST_FILE_CLIENT_EVIDENCE, 'native-business.log'), log)
  expect(code, log).toBe(0); expect(log).toMatch(/[1-9]\d* passed/)
}, 180000)

async function fixture(options: { sharedProject?: boolean; scratch?: boolean } = {}, existing?: Awaited<ReturnType<typeof sourceFilesHosts>>) {
  vi.resetModules(); window.localStorage.clear(); vi.stubGlobal('crypto', webcrypto)
  const f = existing ?? await sourceFilesHosts(cleanup, options), source = f.sources[1]!, bridge = sourceFilesIpcBridge(f.runtime, cleanup)
  const { api } = await import('../src/renderer/src/lib/api.js'), { useAppStore: store } = await import('../src/renderer/src/store.js')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state.js')
  const workspace = { id: 'display-files', hostId: source.id, path: source.project, name: 'Source Files', kind: 'folder' as const }
  const config = { version: 9, hosts: [{ id: source.id, kind: 'local', label: 'Private Source carrier' }], executors: {}, workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } } as AppConfig
  store.setState({ config, tabs: {}, documents: {}, layouts: { [workspace.id]: createWorkspaceLayout('file-group', []) }, activeWorkspaceId: workspace.id })
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'desktop-spatial.json'))
  if (!await spatial.read()) await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  const user = new WorkbenchUserStateStore(join(f.root, 'desktop-user.json'))
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
  let watchReady = false
  vi.spyOn(api.sourceFiles, 'watch').mockImplementation(async (...args) => { const reader = await bridge.files.watch(...args); return { ...reader, start: async () => { await reader.start(); watchReady = true } } })
  const mount = bridge.spaces.call
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, value, signal) => {
    if (method === 'register') {
      const saved = JSON.parse((await user.read())!).state as any
      expect(saved.sourceFilesInputs.selections[workspace.id].registration).toEqual((value as any).registration)
    }
    return await mount(method, value, signal)
  })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  const dispose = await store.getState().initialize(); cleanup.push(dispose)
  return { ...f, source, bridge, api, store, workspace, user, watchReady: () => watchReady }
}

async function visualScene(f: Awaited<ReturnType<typeof fixture>>, name: string, title: string, extra?: import('react').ReactNode) {
  const out = process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM
  if (!out) return
  const { createClientUiRoot } = await import('./helpers/client-ui-render.js')
  const { installNativePopover } = await import('./fixtures/mote-workface.js'); cleanup.push(installNativePopover())
  const { EditorPane } = await import('../src/renderer/src/components/EditorPane.js'), { SourceFilesAccess } = await import('../src/renderer/src/components/SourceFilesAccess.js')
  const tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file'))!
  const surface = Object.values(tab.regions).find(region => region.kind === 'file')!
  await f.store.getState().setEditorRegionMode(surface.regionId, surface.workspaceId, surface.path, 'edit')
  const element = document.createElement('div'), root = createClientUiRoot(element); document.body.append(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(createElement('main', { 'data-source-scene': name }, createElement('h2', { 'data-scene-title': true }, title),
    createElement(SourceFilesAccess, { workspace: f.workspace, visible: true }), createElement(EditorPane, { tabId: tab.id, surface: surface as any }), extra)))
  await vi.waitFor(() => expect(element.querySelector('[data-native-monaco-paint]')).not.toBeNull())
  await writeFile(join(out, name + '.dom.html'), document.body.innerHTML)
  await writeFile(join(out, name + '.state.json'), JSON.stringify({ sourceCommit: 'qualification candidate', tab, surface,
    document: f.store.getState().documents[f.workspace.id + '\0' + surface.path], issue: f.store.getState().documentIssues[f.workspace.id + '\0' + surface.path], sourceInputs: f.store.getState().sourceFilesInputs }, null, 2))
  return { element, root, async capture(next: string) { await writeFile(join(out, next + '.dom.html'), document.body.innerHTML) } }
}

async function connectCloseOwner(f: Awaited<ReturnType<typeof fixture>>) {
  const { DesktopControlIpcBridge } = await import('../src/main/control-ipc-bridge.js')
  const { createDesktopWorkbenchCloseOwner } = await import('../src/main/workbench-close-owner.js')
  const { spaceCloseDigest } = await import('@agentmux/core')
  let bridge: InstanceType<typeof DesktopControlIpcBridge>
  bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation: () => {}, sendRequest(request) {
    if (!request.operation.startsWith('workbench.close.')) throw new Error('Unexpected private close bridge request')
    void f.store.getState().executeWorkbenchClose(request as import('../src/shared/workbench-close-control.js').WorkbenchCloseRendererRequest).then(result => {
      bridge.accept({ requestId: request.requestId, ok: true, result })
    }, error => { bridge.accept({ requestId: request.requestId, ok: false, error: { code: 'CONTROL_UNAVAILABLE', message: error.message } }) })
  } })
  cleanup.push(() => bridge.dispose())
  const owner = createDesktopWorkbenchCloseOwner({ store: f.user, bridge, runtime: f.runtime, closeBrowser: async () => {},
    authority: () => ({ ownerId: spaceCloseDigest(f.user.path), endpoint: 'private-desktop', documentGeneration: 'private-file-client' }) })
  vi.spyOn(f.api.workbenchClose, 'call').mockImplementation((method, params) => owner.call(method, params, { actor: { kind: 'user', id: 'private-user' } }))
  return owner
}

it.runIf(business)('original Files UI checkpoints the directory packet before registration and CLI delete retains a clean body in actual UserState', async () => {
  const f = await fixture(), { SourceFilesAccess } = await import('../src/renderer/src/components/SourceFilesAccess.js')
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM) {
    const ordinary = new OrdinaryWorkspaceFiles()
    vi.spyOn(f.api.files, 'read').mockImplementation(async (_workspaceId, path) => ordinary.read(f.workspace, path))
    await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  }
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(createElement(SourceFilesAccess, { workspace: f.workspace, visible: true })))
  await vi.waitFor(() => expect(element.textContent).toContain('Use this folder for Files'))
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]).toBeUndefined()
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM) await visualScene(f, 'folder-needed', 'Source Files · choose the original folder')
  const use = [...element.querySelectorAll('button')].find(button => button.textContent === 'Use this folder for Files')!
  await act(async () => use.click())
  await vi.waitFor(() => expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]?.locator).toBeTruthy())
  expect(f.api.spaceMounts.call).toHaveBeenCalledWith('register', expect.objectContaining({ hostId: f.source.id, registration: expect.objectContaining({ runtimeId: f.source.identity.runtimeId }) }))
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM) await f.store.getState().refreshDocument(f.workspace.id, 'original.txt')
  await vi.waitFor(() => expect(f.watchReady()).toBe(true))
  const key = f.workspace.id + '\0original.txt', original = f.store.getState().documents[key]!
  expect(original.readSource?.target).toMatchObject({ hostId: f.source.id, expectedRuntimeId: f.source.identity.runtimeId })
  expect(original.readIdentity?.entry.inode).toBe(String((await stat(join(f.source.project, 'original.txt'), { bigint: true })).ino))
  const locator = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!, resource = locator.resource
  const query = { zoneId: resource.zoneId, path: 'original.txt', expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath }, includeRevision: true }
  const observed = (await f.bridge.files.call({ hostId: locator.mount.hostId, reference: locator.mount.reference }, 'file.stat', query)).result
  if (!observed.resource || observed.result.status !== 'observed' || observed.result.observation.revision?.status !== 'observed') throw new Error('Original stat revision unavailable')
  const o = observed.result.observation, request = { ...query, includeRevision: undefined, operationId: 'outside-delete-original', expectedResource: observed.resource,
    expected: { root: o.root, parent: o.parent, entry: o.entry }, expectedRevision: o.revision.revision }
  delete request.includeRevision
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.source.socketPath, 'file', 'delete', '--input', '-'], objectCliEnvironment(f.source.state), JSON.stringify(request))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  await vi.waitFor(() => expect(f.store.getState().documentIssues[key]?.kind).toBe('deleted'))
  expect(f.store.getState().documents[key]?.content).toBe(original.content)
  expect(f.store.getState().dirtyDocuments[key]).not.toBe(true)
  await vi.waitFor(async () => expect(JSON.parse((await f.user.read())!).state).toMatchObject({ documents: { [key]: { content: original.content } }, documentIssues: { [key]: { kind: 'deleted' } } }))
  await expect(readFile(join(f.source.project, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.sources[0]!.project, 'original.txt'), 'utf8')).toBe('source-a original body')
  const { captureWorkbenchClose } = await import('../src/renderer/src/lib/workbench-close-owner.js')
  const state = f.store.getState(), tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  const frozen = captureWorkbenchClose(state, { operationId: 'clean-deleted-close', target: { kind: 'tab-occurrence', displayWorkspaceId: f.workspace.id, groupId: 'file-group', tabId: tab.id }, keepAgentSessions: true })
  expect(frozen.drafts).toHaveLength(1)
  await visualScene(f, 'deleted-body-kept', 'Source Files · deleted file, editor contents kept')
  await connectCloseOwner(f)
  const { useWorkbenchTabsClose } = await import('../src/renderer/src/hooks/useWorkbenchTabsClose.js')
  const { installNativePopover } = await import('./fixtures/mote-workface.js')
  cleanup.push(installNativePopover())
  const { createClientUiRoot } = await import('./helpers/client-ui-render.js')
  const closeNode = document.createElement('div'); document.body.append(closeNode); const closeRoot = createClientUiRoot(closeNode)
  cleanup.push(async () => { await act(async () => closeRoot.unmount()); closeNode.remove() })
  function CloseConsumer() {
    const close = useWorkbenchTabsClose()
    return createElement('div', null, createElement('button', { onClick: () => void close.request({ workspaceId: f.workspace.id,
      group: { id: 'file-group', tabOrder: [tab.id] }, tabIds: [tab.id], subject: 'Original deleted file' }) }, 'Close retained file'), close.dialog)
  }
  await act(async () => closeRoot.render(createElement(CloseConsumer)))
  await act(async () => closeNode.querySelector<HTMLButtonElement>('button')!.click())
  await vi.waitFor(() => expect(document.body.textContent).toContain('Discard editor contents?'))
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM) await writeFile(join(process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM, 'deleted-discard-confirmation.dom.html'), document.body.innerHTML)
  expect(f.store.getState().tabs[tab.id]).toBeDefined(); expect(f.store.getState().documents[key]?.content).toBe(original.content)
  // The user's old confirmation cannot discard input arriving while the dialog is open.
  f.store.getState().updateDocument(tab.id, 'Later input after the delete confirmation', Object.values(tab.regions).find(region => region.kind === 'file')!.regionId)
  const discard = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Discard & Close')!
  await act(async () => discard.click())
  await vi.waitFor(() => expect(f.store.getState().error).toBeTruthy())
  expect(f.store.getState().tabs[tab.id]).toBeDefined()
  expect(f.store.getState().documents[key]?.content).toBe('Later input after the delete confirmation')
  await expect(readFile(join(f.source.project, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 60000)

async function connectFolder(f: Awaited<ReturnType<typeof fixture>>) {
  const original = await f.store.getState().resolveFilesSource(f.workspace.id)
  if (original.status !== 'registration-required') throw new Error('Original directory packet required')
  expect((await f.store.getState().useFilesSourceFolder(f.workspace.id, original.registration)).status).toBe('located')
}

it.runIf(business)('same-Source copies replace pending directory readers and a new tree root recomputes depth', async () => {
  const f = await fixture(); await connectFolder(f)
  await mkdir(join(f.source.project, 'child')); await writeFile(join(f.source.project, 'child', 'nested.txt'), 'Original nested candidate')
  const { useWorkspaceFileTree } = await import('../src/renderer/src/components/file-tree/useWorkspaceFileTree.js')
  const call = f.bridge.files.call, expanded = new Set<string>(), held: Array<() => void> = []
  let block = true, requests = 0, tree!: ReturnType<typeof useWorkspaceFileTree>, setRoot!: (value: string) => void
  cleanup.push(() => held.splice(0).forEach(release => release()))
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { const reply = await call(...args); if (args[1] === 'file.list') {
    ++requests
    if (block) { block = false; await new Promise<void>(resolve => held.push(resolve)) }
  } return reply })
  const element = document.createElement('div'), root = createRoot(element); document.body.append(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  function Probe() { const [path, update] = useState(''); setRoot = update; tree = useWorkspaceFileTree(f.workspace.id, expanded, path); return null }
  const copyStatus = () => f.store.setState(state => ({ sourceFilesInputs: { ...state.sourceFilesInputs, selections: { ...state.sourceFilesInputs.selections,
    [f.workspace.id]: { ...state.sourceFilesInputs.selections[f.workspace.id]!, issue: 'Original Source observation ended' } } } }))
  await act(async () => root.render(createElement(Probe)))
  await vi.waitFor(() => expect(held.length).toBe(1))
  await act(async () => copyStatus())
  await vi.waitFor(() => expect(tree.rootCache?.loading).toBe(false))
  expect(tree.rootCache?.children.some(entry => entry.name === 'child')).toBe(true); expect(requests).toBe(2)
  held.splice(0).forEach(release => release())
  block = true
  let refreshing!: Promise<boolean>
  await act(async () => { refreshing = tree.refreshDir('') })
  await vi.waitFor(() => expect(held.length).toBe(1))
  await act(async () => copyStatus())
  await vi.waitFor(() => expect(tree.rootCache?.loading).toBe(false))
  expect(tree.rootCache?.children.some(entry => entry.name === 'child')).toBe(true)
  held.splice(0).forEach(release => release()); await refreshing
  await act(async () => { await tree.loadDir('child', { force: true }) })
  expect(tree.dirCache.child?.children[0]?.depth).toBe(1)
  await act(async () => setRoot('child'))
  await vi.waitFor(() => expect(tree.rootCache?.children[0]?.depth).toBe(0))
}, 60000)

it.runIf(business)('a default Source probe remains observation while original Files consumers stay usable', async () => {
  const f = await fixture(), ordinary = new OrdinaryWorkspaceFiles()
  const original = { ...f.workspace, hostId: 'local' }
  await writeFile(join(f.source.project, 'healthy-original.txt'), 'Original readable file')
  const directories = vi.spyOn(f.api.files, 'readDirectory').mockImplementation(async (id, path) => { expect(id).toBe(f.workspace.id); return ordinary.readDirectory(original, path) })
  vi.spyOn(f.api.files, 'list').mockImplementation(async id => { expect(id).toBe(f.workspace.id); return ordinary.listFiles(original) })
  vi.spyOn(f.api.files, 'read').mockImplementation(async (id, path) => { expect(id).toBe(f.workspace.id); return ordinary.read(original, path) })
  await f.store.getState().openFile('healthy-original.txt', 'file-group', undefined, f.workspace.id)
  const documentKey = f.workspace.id + '\0healthy-original.txt', retained = f.store.getState().documents[documentKey]
  let entered!: () => void, release!: () => void
  const enteredProbe = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  cleanup.push(() => release())
  vi.mocked(f.api.sourceFiles.resolve).mockImplementationOnce(async () => { entered(); await gate; return { status: 'unconfirmed', issue: { code: 'CONTROL_UNAVAILABLE', message: 'Original Source probe unavailable' } } })
  const { SourceFilesAccess } = await import('../src/renderer/src/components/SourceFilesAccess.js')
  const { useWorkspaceFileTree } = await import('../src/renderer/src/components/file-tree/useWorkspaceFileTree.js')
  const { QuickOpenFiles } = await import('../src/renderer/src/components/QuickOpenFiles.js')
  let tree!: ReturnType<typeof useWorkspaceFileTree>
  const expanded = new Set<string>(), element = document.createElement('div'), root = createRoot(element); document.body.append(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  function Probe() { tree = useWorkspaceFileTree(f.workspace.id, expanded); return createElement(Fragment, null,
    createElement(SourceFilesAccess, { workspace: f.workspace, visible: true }), createElement(QuickOpenFiles, { onClose() {} })) }
  await act(async () => root.render(createElement(Probe)))
  await enteredProbe
  await act(async () => { await tree.refreshDir('') })
  expect(tree.rootCache?.children.some(entry => entry.name === 'healthy-original.txt')).toBe(true)
  expect(tree.rootError).toBeNull()
  await vi.waitFor(() => expect(element.textContent).toContain('healthy-original.txt'))
  await act(async () => release())
  await vi.waitFor(() => expect(element.textContent).toContain('Original Source probe unavailable'))
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]).toBeUndefined()
  await act(async () => { await tree.refreshDir('') })
  expect(tree.rootError).toBeNull(); expect(directories.mock.calls.length).toBeGreaterThan(0)
  expect(f.store.getState().documents[documentKey]).toBe(retained)
  expect(retained?.content).toBe('Original readable file')
  vi.mocked(f.api.sourceFiles.resolve).mockRejectedValueOnce(new Error('Original Source transport unavailable'))
  await expect(f.store.getState().resolveFilesSource(f.workspace.id)).rejects.toThrow('transport unavailable')
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]).toBeUndefined()
  await act(async () => { await tree.refreshDir('') }); expect(tree.rootError).toBeNull()
}, 60000)

it.runIf(business)('the real Explorer keeps reserved Scratch out of ordinary folder rebind while normal Folder recovery stays available', async () => {
  const f = await fixture(), { FileExplorer } = await import('../src/renderer/src/components/FileExplorer.js')
  installFileTreeGeometry()
  vi.spyOn(f.api.files, 'readDirectory').mockRejectedValue(new Error('Original directory unavailable'))
  const rebind = vi.spyOn(f.api.workspaces, 'rebindLocalFolder')
  const scratch = { ...f.workspace, id: '__scratch__', hostId: 'local' }
  f.store.setState(state => ({ config: { ...state.config!, workspaces: [scratch, f.workspace] } }))
  const element = document.createElement('div'), root = createRoot(element); document.body.append(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(createElement(FileExplorer, { workspaceId: scratch.id, active: true })))
  await vi.waitFor(() => expect(element.textContent).toContain('Could not read workspace'))
  expect([...element.querySelectorAll('button')].some(button => button.textContent === 'Retry')).toBe(true)
  expect(element.textContent).not.toContain('Choose new folder'); expect(rebind).not.toHaveBeenCalled()
  const folder = { ...f.workspace, hostId: 'local' }
  f.store.setState(state => ({ config: { ...state.config!, workspaces: [scratch, folder] } }))
  await act(async () => root.render(createElement(FileExplorer, { workspaceId: folder.id, active: true })))
  await vi.waitFor(() => expect(element.textContent).toContain('Choose new folder'))
}, 60000)

it.runIf(business)('a failed Source re-observation retains its locator and reads only the original selected Source', async () => {
  const f = await fixture(); await connectFolder(f)
  const retained = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator
  const main = vi.spyOn(f.api.files, 'readDirectory').mockRejectedValue(new Error('Another Main must not be read'))
  vi.mocked(f.api.sourceFiles.resolve).mockResolvedValueOnce({ status: 'unconfirmed', issue: { code: 'CONTROL_UNAVAILABLE', message: 'Original directory probe unavailable' } })
  await expect(f.store.getState().resolveFilesSource(f.workspace.id)).resolves.toMatchObject({ status: 'unconfirmed' })
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]).toMatchObject({ locator: retained, issue: 'Original directory probe unavailable' })
  const { readWorkspaceDirectory } = await import('../src/renderer/src/lib/source-files-discovery.js')
  const actual = await readWorkspaceDirectory(f.workspace.id, '', f.store.getState)
  expect(actual.entries.some(entry => entry.name === 'original.txt')).toBe(true)
  expect(main).not.toHaveBeenCalled()
  expect(f.api.sourceFiles.call).toHaveBeenCalledWith(expect.anything(), 'file.list', expect.objectContaining({ expectedResource: expect.objectContaining({ workspacePath: f.workspace.path }) }))
}, 60000)

it.runIf(business)('a held unknown Source request cannot select Main while its presentation selection is unavailable', async () => {
  const f = await fixture(); await connectFolder(f)
  const selected = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!, call = f.bridge.files.call
  let writes = 0
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => {
    const response = await call(...args)
    if (args[1] === 'file.mkdir') { writes++; throw new Error('Original mkdir reply lost') }
    return response
  })
  await expect(f.store.getState().createPath({ kind: 'directory', path: 'held-original-directory' }, f.workspace.id)).rejects.toThrow('Original mkdir reply lost')
  const pending = f.store.getState().sourceFilesInputs.pending, operationIds = Object.keys(pending)
  expect(operationIds).toHaveLength(1); expect((await stat(join(f.source.project, 'held-original-directory'))).isDirectory()).toBe(true)
  f.store.setState(state => ({ sourceFilesInputs: { ...state.sourceFilesInputs, selections: {} } }))
  const mainNames = vi.spyOn(f.api.files, 'list'), mainDirectories = vi.spyOn(f.api.files, 'readDirectory')
  const { listWorkspaceFileNames, readWorkspaceDirectory } = await import('../src/renderer/src/lib/source-files-discovery.js')
  await expect(listWorkspaceFileNames(f.workspace.id, f.store.getState)).rejects.toThrow('original Source directory')
  await expect(readWorkspaceDirectory(f.workspace.id, '', f.store.getState)).rejects.toThrow('original Source directory')
  expect(mainNames).not.toHaveBeenCalled(); expect(mainDirectories).not.toHaveBeenCalled()
  expect(f.store.getState().sourceFilesInputs.pending).toBe(pending)
  // A later explicit Workspace resource is independent of the old request; sharing an ID cannot merge roots.
  const nextRoot = join(f.root, 'another-display-root'); await mkdir(nextRoot); await writeFile(join(nextRoot, 'new-root.txt'), 'Independent exact resource')
  const ordinary = new OrdinaryWorkspaceFiles()
  mainNames.mockImplementation(async id => ordinary.listFiles({ id, hostId: 'local', path: nextRoot }))
  f.store.setState(state => ({ config: { ...state.config!, workspaces: [{ ...f.workspace, path: nextRoot }] } }))
  expect((await listWorkspaceFileNames(f.workspace.id, f.store.getState)).files).toContain('new-root.txt')
  expect(f.store.getState().sourceFilesInputs.pending).toBe(pending)
  f.store.setState(state => ({ config: { ...state.config!, workspaces: [f.workspace] }, sourceFilesInputs: { ...state.sourceFilesInputs, selections: { [f.workspace.id]: selected } } }))
  await f.store.getState().inspectFilesMutation(operationIds[0]!)
  expect(f.api.sourceFiles.call).toHaveBeenLastCalledWith(selected.target, 'file.mutation.inspect', expect.objectContaining({ operationId: operationIds[0], expectedResource: pending[operationIds[0]!]!.request.expectedResource }))
  const held = f.store.getState().sourceFilesInputs.pending[operationIds[0]!]
  if (held) { expect(held.request).toEqual(pending[operationIds[0]!]!.request); expect(held.target).toEqual(pending[operationIds[0]!]!.target) }
  expect(writes).toBe(1)
}, 60000)

it.runIf(business)('Source Explorer and Quick Open discover original Native candidates including empty directories without a Main alias', async () => {
  const f = await fixture(); await connectFolder(f)
  await mkdir(join(f.source.project, 'empty-source-folder')); await writeFile(join(f.source.project, 'source-only.txt'), 'Original Source candidate')
  await writeFile(join(f.sources[0]!.project, 'wrong-main-alias.txt'), 'Another actual Source candidate')
  await symlink('source-only.txt', join(f.source.project, 'source-link'))
  const ordinary = new OrdinaryWorkspaceFiles(), wrong = { id: 'wrong-alias', hostId: 'local', path: f.sources[0]!.project }
  const mainDirectories = vi.spyOn(f.api.files, 'readDirectory').mockImplementation(async (_id, path) => ordinary.readDirectory(wrong, path))
  const mainNames = vi.spyOn(f.api.files, 'list').mockImplementation(async () => ordinary.listFiles(wrong))
  const { useWorkspaceFileTree } = await import('../src/renderer/src/components/file-tree/useWorkspaceFileTree.js')
  const { QuickOpenFiles } = await import('../src/renderer/src/components/QuickOpenFiles.js')
  let tree!: ReturnType<typeof useWorkspaceFileTree>
  const expanded = new Set<string>(), element = document.createElement('div'), root = createRoot(element); document.body.append(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  function Probe() { tree = useWorkspaceFileTree(f.workspace.id, expanded); return createElement(QuickOpenFiles, { onClose() {} }) }
  await act(async () => root.render(createElement(Probe)))
  await vi.waitFor(() => expect(tree.rootCache?.children).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'empty-source-folder', isDirectory: true }), expect.objectContaining({ name: 'source-link', isSymlink: true })
  ])))
  await vi.waitFor(() => expect(element.textContent).toContain('source-only.txt'))
  expect(element.textContent).not.toContain('wrong-main-alias.txt'); expect(mainDirectories).not.toHaveBeenCalled(); expect(mainNames).not.toHaveBeenCalled()
  const locator = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!, r = locator.resource
  const flags = ['--endpoint', 'unix:' + f.source.socketPath, 'file', 'ls', '--zone', r.zoneId, '--host', r.hostId, '--workspace', r.workspaceId, '--workspace-path', r.workspacePath]
  const cli = await runCompiledObjectCli([...flags, '--directory'], objectCliEnvironment(f.source.state))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.result).toMatchObject({ status: 'directory-listed', complete: true, entries: expect.arrayContaining([expect.objectContaining({ name: 'empty-source-folder', isDirectory: true })]) })
  const bounded = await runCompiledObjectCli([...flags, '--directory', '--limit', '1'], objectCliEnvironment(f.source.state))
  expect(bounded.code, bounded.stdout + bounded.stderr).toBe(0); expect(JSON.parse(bounded.stdout).result.result).toMatchObject({ status: 'directory-listed', complete: false, partialReason: 'limit', entries: [expect.anything()] })
  const names = await runCompiledObjectCli(flags, objectCliEnvironment(f.source.state))
  expect(names.code, names.stdout + names.stderr).toBe(0); expect(JSON.parse(names.stdout).result.result).toMatchObject({ status: 'listed', files: expect.arrayContaining(['source-only.txt']) })
  const call = f.bridge.files.call
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { if (args[1] === 'file.list') throw new Error('Original Source discovery unavailable'); return call(...args) })
  await act(async () => { await tree.refreshDir('') })
  expect(tree.rootCache?.children.some(entry => entry.name === 'empty-source-folder')).toBe(true); expect(tree.rootError).toContain('unavailable')
  await act(async () => f.store.setState(state => ({ sourceFilesInputs: { ...state.sourceFilesInputs, selections: { ...state.sourceFilesInputs.selections,
    [f.workspace.id]: { ...state.sourceFilesInputs.selections[f.workspace.id]!, issue: 'Original Source live observation ended' } } } })))
  await vi.waitFor(() => expect(element.textContent).toContain('Original Source discovery unavailable'))
  expect(element.textContent).toContain('source-only.txt'); expect(tree.rootCache?.children.some(entry => entry.name === 'empty-source-folder')).toBe(true)
  expect(mainDirectories).not.toHaveBeenCalled(); expect(mainNames).not.toHaveBeenCalled()
}, 60000)

it.runIf(business)('a late Source candidate reply cannot survive a new original selection or fall back to Main', async () => {
  const f = await fixture(); await connectFolder(f)
  const { listWorkspaceFileNames } = await import('../src/renderer/src/lib/source-files-discovery.js')
  const call = f.bridge.files.call, main = vi.spyOn(f.api.files, 'list')
  let entered!: () => void, release!: () => void
  const held = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  cleanup.push(() => release())
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { const result = await call(...args); if (args[1] === 'file.list') { entered(); await gate } return result })
  const pending = listWorkspaceFileNames(f.workspace.id, f.store.getState), refused = expect(pending).rejects.toThrow('original Source directory')
  await held
  expect((await f.store.getState().resolveFilesSource(f.workspace.id)).status).toBe('located')
  release(); await refused; expect(main).not.toHaveBeenCalled()
}, 60000)

it.runIf(business)('Source candidate scopes change during render before passive cleanup and stale clicks cannot open another actual Source', async () => {
  const f = await fixture({ sharedProject: true }); await connectFolder(f)
  installFileTreeGeometry()
  await writeFile(join(f.source.project, 'original-candidate.txt'), 'Shared physical bytes, original Source namespace')
  const a = f.sources[0]!, target = { hostId: a.id, expectedRuntimeId: a.identity.runtimeId }, selection = { kind: 'directory' as const, path: a.project }
  const needed = await f.runtime.resolveSourceFiles(target, selection)
  if (needed.status !== 'registration-required') throw new Error('The independent Source must require its own original registration')
  await f.runtime.registerFolderSpace(a.id, needed.registration)
  const resolved = await f.runtime.resolveSourceFiles(target, selection)
  if (resolved.status !== 'located') throw new Error('The actual independent Source locator is required')
  const { QuickOpenFiles } = await import('../src/renderer/src/components/QuickOpenFiles.js')
  const { FileExplorer } = await import('../src/renderer/src/components/FileExplorer.js')
  const opened = vi.spyOn(f.store.getState(), 'openFileAndReveal').mockResolvedValue(true), frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  const element = document.createElement('div'), root = createRoot(element); document.body.append(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  let changedLayout = false
  function Probe() {
    const input = f.store(state => state.sourceFilesInputs.selections[f.workspace.id])
    useLayoutEffect(() => {
      if (input?.target.hostId !== a.id) return
      changedLayout = true
      expect([...element.querySelectorAll('[role="option"], .tree-row__label')].some(node => node.textContent?.includes('original-candidate.txt'))).toBe(false)
      element.querySelector('[aria-label="Find project files"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }, [input])
    return createElement(Fragment, null, createElement(QuickOpenFiles, { onClose() {} }), createElement(FileExplorer, { workspaceId: f.workspace.id }))
  }
  await act(async () => root.render(createElement(Probe)))
  await vi.waitFor(() => expect([...element.querySelectorAll('[role="option"]')].some(node => node.textContent?.includes('original-candidate.txt'))).toBe(true))
  await vi.waitFor(() => expect([...element.querySelectorAll('.tree-row__label')].some(node => node.textContent?.includes('original-candidate.txt'))).toBe(true))
  await act(async () => (element.querySelector('[role="option"]') as HTMLButtonElement).click())
  expect(frames.length).toBeGreaterThan(0)
  const nextWorkspace = { ...f.workspace, hostId: a.id, path: a.project }
  await act(async () => f.store.setState(state => ({ config: { ...state.config!, workspaces: [nextWorkspace] }, sourceFilesInputs: { ...state.sourceFilesInputs,
    selections: { ...state.sourceFilesInputs.selections, [f.workspace.id]: { workspace: nextWorkspace, target, selection, locator: resolved.locator } } } })))
  expect(changedLayout).toBe(true)
  await act(async () => { frames.splice(0).forEach(callback => callback(0)) })
  expect(opened).not.toHaveBeenCalled()
}, 60000)

it.runIf(business)('original GUI mkdir, file creation, directory move and delete consume Source receipts once while keeping the same draft and View identities', async () => {
  const f = await fixture(); await connectFolder(f)
  await mkdir(join(f.source.project, 'drafts')); await writeFile(join(f.source.project, 'drafts', 'child.txt'), 'Original nested body')
  await f.store.getState().openFile('drafts/child.txt', 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0drafts/child.txt', initial = f.store.getState()
  const tab = Object.values(initial.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'drafts/child.txt'))!
  const regionId = Object.values(tab.regions).find(region => region.kind === 'file')!.regionId
  f.store.getState().updateDocument(tab.id, 'Original unsaved nested draft', regionId)
  const originalCall = f.bridge.files.call, mutations: string[] = []
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (target, method, request, signal) => {
    if (method === 'file.mkdir' || method === 'file.move' || method === 'file.delete') {
      const pending = JSON.parse((await f.user.read())!).state.sourceFilesInputs.pending
      expect(Object.values(pending).some((item: any) => JSON.stringify(item.request) === JSON.stringify(request))).toBe(true)
      mutations.push(method)
    }
    return await originalCall(target, method, request, signal)
  })
  await f.store.getState().createPath({ kind: 'directory', path: 'another' }, f.workspace.id)
  await f.store.getState().createPath({ kind: 'file', path: 'empty.txt' }, f.workspace.id)
  expect(await readFile(join(f.source.project, 'empty.txt'), 'utf8')).toBe('')
  await f.store.getState().renamePath('drafts', 'moved', f.workspace.id)
  const movedKey = f.workspace.id + '\0moved/child.txt'
  expect(f.store.getState().documents[movedKey]?.content).toBe('Original unsaved nested draft')
  expect(f.store.getState().dirtyDocuments[movedKey]).toBe(true)
  expect(f.store.getState().tabs[tab.id]?.regions[regionId]).toMatchObject({ path: 'moved/child.txt' })
  expect(f.store.getState().documents[key]).toBeUndefined()
  expect(await readFile(join(f.source.project, 'moved', 'child.txt'), 'utf8')).toBe('Original nested body')
  await f.store.getState().deletePath('moved', f.workspace.id)
  expect(f.store.getState().documents[movedKey]?.content).toBe('Original unsaved nested draft')
  expect(f.store.getState().documentIssues[movedKey]?.kind).toBe('deleted')
  expect(f.store.getState().tabs[tab.id]?.regions[regionId]).toMatchObject({ path: 'moved/child.txt' })
  expect(mutations).toEqual(['file.mkdir', 'file.move', 'file.delete'])
  expect(f.store.getState().sourceFilesInputs.pending).toEqual({})
  expect(f.store.getState().sourceFilesInputs.creations).toEqual({})
}, 60000)

it.runIf(business)('a lost directory registration reply keeps the original packet across read-only reconciliation and never registers twice', async () => {
  const f = await fixture(), original = await f.store.getState().resolveFilesSource(f.workspace.id)
  if (original.status !== 'registration-required') throw new Error('Original packet missing')
  const call = f.bridge.spaces.call; let registrations = 0
  vi.mocked(f.api.spaceMounts.call).mockImplementation(async (method, request, signal) => {
    const result = await call(method, request, signal)
    if (method === 'register') { registrations++; throw new Error('Original registration reply was lost') }
    return result
  })
  await expect(f.store.getState().useFilesSourceFolder(f.workspace.id, original.registration)).rejects.toThrow('reply was lost')
  const observed = await f.store.getState().resolveFilesSource(f.workspace.id)
  expect(observed.status).toBe('located')
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]).toMatchObject({ registration: original.registration, registrationStatus: 'unknown' })
  await f.store.getState().useFilesSourceFolder(f.workspace.id, original.registration)
  expect(registrations).toBe(1)
  const { checkpointMountedSpaceInputs } = await import('../src/renderer/src/store.js')
  await checkpointMountedSpaceInputs()
  expect(JSON.parse((await f.user.read())!).state.sourceFilesInputs.selections[f.workspace.id]).toMatchObject({ registration: original.registration, registrationStatus: 'unknown' })
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM) {
    await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
    const scene = await visualScene(f, 'folder-registration-unconfirmed', 'Source Files · folder found, original registration reply unconfirmed')
    const check = [...scene!.element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check original registration')!
    expect(check).toBeTruthy(); await act(async () => check.click())
    await vi.waitFor(() => expect(check.disabled).toBe(false))
    expect(registrations).toBe(1)
    await scene?.capture('folder-registration-unconfirmed')
  }
}, 60000)

it.runIf(business)('a changed directory with a lost registration reply has one read-only Files directory check', async () => {
  const f = await fixture(), original = await f.store.getState().resolveFilesSource(f.workspace.id)
  if (original.status !== 'registration-required') throw new Error('Original packet missing')
  const register = f.bridge.spaces.call
  let writes = 0
  vi.mocked(f.api.spaceMounts.call).mockImplementation(async (method, request, signal) => {
    const receipt = await register(method, request, signal)
    if (method === 'register') { writes++; throw new Error('Original registration reply was lost') }
    return receipt
  })
  await expect(f.store.getState().useFilesSourceFolder(f.workspace.id, original.registration)).rejects.toThrow('reply was lost')
  expect((await f.store.getState().resolveFilesSource(f.workspace.id)).status).toBe('located')
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  await rename(f.source.project, f.source.project + '-original')
  await mkdir(f.source.project)

  const { SourceFilesAccess } = await import('../src/renderer/src/components/SourceFilesAccess.js')
  const scene = await visualScene(f, 'folder-identity-changed', 'Files · the original folder needs checking')
  const element = scene?.element ?? document.createElement('div')
  if (!scene) {
    const root = createRoot(element); document.body.append(element)
    cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
    await act(async () => root.render(createElement(SourceFilesAccess, { workspace: f.workspace, visible: true })))
  }
  await vi.waitFor(() => expect(element.querySelector('.surface-state__title')?.textContent).toBe('Folder identity changed'))
  const notice = element.querySelector('.file-operation-service')!
  const details = notice.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('The original directory changed')
  expect(details.textContent).toContain('Choose current folder')
  const checks = [...notice.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.closest('details'))
  expect(checks.map(button => button.textContent?.trim())).toEqual(['Check original registration'])
  vi.mocked(f.api.sourceFiles.resolve).mockClear()
  await act(async () => checks[0]!.click())
  await vi.waitFor(() => expect(checks[0]!.disabled).toBe(false))
  expect(f.api.sourceFiles.resolve).toHaveBeenCalledTimes(1)
  expect(writes).toBe(1)
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]).toMatchObject({ registration: original.registration, registrationStatus: 'unknown' })
  expect(f.store.getState().documents[f.workspace.id + '\0original.txt']?.content).toBe(f.source.id + ' original body')
  await scene?.capture('folder-identity-changed')
  if (scene) { details.open = true; await scene.capture('folder-identity-details') }
}, 60000)

it.runIf(business)('consecutive Source saves keep their original binding and refresh same-FD identity; another Runtime sharing the physical file cannot receive the old draft', async () => {
  const f = await fixture({ sharedProject: true }); await connectFolder(f)
  const other = f.sources[0]!, candidate = await f.bridge.files.resolve({ hostId: other.id, expectedRuntimeId: other.identity.runtimeId }, { kind: 'directory', path: other.project })
  if (candidate.status !== 'registration-required') throw new Error('The other original Source must register itself')
  const otherRegistration = await f.runtime.registerFolderSpace(other.id, candidate.registration)
  expect(otherRegistration.workspaceId).toBe(f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!.resource.workspaceId)
  expect(otherRegistration.zoneId).toBe(f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!.resource.zoneId)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0original.txt', initial = f.store.getState().documents[key]!
  const tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  const regionId = Object.values(tab.regions).find(region => region.kind === 'file')!.regionId
  const legacy = vi.spyOn(f.api.files, 'write')
  for (const content of ['First Source saved body', 'Second Source saved body']) {
    f.store.getState().updateDocument(tab.id, content, regionId)
    await f.store.getState().saveDocument(tab.id, regionId)
    expect(await readFile(join(f.source.project, 'original.txt'), 'utf8')).toBe(content)
    expect(f.store.getState().documents[key]?.readSource?.target).toEqual(initial.readSource!.target)
    expect(f.store.getState().documents[key]?.readIdentity?.entry.inode).toBe(String((await stat(join(f.source.project, 'original.txt'), { bigint: true })).ino))
    expect(f.store.getState().dirtyDocuments[key]).toBe(false)
  }
  expect(legacy).not.toHaveBeenCalled()
  f.store.getState().updateDocument(tab.id, 'Old Source draft must not go to the new Runtime', regionId)
  f.routes.set(f.source.id, { client: f.sources[0]!.client })
  const nativeWrites = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'write')
  await f.store.getState().saveDocument(tab.id, regionId)
  expect(await readFile(join(f.source.project, 'original.txt'), 'utf8')).toBe('Second Source saved body')
  expect(f.store.getState().documents[key]?.content).toBe('Old Source draft must not go to the new Runtime')
  expect(f.store.getState().dirtyDocuments[key]).toBe(true)
  expect(f.store.getState().documentIssues[key]).toMatchObject({ kind: 'write-unknown', attempted: { source: { target: initial.readSource!.target } } })
  expect(legacy).not.toHaveBeenCalled()
  expect(nativeWrites).not.toHaveBeenCalled()
}, 60000)

it.runIf(business)('unknown write checks the captured old Source even after selecting a new Runtime with identical bytes on the same physical file', async () => {
  const f = await fixture({ sharedProject: true }); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0original.txt', tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  const regionId = Object.values(tab.regions).find(region => region.kind === 'file')!.regionId
  const call = f.bridge.files.call
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (target, method, request, signal) => {
    const result = await call(target, method, request, signal)
    if (method === 'file.write') throw new Error('The original write reply was lost after its actual Source effect')
    return result
  })
  f.store.getState().updateDocument(tab.id, 'Original Source current bytes are observed, not an ACK', regionId)
  await f.store.getState().saveDocument(tab.id, regionId)
  const pending = f.store.getState().documentIssues[key]
  expect(pending?.kind).toBe('write-unknown')
  if (pending?.kind !== 'write-unknown') throw new Error('Original write request missing')
  f.routes.set(f.source.id, { client: f.sources[0]!.client })
  const next = await f.store.getState().selectCurrentFilesSource(f.workspace.id)
  if (next.status !== 'registration-required') throw new Error('New Source requires its actual own registration')
  await f.store.getState().useFilesSourceFolder(f.workspace.id, next.registration)
  await f.store.getState().refreshDocument(f.workspace.id, 'original.txt')
  expect(f.store.getState().documentIssues[key]).toMatchObject({ kind: 'write-unknown', attempted: pending.attempted })
  expect(f.store.getState().dirtyDocuments[key]).toBe(true)
  expect(await readFile(join(f.source.project, 'original.txt'), 'utf8')).toBe(pending.attempted.content)
  f.routes.set(f.source.id, { client: f.source.client })
  await f.store.getState().refreshDocument(f.workspace.id, 'original.txt')
  expect(f.store.getState().documentIssues[key]).toBeUndefined()
  expect(f.store.getState().dirtyDocuments[key]).toBe(false)
  expect(f.store.getState().documents[key]?.readSource?.target).toEqual(pending.attempted.source!.target)
}, 60000)

it.runIf(business)('two real Notes owners with the same Note ID keep their creators and history separate while Source edit, restore and undo use their own owner', async () => {
  const f = await fixture(), path = 'same.note.md', noteId = 'same-note', blockId = 'same-block'
  const original = serializeNoteDocument(newNoteDocument('Original Source Note body', noteId, blockId, 'Original Note'))
  await writeFile(join(f.source.project, path), original)
  const main = new AgentMuxNotebookStore(join(f.root, 'original-main-notes', 'notebooks.root.json'))
  const mainResource = { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path, path }
  const mainActor = { kind: 'user' as const, id: 'original-main-author' }, sourceActor = { kind: 'user' as const, id: 'original-source-author' }
  const blocks = (actor: typeof mainActor) => ({ [blockId]: { created: { actor, at: 1 }, lastEdited: { actor, at: 1 } } })
  const mainProvenance = await main.recordProvenance({ noteId, resource: mainResource, revision: noteHistoryRevision(original), blocks: blocks(mainActor) })
  await main.recordHistory({ noteId, resource: mainResource, originalResource: mainResource, eventId: 'main-only-event', sequence: 0,
    batchId: 'main-only-batch', parentEventId: null, actor: mainActor, status: 'committed', operation: 'edit', at: 1, requestFingerprint: 'main-only',
    beforeContent: null, baseRevision: null, content: original, revision: noteHistoryRevision(original) })
  const ordinary = new OrdinaryWorkspaceFiles(), mainWriter = new NoteFileWriter(ordinary, undefined, main)
  vi.spyOn(f.api.files, 'read').mockImplementation(async (workspaceId, target) => {
    if (workspaceId !== f.workspace.id) throw new Error('Wrong original Main Workspace')
    return await mainWriter.read(f.workspace, target)
  })
  await f.store.getState().openFile(path, 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0' + path
  expect(f.store.getState().documents[key]?.noteProvenance).toEqual(mainProvenance)
  await connectFolder(f)
  const locator = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!
  const sourceResource = { hostId: locator.resource.hostId, workspaceId: locator.resource.workspaceId, workspacePath: locator.resource.workspacePath, path }
  const source = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(join(f.source.state, 'notes-location.json')))
  const sourceProvenance = await source.recordProvenance({ noteId, resource: sourceResource, revision: noteHistoryRevision(original), blocks: blocks(sourceActor) })
  await source.recordHistory({ noteId, resource: sourceResource, originalResource: sourceResource, eventId: 'source-only-event', sequence: 0,
    batchId: 'source-only-batch', parentEventId: null, actor: sourceActor, status: 'committed', operation: 'edit', at: 1, requestFingerprint: 'source-only',
    beforeContent: null, baseRevision: null, content: original, revision: noteHistoryRevision(original),
    provenance: { noteId, resource: sourceResource, revision: noteHistoryRevision(original), blocks: blocks(sourceActor) } })
  const mainRoot = await readFile(main.path), mainHistory = await main.readHistory({ noteId, resource: mainResource, eventId: 'main-only-event', includeContent: true })
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM) {
    vi.spyOn(f.api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...mainResource, zoneId: params.zoneId, zonePath: f.workspace.path }, result: await mainWriter.read(f.workspace, params.path) }))
    vi.spyOn(f.api.files, 'historyPublic').mockImplementation(async params => ({ resource: params.expectedResource,
      result: await main.readHistory({ noteId, resource: mainResource, ...(params.before === undefined ? {} : { before: params.before }), ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.eventId === undefined ? {} : { eventId: params.eventId }), ...(params.includeContent === undefined ? {} : { includeContent: params.includeContent }) }) }))
  }
  await f.store.getState().refreshDocument(f.workspace.id, path)
  expect(f.store.getState().documents[key]?.noteProvenance).toEqual(sourceProvenance)
  expect(f.store.getState().documents[key]?.legacyMainNote).toMatchObject({ noteId, resource: mainResource, provenance: mainProvenance })
  const tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
  const regionId = Object.values(tab.regions).find(region => region.kind === 'file')!.regionId
  const legacyWrite = vi.spyOn(f.api.files, 'write'), legacyRestore = vi.spyOn(f.api.files, 'restorePublic'), legacyUndo = vi.spyOn(f.api.files, 'undoPublic')
  f.store.getState().updateDocument(tab.id, original.replace('Original Source Note body', 'First Source edit'), regionId)
  await f.store.getState().saveDocument(tab.id, regionId)
  expect(await readFile(join(f.source.project, path), 'utf8')).toContain('First Source edit')
  const { readNoteFileHistory } = await import('../src/renderer/src/lib/note-history-source.js')
  let target = (await f.store.getState().inspectNoteHistory(tab.id, regionId, noteId)).target
  expect(target.source?.target).toMatchObject({ hostId: f.source.id, expectedRuntimeId: f.source.identity.runtimeId })
  const first = await readNoteFileHistory(target)
  if (first.result.status === 'unknown') throw new Error(first.result.message)
  expect(first.result.entries.some(entry => entry.eventId === 'source-only-event')).toBe(true)
  expect(first.result.entries.some(entry => entry.eventId === 'main-only-event')).toBe(false)
  await f.store.getState().applyNoteHistory(tab.id, regionId, { target, eventId: 'source-only-event' })
  expect(await readFile(join(f.source.project, path), 'utf8')).toContain('Original Source Note body')
  f.store.getState().updateDocument(tab.id, original.replace('Original Source Note body', 'Second Source edit for undo'), regionId)
  await f.store.getState().saveDocument(tab.id, regionId)
  target = (await f.store.getState().inspectNoteHistory(tab.id, regionId, noteId)).target
  const second = await readNoteFileHistory(target)
  if (second.result.status === 'unknown') throw new Error(second.result.message)
  const edit = second.result.entries.find(entry => entry.operation === 'edit' && entry.eventId !== 'source-only-event')!
  expect(edit).toBeTruthy()
  expect((await readNoteFileHistory(target, { eventId: edit.eventId, includeContent: true })).result).toMatchObject({ entries: [expect.objectContaining({ content: expect.stringContaining('Second Source edit for undo') })] })
  await f.store.getState().applyNoteHistory(tab.id, regionId, { target, batchId: edit.batchId, batchLastEventId: edit.eventId })
  expect(await readFile(join(f.source.project, path), 'utf8')).toContain('Original Source Note body')
  const { source: _source, ...mainTarget } = target
  await expect(f.store.getState().applyNoteHistory(tab.id, regionId, { target: { ...mainTarget, expectedResource: { ...target.expectedResource, ...mainResource } }, eventId: 'main-only-event' })).rejects.toThrow('Original Main history is read-only')
  expect(legacyWrite).not.toHaveBeenCalled(); expect(legacyRestore).not.toHaveBeenCalled(); expect(legacyUndo).not.toHaveBeenCalled()
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_VISUAL_DOM) {
    const scene = await visualScene(f, 'source-history', 'Source Note · history stays with its original owner')
    const historyButton = [...scene!.element.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('History'))!
    await act(async () => historyButton.click())
    await vi.waitFor(() => expect(document.querySelector('.note-version-history__activity')).not.toBeNull())
    await scene?.capture('source-history')
    const mainButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Original Main history')!
    await act(async () => mainButton.click())
    await vi.waitFor(() => expect(document.querySelector('.note-version-history__activities')?.textContent).toContain('original-main-author'))
    const originalReference = document.querySelector<HTMLDetailsElement>('.note-version-history__scope')!; originalReference.open = true
    expect(document.querySelector('.note-version-history')?.textContent).toContain('read-only')
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.includes('Undo this activity'))).toBe(false)
    await scene?.capture('main-history-readonly')
  }
  expect(await readFile(main.path)).toEqual(mainRoot)
  expect(await main.readHistory({ noteId, resource: mainResource, eventId: 'main-only-event', includeContent: true })).toEqual(mainHistory)
  expect(await main.readProvenance({ noteId, resource: mainResource, revision: noteHistoryRevision(original), blockIds: [blockId] })).toEqual(mainProvenance)
}, 60000)

it.runIf(business)('Source text saves keep older sharing requests and cleanup separate; new promotions and late-bound Main retries never dispatch', async () => {
  const f = await fixture(), path = 'references.note.md', note = newNoteDocument('Original ordinary text', 'reference-note', 'reference-block', 'References')
  note.content.content!.push({ type: 'noteInclude', attrs: { noteId: 'saved-shared-note', path: 'saved-shared.note.md', referenceId: 'saved-reference' } })
  const original = serializeNoteDocument(note)
  await writeFile(join(f.source.project, path), original); await connectFolder(f)
  await f.store.getState().openFile(path, 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0' + path, tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!
  const regionId = Object.values(tab.regions).find(region => region.kind === 'file')!.regionId, before = f.store.getState().documents[key]!, binding = before.readSource!
  const mainUndo = vi.spyOn(f.api.files, 'shareUndoPublic'), mainShare = vi.spyOn(f.api.files, 'sharePublic'), mainInspect = vi.spyOn(f.api.files, 'inspectSharePublic')
  const cleaned = newNoteDocument('Ordinary text after removing a saved reference', 'reference-note', 'reference-block', 'References')
  f.store.getState().updateDocument(tab.id, serializeNoteDocument(cleaned), regionId)
  await f.store.getState().saveDocument(tab.id, regionId)
  expect(await readFile(join(f.source.project, path), 'utf8')).toContain('Ordinary text after removing a saved reference')
  expect(f.store.getState().dirtyDocuments[key]).not.toBe(true)
  expect(f.store.getState().documents[key]?.noteEditing?.receipt?.noteHistory?.status).toBe('committed')
  expect(f.store.getState().documents[key]?.noteEditing?.shareCleanupIssue?.referenceIds).toEqual(['saved-reference'])
  const cleanupScene = await visualScene(f, 'source-save-cleanup-unconfirmed', 'Source Note · text saved, shared-reference cleanup unconfirmed')
  if (cleanupScene) expect(cleanupScene.element.textContent).toContain('Shared-reference cleanup unconfirmed')
  expect(mainUndo).not.toHaveBeenCalled(); expect(mainShare).not.toHaveBeenCalled(); expect(mainInspect).not.toHaveBeenCalled()
  // A complete pre-existing request is retained as a request; it is not relabelled as a Source action.
  const params = { destination: { ...binding.query, expectedResource: { ...binding.resource, hostId: f.workspace.hostId, workspaceId: f.workspace.id },
    content: original, baseContent: original, expectedRevision: noteHistoryRevision(original), operationId: 'retained-main-cleanup' }, referenceIds: ['saved-reference'], preserveNoteIds: [] }
  const originalDocument = f.store.getState().documents[key]!
  f.store.setState(state => ({ documents: { ...state.documents, [key]: { ...originalDocument, noteEditing: { ...originalDocument.noteEditing, shareUndo: { params } } } } }))
  await f.store.getState().inspectNoteShareUndo(f.workspace.id, path)
  await f.store.getState().continueNoteShareUndo(f.workspace.id, path)
  expect(mainInspect).not.toHaveBeenCalled(); expect(mainUndo).not.toHaveBeenCalled()
  f.store.getState().updateDocument(tab.id, serializeNoteDocument(cleaned).replace('Ordinary text after removing a saved reference', 'Another ordinary Source save'), regionId)
  await f.store.getState().saveDocument(tab.id, regionId)
  expect(await readFile(join(f.source.project, path), 'utf8')).toContain('Another ordinary Source save')
  expect(f.store.getState().documents[key]?.noteEditing?.shareUndo?.params).toEqual(params)
  const { stageNoteShare, pendingNoteShares } = await import('../src/renderer/src/lib/note-share-staging.js')
  const include = stageNoteShare(key, { version: 1, source: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path, path: 'original-legacy-source.note.md', noteId: 'reference-note' },
    read: binding.query, block: { path: [0], fingerprint: 'frozen-copy', blockId: 'reference-block' } })
  const staged = newNoteDocument('Staged draft kept', 'reference-note', 'reference-block', 'References')
  staged.content.content!.push({ type: 'noteInclude', attrs: include })
  f.store.getState().updateDocument(tab.id, serializeNoteDocument(staged), regionId)
  const beforeStaged = await readFile(join(f.source.project, path), 'utf8')
  await f.store.getState().saveDocument(tab.id, regionId)
  expect(await readFile(join(f.source.project, path), 'utf8')).toBe(beforeStaged)
  expect(pendingNoteShares(key).get(include.referenceId)?.include).toEqual(include)
  expect(f.store.getState().documents[key]?.content).toContain('Staged draft kept')
  expect(mainShare).not.toHaveBeenCalled()
  // The same request starts unbound, then the document is rebound while its read-only inspection waits.
  let release!: (value: any) => void
  mainInspect.mockImplementation(() => new Promise(resolve => { release = resolve }))
  f.store.setState(state => ({ documents: { ...state.documents, [key]: { ...state.documents[key]!, readSource: undefined } } }))
  const continuing = f.store.getState().continueNoteShareUndo(f.workspace.id, path)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  f.store.setState(state => ({ documents: { ...state.documents, [key]: { ...state.documents[key]!, readSource: binding } } }))
  const observed = { operationId: params.destination.operationId, status: 'unknown' as const, destination: null, collections: [], message: 'Original owner observation remains unknown' }
  release({ mode: 'undo', result: observed }); await continuing
  expect(mainUndo).not.toHaveBeenCalled()
  expect(f.store.getState().documents[key]?.noteEditing?.shareUndo).toEqual({ params, observed })
  expect(f.store.getState().documents[key]?.content).toContain('Staged draft kept')
}, 60000)

it.runIf(business)('GUI Source Note creation waits on the original Notes lease while an ordinary file remains writable', async () => {
  const f = await fixture(); await connectFolder(f)
  const notes = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(join(f.source.state, 'notes-location.json')))
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const blocker = notes.runWithWriteLease(async () => { entered(); await gate }); await held
  cleanup.push(() => { release(); return blocker })
  const creating = f.store.getState().createPath({ path: 'late.note.md', kind: 'file' }, f.workspace.id)
  await f.store.getState().createPath({ path: 'ordinary-independent.txt', kind: 'file' }, f.workspace.id)
  expect(await readFile(join(f.source.project, 'ordinary-independent.txt'), 'utf8')).toBe('')
  await expect(readFile(join(f.source.project, 'late.note.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  release(); await blocker; expect(await creating).toBe(f.workspace.id)
  expect(await readFile(join(f.source.project, 'late.note.md'), 'utf8')).toBe('')
}, 60000)

it.runIf(business)('GUI directory move and Note deletion borrow the same original Source Notes lease', async () => {
  const f = await fixture(); await connectFolder(f)
  const note = serializeNoteDocument(newNoteDocument('Original Note body', 'lease-note', 'lease-block', 'Lease Note'))
  await mkdir(join(f.source.project, 'original')); await writeFile(join(f.source.project, 'original', 'inside.note.md'), note)
  await writeFile(join(f.source.project, 'deleted.note.md'), note.replace('lease-note', 'deleted-lease-note'))
  const notes = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(join(f.source.state, 'notes-location.json')))
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const blocker = notes.runWithWriteLease(async () => { entered(); await gate }); await held
  cleanup.push(() => { release(); return blocker })
  let moveEntered!: () => void
  const observed = new Promise<void>(resolve => { moveEntered = resolve }), call = f.bridge.files.call
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (target, method, params, signal) => {
    if (method === 'file.move') moveEntered()
    return await call(target, method, params, signal)
  })
  const moving = f.store.getState().renamePath('original', 'moved', f.workspace.id)
  await observed
  expect(await readFile(join(f.source.project, 'original', 'inside.note.md'), 'utf8')).toBe(note)
  await expect(readFile(join(f.source.project, 'moved', 'inside.note.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  release(); await blocker; await moving
  expect(await readFile(join(f.source.project, 'moved', 'inside.note.md'), 'utf8')).toBe(note)
  // Freeze a separate lease interval for the delete producer, after the prior operation settles.
  let releaseDelete!: () => void, enteredDelete!: () => void, dispatchedDelete!: () => void
  const deleteGate = new Promise<void>(resolve => { releaseDelete = resolve }), deleteHeld = new Promise<void>(resolve => { enteredDelete = resolve })
  const deletingLease = notes.runWithWriteLease(async () => { enteredDelete(); await deleteGate }); await deleteHeld
  cleanup.push(() => { releaseDelete(); return deletingLease })
  const deleteDispatched = new Promise<void>(resolve => { dispatchedDelete = resolve })
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (target, method, params, signal) => { if (method === 'file.delete') dispatchedDelete(); return await call(target, method, params, signal) })
  const deleting = f.store.getState().deletePath('deleted.note.md', f.workspace.id); await deleteDispatched
  expect(await readFile(join(f.source.project, 'deleted.note.md'), 'utf8')).toContain('Original Note body')
  releaseDelete(); await deletingLease; await deleting
  await expect(readFile(join(f.source.project, 'deleted.note.md'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 60000)

it.runIf(business)('Source file creation returns its captured display Workspace across a late active Workspace switch', async () => {
  const f = await fixture(); await connectFolder(f)
  const other = { ...f.workspace, id: 'other-display', name: 'Other display' }
  f.store.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, other] }, layouts: { ...state.layouts, [other.id]: createWorkspaceLayout('other-group', []) } }))
  const call = f.bridge.files.call, used: string[] = []
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (target, method, params, signal) => {
    const result = await call(target, method, params, signal)
    if (method === 'file.create') { used.push(target.hostId); f.store.setState({ activeWorkspaceId: other.id }) }
    return result
  })
  const returned = await f.store.getState().createPath({ path: 'created-here.txt', kind: 'file' })
  expect(f.store.getState().activeWorkspaceId).toBe(other.id); expect(used).toEqual([f.source.id]); expect(returned).toBe(f.workspace.id)
  await f.store.getState().openFile('created-here.txt', undefined, undefined, returned)
  expect(f.store.getState().documents[other.id + '\0created-here.txt']).toBeUndefined()
  expect(f.store.getState().documents[f.workspace.id + '\0created-here.txt']?.content).toBe('')
  expect(await readFile(join(f.source.project, 'created-here.txt'), 'utf8')).toBe('')
  await expect(readFile(join(f.sources[0]!.project, 'created-here.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 60000)

async function originalRestartSources() {
  const { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } = await import('@agentmux/core')
  const { configuredDesktopAgentMuxHost } = await import('../src/main/desktop-host.js')
  const { RuntimeController } = await import('../src/main/runtime-controller.js')
  const saved = JSON.parse(await readFile(process.env.AGENTMUX_TEST_FILE_CLIENT_MANIFEST!, 'utf8'))
  const sources = []
  for (const original of saved.sources) {
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(original.directory, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', original.state)
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(original.state, 'messages.ndjson')); vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(original.state, 'spatial.json'))
    const store = new AgentMuxFileAgentSessionStore(join(original.state, 'sessions.json'))
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: original.socketPath } }); cleanup.push(() => rpc.dispose())
    expect((await rpc.call('runtime.owner.identity', {})).owner).toEqual(original.identity)
    const client = await configuredDesktopAgentMuxHost(original.configurationPath, join(original.state, 'connectors'))({ id: 'local', kind: 'local', label: original.id }, store)
    cleanup.push(() => client.dispose()); sources.push({ ...original, store, rpc, client })
  }
  const routes = new Map(sources.map(source => [source.id, { client: source.client }]))
  return { saved, original: { root: saved.root, sources, routes, runtime: Object.assign(Object.create(RuntimeController.prototype), { hosts: routes, hostReconfigurationReservations: new Map() }) } as Awaited<ReturnType<typeof sourceFilesHosts>> }
}

it.runIf(Boolean(restartMode))('private Source workface worker preserves the original draft, clean deleted body and pending operation', async () => {
  const { original, saved } = await originalRestartSources(), f = await fixture({}, original)
  const key = f.workspace.id + '\0original.txt', dirtyKey = f.workspace.id + '\0unsaved.txt', cleanKey = f.workspace.id + '\0clean.txt'
  if (restartMode === 'writer') {
    await connectFolder(f)
    await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
    await writeFile(join(f.source.project, 'clean.txt'), 'Original clean Source body')
    await f.store.getState().openFile('clean.txt', 'file-group', undefined, f.workspace.id)
    await writeFile(join(f.source.project, 'unsaved.txt'), 'Original disk baseline')
    await f.store.getState().openFile('unsaved.txt', 'file-group', undefined, f.workspace.id)
    const dirtyTab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'unsaved.txt'))!
    f.store.getState().updateDocument(dirtyTab.id, 'Original unsaved body across OS restart', Object.values(dirtyTab.regions).find(region => region.kind === 'file')!.regionId)
    const release = await f.store.getState().observeFilesSource(f.workspace.id); cleanup.push(release)
    const locator = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!, r = locator.resource
    const query = { zoneId: r.zoneId, path: 'original.txt', expectedResource: { hostId: r.hostId, workspaceId: r.workspaceId, workspacePath: r.workspacePath }, includeRevision: true }
    const observed = (await f.bridge.files.call({ hostId: locator.mount.hostId, reference: locator.mount.reference }, 'file.stat', query)).result
    if (observed.result.status !== 'observed' || !observed.resource || observed.result.observation.revision?.status !== 'observed') throw Error('Original revision unavailable')
    const o = observed.result.observation, { includeRevision: _include, ...target } = query
    const request = { ...target, operationId: 'restart-cli-delete', expectedResource: observed.resource, expected: { root: o.root, parent: o.parent, entry: o.entry }, expectedRevision: o.revision.revision }
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + f.source.socketPath, 'file', 'delete', '--input', '-'], objectCliEnvironment(f.source.state), JSON.stringify(request))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    await vi.waitFor(() => expect(f.store.getState().documentIssues[key]?.kind).toBe('deleted'))
    const call = f.bridge.files.call
    vi.mocked(f.api.sourceFiles.call).mockImplementation(async (target, method, params, signal) => { const reply = await call(target, method, params, signal); if (method === 'file.mkdir') throw Error('Private lost mkdir reply'); return reply })
    await expect(f.store.getState().createPath({ path: 'original-pending-dir', kind: 'directory' }, f.workspace.id)).rejects.toThrow('Private lost mkdir reply')
    const { prepareRendererUpdate } = await import('../src/renderer/src/store.js'); await prepareRendererUpdate('quit')
    const state = f.store.getState()
    expect(state.dirtyDocuments[key]).not.toBe(true); expect(state.documents[key]?.content).toBe('source-b original body')
    const pending = Object.values(state.sourceFilesInputs.pending)
    expect(pending).toHaveLength(1)
    expect(JSON.parse((await f.user.read())!).state.documents[cleanKey]).toBeUndefined()
    await writeFile(join(f.root, 'source-workface-writer.json'), JSON.stringify({ pid: process.pid, documents: { [key]: state.documents[key], [dirtyKey]: state.documents[dirtyKey] }, tabs: state.tabs,
      layouts: state.layouts, pending: state.sourceFilesInputs.pending, inputs: state.sourceFilesInputs, issue: state.documentIssues[key], run: saved.healthy }))
  } else {
    const writer = JSON.parse(await readFile(join(f.root, 'source-workface-writer.json'), 'utf8')), state = f.store.getState()
    expect(process.pid).not.toBe(writer.pid)
    expect(state.documents[key]).toEqual(writer.documents[key]); expect(state.documentIssues[key]).toEqual(writer.issue)
    expect(state.dirtyDocuments[key]).not.toBe(true)
    expect(state.documents[dirtyKey]?.content).toBe('Original unsaved body across OS restart'); expect(state.dirtyDocuments[dirtyKey]).toBe(true)
    expect(state.layouts).toEqual(writer.layouts)
    for (const [id, tab] of Object.entries(writer.tabs)) expect(state.tabs[id]).toMatchObject({ id, regions: (tab as any).regions })
    expect(state.sourceFilesInputs).toMatchObject(writer.inputs)
    await expect(readFile(join(f.source.project, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const directory = await stat(join(f.source.project, 'original-pending-dir'), { bigint: true }), calls: string[] = [], call = f.bridge.files.call
    vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { calls.push(args[1]); return await call(...args) })
    const operationId = Object.keys(writer.pending)[0]!
    await f.store.getState().inspectFilesMutation(operationId)
    expect(calls).toEqual(['file.mutation.inspect'])
    expect((await stat(join(f.source.project, 'original-pending-dir'), { bigint: true })).ino).toBe(directory.ino)
    expect(f.store.getState().documents[key]?.content).toBe('source-b original body')
    expect(f.store.getState().documents[dirtyKey]?.content).toBe('Original unsaved body across OS restart')
    const mainRead = vi.spyOn(f.api.files, 'read').mockResolvedValue({ status: 'read', document: { path: 'clean.txt', content: 'Wrong later Main body', revision: 'wrong-main-revision' } }), mainWrite = vi.spyOn(f.api.files, 'write')
    const beforeOffline = f.bridge.files.call
    vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { if (args[1] === 'file.read') throw Error('Private original Source temporarily unavailable'); return await beforeOffline(...args) })
    await f.store.getState().openFile('clean.txt', 'file-group', undefined, f.workspace.id)
    // The shipping EditorPane invokes this owner when a restored File Tab has no body yet.
    await f.store.getState().attachPersistedFileDocument(f.workspace.id, 'clean.txt')
    expect(f.store.getState().documents[cleanKey]).toBeUndefined()
    expect(f.store.getState().documentIssues[cleanKey]?.kind).toBe('read-error')
    expect(Object.values(f.store.getState().tabs).some(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'clean.txt'))).toBe(true)
    expect(mainRead).not.toHaveBeenCalled(); expect(mainWrite).not.toHaveBeenCalled()
    const healthy = await f.source.rpc.call('terminal.inspect', { target: { hostId: 'local', runtimeId: saved.healthyRuntime.runtimeId, run: { runId: writer.run.runId } } })
    expect(healthy.run.runId).toBe(writer.run.runId); expect(healthy.run.state).toEqual(writer.run.state)
    await writeFile(join(f.root, 'source-workface-reader.json'), JSON.stringify({ writerPid: writer.pid, readerPid: process.pid, restored: true, noCreateReplay: true,
      originalRun: healthy.run, deletedBuffer: f.store.getState().documents[key], pendingBefore: writer.pending, pendingAfter: f.store.getState().sourceFilesInputs.pending }))
  }
}, 60000)

it.runIf(!native)('two original OS processes reopen Source workfaces without recreating files or replacing the healthy Native Run', async () => {
  const f = await sourceFilesHosts(cleanup), source = f.sources[1]!
  const healthy = await source.client.createTerminal({ command: process.execPath, args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], workspacePath: source.project, createOperationId: 'source-workface-healthy-run' })
  const manifest = join(f.root, 'source-process-manifest.json')
  const catalog = await source.rpc.call('terminal.ls', { hostId: 'local', limit: 20 })
  expect(catalog.items.some(item => item.run.runId === healthy.runId)).toBe(true)
  await writeFile(manifest, JSON.stringify({ root: f.root, healthy, healthyRuntime: catalog.runtime, sources: f.sources.map(({ id, directory, state, project, socketPath, identity, configurationPath }) => ({ id, directory, state, project, socketPath, identity, configurationPath })) }))
  for (const mode of ['writer', 'reader']) {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.file-path-client.config.mts', '--maxWorkers=1', '-t', 'private Source workface worker'], {
      cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, AGENTMUX_TEST_FILE_CLIENT_NATIVE: '1', AGENTMUX_TEST_FILE_CLIENT_RESTART: mode, AGENTMUX_TEST_FILE_CLIENT_MANIFEST: manifest }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    const code = await new Promise<number | null>((yes, no) => { child.once('error', no); child.once('close', yes) })
    if (process.env.AGENTMUX_TEST_FILE_CLIENT_EVIDENCE) await writeFile(join(process.env.AGENTMUX_TEST_FILE_CLIENT_EVIDENCE, 'source-two-os-' + mode + '-' + (process.env.AGENTMUX_TEST_FILE_CLIENT_ATTEMPT ?? 'unqualified') + '.log'), output)
    expect(code, output).toBe(0); expect(output).toMatch(/1 passed/)
  }
  const proof = JSON.parse(await readFile(join(f.root, 'source-workface-reader.json'), 'utf8'))
  expect(proof).toMatchObject({ restored: true, noCreateReplay: true }); expect(proof.writerPid).not.toBe(proof.readerPid)
  expect((await source.rpc.call('terminal.inspect', { target: { hostId: 'local', runtimeId: catalog.runtime.runtimeId, run: { runId: healthy.runId } } })).run.runId).toBe(healthy.runId)
  if (process.env.AGENTMUX_TEST_FILE_CLIENT_EVIDENCE) await writeFile(join(process.env.AGENTMUX_TEST_FILE_CLIENT_EVIDENCE, 'source-two-os-proof-' + (process.env.AGENTMUX_TEST_FILE_CLIENT_ATTEMPT ?? 'unqualified') + '.json'), JSON.stringify(proof, null, 2))
}, 180000)

it.runIf(business)('a bound Source read failure never replaces its body or later save with a different-revision Main fallback', async () => {
  const f = await fixture({ sharedProject: true }); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0original.txt', original = f.store.getState().documents[key]!, call = f.bridge.files.call
  const mainRead = vi.spyOn(f.api.files, 'read').mockResolvedValue({ status: 'read', document: { path: 'original.txt', content: 'Wrong later Main body', revision: 'wrong-later-revision' } })
  const mainWrite = vi.spyOn(f.api.files, 'write')
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => {
    if (args[1] === 'file.read') return { carrierCurrent: true, result: { resource: original.readSource!.resource, result: { status: 'unknown', code: 'PRIVATE_SOURCE_READ_UNAVAILABLE', message: 'Private Source read unavailable' } } } as never
    return await call(...args)
  })
  await f.store.getState().refreshDocument(f.workspace.id, 'original.txt')
  expect(f.store.getState().documents[key]?.content).toBe(original.content)
  expect(f.store.getState().documents[key]?.readSource).toEqual(original.readSource)
  expect(f.store.getState().documentIssues[key]?.kind).toBe('read-error')
  await visualScene(f, 'source-unavailable-body-kept', 'Source Files · original Source unavailable, editor contents kept')
  const tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  f.store.getState().updateDocument(tab.id, 'Original Source draft retained', Object.values(tab.regions).find(region => region.kind === 'file')!.regionId)
  await f.store.getState().saveDocument(tab.id)
  expect(mainRead).not.toHaveBeenCalled(); expect(mainWrite).not.toHaveBeenCalled()
  expect(await readFile(join(f.source.project, 'original.txt'), 'utf8')).toBe(original.content)
}, 60000)

it.runIf(business)('Source reference copying cannot serialize a Main capability, including existing includes before the source View closes', async () => {
  const f = await fixture(), path = 'copy-source.note.md', noteId = 'copy-source-note'
  await writeFile(join(f.source.project, path), serializeNoteDocument(newNoteDocument('Original Source copy body', noteId, 'source-copy-block', 'Copy Source')))
  await connectFolder(f); await f.store.getState().openFile(path, 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0' + path, source = { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path, path, noteId }
  expect(f.store.getState().documents[key]?.readSource).toBeTruthy()
  const { copyNoteBlock, writeNoteShareClipboard, readNoteShareClipboard } = await import('../src/renderer/src/lib/note-share-staging.js')
  if (!document.execCommand) Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
  const command = vi.spyOn(document, 'execCommand').mockReturnValue(true), target = f.store.getState().documents[key]!.readSource!
  const { Editor } = await import('@tiptap/core'), { noteContentExtensions } = await import('@agentmux/client-ui/note/note-content-schema')
  const actual = readNoteDocument(f.store.getState().documents[key]!.content); if (actual.status !== 'valid') throw Error('Actual Source Note body must parse')
  const editor = new Editor({ extensions: noteContentExtensions(), content: actual.note.content }); cleanup.push(() => editor.destroy())
  expect(() => copyNoteBlock(editor, 0, source, target.query)).toThrow('shared reference is not confirmed')
  const { NoteSharedFileEditing } = await import('../src/renderer/src/components/NoteSharedFileEditing.js')
  const { NoteSharedContext } = await import('../src/renderer/src/lib/note-shared-context.js')
  const { noteKnowledge } = await import('@agentmux/client-ui/note/note-knowledge')
  let context: any
  const node = document.createElement('div'), root = createRoot(node); document.body.append(node)
  cleanup.push(async () => { await act(async () => root.unmount()); node.remove() })
  await act(async () => root.render(createElement(NoteSharedFileEditing, { target: source, include: { noteId: 'original-shared', path: 'original-shared.note.md', referenceId: 'original-include' },
    occurrence: 'source-copy-occurrence', active: true, knowledge: noteKnowledge([]), hasIncludes: false, onOpen: () => {}, children:
      createElement(NoteSharedContext.Consumer, null, value => { context = value; return null }) })))
  await expect(context.copyBlock({ view: { dom: node }, getText: () => 'Original Source copy body' }, 0)).rejects.toThrow('shared reference is not confirmed')
  // The details copy path can point at an embedded legacy Main file; its host occurrence remains Source-bound.
  expect(() => writeNoteShareClipboard(document, { version: 1, source: { ...source, path: 'embedded-main.note.md' },
    block: { path: [], fingerprint: '' }, include: { noteId: 'original-shared', path: 'embedded-main.note.md', referenceId: 'original-include' } }, 'Original text', source)).toThrow('shared reference is not confirmed')
  expect(command).not.toHaveBeenCalled()
  f.store.setState(state => ({ documents: Object.fromEntries(Object.entries(state.documents).filter(([id]) => id !== key)), tabs: {}, layouts: { [f.workspace.id]: createWorkspaceLayout('file-group', []) } }))
  const plain = new DataTransfer(); plain.setData('text/plain', 'Ordinary text remains usable')
  expect(readNoteShareClipboard(new ClipboardEvent('paste', { clipboardData: plain }), document)).toBeNull()
  expect(plain.getData('text/plain')).toBe('Ordinary text remains usable')
  const mainRoot = join(f.root, 'legacy-paste-target'); await mkdir(mainRoot)
  const main = { id: 'legacy-paste', hostId: 'local', path: mainRoot, name: 'Original Main target', kind: 'folder' as const }
  const body = serializeNoteDocument(newNoteDocument('Original Main target body', 'main-paste-note', 'main-paste-block', 'Main target'))
  await writeFile(join(mainRoot, 'target.note.md'), body)
  const writer = new NoteFileWriter(new OrdinaryWorkspaceFiles(), undefined, new AgentMuxNotebookStore(join(f.root, 'legacy-paste-notes', 'notebooks.root.json')))
  const read = await writer.read(main, 'target.note.md'); if (read.status !== 'read') throw Error('Actual original Main body unavailable')
  f.store.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, main] }, documents: { ...state.documents, [main.id + '\0target.note.md']: read.document } }))
  await act(async () => root.render(createElement(NoteSharedFileEditing, { target: { hostId: main.hostId, workspaceId: main.id, workspacePath: main.path, path: 'target.note.md', noteId: 'main-paste-note' },
    occurrence: 'legacy-paste-occurrence', active: true, knowledge: noteKnowledge([]), hasIncludes: false, onOpen: () => {}, children:
      createElement(NoteSharedContext.Consumer, null, value => { context = value; return null }) })))
  const sharing = vi.spyOn(f.api.files, 'sharePublic')
  expect(context.paste({ view: { dom: node } }, new ClipboardEvent('paste', { clipboardData: plain }))).toBe(false)
  const { pendingNoteShares } = await import('../src/renderer/src/lib/note-share-staging.js')
  expect(pendingNoteShares(main.id + '\0target.note.md').size).toBe(0)
  expect(sharing).not.toHaveBeenCalled(); expect(await readFile(join(mainRoot, 'target.note.md'), 'utf8')).toBe(body)
  expect(command).not.toHaveBeenCalled()
}, 60000)

it.runIf(business)('a confirmed Source move cannot rebind an editor while its original composition is active', async () => {
  const f = await fixture(); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0original.txt', original = f.store.getState().documents[key]!, tabs = f.store.getState().tabs
  const { setNoteComposition } = await import('../src/renderer/src/lib/note-live-merge.js')
  setNoteComposition(key, 'original-source-editor-composition', true); cleanup.push(() => setNoteComposition(key, 'original-source-editor-composition', false))
  await f.store.getState().renamePath('original.txt', 'moved-composing.txt', f.workspace.id)
  expect(await readFile(join(f.source.project, 'moved-composing.txt'), 'utf8')).toBe(original.content)
  expect(f.store.getState().documents[key]).toEqual(original)
  expect(f.store.getState().documents[f.workspace.id + '\0moved-composing.txt']).toBeUndefined()
  expect(f.store.getState().tabs).toEqual(tabs)
  expect(f.store.getState().documentIssues[key]).toMatchObject({ kind: 'read-error', code: 'FILE_EFFECT_SOURCE_UNCONFIRMED' })
}, 60000)

it.runIf(business)('late input after a real Native move keeps its old workface and an exact projection service window', async () => {
  const f = await fixture(); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0original.txt', initial = f.store.getState(), tab = Object.values(initial.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  let ready!: () => void, release!: () => void
  const obtained = new Promise<void>(resolve => { ready = resolve }), gate = new Promise<void>(resolve => { release = resolve }), call = f.bridge.files.call
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { const reply = await call(...args); if (args[1] === 'file.move') { ready(); await gate } return reply })
  const moving = f.store.getState().renamePath('original.txt', 'moved-late-input.txt', f.workspace.id)
  await obtained
  f.store.getState().updateDocument(tab.id, 'Later input after the real Native move', Object.values(tab.regions).find(region => region.kind === 'file')!.regionId)
  release(); await moving
  expect(await readFile(join(f.source.project, 'moved-late-input.txt'), 'utf8')).toBe(initial.documents[key]!.content)
  expect(f.store.getState().documents[key]?.content).toBe('Later input after the real Native move')
  expect(f.store.getState().dirtyDocuments[key]).toBe(true)
  expect(f.store.getState().tabs[tab.id]?.regions).toEqual(tab.regions)
  expect(f.store.getState().documentIssues[key]).toMatchObject({ kind: 'read-error', code: 'FILE_EFFECT_PROJECTION_CHANGED', message: expect.stringContaining('Check original operation') })
}, 60000)

it.runIf(business)('Core-owned topology-only File View changes add and prune original Source pointers without copying clean bodies', async () => {
  const f = await fixture(); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const { prepareRendererUpdate } = await import('../src/renderer/src/store.js')
  const { addWorkbenchRegion, removeWorkbenchRegion } = await import('../src/renderer/src/lib/workbench-tabs.js')
  await prepareRendererUpdate('reload')
  const state = f.store.getState(), key = f.workspace.id + '\0original.txt', tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  const originalRegion = Object.values(tab.regions).find(region => region.kind === 'file')!.regionId
  const pointer = tab.id + '\0source-pointer-clone'
  const cloned = addWorkbenchRegion(tab, originalRegion, 'right', { kind: 'file', workspaceId: f.workspace.id, path: 'original.txt', regionId: 'source-pointer-clone' })!
  f.store.setState({ tabs: { ...state.tabs, [tab.id]: cloned } })
  expect(f.store.getState().documents).toBe(state.documents); expect(f.store.getState().sourceFilesInputs).toBe(state.sourceFilesInputs)
  await prepareRendererUpdate('reload')
  let saved = JSON.parse((await f.user.read())!).state
  expect(saved.restoredWorkbench).toBeUndefined(); expect(saved.documents[key]).toBeUndefined()
  expect(saved.sourceFilesInputs.readSources[pointer]?.source).toEqual(state.documents[key]!.readSource)
  const current = f.store.getState(), reduced = removeWorkbenchRegion(current.tabs[tab.id]!, 'source-pointer-clone')!
  f.store.setState({ tabs: { ...current.tabs, [tab.id]: reduced } })
  await prepareRendererUpdate('reload')
  saved = JSON.parse((await f.user.read())!).state
  expect(saved.sourceFilesInputs.readSources[pointer]).toBeUndefined()
  expect(saved.sourceFilesInputs.readSources[tab.id + '\0' + originalRegion]?.source).toEqual(state.documents[key]!.readSource)
}, 60000)

it.runIf(business).each([false, true])('stable Source body input reuses its topology projection beside 500 unrelated Tabs (retained Source: %s)', async retained => {
  const f = await fixture(); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs.js')
  const { prepareRendererUpdate } = await import('../src/renderer/src/store.js')
  const state = f.store.getState(), key = f.workspace.id + '\0original.txt'
  const tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  const regionId = Object.values(tab.regions).find(region => region.kind === 'file')!.regionId
  const unrelated = Object.fromEntries(Array.from({ length: 500 }, (_, index) => {
    const id = 'unrelated-file-' + index
    return [id, createWorkbenchTab(id, { kind: 'file', regionId: id + '-region', workspaceId: f.workspace.id, path: id + '.txt' })]
  }))
  const mount = state.sourceFilesInputs.selections[f.workspace.id]!.locator!.mount
  const sourceWorkspace = 'original-source-workspace:retained-file-fixture'
  const retainedTab = { ...createWorkbenchTab('retained-source-tab', { kind: 'file', regionId: 'retained-source-region', workspaceId: sourceWorkspace, path: 'retained.txt' }),
    source: { reference: mount.reference, zoneId: mount.zoneId, workspaceId: mount.workspaceId, tabId: 'original-source-tab' } }
  f.store.setState({ tabs: { ...unrelated, ...state.tabs, ...(retained ? { [retainedTab.id]: retainedTab } : {}) }, layouts: {
    [f.workspace.id]: createWorkspaceLayout('file-group', [...Object.keys(unrelated), ...Object.keys(state.tabs)]),
    ...(retained ? { [sourceWorkspace]: createWorkspaceLayout('retained-source-group', [retainedTab.id]) } : {})
  } })
  await prepareRendererUpdate('reload')
  let topologyScans = 0, layoutScans = 0
  const tabs = new Proxy(f.store.getState().tabs, { ownKeys(value) { topologyScans++; return Reflect.ownKeys(value) } })
  const layouts = new Proxy(f.store.getState().layouts, { ownKeys(value) { layoutScans++; return Reflect.ownKeys(value) } })
  f.store.setState({ tabs, layouts })
  const partialize = f.store.persist.getOptions().partialize!
  const before = partialize(f.store.getState()).restoredWorkbench
  expect(Boolean(before)).toBe(retained)
  topologyScans = 0; layoutScans = 0
  for (let index = 0; index < 3; index++) f.store.getState().updateDocument(tab.id, 'Source body input ' + index, regionId)
  expect(f.store.getState().tabs).toBe(tabs)
  expect(topologyScans).toBe(0); expect(layoutScans).toBe(0)
  expect(partialize(f.store.getState()).restoredWorkbench).toBe(before)
  await prepareRendererUpdate('reload')
  const saved = JSON.parse((await f.user.read())!).state
  expect(saved.documents[key]).toMatchObject({ content: 'Source body input 2', readSource: state.documents[key]!.readSource })
  expect(saved.dirtyDocuments[key]).toBe(true)
  expect(Object.keys(saved.documents)).toEqual([key])
  expect(saved.sourceFilesInputs.readSources[tab.id + '\0' + regionId].source).toEqual(state.documents[key]!.readSource)
  expect(f.user.observe().lastConfirmedWrite?.diskDurability).toBe('confirmed')
  // Both structural inputs invalidate the retained projection independently.
  if (retained) {
    f.store.setState({ tabs: { ...f.store.getState().tabs, [retainedTab.id]: { ...retainedTab, name: 'Original renamed Tab' } } })
    await prepareRendererUpdate('reload')
    expect(JSON.parse((await f.user.read())!).state.restoredWorkbench.tabs[retainedTab.id].name).toBe('Original renamed Tab')
    const layout = createWorkspaceLayout('changed-file-group', [retainedTab.id])
    f.store.setState({ layouts: { ...f.store.getState().layouts, [sourceWorkspace]: layout } })
    await prepareRendererUpdate('reload')
    expect(JSON.parse((await f.user.read())!).state.restoredWorkbench.layouts[sourceWorkspace]).toEqual(layout)
  }
}, 60000)

it.runIf(business)('a confirmed Source write retains its namespace when its fresh identity read is unavailable', async () => {
  const f = await fixture(); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const state = f.store.getState(), key = f.workspace.id + '\0original.txt', original = state.documents[key]!, tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  const mainRead = vi.spyOn(f.api.files, 'read').mockResolvedValue({ status: 'read', document: { path: 'original.txt', content: 'Unrelated Main body', revision: 'unrelated-main-revision' } }), mainWrite = vi.spyOn(f.api.files, 'write')
  const call = f.bridge.files.call; let written = false
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => {
    if (written && args[1] === 'file.read') throw Error('Private post-write Source read unavailable')
    const result = await call(...args); if (args[1] === 'file.write') written = true; return result
  })
  f.store.getState().updateDocument(tab.id, 'Confirmed original Source body', Object.values(tab.regions).find(region => region.kind === 'file')!.regionId)
  await f.store.getState().saveDocument(tab.id)
  expect(written).toBe(true); expect(await readFile(join(f.source.project, 'original.txt'), 'utf8')).toBe('Confirmed original Source body')
  expect(f.store.getState().documents[key]?.content).toBe('Confirmed original Source body')
  expect(f.store.getState().documents[key]?.readSource).toEqual(original.readSource)
  expect(f.store.getState().documents[key]?.readIdentity).toBeUndefined()
  expect(mainRead).not.toHaveBeenCalled(); expect(mainWrite).not.toHaveBeenCalled()
}, 60000)

it.runIf(business).each(['file', 'directory'] as const)('a confirmed delete of a replacement %s cannot consume the old buffer generation', async kind => {
  const f = await fixture(); await connectFolder(f)
  const path = kind === 'file' ? 'original.txt' : 'original/child.txt'
  if (kind === 'directory') { await mkdir(join(f.source.project, 'original')); await writeFile(join(f.source.project, path), 'Original nested bytes') }
  await f.store.getState().openFile(path, 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0' + path, original = f.store.getState().documents[key]!
  const from = kind === 'file' ? path : 'original'
  await rename(join(f.source.project, from), join(f.source.project, 'kept-original'))
  if (kind === 'directory') await mkdir(join(f.source.project, 'original'))
  await writeFile(join(f.source.project, path), original.content)
  expect(String((await stat(join(f.source.project, path), { bigint: true })).ino)).not.toBe(original.readIdentity?.entry.inode)
  await f.store.getState().deletePath(from, f.workspace.id)
  await expect(readFile(join(f.source.project, path))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.store.getState().documents[key]).toEqual(original)
  expect(f.store.getState().documentIssues[key]?.kind).not.toBe('deleted')
  expect(await readFile(join(f.source.project, 'kept-original', ...(kind === 'directory' ? ['child.txt'] : [])), 'utf8')).toBe(original.content)
}, 60000)

it.runIf(business)('a failed original UserState checkpoint refuses only the unsent Source mutation and keeps its request and draft', async () => {
  const f = await fixture(); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const state = f.store.getState(), key = f.workspace.id + '\0original.txt', tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === 'original.txt'))!
  f.store.getState().updateDocument(tab.id, 'Original unsaved draft during storage failure', Object.values(tab.regions).find(region => region.kind === 'file')!.regionId)
  vi.mocked(f.api.ui.writeWorkbenchState).mockRejectedValue(Error('Private UserState ACK failure'))
  const call = f.bridge.files.call, dispatched: string[] = []
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { if (args[1] === 'file.mkdir') dispatched.push(args[1]); return await call(...args) })
  await expect(f.store.getState().createPath({ path: 'must-not-be-published', kind: 'directory' }, f.workspace.id)).rejects.toThrow('Private UserState ACK failure')
  expect(dispatched).toEqual([])
  await expect(stat(join(f.source.project, 'must-not-be-published'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.store.getState().documents[key]?.content).toBe('Original unsaved draft during storage failure')
  expect(Object.values(f.store.getState().sourceFilesInputs.pending)).toHaveLength(1)
  vi.mocked(f.api.ui.writeWorkbenchState).mockImplementation(value => f.user.write(value))
}, 60000)

it.runIf(business)('a full Source read opened before a real deletion cannot clear its newer disk observation', async () => {
  const f = await fixture(); await connectFolder(f)
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
  const key = f.workspace.id + '\0original.txt', original = f.store.getState().documents[key]!, before = f.store.getState().documentObservationGenerations[key] ?? 0
  let entered!: () => void, release!: () => void
  const held = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }), call = f.bridge.files.call
  cleanup.push(() => release())
  vi.mocked(f.api.sourceFiles.call).mockImplementation(async (...args) => { const reply = await call(...args); if (args[1] === 'file.read') { entered(); await gate } return reply })
  const reading = f.store.getState().refreshDocument(f.workspace.id, 'original.txt'); await held
  await f.store.getState().deletePath('original.txt', f.workspace.id)
  await vi.waitFor(() => expect(f.store.getState().documentIssues[key]?.kind).toBe('deleted'))
  expect(f.store.getState().documentObservationGenerations[key]).toBeGreaterThan(before)
  release(); await reading
  expect(f.store.getState().documentIssues[key]?.kind).toBe('deleted')
  expect(f.store.getState().documents[key]?.content).toBe(original.content)
  expect(f.store.getState().dirtyDocuments[key]).not.toBe(true)
  await expect(readFile(join(f.source.project, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 60000)

it.runIf(business)('a dirty Source baseline refresh adopts only physical identity while preserving its original Note metadata and unconfirmed receipt', async () => {
  const f = await fixture(); await connectFolder(f)
  const path = 'baseline.note.md', noteId = 'baseline-note', blockId = 'baseline-block', original = serializeNoteDocument(newNoteDocument('Original saved body', noteId, blockId, 'Baseline'))
  await writeFile(join(f.source.project, path), original)
  const locator = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!, resource = { hostId: locator.resource.hostId, workspaceId: locator.resource.workspaceId, workspacePath: locator.resource.workspacePath, path }
  const notes = new AgentMuxNotebookStore(undefined, new AgentMuxNotesStorage(join(f.source.state, 'notes-location.json'))), actor = { kind: 'user' as const, id: 'original-author' }
  const created = { actor, at: 1 }, prior = await notes.recordProvenance({ noteId, resource, revision: noteHistoryRevision(original), blocks: { [blockId]: { created, lastEdited: created } } })
  await f.store.getState().openFile(path, 'file-group', undefined, f.workspace.id)
  const tab = Object.values(f.store.getState().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'file' && region.path === path))!, key = f.workspace.id + '\0' + path
  expect(f.store.getState().documents[key]?.noteProvenance).toEqual(prior)
  const draft = original.replace('Original saved body', 'Later unsaved body'), attribution = { status: 'unconfirmed' as const, reason: 'Original write receipt remains unconfirmed' }
  f.store.getState().updateDocument(tab.id, draft)
  // A prior client may have retained the body while its attribution observation
  // was unavailable. A baseline-only refresh cannot certify its original receipt.
  f.store.setState(state => { const { readIdentity: _old, noteProvenance: _unobserved, ...document } = state.documents[key]!; return { documents: { ...state.documents, [key]: { ...document, noteWriteAttribution: attribution } } } })
  const generation = f.store.getState().documentGenerations[key], input = f.store.getState().documents[key]!.noteEditing
  await f.store.getState().refreshDocument(f.workspace.id, path)
  expect(f.store.getState().documents[key]).toMatchObject({ content: draft, revision: noteHistoryRevision(original), noteWriteAttribution: attribution })
  expect(f.store.getState().documents[key]?.noteProvenance).toBeUndefined()
  expect(f.store.getState().documents[key]?.readIdentity?.entry.inode).toBe(String((await stat(join(f.source.project, path), { bigint: true })).ino))
  expect(f.store.getState().documents[key]?.noteEditing).toEqual(input)
  expect(f.store.getState().dirtyDocuments[key]).toBe(true); expect(f.store.getState().documentGenerations[key]).toBe(generation)
}, 60000)

it.runIf(business)('literal Unix candidates continue through actual CLI reads, Source GUI opens and nested Topic Zone directory names without escaping the original scope', async () => {
  const f = await fixture({ scratch: true }); await connectFolder(f)
  const name = 'literal\nback\\slash.txt', content = 'Exact literal Unix file body'
  await writeFile(join(f.source.project, name), content)
  const locator = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator!, r = locator.resource
  const flags = ['--endpoint', 'unix:' + f.source.socketPath], resourceFlags = ['--zone', r.zoneId, '--host', r.hostId, '--workspace', r.workspaceId, '--workspace-path', r.workspacePath]
  const listed = await runCompiledObjectCli([...flags, 'file', 'ls', ...resourceFlags], objectCliEnvironment(f.source.state))
  expect(listed.code, listed.stdout + listed.stderr).toBe(0); expect(JSON.parse(listed.stdout).result.result.files).toContain(name)
  const read = await runCompiledObjectCli([...flags, 'file', 'read', ...resourceFlags, '--path', name], objectCliEnvironment(f.source.state))
  expect(read.code, read.stdout + read.stderr).toBe(0); expect(JSON.parse(read.stdout).result.result.document).toMatchObject({ path: name, content })
  const binaryName = 'binary\nback\\slash.bin'; await writeFile(join(f.source.project, binaryName), Buffer.from([0, 1, 2, 3]))
  const binary = await runCompiledObjectCli([...flags, 'file', 'read', ...resourceFlags, '--path', binaryName], objectCliEnvironment(f.source.state))
  expect(binary.code, binary.stdout + binary.stderr).toBe(0); expect(JSON.parse(binary.stdout).result.result).toMatchObject({ status: 'binary', path: binaryName, byteLength: 4 })
  await f.store.getState().openFile(name, 'file-group', undefined, f.workspace.id)
  expect(f.store.getState().documents[f.workspace.id + '\0' + name]).toMatchObject({ path: name, content, readSource: { resource: { path: name } } })
  const created = await f.source.rpc.call('topic.create', { topicId: mintObjectId(), title: 'Literal nested Source Zone' })
  const directory = 'inside\nfolder\\part'; await mkdir(join(created.topic.directoryPath, directory)); await writeFile(join(created.topic.directoryPath, directory, name), content)
  const mount = { hostId: f.source.id, reference: { runtimeId: f.source.identity.runtimeId, spaceId: created.topic.categorySpaceIds[0]! }, zoneId: created.topic.zoneId!, workspaceId: created.topic.workspaceId }
  const mapped = await f.runtime.resolveSourceFiles({ hostId: f.source.id, expectedRuntimeId: f.source.identity.runtimeId }, { kind: 'mount', mount })
  if (mapped.status !== 'located') throw new Error('An actual nested Topic Zone locator is required')
  const topic = mapped.locator.resource, nestedFlags = ['--zone', topic.zoneId, '--host', topic.hostId, '--workspace', topic.workspaceId, '--workspace-path', topic.workspacePath]
  const entries = await runCompiledObjectCli([...flags, 'file', 'ls', ...nestedFlags, '--directory', '--path', directory], objectCliEnvironment(f.source.state))
  expect(entries.code, entries.stdout + entries.stderr).toBe(0)
  const entry = JSON.parse(entries.stdout).result.result.entries.find((entry: { name: string }) => entry.name === name)
  expect(entry).toBeTruthy(); expect(entry.path).not.toBe(directory + '/' + name)
  const continuation = await runCompiledObjectCli([...flags, 'file', 'read', ...nestedFlags, '--path', directory + '/' + entry.name], objectCliEnvironment(f.source.state))
  expect(continuation.code, continuation.stdout + continuation.stderr).toBe(0); expect(JSON.parse(continuation.stdout).result.result.document.content).toBe(content)
  const native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'read'), count = native.mock.calls.length
  for (const path of ['../escaped.txt', '/absolute.txt', 'inside/../../escaped.txt', 'bad\0name']) await expect(f.source.rpc.call('file.read', { zoneId: r.zoneId, path,
    expectedResource: { hostId: r.hostId, workspaceId: r.workspaceId, workspacePath: r.workspacePath } })).rejects.toBeTruthy()
  expect(native).toHaveBeenCalledTimes(count)
}, 60000)

async function repeatedWorkingLocations() {
  const f = await fixture(), rpc = f.source.rpc
  const observed = await rpc.call('space.folder.inspect', { runtimeId: f.source.identity.runtimeId, path: f.source.project })
  const saved = await rpc.call('space.folder.register', { runtimeId: f.source.identity.runtimeId, directory: observed.resource! })
  const { readSpaceSnapshot } = await import('@agentmux/core')
  const snapshot = await readSpaceSnapshot(rpc, saved.reference)
  const zone = snapshot.scope.zones.find(zone => zone.zoneId === saved.zoneId)!
  await rpc.call('space.apply', { reference: saved.reference, expectedRevision: snapshot.revision, changes: {
    zones: [{ ...zone, zoneId: 'another-working-position' }], bindings: [...snapshot.scope.bindings, { spaceId: saved.reference.spaceId, zoneId: 'another-working-position' }]
  } })
  const ambiguous = await f.bridge.files.resolve({ hostId: f.source.id, expectedRuntimeId: f.source.identity.runtimeId }, { kind: 'directory', path: f.source.project })
  expect(ambiguous.status).toBe('selection-required')
  return { ...f, saved, ambiguous }
}

it.runIf(business)('working location context reaches actual Files without asking for the same directory registration again', async () => {
  const f = await repeatedWorkingLocations(), workspace = { ...f.workspace, id: f.saved.workspaceId, hostId: 'local' }
  f.routes.set('local', f.routes.get(f.source.id)!)
  const graph = await new AgentMuxSpatialStateStore(join(f.source.state, 'spatial.json')).read()
  const local = await f.api.spatial.read()
  const next = structuredClone(local!.graph)
  for (const [kind, key] of [['spaces', 'spaceId'], ['zones', 'zoneId']] as const) {
    for (const value of graph!.graph[kind]) if (!next[kind].some(item => (item as any)[key] === (value as any)[key])) (next[kind] as any[]).push(value)
  }
  next.bindings.push(...graph!.graph.bindings); next.resources = { ...next.resources, ...graph!.graph.resources }
  await f.api.spatial.commit({ expectedRevision: local!.revision, graph: next })
  const { currentCoreSpatialGraph } = await import('../src/renderer/src/store.js')
  await vi.waitFor(() => expect(currentCoreSpatialGraph()?.zones.some(value => value.zoneId === f.saved.zoneId)).toBe(true))
  const state = f.store.getState(), original = { spaceId: f.saved.reference.spaceId, zoneId: f.saved.zoneId, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null }
  f.store.setState({ config: { ...state.config!, workspaces: [workspace] }, activeWorkspaceId: workspace.id, workbenchSpaceSelection: original, sourceFilesInputs: { selections: {}, pending: {}, creations: {}, folderRequests: {} } })
  const resolved = await f.store.getState().resolveFilesSource(workspace.id)
  expect(resolved).toMatchObject({ status: 'located', locator: { mount: { reference: f.saved.reference, zoneId: f.saved.zoneId, workspaceId: f.saved.workspaceId } } })
  expect(f.api.sourceFiles.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: 'local' }), { kind: 'mount', mount: expect.objectContaining({ reference: f.saved.reference, zoneId: f.saved.zoneId }) })
  const { readWorkspaceDirectory } = await import('../src/renderer/src/lib/source-files-discovery.js')
  expect((await readWorkspaceDirectory(workspace.id, '', f.store.getState)).entries.map(value => value.name)).toContain('original.txt')
  expect(f.store.getState().workbenchSpaceSelection).toBe(original)
})

it.runIf(business)('working location chooser accepts the first explicit click through real Source adapters', async () => {
  const f = await repeatedWorkingLocations(), { SourceFilesAccess } = await import('../src/renderer/src/components/SourceFilesAccess.js')
  const element = document.createElement('div'), root = createRoot(element); document.body.append(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(createElement(SourceFilesAccess, { workspace: f.workspace, visible: true })))
  await vi.waitFor(() => expect(element.textContent).toContain('Choose working location'))
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]).toBeUndefined()
  const disclosure = element.querySelector('details')!
  expect(disclosure.open).toBe(false)
  expect(element.textContent).not.toContain('Choose current Source')
  disclosure.open = true
  const button = [...element.querySelectorAll('button')].find(value => value.textContent === 'Use this location')!
  await act(async () => button.click())
  await vi.waitFor(() => expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]?.locator).toBeTruthy())
  expect(element.querySelector('.file-operation-service')).toBeNull()
})

it.runIf(business)('working location observation cannot replace a later exact position selection', async () => {
  const f = await repeatedWorkingLocations(), workspace = { ...f.workspace, id: f.saved.workspaceId, hostId: 'local' }, state = f.store.getState()
  f.routes.set('local', f.routes.get(f.source.id)!)
  const graph = await new AgentMuxSpatialStateStore(join(f.source.state, 'spatial.json')).read()
  const local = await f.api.spatial.read()
  const next = structuredClone(local!.graph)
  for (const [kind, key] of [['spaces', 'spaceId'], ['zones', 'zoneId']] as const) {
    for (const value of graph!.graph[kind]) if (!next[kind].some(item => (item as any)[key] === (value as any)[key])) (next[kind] as any[]).push(value)
  }
  next.bindings.push(...graph!.graph.bindings); next.resources = { ...next.resources, ...graph!.graph.resources }
  await f.api.spatial.commit({ expectedRevision: local!.revision, graph: next })
  const { currentCoreSpatialGraph } = await import('../src/renderer/src/store.js')
  await vi.waitFor(() => expect(currentCoreSpatialGraph()?.zones.some(value => value.zoneId === f.saved.zoneId)).toBe(true))
  const original = { spaceId: f.saved.reference.spaceId, zoneId: f.saved.zoneId, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null }
  f.store.setState({ config: { ...state.config!, workspaces: [workspace] }, activeWorkspaceId: workspace.id, workbenchSpaceSelection: original, sourceFilesInputs: { selections: {}, pending: {}, creations: {}, folderRequests: {} } })
  const real = f.bridge.files.resolve; let finish!: () => void
  const held = new Promise<void>(yes => { finish = yes })
  vi.mocked(f.api.sourceFiles.resolve).mockImplementation(async (...args) => { const result = await real(...args); await held; return result })
  const pending = f.store.getState().resolveFilesSource(workspace.id)
  await vi.waitFor(() => expect(f.api.sourceFiles.resolve).toHaveBeenCalled())
  const later = { ...original, zoneId: 'another-working-position' }
  f.store.setState({ workbenchSpaceSelection: later }); finish()
  expect(await pending).toMatchObject({ status: 'unconfirmed' })
  expect(f.store.getState().sourceFilesInputs.selections[workspace.id]).toBeUndefined()
  expect(f.store.getState().workbenchSpaceSelection).toBe(later)
})

it.runIf(business)('working location explicit choice is retained before observation and later clicks win', async () => {
  const f = await repeatedWorkingLocations()
  if (f.ambiguous.status !== 'selection-required') throw Error('Expected real distinct working positions')
  const [a, b] = f.ambiguous.registrations.map(value => ({ hostId: f.source.id, reference: value.reference, zoneId: value.zoneId, workspaceId: value.workspaceId }))
  const real = f.bridge.files.resolve; let finish!: () => void
  const held = new Promise<void>(yes => { finish = yes })
  vi.mocked(f.api.sourceFiles.resolve).mockImplementation(async (...args) => { const result = await real(...args); await held; return result })
  const first = f.store.getState().selectFilesRegistration(f.workspace.id, a!)
  await vi.waitFor(() => expect(f.api.sourceFiles.resolve).toHaveBeenCalled())
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]?.selection).toMatchObject({ registration: a })
  vi.mocked(f.api.sourceFiles.resolve).mockImplementation(real)
  await f.store.getState().selectFilesRegistration(f.workspace.id, b!)
  finish(); await expect(first).rejects.toThrow('Later Source selection')
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]?.locator?.mount.zoneId).toBe(b!.zoneId)
  vi.mocked(f.api.sourceFiles.resolve).mockRejectedValueOnce(Error('Original Source observation unavailable'))
  await expect(f.store.getState().selectFilesRegistration(f.workspace.id, a!)).rejects.toThrow('observation unavailable')
  const selected = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!
  expect(selected.selection).toMatchObject({ registration: a }); expect(selected.locator).toBeUndefined()
  expect(selected.issue).toContain('observation unavailable')
  const { readWorkspaceDirectory } = await import('../src/renderer/src/lib/source-files-discovery.js')
  const main = vi.spyOn(f.api.files, 'readDirectory')
  await expect(readWorkspaceDirectory(f.workspace.id, '', f.store.getState)).rejects.toThrow('unconfirmed')
  expect(main).not.toHaveBeenCalled()
  vi.mocked(f.api.sourceFiles.resolve).mockImplementation(real)
  await f.store.getState().selectFilesRegistration(f.workspace.id, b!)
  const known = f.store.getState().sourceFilesInputs.selections[f.workspace.id]!.locator
  vi.mocked(f.api.sourceFiles.resolve).mockRejectedValueOnce(Error('Same position observation unavailable'))
  await expect(f.store.getState().selectFilesRegistration(f.workspace.id, b!)).rejects.toThrow('Same position observation')
  expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]?.locator).toBe(known)
})

it.runIf(business)('working location Source projection uses the original registration through the same Files owner', async () => {
  const f = await repeatedWorkingLocations()
  const target = { hostId: f.source.id, reference: f.saved.reference, zoneId: f.saved.zoneId, workspaceId: f.saved.workspaceId }
  const { readSpaceSnapshot } = await import('@agentmux/core')
  const snapshot = await readSpaceSnapshot(f.source.rpc, f.saved.reference)
  f.store.getState().openOriginalSpaceLocation({ target })
  f.store.getState().observeSpaceMount(target, { snapshot, reading: false })
  const workspaceId = f.store.getState().activeWorkspaceId!
  expect(workspaceId).not.toBe(f.workspace.id)
  await expect(f.store.getState().resolveFilesSource(workspaceId)).resolves.toMatchObject({ status: 'located', locator: { mount: target } })
  const { readWorkspaceDirectory, listWorkspaceFileNames } = await import('../src/renderer/src/lib/source-files-discovery.js')
  const main = vi.spyOn(f.api.files, 'readDirectory'), names = vi.spyOn(f.api.files, 'list')
  expect((await readWorkspaceDirectory(workspaceId, '', f.store.getState)).entries.map(value => value.name)).toContain('original.txt')
  expect((await listWorkspaceFileNames(workspaceId, f.store.getState)).files).toContain('original.txt')
  expect(main).not.toHaveBeenCalled(); expect(names).not.toHaveBeenCalled()
})

it.runIf(business)('Topic and Mote mutations use their own directory when the common Scratch registration is unconfirmed', async () => {
  const f = await fixture({ scratch: true }), workspace = { id: '__scratch__', hostId: 'local', path: f.source.scratch, name: 'Scratch', kind: 'folder' as const }
  f.routes.set('local', { client: f.source.client })
  const { ScratchTopics } = await import('../../host/src/mote-resources')
  const { scratchTopicDirectoryName, scratchTopicPhysicalPath } = await import('@agentmux/host/mote-model')
  const topics = new ScratchTopics()
  const topicA = mintObjectId(), topicB = mintObjectId()
  for (const id of [topicA, topicB]) await f.source.rpc.call('topic.create', { topicId: id, title: 'Shared title' })
  await f.source.rpc.call('topic.promote.apply', { topicId: topicA, operationId: crypto.randomUUID() })
  const a = (await topics.read(workspace, topicA))!, b = (await topics.read(workspace, topicB))!
  const first = scratchTopicDirectoryName(a.id), second = scratchTopicDirectoryName(b.id)
  const aPath = scratchTopicPhysicalPath(workspace, a), bPath = scratchTopicPhysicalPath(workspace, b)
  await writeFile(join(aPath, 'entry.txt'), 'the first original')
  await writeFile(join(bPath, 'entry.txt'), 'the second original')
  const common = { workspace, target: { hostId: 'local', expectedRuntimeId: f.source.identity.runtimeId }, selection: { kind: 'directory' as const, path: workspace.path }, registrationStatus: 'unknown' as const }
  f.store.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces, workspace] },
    scratchTopicSnapshots: { [workspace.id]: { scope: JSON.stringify([workspace.hostId, workspace.path]), revision: 1, topics: [a, b], error: null, reading: false } },
    sourceFilesInputs: { ...state.sourceFilesInputs, selections: { [workspace.id]: common } } }))
  const app = f.store.getState()
  await app.createPath({ kind: 'file', path: first + '/new.txt' }, workspace.id)
  expect(await readFile(join(aPath, 'new.txt'), 'utf8')).toBe('')
  await expect(stat(join(bPath, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(app.renamePath(first + '/entry.txt', second + '/moved.txt', workspace.id)).rejects.toThrow('original Topic directory')
  const target = { zoneId: (await import('@agentmux/host/topic-categories')).topicContentZoneId(workspace, a), path: 'entry.txt',
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
  const original = await f.source.rpc.call('file.read', target)
  if (original.result.status !== 'read' || !original.result.document.readIdentity) throw new Error('The original editor generation is required')
  const baseline = original.result.document
  const key = workspace.id + '\0' + first + '/entry.txt', movedKey = workspace.id + '\0' + first + '/moved.txt'
  f.store.setState(state => ({ documents: { ...state.documents, [key]: { ...baseline,
    path: first + '/entry.txt', content: 'unsaved first draft' } },
    dirtyDocuments: { ...state.dirtyDocuments, [key]: true } }))
  await app.renamePath(first + '/entry.txt', first + '/moved.txt', workspace.id)
  expect(f.store.getState().documents[movedKey]).toMatchObject({ content: 'unsaved first draft' })
  expect(f.store.getState().documents[movedKey]?.readSource).toBeUndefined()
  expect(await readFile(join(aPath, 'moved.txt'), 'utf8')).toBe('the first original')
  expect(await readFile(join(bPath, 'entry.txt'), 'utf8')).toBe('the second original')
  await app.deletePath(first + '/moved.txt', workspace.id)
  expect(f.store.getState().documentIssues[movedKey]?.kind).toBe('deleted')
  expect(f.store.getState().documents[movedKey]?.content).toBe('unsaved first draft')
  await expect(stat(join(aPath, 'moved.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

  // Lose the original reply after the real Host publishes. A second object can still make its own directory.
  const call = f.api.sourceFiles.call
  let loseReply = true
  const realCall = f.bridge.files.call
  vi.mocked(call).mockImplementation(async (target, method, request, signal) => {
    const response = await realCall(target, method, request, signal)
    if (method === 'file.mkdir' && loseReply) { loseReply = false; throw new Error('Original reply unavailable') }
    return response
  })
  await expect(app.createPath({ kind: 'directory', path: first + '/result' }, workspace.id)).rejects.toThrow('Original reply unavailable')
  const [operationId, held] = Object.entries(f.store.getState().sourceFilesInputs.pending)[0]!
  expect(held.request.expectedResource.path).toBe(first + '/result')
  await app.createPath({ kind: 'directory', path: second + '/result' }, workspace.id)
  await app.createPath({ kind: 'directory', path: first + '/other' }, workspace.id)
  await expect(app.createPath({ kind: 'directory', path: first + '/result' }, workspace.id)).rejects.toThrow('retained original request')
  expect(await Promise.all([aPath, bPath].map(async path => (await stat(join(path, 'result'))).isDirectory()))).toEqual([true, true])
  await app.inspectFilesMutation(operationId)
  const inspected = vi.mocked(call).mock.settledResults.at(-1)
  expect(inspected).toMatchObject({ value: { result: { result: { action: 'mkdir', filesystem: 'created', durability: 'unconfirmed' } } } })
  expect(f.store.getState().sourceFilesInputs.pending[operationId]?.request).toEqual(held.request)
  expect(f.store.getState().sourceFilesInputs.selections[workspace.id]).toBe(common)
  expect(vi.mocked(call).mock.calls.filter(([, method]) => method === 'file.mkdir')).toHaveLength(3)
}, 60000)

it.runIf(business)('a pending file move serializes saves only inside its own Topic', async () => {
  const { fileMutationTail, withWorkspaceFileMutation } = await import('../src/renderer/src/lib/file-document-bookkeeping')
  const { scratchTopicDirectoryName } = await import('@agentmux/host/mote-model')
  const paths = [mintObjectId(), mintObjectId()].map(id => scratchTopicDirectoryName(id) + '/entry.txt')
  const [a, b] = paths as [string, string]
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const operation = withWorkspaceFileMutation('__scratch__', a, () => gate)
  let waiting = true, independent = false
  const same = fileMutationTail('__scratch__', a).then(() => { waiting = false })
  const other = fileMutationTail('__scratch__', b).then(() => { independent = true })
  try {
    await Promise.resolve()
    expect(independent).toBe(true)
    expect(waiting).toBe(true)
  } finally { release(); await Promise.all([operation, same, other]) }
})
