import { afterEach, expect, it, vi } from 'vitest'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, AgentMuxSpatialStateStore, connectAgentMuxRpc, readSpaceSnapshot } from '@agentmux/core'
import { sourceFilesHosts } from './helpers/source-files-hosts.js'
import { OrdinaryWorkspaceFiles } from '../../host/src/ordinary-files.js'
import type { SpaceMountRecord } from '../src/shared/space-mount.js'
import type { FileReadResource } from '@agentmux/core/files'
import { mintObjectId } from '@agentmux/core/object-id'

vi.mock('electron', () => ({ app: { getPath: () => 'unused-source-files-profile' }, nativeImage: {} }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
const workspaceResource = ({ hostId, workspaceId, workspacePath }: FileReadResource) => ({ hostId, workspaceId, workspacePath })
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })

async function located() {
  const f = await sourceFilesHosts(cleanup), b = f.sources[1]!, target = { hostId: b.id, expectedRuntimeId: b.identity.runtimeId }
  const found = await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b.project })
  expect(found.status).toBe('registration-required')
  if (found.status !== 'registration-required') throw Error('Expected the original Source registration packet')
  const receipt = await f.runtime.registerFolderSpace(b.id, found.registration)
  const mount: SpaceMountRecord = { hostId: b.id, reference: receipt.reference, zoneId: receipt.zoneId, workspaceId: receipt.workspaceId }
  const resolved = await f.runtime.resolveSourceFiles(target, { kind: 'mount', mount })
  expect(resolved.status).toBe('located')
  if (resolved.status !== 'located') throw Error('Expected a real registered Source locator')
  return { ...f, b, target, mount, locator: resolved.locator, receipt }
}

it('actual Main uses Source directory registration and Native Files without an Agent metadata bootstrap or alias rewrite', async () => {
  const f = await sourceFilesHosts(cleanup), [a, b] = f.sources
  const reads = vi.spyOn(b!.client, 'readAgentSessions').mockRejectedValue(new Error('Unrelated Agent metadata unavailable'))
  vi.spyOn(b!.client, 'runtimeOwnerIdentity').mockReturnValue(null)
  const target = { hostId: b!.id, expectedRuntimeId: b!.identity.runtimeId }
  const found = await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b!.project })
  expect(found.status).toBe('registration-required')
  if (found.status !== 'registration-required') throw Error('No real Source directory packet')
  expect(found.registration.directory).toMatchObject({ hostId: 'local', workspacePath: b!.project })
  const saved = await f.runtime.registerFolderSpace(b!.id, found.registration)
  expect(saved.workspaceId).toBe('same-workspace')
  const mount = { hostId: b!.id, reference: saved.reference, zoneId: saved.zoneId, workspaceId: saved.workspaceId }
  const resolved = await f.runtime.resolveSourceFiles(target, { kind: 'mount', mount })
  expect(resolved.status).toBe('located')
  const result = await f.runtime.sourceFilesCall(target, 'file.read', { zoneId: mount.zoneId, spaceId: mount.reference.spaceId, path: 'original.txt',
    expectedResource: { hostId: 'local', workspaceId: mount.workspaceId, workspacePath: b!.project } })
  expect(result).toMatchObject({ carrierCurrent: true, result: { resource: { hostId: 'local', workspacePath: b!.project }, result: { status: 'read', document: { content: 'source-b original body' } } } })
  expect(reads).not.toHaveBeenCalled()
  expect((await a!.rpc.call('app.snapshot', { include: ['spaces'] })).spaces).toEqual([])
  expect(await readFile(join(a!.project, 'original.txt'), 'utf8')).toBe('source-a original body')
  await expect(f.runtime.sourceFilesCall({ ...target, expectedRuntimeId: a!.identity.runtimeId }, 'file.stat', { zoneId: mount.zoneId, path: '.', expectedResource: { hostId: 'local', workspaceId: mount.workspaceId, workspacePath: b!.project } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(f.runtime.sourceFilesCall(target, 'app.snapshot' as never, { include: ['workspaces'] } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it('actual Source Native mkdir ACK survives a late carrier replacement and old OP inspect does not require its live directory', async () => {
  const f = await located(), path = 'new-directory'
  const observed = (await f.runtime.sourceFilesCall(f.target, 'file.stat', { zoneId: f.mount.zoneId, spaceId: f.mount.reference.spaceId, path,
    expectedResource: workspaceResource(f.locator.resource) })).result
  if (observed.result.status !== 'observed' || !observed.resource) throw Error('No real absence witness')
  const request = { zoneId: f.mount.zoneId, spaceId: f.mount.reference.spaceId, path, operationId: 'main source original mkdir', expectedResource: observed.resource,
    expectedAbsent: true as const, expected: { root: observed.result.observation.root, parent: observed.result.observation.parent } }
  const original = OrdinaryWorkspaceFiles.prototype.mkdirPath
  vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath').mockImplementation(async function (...args) {
    const receipt = await original.call(this, ...args)
    f.routes.set(f.b.id, { client: { ...f.b.client } as typeof f.b.client })
    return receipt
  })
  const receipt = await f.runtime.sourceFilesCall(f.target, 'file.mkdir', request)
  expect(receipt).toMatchObject({ carrierCurrent: false, result: { operationId: request.operationId, result: { filesystem: 'created' } } })
  await access(join(f.b.project, path))
  f.routes.set(f.b.id, { client: f.b.client })
  await rename(join(f.b.project, path), join(f.b.project, 'moved-externally'))
  const snapshot = await readSpaceSnapshot(f.b.rpc, f.mount.reference)
  await f.b.rpc.call('space.apply', { reference: f.mount.reference, expectedRevision: snapshot.revision, changes: { bindings: [], remove: { zones: [f.mount.zoneId] } } })
  expect((await readSpaceSnapshot(f.b.rpc, f.mount.reference)).scope.zones).toEqual([])
  const inspected = await f.runtime.sourceFilesCall(f.target, 'file.mutation.inspect', { operationId: request.operationId, zoneId: request.zoneId,
    spaceId: request.spaceId, path, expectedResource: request.expectedResource })
  expect(inspected.result).toMatchObject({ operationId: request.operationId, result: { filesystem: 'created' } })
})

it('a positive original folder registration is retained after carrier replacement and observing it never registers again', async () => {
  const f = await sourceFilesHosts(cleanup), b = f.sources[1]!, target = { hostId: b.id, expectedRuntimeId: b.identity.runtimeId }
  const real = AgentMuxSpatialStateStore.prototype.registerDirectory
  const register = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'registerDirectory').mockImplementation(async function (...args) {
    const receipt = await real.call(this, ...args)
    f.routes.set(b.id, { client: { ...b.client } as typeof b.client })
    return receipt
  })
  const discovered = await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b.project })
  expect(register).not.toHaveBeenCalled()
  if (discovered.status !== 'registration-required') throw Error('No exact registration packet')
  const receipt = await f.runtime.registerFolderSpace(b.id, discovered.registration)
  expect(receipt).toMatchObject({ source: { runtimeId: target.expectedRuntimeId }, created: true, diskDurability: 'confirmed', resource: { workspacePath: b.project } })
  expect(register).toHaveBeenCalledTimes(1)
  f.routes.set(b.id, { client: b.client })
  const recovered = await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b.project, expectedResource: discovered.registration.directory })
  expect(recovered).toMatchObject({ status: 'located', locator: { mount: { reference: receipt.reference, zoneId: receipt.zoneId, workspaceId: receipt.workspaceId } } })
  expect(register).toHaveBeenCalledTimes(1)
})

it('a registration result interrupted after the original durable write is recovered by readonly observation without another register', async () => {
  const f = await sourceFilesHosts(cleanup), b = f.sources[1]!, target = { hostId: b.id, expectedRuntimeId: b.identity.runtimeId }
  const real = AgentMuxSpatialStateStore.prototype.registerDirectory
  const register = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'registerDirectory').mockImplementation(async function (...args) {
    await real.call(this, ...args)
    throw Error('Original registration result interrupted after the durable write')
  })
  const found = await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b.project })
  if (found.status !== 'registration-required') throw Error('No original registration packet')
  await expect(f.runtime.registerFolderSpace(b.id, found.registration)).rejects.toThrow('interrupted after the durable write')
  const recovered = await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b.project, expectedResource: found.registration.directory })
  expect(recovered.status).toBe('located')
  expect(JSON.stringify(recovered)).not.toContain('diskDurability')
  expect(register).toHaveBeenCalledTimes(1)
  expect(await readFile(join(b.project, 'original.txt'), 'utf8')).toBe('source-b original body')
})

it('the frozen Source directory packet never adopts a replacement inode or registers it on reconnect', async () => {
  const f = await sourceFilesHosts(cleanup), b = f.sources[1]!, target = { hostId: b.id, expectedRuntimeId: b.identity.runtimeId }
  const found = await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b.project })
  if (found.status !== 'registration-required') throw Error('No exact original directory witness')
  await rename(b.project, b.project + '-retained'); await mkdir(b.project)
  const register = vi.spyOn(AgentMuxSpatialStateStore.prototype, 'registerDirectory')
  await expect(f.runtime.registerFolderSpace(b.id, found.registration)).rejects.toMatchObject({ code: 'SPACE_DIRECTORY_CHANGED' })
  expect(await f.runtime.resolveSourceFiles(target, { kind: 'directory', path: b.project, expectedResource: found.registration.directory })).toMatchObject({
    status: 'unconfirmed', issue: { code: 'SPACE_DIRECTORY_CHANGED' } })
  expect(register).not.toHaveBeenCalled()
  expect((await b.rpc.call('app.snapshot', { include: ['spaces'] })).spaces).toEqual([])
  expect(await readFile(join(b.project + '-retained', 'original.txt'), 'utf8')).toBe('source-b original body')
})

it('production-shaped client server borrows the real Core fence with no hostedRuntime and rejects wrong R or new I before Files', async () => {
  const f = await located()
  // Borrow the actual Source FileReadOwner in this client-host composition;
  // there is one filesystem owner, no substitute semantic Runtime or fake ACK.
  const files = (f.b.host.server as unknown as { options: { files: import('@agentmux/core/files').AgentMuxRpcFilesOwner } }).options.files
  expect(files).toBeDefined()
  const calls = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'statPath')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'desktop.sock'),
    callOriginalCore: async (hostId, method, params, context) => {
      expect(hostId).toBe('local')
      return await f.runtime.callOriginalCore(f.b.id, method, params, context)
    }, files })
  cleanup.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const params = { zoneId: f.mount.zoneId, path: '.', expectedResource: workspaceResource(f.locator.resource) }
  const fence = { runtimeId: f.b.identity.runtimeId, ownerInstanceId: f.b.identity.ownerInstanceId }
  await expect(rpc.call('file.stat', params, { runtimeFence: { ...fence, runtimeId: f.sources[0]!.identity.runtimeId } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(rpc.call('file.stat', params, { runtimeFence: { ...fence, ownerInstanceId: 'same-runtime-new-instance' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(calls).not.toHaveBeenCalled()
  expect(await rpc.call('file.stat', params, { runtimeFence: fence })).toMatchObject({ result: { status: 'observed' }, resource: { workspacePath: f.b.project } })
  expect(calls).toHaveBeenCalledTimes(1)
})

it('original Files watch retains its exact fence without metadata bootstrap and ends only the stale carrier reader', async () => {
  const f = await located(), events: unknown[] = [], end = vi.fn()
  const metadata = vi.spyOn(f.b.client, 'readAgentSessions').mockRejectedValue(new Error('Unrelated metadata unavailable'))
  vi.spyOn(f.b.client, 'runtimeOwnerIdentity').mockReturnValue(null)
  const controller = new AbortController()
  const initial = vi.fn()
  const reader = await f.runtime.watchSourceFiles(f.target, { zoneId: f.mount.zoneId, spaceId: f.mount.reference.spaceId, path: '.',
    expectedResource: workspaceResource(f.locator.resource) }, { onInitial: initial, onEvent: event => events.push(event), onEnd: end, signal: controller.signal })
  cleanup.push(() => reader.dispose())
  expect(initial).toHaveBeenCalledWith(expect.objectContaining({ delivery: 'live-only' }))
  const observed = (await f.runtime.sourceFilesCall(f.target, 'file.stat', { zoneId: f.mount.zoneId, path: 'watch.txt', expectedResource: workspaceResource(f.locator.resource) })).result
  expect(observed.resource).not.toBeNull()
  await f.runtime.sourceFilesCall(f.target, 'file.create', { zoneId: f.mount.zoneId, path: 'watch.txt', expectedResource: observed.resource!, content: 'original watch body', expectedRevision: null })
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'effect', data: expect.objectContaining({ type: 'created-file' }) })))
  f.routes.set(f.b.id, { client: { ...f.b.client } as typeof f.b.client })
  await f.b.rpc.call('file.create', { zoneId: f.mount.zoneId, path: 'late.txt', expectedResource: { ...observed.resource!, path: 'late.txt' }, content: '', expectedRevision: null })
  await vi.waitFor(() => expect(end).toHaveBeenCalledWith(expect.objectContaining({ code: 'RUNTIME_OWNER_MISMATCH' })))
  expect(events).toHaveLength(1)
  expect(metadata).not.toHaveBeenCalled()
  controller.abort()
  expect(await readFile(join(f.b.project, 'watch.txt'), 'utf8')).toBe('original watch body')
})

it('a cancelled late Source subscription is disposed without adopting its opening or bootstrapping Agent metadata', async () => {
  const f = await located(), controller = new AbortController(), metadata = vi.spyOn(f.b.client, 'readAgentSessions').mockRejectedValue(new Error('Unrelated metadata unavailable'))
  vi.spyOn(f.b.client, 'runtimeOwnerIdentity').mockReturnValue(null)
  const real = f.b.client.subscribeRpc!.bind(f.b.client), dispose = vi.fn(), end = vi.fn()
  vi.spyOn(f.b.client, 'subscribeRpc').mockImplementation(async (...args) => {
    const reader = await real(...args)
    controller.abort()
    return { subscriptionId: reader.subscriptionId, dispose: async () => { dispose(); await reader.dispose() } }
  })
  await expect(f.runtime.watchSourceFiles(f.target, { zoneId: f.mount.zoneId, path: '.', expectedResource: workspaceResource(f.locator.resource) },
    { signal: controller.signal, onInitial: () => {}, onEvent: () => { throw Error('Cancelled reader cannot consume another event') }, onEnd: end })).rejects.toMatchObject({ name: 'AbortError' })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(end).toHaveBeenCalledTimes(1)
  expect(metadata).not.toHaveBeenCalled()
  expect(await readFile(join(f.b.project, 'original.txt'), 'utf8')).toBe('source-b original body')
})

it('a real Source Topic Zone resolves its original Workspace root separately from its physical Zone directory', async () => {
  const f = await sourceFilesHosts(cleanup, { scratch: true }), b = f.sources[1]!
  const created = await b.rpc.call('topic.create', { topicId: mintObjectId(), title: 'Original Source child' })
  expect(created.topic.zoneId).toBeTruthy()
  expect(created.topic.directoryPath).not.toBe(b.scratch)
  expect(created.topic.directoryPath.startsWith(b.directory + '/')).toBe(true)
  await writeFile(join(created.topic.directoryPath, 'child.txt'), 'original Source Topic child body')
  const mount = { hostId: b.id, reference: { runtimeId: b.identity.runtimeId, spaceId: created.topic.categorySpaceIds[0]! },
    zoneId: created.topic.zoneId!, workspaceId: created.topic.workspaceId }
  const result = await f.runtime.resolveSourceFiles({ hostId: b.id, expectedRuntimeId: b.identity.runtimeId }, { kind: 'mount', mount })
  expect(result).toMatchObject({ status: 'located', locator: { resource: { workspaceId: '__scratch__', workspacePath: b.scratch, zoneId: created.topic.zoneId } } })
  if (result.status !== 'located') throw Error('Original Topic Zone could not resolve')
  const read = await f.runtime.sourceFilesCall({ hostId: b.id, expectedRuntimeId: b.identity.runtimeId }, 'file.read', {
    zoneId: mount.zoneId, spaceId: mount.reference.spaceId, path: 'child.txt', expectedResource: workspaceResource(result.locator.resource) })
  expect(read.result.resource).toMatchObject({ workspacePath: b.scratch, zoneId: mount.zoneId })
  expect(read.result.result).toMatchObject({ status: 'read', document: { content: 'original Source Topic child body' } })
})
