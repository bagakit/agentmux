import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { readSpaceSnapshot } from '../src/space-authority-stream.js'
import { folderSpaceFacts, type FolderSpaceResource } from '../src/space-folder.js'
import { inspectFolderSpaceRegistration } from '../src/space-folder-client.js'
import { createHostFolderSpaceResource } from '../../../apps/host/src/folder-space-resource.js'

const releases: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })
const resource: FolderSpaceResource = { id: 'original-workspace', hostId: 'local', name: 'Original project', path: '/original/project' }
async function fixture(runtimeId = 'original-b') {
  const root = await mkdtemp(join(tmpdir(), 'amx-folder-')); releases.push(() => rm(root, { recursive: true, force: true }))
  const configurationPath = join(root, 'config.json'), store = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  await writeFile(configurationPath, JSON.stringify({ workspaces: [resource] }))
  const source = { runtimeId, ownerInstanceId: 'original-instance' }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), spatialState: store, coreClients: () => [],
    spatialFolderResource: createHostFolderSpaceResource(configurationPath), hostedRuntime: () => ({
      call: async (method: string) => { expect(method).toBe('runtime.owner.identity'); return { owner: { ...source, protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' } } },
      subscribe: async () => { throw Error('Unrelated Session, PTY or Host events are not a registration prerequisite.') }, assertFence: () => {}
    }) as never })
  releases.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); releases.push(() => rpc.dispose())
  return { store, rpc, root, configurationPath, source, input: { runtimeId, workspaceId: resource.id,
    expectedResource: { hostId: resource.hostId, workspacePath: resource.path, projectRootPath: resource.path } } }
}
it('explicitly registers B original configured resource through public RPC, then reads the same scoped original Space', async () => {
  const b = await fixture(), a = await fixture('unrelated-a')
  expect(await b.store.read()).toBeNull()
  const saved = await b.rpc.call('space.folder.register', b.input)
  expect(saved).toMatchObject({ source: b.source, created: true, resource: b.input.expectedResource, diskDurability: 'confirmed' })
  const snapshot = await readSpaceSnapshot(b.rpc, saved.reference)
  expect(snapshot.scope.space).toEqual(folderSpaceFacts(resource).space)
  expect(snapshot.scope.zones).toEqual([folderSpaceFacts(resource).zone])
  expect(snapshot.scope.bindings).toEqual([{ spaceId: saved.reference.spaceId, zoneId: saved.zoneId }])
  const wrongRegistration = await a.rpc.call('space.folder.register', b.input).then(value => ({ value }), error => ({ error }))
  expect(await a.store.read()).toBeNull()
  expect(wrongRegistration).toMatchObject({ error: { code: 'RUNTIME_OWNER_MISMATCH' } })
  await expect(readSpaceSnapshot(a.rpc, saved.reference)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
})
it('rejects a changed source resource rather than registering a new path under the previously selected Workspace ID', async () => {
  const f = await fixture()
  await writeFile(f.configurationPath, JSON.stringify({ workspaces: [{ ...resource, path: '/different/project' }] }))
  const result = await f.rpc.call('space.folder.register', f.input).then(value => ({ value }), error => ({ error }))
  expect(await f.store.read()).toBeNull()
  expect(result).toMatchObject({ error: { code: 'SPACE_RESOURCE_CHANGED' } })
})
it('retains original labels and every unrelated entity, and a repeated exact registration does not rewrite its document', async () => {
  const f = await fixture(), other = { ...resource, id: 'other', path: '/unrelated', name: 'Unrelated' }
  await f.store.registerFolder(other)
  const saved = await f.rpc.call('space.folder.register', f.input)
  const path = join(f.root, 'spatial.json')
  await writeFile(f.configurationPath, JSON.stringify({ workspaces: [{ ...resource, name: 'Later config label' }] }))
  const before = await readFile(path, 'utf8'), repeated = await f.rpc.call('space.folder.register', f.input)
  expect(repeated.created).toBe(false); expect(await readFile(path, 'utf8')).toBe(before)
  expect((await readSpaceSnapshot(f.rpc, saved.reference)).scope.space?.name).toBe(resource.name)
  expect((await f.store.read())!.graph.spaces).toContainEqual(folderSpaceFacts(other).space)
})
it('only rejects the registration whose original Space resource conflicts, preserving the full original graph', async () => {
  const f = await fixture(), facts = folderSpaceFacts(resource)
  await f.store.commit({ expectedRevision: 0, graph: { spaces: [{ ...facts.space, directoryPath: '/another-original' }], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const before = await readFile(join(f.root, 'spatial.json'), 'utf8')
  await expect(f.rpc.call('space.folder.register', f.input)).rejects.toMatchObject({ code: 'SPACE_RESOURCE_CHANGED' })
  expect(await readFile(join(f.root, 'spatial.json'), 'utf8')).toBe(before)
})

it('reads back an unknown registration through original space objects without repeating the write or using another Host namespace', async () => {
  const f = await fixture(); let writes = 0
  await expect((async () => { writes++; await f.rpc.call('space.folder.register', f.input); throw Error('Original reply lost after the service write') })()).rejects.toThrow('Original reply lost')
  const result = await f.rpc.call('space.ls', { target: {} })
  const spaces = result.catalog.spaces.filter(space => space.kind === 'folder' && space.hostId === f.input.expectedResource.hostId && space.directoryPath === f.input.expectedResource.projectRootPath)
  const zones = result.catalog.zones.filter(zone => zone.workspaceId === f.input.workspaceId && zone.hostId === f.input.expectedResource.hostId && zone.directoryPath === f.input.expectedResource.workspacePath)
  expect(spaces).toHaveLength(1); expect(zones).toHaveLength(1)
  expect(result.catalog.bindings).toContainEqual({ spaceId: spaces[0]!.spaceId, zoneId: zones[0]!.zoneId })
  const original = await readSpaceSnapshot(f.rpc, { runtimeId: f.input.runtimeId, spaceId: spaces[0]!.spaceId })
  expect(original.scope.zones).toContainEqual(zones[0]); expect(writes).toBe(1)
  const inspected = await inspectFolderSpaceRegistration(f.rpc, f.input)
  expect(inspected).toMatchObject({ reference: original.reference, source: original.source, zoneId: zones[0]!.zoneId, resource: f.input.expectedResource })
  expect(inspected).not.toHaveProperty('created'); expect(inspected).not.toHaveProperty('diskDurability')
})
it('the original inspection reports current absence and ambiguity without picking an alias or issuing registration', async () => {
  const f = await fixture()
  await expect(inspectFolderSpaceRegistration(f.rpc, f.input)).rejects.toMatchObject({ code: 'SPATIAL_STATE_ABSENT' })
  expect(await f.store.read()).toBeNull()
  await f.store.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} } })
  // Readback may be absent while a separate original request is still in flight;
  // null is a current object observation, never a not-applied operation receipt.
  expect(await inspectFolderSpaceRegistration(f.rpc, f.input)).toBeNull()
  expect((await f.store.read())!.graph.spaces).toEqual([])
  const registered = await f.rpc.call('space.folder.register', f.input), state = (await f.store.read())!
  await f.store.commit({ expectedRevision: state.revision, graph: { ...state.graph,
    spaces: [...state.graph.spaces, { ...state.graph.spaces[0]!, spaceId: 'another-folder-alias' }],
    bindings: [...state.graph.bindings, { spaceId: 'another-folder-alias', zoneId: registered.zoneId }] } })
  const before = await readFile(f.store.path, 'utf8')
  await expect(inspectFolderSpaceRegistration(f.rpc, f.input)).rejects.toMatchObject({ code: 'SPACE_REGISTRATION_AMBIGUOUS' })
  expect(await readFile(f.store.path, 'utf8')).toBe(before)
})
it.skipIf(!process.env.SPACE_FOLDER_CLI)('the actual candidate CLI registers the original private Core Folder and reads its public scoped snapshot', async () => {
  const f = await fixture(), input = join(f.root, 'resource.json')
  await writeFile(input, JSON.stringify(f.input.expectedResource))
  const invoke = async (args: string[]) => {
    // This is a new private test-user namespace, never a credential retry at a production endpoint.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const child = spawn(process.execPath, [process.env.SPACE_FOLDER_CLI!, '--endpoint', 'unix:' + join(f.root, 'rpc.sock'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      expect(code, stderr).toBe(0)
      return JSON.parse(stdout).result
    } finally { clearTimeout(timer) }
  }
  const saved = await invoke(['space', 'folder', 'register', '--runtime', f.input.runtimeId, '--workspace', f.input.workspaceId, '--input', input])
  expect(saved.resource).toEqual(f.input.expectedResource)
  const read = await invoke(['space', 'snapshot', '--runtime', f.input.runtimeId, '--space', saved.reference.spaceId])
  expect(read.reference).toEqual(saved.reference); expect(read.scope.zones[0].workspaceId).toBe(resource.id)
})
