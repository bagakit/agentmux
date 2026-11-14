import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { AgentMuxNotesStorage, AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { NotesStorageOwner } from '../src/main/notes-storage-owner.js'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state.js'
import { callOriginalDesktopHost, connectDesktopAgentMuxHost } from '../src/main/desktop-host.js'
import { desktopRpcMethods } from '../src/main/desktop-rpc-exposure.js'
import { reconcileNotesStorageResources } from '../src/renderer/src/lib/notes-storage-reconciliation.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses.js'
vi.mock('electron', () => ({ app: { getPath: () => '/private-notes-test' } }))

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private Notes owner cleanup failed.')
})

async function fixture(legacy = false) {
  const original = await rpcOwnerFixture(['original-agent'], core); cleanup.push(original.close)
  const native = original.inner.kernel
  await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const path = join(original.root, 'control.sock'), desktopPath = join(original.root, 'desktop.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: path, desktopSocketPath: desktopPath, mobileBuildDirectory: join(original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const desktopCore = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, original.store)
  cleanup.push(() => desktopCore.dispose()); await desktopCore.readAgentSessions()
  const canonicalRoot = await realpath(original.root)
  const directory = join(canonicalRoot, 'notes'), destination = join(canonicalRoot, 'relocated\nnotes')
  await mkdir(directory)
  const configPath = join(original.root, 'config.json')
  let config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: '__notes__', name: 'Notes', hostId: 'local', kind: 'folder' as const, path: directory }] }
  await writeFile(configPath, JSON.stringify(config))
  const configOwner = new ConfigOwner({ read: () => config, save: async next => { await writeFile(configPath, JSON.stringify(next)); return next }, publish: next => { config = next as typeof config } })
  let owner!: NotesStorageOwner
  const storage = new AgentMuxNotesStorage(join(original.root, 'notes-location.json'), directory, { beforeSourceCleanup: async () => { await owner.confirmResources(await storage.inspect()) } })
  const store = new AgentMuxNotebookStore(undefined, storage)
  const note = { schema: 'agentmux.note.v1' as const, noteId: 'original-note', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'original-block' }, content: [{ type: 'text', text: 'Original saved body' }] }] } }
  const notePath = legacy ? 'original.note.json' : 'original.note.md'
  const bytes = legacy ? JSON.stringify(note) : serializeNoteDocument(note)
  await writeFile(join(directory, notePath), bytes)
  await store.apply({ expectedRevision: 0, operationId: 'register-original', change: { kind: 'register', noteId: note.noteId, title: 'Original', resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: directory, path: notePath } } }, { kind: 'user', id: 'fixture' })
  if (legacy) {
    await writeFile(join(directory, 'unconvertible.note.json'), '{"unsupported":"Retain these original bytes"}')
    await store.apply({ expectedRevision: 1, operationId: 'register-unconvertible', change: { kind: 'register', noteId: 'unconvertible', title: 'Retain', resource: { hostId: 'local', workspaceId: '__notes__', workspacePath: directory, path: 'unconvertible.note.json' } } }, { kind: 'user', id: 'fixture' })
  }
  const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  const spaceId = directoryIdentity('local', directory), zoneId = workspaceZoneId(spaceId, '__notes__')
  const tab = createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: '__notes__', path: notePath }); tab.space = { spaceId, zoneId }
  const layout = createWorkspaceLayout('original-group', [tab.id])
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId, kind: 'folder', name: 'Notes', hostId: 'local', directoryPath: directory, projectId: null }], zones: [{ zoneId, workspaceId: '__notes__', kind: 'directory', hostId: 'local', directoryPath: directory, branch: null }], bindings: [{ spaceId, zoneId }], tabs: [{ tabId: tab.id, workspaceId: '__notes__', zoneId, name: null, regionIds: ['original-region'] }], regions: [{ tabId: tab.id, regionId: 'original-region', kind: 'file', agentSessionId: null, runId: null, execution: null }], layouts: { __notes__: layout }, tabLayouts: { [tab.id]: tab.layout }, resources: { 'region:original-region': { workspaceId: '__notes__', path: notePath }, ['zone:' + zoneId]: { directoryPath: directory } } } })
  owner = new NotesStorageOwner(configOwner, spatial, () => {}, storage)
  const desktopOptions: ConstructorParameters<typeof core.AgentMuxControlServer>[0] = { socketPath: desktopPath, exposedMethods: desktopRpcMethods(), forwardingPeer: { authoritySocketPath: path }, coreClients: () => [{ hostId: 'local', client: desktopCore }], notesStorage: owner, notebookStore: store,
    callOriginalCore: (_host, method, params, context) => callOriginalDesktopHost(desktopCore, method, params, context) }
  let desktop = new core.AgentMuxControlServer(desktopOptions)
  const reopenDesktop = async () => { desktop = new core.AgentMuxControlServer(desktopOptions); await desktop.start() }
  await desktop.start(); cleanup.push(() => desktop.stop())
  const env = objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}`, AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability })
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['notebook', 'storage', ...args], env, input === undefined ? '' : JSON.stringify(input))
  const key = '__notes__\0' + notePath
  const draft = { tabs: { [tab.id]: tab }, layouts: { __notes__: layout }, config, documents: { [key]: { path: notePath, content: 'UNSAVED ORIGINAL DRAFT', revision: 'original-disk' } }, dirtyDocuments: { [key]: true }, documentGenerations: { [key]: 7 }, documentObservationGenerations: {}, documentIssues: {}, savingDocuments: {}, lastActiveFileByWorkspace: {}, fileExplorerStates: {} }
  return { original, host, get desktop() { return desktop }, reopenDesktop, owner, storage, store, spatial, configPath, configOwner, directory, destination, notePath, bytes, draft, key, env, cli }
}

it('compiled CLI crosses actual Host/Desktop owners and reopens original Notes, surface identities and dirty draft in a new process', async () => {
  const f = await fixture(), before = await readFile(f.original.store.path)
  const request = { operationId: 'original-move', expectedDirectory: f.directory, directory: f.destination }
  const changed = await f.cli(['change', '--input', '-'], request)
  expect(changed.code, changed.stderr).toBe(0)
  const value = JSON.parse(changed.stdout).result
  expect(value).toMatchObject({ directory: f.destination, operation: { ...request, kind: 'move', phase: 'committed' }, coverage: { resourceChanges: 'retained-committed-operations' } })
  expect(value.operation.catalog).toBeUndefined(); expect(value.operation.files).toBeUndefined(); expect(value.operation.database).toBeUndefined(); expect(value.operation.sourceCatalog).toBeUndefined()
  expect(await readFile(join(f.destination, f.notePath), 'utf8')).toBe(f.bytes)
  const mapped = reconcileNotesStorageResources(f.draft as never, value.resourceChanges, value.directoryChanges)
  expect(mapped.tabs['original-tab']?.regions['original-region']).toMatchObject({ regionId: 'original-region', kind: 'file' })
  expect(mapped.documents[f.key]?.content).toBe('UNSAVED ORIGINAL DRAFT'); expect(mapped.dirtyDocuments[f.key]).toBe(true)
  const statePath = join(f.original.root, 'workbench-user-state.json')
  await new WorkbenchUserStateStore(statePath).write(JSON.stringify({ version: 0, state: mapped }))
  const input = join(f.original.root, 'reopen.mjs'), output = join(f.original.root, 'reopen-product.mjs')
  await symlink(resolve('apps/desktop/node_modules'), join(f.original.root, 'node_modules'), 'dir')
  await writeFile(input, `import { readFile } from 'node:fs/promises';
import { AgentMuxNotesStorage } from '@agentmux/core/notebook-store';
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state';
import { ConfigOwner } from ${JSON.stringify(resolve('apps/desktop/src/main/config-owner.ts'))};
import { NotesStorageOwner } from ${JSON.stringify(resolve('apps/desktop/src/main/notes-storage-owner.ts'))};
import { WorkbenchUserStateStore } from ${JSON.stringify(resolve('apps/desktop/src/main/workbench-user-state.ts'))};
const config=JSON.parse(await readFile(${JSON.stringify(f.configPath)},'utf8'));
const owner=new NotesStorageOwner(new ConfigOwner({read:()=>config,save:async value=>value,publish:()=>{}}),new AgentMuxSpatialStateStore(${JSON.stringify(join(f.original.root, 'spatial.json'))}),()=>{},new AgentMuxNotesStorage(${JSON.stringify(f.storage.locatorPath)},${JSON.stringify(f.directory)}));
console.log(JSON.stringify({storage:await owner.call('notebook.storage.inspect',{operationId:'original-move'}),surface:JSON.parse(await new WorkbenchUserStateStore(${JSON.stringify(statePath)}).read())}));`)
  await build({ entryPoints: [input], outfile: output, platform: 'node', format: 'esm', target: 'node24', packages: 'external', bundle: true, logLevel: 'silent' })
  const reopened = JSON.parse((await promisify(execFile)(process.execPath, [output], { env: objectCliEnvironment(f.original.root) })).stdout)
  expect(reopened.storage.operation).toMatchObject({ ...request, phase: 'committed' })
  expect(reopened.surface.state.tabs['original-tab'].regions['original-region']).toMatchObject({ regionId: 'original-region', kind: 'file' })
  expect(reopened.surface.state.documents[f.key].content).toBe('UNSAVED ORIGINAL DRAFT'); expect(reopened.surface.state.dirtyDocuments[f.key]).toBe(true)
  expect(await readFile(f.original.store.path)).toEqual(before)
})

it('inspect preserves committed-but-unacknowledged original effects and exact request resumes only explicitly', async () => {
  const f = await fixture(), request = { operationId: 'pending-resource-ack', expectedDirectory: f.directory, directory: f.destination }
  const commit = vi.spyOn(f.spatial, 'commit').mockRejectedValueOnce(Object.assign(new Error('Original resource ACK unavailable'), { code: 'SPATIAL_STATE_UNAVAILABLE' }))
  const failed = await f.cli(['change', '--input', '-'], request)
  expect(failed.code).not.toBe(0); expect(JSON.parse(failed.stderr).error.code).toBe('SPATIAL_STATE_UNAVAILABLE')
  const change = vi.spyOn(f.owner, 'change'), convert = vi.spyOn(f.storage, 'convert'), locator = await readFile(f.storage.locatorPath)
  const inspected = await f.cli(['inspect', '--operation-id', request.operationId])
  expect(inspected.code, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).result.operation).toMatchObject({ ...request, phase: 'committed' })
  expect(change).not.toHaveBeenCalled(); expect(convert).not.toHaveBeenCalled(); expect(await readFile(f.storage.locatorPath)).toEqual(locator)
  expect(await readFile(join(f.directory, f.notePath), 'utf8')).toBe(f.bytes)
  const wrong = await f.cli(['change', '--input', '-'], { ...request, directory: join(f.original.root, 'different') })
  expect(wrong.code).not.toBe(0); expect(JSON.parse(wrong.stderr).error.code).toBe('NOTES_STORAGE_INPUT_INVALID')
  const resumed = await f.cli(['change', '--input', '-'], request)
  expect(resumed.code, resumed.stderr).toBe(0); expect(commit.mock.calls.length).toBeGreaterThan(1)
  await expect(readFile(join(f.directory, f.notePath))).rejects.toMatchObject({ code: 'ENOENT' })
  const stale = await f.cli(['change', '--input', '-'], { ...request, operationId: 'stale-new-operation' })
  expect(stale.code).not.toBe(0); expect(JSON.parse(stale.stderr).error.code).toBe('CONFIG_CONFLICT')
})

it('same-directory conversion preserves partial issues and pending exact input cannot be replaced', async () => {
  const f = await fixture(true), request = { operationId: 'original-conversion', expectedDirectory: f.directory, directory: f.directory }
  const publication = vi.spyOn(f.storage as any, 'finish').mockRejectedValueOnce(Object.assign(new Error('Original publication unavailable'), { code: 'NOTE_PUBLICATION_UNAVAILABLE' }))
  const pending = await f.cli(['change', '--input', '-'], request)
  expect(pending.code).not.toBe(0); expect(JSON.parse(pending.stderr).error.code).toBe('NOTE_PUBLICATION_UNAVAILABLE')
  expect((await f.storage.inspect(request.operationId)).operation?.phase).toBe('prepared')
  const childInput = join(f.original.root, 'relative-input.mjs'), childOutput = join(f.original.root, 'relative-input-product.mjs')
  await symlink(resolve('apps/desktop/node_modules'), join(f.original.root, 'node_modules'), 'dir')
  await writeFile(childInput, `import { readFile } from 'node:fs/promises';
import { AgentMuxNotesStorage } from '@agentmux/core/notebook-store';
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state';
import { ConfigOwner } from ${JSON.stringify(resolve('apps/desktop/src/main/config-owner.ts'))};
import { NotesStorageOwner } from ${JSON.stringify(resolve('apps/desktop/src/main/notes-storage-owner.ts'))};
const config=JSON.parse(await readFile(${JSON.stringify(f.configPath)},'utf8'));
const storage=new AgentMuxNotesStorage(${JSON.stringify(f.storage.locatorPath)},${JSON.stringify(f.directory)});
let resumes=0,inspections=0;const resume=storage.resume.bind(storage),inspect=storage.inspect.bind(storage);
storage.resume=(...args)=>{resumes++;return resume(...args)};storage.inspect=(...args)=>{inspections++;return inspect(...args)};
const owner=new NotesStorageOwner(new ConfigOwner({read:()=>config,save:async value=>value,publish:()=>{}}),new AgentMuxSpatialStateStore(${JSON.stringify(join(f.original.root,'spatial.json'))}),()=>{},storage);
const results=[];for(const directory of ['', '.']){try{await owner.call('notebook.storage.change',{operationId:'original-conversion',expectedDirectory:directory,directory});results.push({accepted:true})}catch(error){results.push({code:error.code})}}
console.log(JSON.stringify({results,resumes,inspections,cwd:process.cwd()}));`)
  await build({ entryPoints: [childInput], outfile: childOutput, platform: 'node', format: 'esm', target: 'node24', packages: 'external', bundle: true, logLevel: 'silent' })
  const relative = JSON.parse((await promisify(execFile)(process.execPath, [childOutput], { cwd: f.directory, env: objectCliEnvironment(f.original.root) })).stdout)
  expect(relative.cwd).toBe(f.directory)
  expect(relative.results).toEqual([{ code: 'NOTES_STORAGE_INPUT_INVALID' }, { code: 'NOTES_STORAGE_INPUT_INVALID' }])
  expect(relative.resumes).toBe(0); expect(relative.inspections).toBe(0)
  expect((await f.storage.inspect(request.operationId)).operation?.phase).toBe('prepared')
  const resume = vi.spyOn(f.storage, 'resume')
  const wrong = await f.cli(['change', '--input', '-'], { ...request, directory: f.destination })
  expect(wrong.code).not.toBe(0); expect(JSON.parse(wrong.stderr).error.code).toBe('NOTES_STORAGE_INPUT_INVALID')
  expect(resume).not.toHaveBeenCalled()
  const conversion = await f.cli(['change', '--input', '-'], request)
  expect(conversion.code, conversion.stderr).toBe(0); expect(publication.mock.calls.length).toBeGreaterThan(1)
  const value = JSON.parse(conversion.stdout).result
  expect(value.operation).toMatchObject({ ...request, kind: 'convert', phase: 'committed' })
  expect(value.conversionIssues).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: 'unconvertible' })]))
  expect(await readFile(join(f.directory, 'unconvertible.note.json'), 'utf8')).toContain('Retain these original bytes')
  expect(await readFile(join(f.directory, 'original.note.md'), 'utf8')).toContain('Original saved body')
  const inspected = await f.cli(['inspect', '--operation-id', request.operationId])
  expect(inspected.code, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).result.operation).toEqual(value.operation)

})

it('a lost Desktop connection after publication is inspected by original operation without replay', async () => {
  const f = await fixture(), request = { operationId: 'lost-original-ack', expectedDirectory: f.directory, directory: f.destination }
  const originalCall = f.owner.call.bind(f.owner)
  const calls = vi.spyOn(f.owner, 'call').mockImplementationOnce(async (method, params) => {
    const result = await originalCall(method, params)
    await f.desktop.stop() // The result exists, but its original RPC connection cannot deliver it.
    return result
  })
  const changed = await f.cli(['change', '--input', '-'], request)
  expect(changed.code).not.toBe(0)
  expect(calls).toHaveBeenCalledTimes(1)
  expect((await f.storage.inspect(request.operationId)).operation).toMatchObject({ ...request, phase: 'committed' })
  await f.reopenDesktop()
  const mutate = vi.spyOn(f.owner, 'change')
  const read = await f.cli(['inspect', '--operation-id', request.operationId])
  expect(read.code, read.stderr).toBe(0)
  expect(JSON.parse(read.stdout).result.operation).toMatchObject({ ...request, phase: 'committed' })
  expect(mutate).not.toHaveBeenCalled(); expect(calls).toHaveBeenCalledTimes(2)
  expect(await readFile(join(f.destination, f.notePath), 'utf8')).toBe(f.bytes)
})
