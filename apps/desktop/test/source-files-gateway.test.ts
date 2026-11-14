import { afterEach, expect, it, vi } from 'vitest'
import { access, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { sourceFilesHosts } from './helpers/source-files-hosts.js'
import { OrdinaryWorkspaceFiles } from '../../host/src/ordinary-files.js'
import type { SpaceMountRecord } from '../src/shared/space-mount.js'
import type { FileReadResource } from '@agentmux/core/files'

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
  await expect(f.runtime.sourceFilesCall(target, 'space.commit' as never, {} as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
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
  const inspected = await f.runtime.sourceFilesCall(f.target, 'file.mutation.inspect', { operationId: request.operationId, zoneId: request.zoneId,
    spaceId: request.spaceId, path, expectedResource: request.expectedResource })
  expect(inspected.result).toMatchObject({ operationId: request.operationId, result: { filesystem: 'created' } })
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
