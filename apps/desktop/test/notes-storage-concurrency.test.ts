import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxNotebookStore, AgentMuxNotesStorage } from '../../../packages/core/src/notebook-store.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { NotesStorageOwner } from '../src/main/notes-storage-owner.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import type { AppConfig } from '../src/shared/contracts.js'
import type { AgentMuxSpatialGraph } from '../../../packages/core/src/spatial-graph.js'
vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp/notes-concurrency-fixture") } }))
const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'notes-concurrency-')); roots.push(root)
  const original = join(root, 'original'), target = join(root, 'target'); await mkdir(original)
  let owner!: NotesStorageOwner
  const storage = new AgentMuxNotesStorage(join(root, 'state', 'notes-location.json'), original, { beforeSourceCleanup: async () => { await owner.confirmResources(await storage.inspect()) } })
  const store = new AgentMuxNotebookStore(undefined, storage), bytes = JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'original', content: 'Last good source' })
  await writeFile(join(original, 'one.note.json'), bytes)
  await store.apply({ operationId: 'register', expectedRevision: 0, change: { kind: 'register', noteId: 'original', title: 'Original', resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: original, path: 'one.note.json' } } }, { kind: 'user', id: 'fixture' })
  let config = { hosts: [], executors: {}, workspaces: [{ id: '__notes__', hostId: 'local', path: original, kind: 'folder' }] } as unknown as AppConfig
  const configOwner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value } })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'state', 'spatial.json')), spaceId = directoryIdentity('local', original), zoneId = workspaceZoneId(spaceId, '__notes__')
  const tabs = ['first-tab', 'second-tab'].map(id => createWorkbenchTab(id, { regionId: id + '-region', kind: 'launcher', workspaceId: '__notes__' }))
  const graph: AgentMuxSpatialGraph = { spaces: [{ spaceId, kind: 'folder', name: 'Recall', hostId: 'local', directoryPath: original, projectId: null }], zones: [{ zoneId, workspaceId: '__notes__', kind: 'directory', hostId: 'local', directoryPath: original, branch: null }], bindings: [{ spaceId, zoneId }],
    tabs: tabs.map(tab => ({ tabId: tab.id, workspaceId: '__notes__', zoneId, name: null, regionIds: [tab.id + '-region'] })),
    regions: tabs.map(tab => ({ tabId: tab.id, regionId: tab.id + '-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null })),
    layouts: { __notes__: createWorkspaceLayout('original-group', tabs.map(tab => tab.id)) }, tabLayouts: Object.fromEntries(tabs.map(tab => [tab.id, tab.layout])), resources: { ['zone:' + zoneId]: { directoryPath: original } } }
  await spatial.commit({ expectedRevision: 0, graph }); owner = new NotesStorageOwner(configOwner, spatial, () => {}, storage)
  return { root, original, target, bytes, storage, store, spatial, owner, configOwner, graph, operation: { operationId: 'original-move', expectedDirectory: original, directory: target }, config: () => config }
}
describe('Notes directory acknowledgement concurrent with layout edits', () => {
  it('rederives the mapping from the latest real CAS graph and preserves the concurrent layout edit', async () => {
    const f = await fixture(), commit = f.spatial.commit.bind(f.spatial); let raced = false
    vi.spyOn(f.spatial, 'commit').mockImplementation(async input => {
      if (!raced) {
        raced = true; const latest = (await f.spatial.readForLayout())!, edited = structuredClone(latest.graph)
        edited.layouts.__notes__!.groups[0]!.activeTabId = 'second-tab'; edited.layouts.__notes__!.groups[0]!.recentTabIds = ['second-tab', 'first-tab']
        await commit({ expectedRevision: latest.revision, graph: edited })
      }
      return commit(input)
    })
    await f.owner.change(f.operation)
    const graph = (await f.spatial.readForLayout())!.graph
    expect(graph.layouts.__notes__!.groups[0]).toMatchObject({ activeTabId: 'second-tab', recentTabIds: ['second-tab', 'first-tab'] })
    expect(graph.tabs).toEqual(f.graph.tabs); expect(graph.tabLayouts).toEqual(f.graph.tabLayouts)
    expect(graph.zones[0]?.directoryPath).toBe(f.target); expect(f.config().workspaces[0]?.path).toBe(f.target)
    await expect(readFile(join(f.original, 'one.note.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['SPATIAL_STATE_CONFLICT', 'SPATIAL_STATE_UNAVAILABLE'])('retains the original operation and sources after bounded %s acknowledgement failures', async code => {
    const f = await fixture(), commit = vi.spyOn(f.spatial, 'commit').mockRejectedValue(Object.assign(new Error('ACK unavailable'), { code }))
    await expect(f.owner.change(f.operation)).rejects.toMatchObject({ code })
    expect(commit).toHaveBeenCalledTimes(code === 'SPATIAL_STATE_CONFLICT' ? 3 : 1)
    expect(await readFile(join(f.original, 'one.note.json'), 'utf8')).toBe(f.bytes)
    expect(await readFile(join(f.original, 'notebooks.json'), 'utf8')).toContain('original')
    expect(f.config().workspaces[0]?.path).toBe(f.original)
    expect((await f.storage.inspect()).operation).toMatchObject({ operationId: f.operation.operationId, phase: 'committed', expectedDirectory: f.original })
  })
  it('recovers the original committed move through the shipping CLI operation carrier without another move', async () => {
    const f = await fixture(), commit = vi.spyOn(f.spatial, 'commit').mockRejectedValueOnce(Object.assign(new Error('ACK unavailable'), { code: 'SPATIAL_STATE_UNAVAILABLE' }))
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), notebookStore: f.store, coreClients: () => [], execute: request => { if (request.operation !== 'settings.get' && request.operation !== 'settings.set') throw new Error('Unexpected request'); return executeSettingsControl(request, f.configOwner, f.owner) } }); servers.push(server); await server.start()
    const out = resolve('.local/recall/notes-concurrency-cli.mjs'); await symlink('../../packages/core/node_modules', join(dirname(out), 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
    const { build } = createRequire(resolve('packages/core/package.json'))('esbuild'); await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: out, platform: 'node', format: 'esm', packages: 'external', bundle: true, logLevel: 'silent' })
    const exec = promisify(execFile), env = { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined }
    const args = ['settings', 'set', 'notes.directory', f.target, '--operation-id', f.operation.operationId]
    await expect(exec(process.execPath, [out, ...args], { env, timeout: 5000 })).rejects.toMatchObject({ stderr: expect.stringContaining('SPATIAL_STATE_UNAVAILABLE') })
    expect(commit).toHaveBeenCalledTimes(1); expect(await readFile(join(f.original, 'one.note.json'), 'utf8')).toBe(f.bytes)
    const pending = JSON.parse((await exec(process.execPath, [out, 'notebook', 'inspect', '--operation-id', f.operation.operationId], { env, timeout: 5000 })).stdout)
    expect(pending.result.storageOperation).toMatchObject({ operationId: f.operation.operationId, phase: 'committed', expectedDirectory: f.original })
    await expect(exec(process.execPath, [out, 'settings', 'set', 'notes.directory', join(f.root, 'wrong'), '--operation-id', f.operation.operationId], { env, timeout: 5000 })).rejects.toMatchObject({ stderr: expect.stringContaining('NOTES_STORAGE_INPUT_INVALID') })
    const recovered = JSON.parse((await exec(process.execPath, [out, ...args], { env, timeout: 5000 })).stdout)
    expect(recovered.result).toMatchObject({ operationId: f.operation.operationId, entry: { value: f.target } })
    expect((await f.storage.inspect()).operation).toBeNull(); expect((await f.store.read()).trail).toHaveLength(2)
    expect(JSON.parse(await readFile(f.storage.locatorPath, 'utf8')).operations).toEqual(expect.objectContaining({ [f.operation.operationId]: expect.objectContaining({ expectedDirectory: f.original, directory: f.target }) }))
    expect(Object.keys(JSON.parse(await readFile(f.storage.locatorPath, 'utf8')).operations)).toEqual([f.operation.operationId])
    await expect(readFile(join(f.original, 'one.note.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
