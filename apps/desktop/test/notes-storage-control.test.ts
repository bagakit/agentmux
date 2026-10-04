import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '../../../packages/core/src/notebook-store.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { NotesStorageOwner } from '../src/main/notes-storage-owner.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { reconcileNotesStorageResources, reconcileNotesCreationReceipt, reobserveNotesStorageResources } from '../src/renderer/src/lib/notes-storage-reconciliation'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { noteCreationTarget } from '../src/renderer/src/lib/note-creation'
import { reconcileNotesSpatialResources } from '../src/shared/notes-storage-reconciliation'
import { api } from '../src/renderer/src/lib/api'
import type { AppConfig } from '../src/shared/contracts'
import type { FileWorkbenchState } from '../src/renderer/src/lib/file-workbench-state'
import type { AgentMuxSpatialGraph } from '../../../packages/core/src/spatial-graph'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp/notes-storage-control-fixture") } }))
const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const change = { noteId: 'original', from: { hostId: 'local', workspaceId: '__scratch__', workspacePath: _hygiene_fixturePath("old"), path: 'one.note.json' }, to: { hostId: 'local', workspaceId: '__notes__', workspacePath: _hygiene_fixturePath("notes"), path: 'one.note.json' } }
describe('Notes storage original production consumers', () => {
  it('reconciles only file resources while retaining Tab, Region, Zone, layout, draft and execution facts', () => {
    const key = '__scratch__\0one.note.json', layout = { retained: 'same-layout' }
    const state = { tabs: { originalTab: { id: 'originalTab', workspaceId: '__scratch__', space: { spaceId: 'source', zoneId: 'originalZone' }, titleRegionId: 'originalRegion', layout, regions: { originalRegion: { regionId: 'originalRegion', kind: 'file', workspaceId: '__scratch__', path: 'one.note.json' }, agent: { regionId: 'agent', kind: 'agent', workspaceId: '__scratch__', sessionId: 'healthy' } } } }, documents: { [key]: { content: 'UNSAVED DRAFT', path: 'one.note.json', workspaceId: '__scratch__' } }, dirtyDocuments: { [key]: true }, documentGenerations: { [key]: 9 }, documentObservationGenerations: {}, documentIssues: {}, savingDocuments: {}, layouts: { original: layout }, lastActiveFileByWorkspace: {}, fileExplorerStates: {} } as unknown as FileWorkbenchState
    const result = reconcileNotesStorageResources(state, [change]), nextKey = '__notes__\0one.note.json'
    expect(Object.keys(result.tabs)).toEqual(['originalTab']); expect(result.tabs.originalTab?.regions.originalRegion).toMatchObject({ regionId: 'originalRegion', workspaceId: '__notes__' })
    expect(result.tabs.originalTab?.regions.agent).toEqual(state.tabs.originalTab?.regions.agent); expect(result.tabs.originalTab?.space).toEqual(state.tabs.originalTab?.space)
    expect(result.layouts).toBe(state.layouts); expect(result.documents[nextKey]?.content).toBe('UNSAVED DRAFT'); expect(result.dirtyDocuments[nextKey]).toBe(true); expect(result.documentGenerations[nextKey]).toBe(9)
    const graph = { zones: [], regions: [{ kind: 'file', regionId: 'originalRegion', tabId: 'originalTab', execution: null }, { kind: 'agent', regionId: 'agent', execution: { cwd: _hygiene_fixturePath("old"), hostId: 'local' } }], resources: { 'region:originalRegion': { workspaceId: '__scratch__', path: 'one.note.json' }, 'region:agent': { sessionId: 'healthy', cwd: _hygiene_fixturePath("old") } } } as unknown as AgentMuxSpatialGraph
    const nextGraph = reconcileNotesSpatialResources(graph, [change]); expect(nextGraph.regions).toBe(graph.regions); expect(nextGraph.resources['region:agent']).toBe(graph.resources['region:agent']); expect(nextGraph.resources['region:originalRegion']).toMatchObject({ workspaceId: '__notes__' })
  })
  it('rebinds the dedicated Notes Zone birth resource and creates a new page under the current root without moving execution cwd', () => {
    const spaceId = directoryIdentity('local', _hygiene_fixturePath("old")), zoneId = workspaceZoneId(spaceId, '__notes__')
    const tab = createWorkbenchTab('original-launcher', { regionId: initialWorkbenchRegionId('original-launcher'), kind: 'launcher', workspaceId: '__notes__' }); tab.space = { spaceId, zoneId }
    const state = { config: { workspaces: [{ id: '__notes__', hostId: 'local', path: _hygiene_fixturePath("notes"), kind: 'folder' }] }, sessions: [], tabs: { [tab.id]: tab }, layouts: { __notes__: createWorkspaceLayout('same-group', [tab.id]) }, spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: '__notes__', directoryPath: _hygiene_fixturePath("old") } }, spatialRequests: {}, documents: {}, dirtyDocuments: {}, documentGenerations: {}, documentObservationGenerations: {}, documentIssues: {}, savingDocuments: {} } as any
    const moves = [{ from: _hygiene_fixturePath("old"), to: _hygiene_fixturePath("notes") }], next = reconcileNotesStorageResources(state, [], moves)
    const target = noteCreationTarget(next, [], { workspaceId: '__notes__', groupId: 'same-group', launcher: { tabId: tab.id, regionId: initialWorkbenchRegionId(tab.id) } })
    expect(target).toMatchObject({ zoneId, sourceSpaceId: spaceId, workspacePath: _hygiene_fixturePath("notes"), directoryPath: _hygiene_fixturePath("notes") })
    const graph = { zones: [{ zoneId, workspaceId: '__notes__', directoryPath: _hygiene_fixturePath("old") }, { zoneId: 'foreign', workspaceId: '__scratch__', directoryPath: _hygiene_fixturePath("old") }], regions: [{ kind: 'agent', regionId: 'healthy', execution: { cwd: _hygiene_fixturePath("old") } }], resources: { ['zone:' + zoneId]: { directoryPath: _hygiene_fixturePath("old") } } } as unknown as AgentMuxSpatialGraph
    const mapped = reconcileNotesSpatialResources(graph, [], moves)
    expect(mapped.zones[0]).toMatchObject({ zoneId, directoryPath: _hygiene_fixturePath("notes") }); expect(mapped.zones[1]).toBe(graph.zones[1])
    expect(mapped.regions).toBe(graph.regions); expect(mapped.resources['zone:' + zoneId]).toMatchObject({ directoryPath: _hygiene_fixturePath("notes") })
  })
  it('keeps both conflicting dirty drafts while still admitting the canonical relocated file surface', () => {
    const oldKey = '__scratch__\0one.note.json', newKey = '__notes__\0one.note.json'
    const tab = createWorkbenchTab('retained-file', { regionId: 'file', kind: 'file', workspaceId: '__scratch__', path: 'one.note.json' })
    const state = { tabs: { [tab.id]: tab }, documents: { [oldKey]: { content: 'OLD UNSAVED' }, [newKey]: { content: 'NEW UNSAVED' } }, dirtyDocuments: { [oldKey]: true, [newKey]: true }, documentGenerations: {}, documentObservationGenerations: {}, documentIssues: {}, savingDocuments: {} } as any
    const mapped = reconcileNotesStorageResources(state, [change])
    expect(mapped.tabs[tab.id].regions.file.workspaceId).toBe('__notes__'); expect(mapped.documents[oldKey]).toBeUndefined(); expect(mapped.documents[newKey].content).toBe('NEW UNSAVED')
    expect(mapped.documentIssues[newKey]).toBeUndefined()
    expect(mapped.retainedDocumentDrafts[newKey]).toMatchObject([{ content: 'OLD UNSAVED' }])
  })
  it('does not reacquire a Note file watcher after its original consumer closes during reobservation', async () => {
    const tab = createWorkbenchTab('closing-file', { regionId: 'file', kind: 'file', workspaceId: '__notes__', path: 'one.note.json' })
    let current = { tabs: { [tab.id]: tab } } as any, release!: () => void
    const unobserve = vi.spyOn(api.files, 'unobserve').mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const observe = vi.spyOn(api.files, 'observe').mockResolvedValue({ status: 'unavailable' } as any)
    const pending = reobserveNotesStorageResources(current, [change], () => current)
    current = { tabs: {} }; release(); await pending
    expect(unobserve).toHaveBeenCalledWith('__scratch__', 'one.note.json'); expect(observe).not.toHaveBeenCalled()
    unobserve.mockRestore(); observe.mockRestore()
  })
  it('retains the original creating intent and new input when its directory moves', () => {
    const receipt = { intentId: 'same-intent', noteId: 'original', blockIds: ['same-block'], path: 'one.note.json', draft: 'UNSAVED', target: { workspaceId: '__scratch__', workspacePath: _hygiene_fixturePath("old"), directoryPath: _hygiene_fixturePath("old"), hostId: 'local', zoneId: 'same-zone', groupId: 'same-group' } } as any
    expect(reconcileNotesCreationReceipt(receipt, [change], _hygiene_fixturePath("notes"))).toMatchObject({ intentId: 'same-intent', blockIds: ['same-block'], draft: 'UNSAVED', target: { workspaceId: '__notes__', workspacePath: _hygiene_fixturePath("notes"), directoryPath: _hygiene_fixturePath("notes"), zoneId: 'same-zone' } })
  })
  it('changes the real directory through shipping CLI and the same Settings owner, then inspects the original operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notes-settings-')); roots.push(root); const original = join(root, 'notes'), target = join(root, 'new notes'); await mkdir(original)
    const storage = new AgentMuxNotesStorage(join(root, 'state', 'notes-location.json'), original), store = new AgentMuxNotebookStore(undefined, storage)
    await writeFile(join(original, 'one.note.json'), JSON.stringify({ noteId: 'original', blocks: ['same-block'] }))
    await store.apply({ expectedRevision: 0, operationId: 'register', change: { kind: 'register', noteId: 'original', title: 'Saved', resource: { ...change.to, workspacePath: original } } }, { kind: 'user', id: 'test' })
    let config = { hosts: [], executors: {}, workspaces: [{ id: '__notes__', name: 'Recall', hostId: 'local', kind: 'folder', path: original }] } as unknown as AppConfig
    const configOwner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value } }), snapshots: unknown[] = []
    const spatial = new AgentMuxSpatialStateStore(join(root, 'state', 'spatial.json'))
    const spaceId = directoryIdentity('local', original), zoneId = workspaceZoneId(spaceId, '__notes__')
    const launcher = createWorkbenchTab('retained-launcher', { regionId: 'launcher-region', kind: 'launcher', workspaceId: '__notes__' }); launcher.space = { spaceId, zoneId }
    const originalGraph: AgentMuxSpatialGraph = { spaces: [{ spaceId, kind: 'folder', name: 'Recall', hostId: 'local', directoryPath: original, projectId: null }], zones: [{ zoneId, workspaceId: '__notes__', kind: 'directory', hostId: 'local', directoryPath: original, branch: null }], tabs: [{ tabId: launcher.id, workspaceId: '__notes__', zoneId, name: null, regionIds: ['launcher-region'] }], regions: [{ tabId: launcher.id, regionId: 'launcher-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null }], bindings: [{ spaceId, zoneId }], layouts: { __notes__: createWorkspaceLayout('retained-group', [launcher.id]) }, tabLayouts: { [launcher.id]: launcher.layout }, resources: { ['zone:' + zoneId]: { directoryPath: original, workspaceId: '__notes__', spaceId } } }
    await spatial.commit({ expectedRevision: 0, graph: originalGraph })
    const owner = new NotesStorageOwner(configOwner, spatial, value => snapshots.push(value), storage)
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), notebookStore: store, coreClients: () => [], execute: request => { if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected request'); return executeSettingsControl(request, configOwner, owner) } }); servers.push(server); await server.start()
    const out = resolve('.local/recall/storage-cli.mjs'); await symlink('../../packages/core/node_modules', join(dirname(out), 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error }); await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: out, platform: 'node', format: 'esm', packages: 'external', bundle: true, logLevel: 'silent' })
    const exec = promisify(execFile), env = { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined }
    const listed = JSON.parse((await exec(process.execPath, [out, 'settings', 'inspect', 'notes'], { env, timeout: 5000 })).stdout)
    expect(listed.result.entries).toContainEqual(expect.objectContaining({ key: 'notes.directory', value: original }))
    const saved = JSON.parse((await exec(process.execPath, [out, 'settings', 'set', 'notes.directory', target], { env, timeout: 5000 })).stdout)
    expect(saved.result.entry.value).toBe(target); expect(config.workspaces[0]?.path).toBe(target); expect(snapshots).toHaveLength(1)
    expect(JSON.parse(await readFile(join(target, 'one.note.json'), 'utf8')).noteId).toBe('original')
    const staleSave = vi.fn(async () => 'WRITTEN')
    await expect(owner.write({ id: '__notes__', hostId: 'local', path: original, kind: 'folder' } as any, { path: 'one.note.json', content: 'MUST NOT WRITE', expectedRevision: 'pinned' }, staleSave)).rejects.toMatchObject({ code: 'NOTE_RESOURCE_CHANGED' })
    expect(staleSave).not.toHaveBeenCalled()
    await owner.write(config.workspaces[0]!, { path: 'one.note.json', content: 'retained draft', expectedRevision: 'current' }, staleSave)
    expect(staleSave).toHaveBeenCalledWith(config.workspaces[0])
    const restoredGraph = (await spatial.readForLayout())!.graph
    expect(restoredGraph.zones[0]).toMatchObject({ zoneId, directoryPath: target }); expect(restoredGraph.tabs).toEqual(originalGraph.tabs)
    const current = { config, sessions: [], tabs: { [launcher.id]: launcher }, layouts: restoredGraph.layouts, spaceZoneBindings: { [zoneId]: restoredGraph.resources['zone:' + zoneId] }, spatialRequests: {} } as any
    expect(noteCreationTarget(current, [], { workspaceId: '__notes__', groupId: 'retained-group', launcher: { tabId: launcher.id, regionId: 'launcher-region' } })).toMatchObject({ zoneId, sourceSpaceId: spaceId, directoryPath: target, workspacePath: target })


    const operationId = saved.result.operationId; expect(typeof operationId).toBe('string')
    const inspected = JSON.parse((await exec(process.execPath, [out, 'notebook', 'inspect', '--operation-id', operationId], { env, timeout: 5000 })).stdout)
    expect(inspected.result.storageOperation.phase).toBe('committed'); expect(inspected.result.storageOperation.operationId).toBe(operationId)
  })
})
