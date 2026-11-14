// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteFileWriter } from '../../host/src/note-file-writer.js'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state.js'
import { OrdinaryWorkspaceFiles } from '../../host/src/ordinary-files.js'
import { sourceFilesHosts } from './helpers/source-files-hosts.js'
import { sourceFilesIpcBridge } from './helpers/source-files-ipc-bridge.js'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import type { AppConfig } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => '/private-unused' } }))
const native = process.env.AGENTMUX_TEST_FILE_CLIENT_NATIVE === '1'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it.runIf(!native)('runs the shipping UserState consumer in its own private process', async () => {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/vitest.file-path-client.config.mts', '--maxWorkers=1'], {
    cwd: resolve(import.meta.dirname, '../../..'), env: { ...process.env, AGENTMUX_TEST_FILE_CLIENT_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise<number | null>((yes, no) => { child.once('error', no); child.once('close', yes) })
  expect(code, log).toBe(0); expect(log).toMatch(/[1-9]\d* passed/)
}, 180000)

async function fixture(options: { sharedProject?: boolean } = {}) {
  vi.resetModules(); window.localStorage.clear(); vi.stubGlobal('crypto', webcrypto)
  const f = await sourceFilesHosts(cleanup, options), source = f.sources[1]!, bridge = sourceFilesIpcBridge(f.runtime, cleanup)
  const { api } = await import('../src/renderer/src/lib/api.js'), { useAppStore: store } = await import('../src/renderer/src/store.js')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state.js')
  const workspace = { id: 'display-files', hostId: source.id, path: source.project, name: 'Source Files', kind: 'folder' as const }
  const config = { version: 9, hosts: [{ id: source.id, kind: 'local', label: 'Private Source carrier' }], executors: {}, workspaces: [workspace],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } } as AppConfig
  store.setState({ config, tabs: {}, documents: {}, layouts: { [workspace.id]: createWorkspaceLayout('file-group', []) }, activeWorkspaceId: workspace.id })
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'desktop-spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
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

it.runIf(native)('original Files UI checkpoints the directory packet before registration and CLI delete retains a clean body in actual UserState', async () => {
  const f = await fixture(), { SourceFilesAccess } = await import('../src/renderer/src/components/SourceFilesAccess.js')
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(createElement(SourceFilesAccess, { workspace: f.workspace, visible: true })))
  await vi.waitFor(() => expect(element.textContent).toContain('Use this folder for Files'))
  const use = [...element.querySelectorAll('button')].find(button => button.textContent === 'Use this folder for Files')!
  await act(async () => use.click())
  await vi.waitFor(() => expect(f.store.getState().sourceFilesInputs.selections[f.workspace.id]?.locator).toBeTruthy())
  expect(f.api.spaceMounts.call).toHaveBeenCalledWith('register', expect.objectContaining({ hostId: f.source.id, registration: expect.objectContaining({ runtimeId: f.source.identity.runtimeId }) }))
  await f.store.getState().openFile('original.txt', 'file-group', undefined, f.workspace.id)
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

it.runIf(native)('original GUI mkdir, file creation, directory move and delete consume Source receipts once while keeping the same draft and View identities', async () => {
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

it.runIf(native)('a lost directory registration reply keeps the original packet across read-only reconciliation and never registers twice', async () => {
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
}, 60000)

it.runIf(native)('consecutive Source saves keep their original binding and refresh same-FD identity; another Runtime sharing the physical file cannot receive the old draft', async () => {
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

it.runIf(native)('unknown write checks the captured old Source even after selecting a new Runtime with identical bytes on the same physical file', async () => {
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

it.runIf(native)('two real Notes owners with the same Note ID keep their creators and history separate while Source edit, restore and undo use their own owner', async () => {
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
  expect(await readFile(main.path)).toEqual(mainRoot)
  expect(await main.readHistory({ noteId, resource: mainResource, eventId: 'main-only-event', includeContent: true })).toEqual(mainHistory)
  expect(await main.readProvenance({ noteId, resource: mainResource, revision: noteHistoryRevision(original), blockIds: [blockId] })).toEqual(mainProvenance)
}, 60000)

it.runIf(native)('Source text saves keep older sharing requests and cleanup separate; new promotions and late-bound Main retries never dispatch', async () => {
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
  const include = stageNoteShare(key, { version: 1, source: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path, path, noteId: 'reference-note' },
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

it.runIf(native)('GUI Source Note creation waits on the original Notes lease while an ordinary file remains writable', async () => {
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

it.runIf(native)('GUI directory move and Note deletion borrow the same original Source Notes lease', async () => {
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

it.runIf(native)('Source file creation returns its captured display Workspace across a late active Workspace switch', async () => {
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
