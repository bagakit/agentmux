import { EventEmitter } from 'node:events'
import { readdir } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { sourceFilesHosts } from './helpers/source-files-hosts.js'
import { registerSourceFilesIpc } from '../src/main/source-files-ipc.js'
import { registerSpaceMountIpc } from '../src/main/space-mount-ipc.js'
import { createPreloadSourceFiles } from '../src/preload/source-files.js'
import { createPreloadSpaceMount } from '../src/preload/space-mount.js'
import { createRendererSpaceMount } from '../src/renderer/src/lib/space-mount-api.js'
import { createRendererSourceFiles } from '../src/renderer/src/lib/source-files-api.js'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const original = await sourceFilesHosts(cleanup), source = original.sources[1]!
  const handlers = new Map<string, (...args: any[]) => any>(), events = new EventEmitter(), sender = Object.assign(new EventEmitter(), { id: 27, isDestroyed: () => false,
    send: (channel: string, value: unknown) => { events.emit(channel, {}, structuredClone(value)) } })
  const handle = (channel: string, listener: (...args: any[]) => any) => { handlers.set(channel, listener) }
  const reads = registerSourceFilesIpc({ handle, runtime: original.runtime }), spaces = registerSpaceMountIpc({ handle, runtime: original.runtime })
  cleanup.push(() => { reads.dispose(); spaces.dispose() })
  const ipc = { invoke: async (channel: string, ...args: unknown[]) => {
    const listener = handlers.get(channel); if (!listener) throw new Error('Missing real IPC handler ' + channel)
    return await listener({ sender }, ...structuredClone(args))
  }, on: (channel: string, listener: (...args: any[]) => void) => { events.on(channel, listener) },
  removeListener: (channel: string, listener: (...args: any[]) => void) => { events.removeListener(channel, listener) } }
  const api = createRendererSourceFiles(createPreloadSourceFiles(ipc as any)), target = { hostId: source.id, expectedRuntimeId: source.identity.runtimeId }
  const pending = await api.resolve(target, { kind: 'directory', path: source.project })
  expect(pending.status).toBe('registration-required')
  if (pending.status !== 'registration-required') throw new Error('Original directory registration required')
  const receipt = unwrapSessionInputOperationResult(await ipc.invoke('spaceMounts:call', 'explicit-use-original-directory', 'register', { hostId: source.id, registration: pending.registration })) as any
  const located = await api.resolve(target, { kind: 'directory', path: source.project, expectedResource: pending.registration.directory,
    registration: { hostId: source.id, reference: receipt.reference, zoneId: receipt.zoneId, workspaceId: receipt.workspaceId } })
  expect(located.status).toBe('located')
  if (located.status !== 'located') throw new Error('Original Source locator unavailable')
  const resource = located.locator.resource, query = { zoneId: resource.zoneId, path: '.', expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } }
  const request = async (path: string) => {
    const observed = (await api.call(target, 'file.stat', { ...query, path })).result
    expect(observed.result.status).toBe('observed')
    if (observed.result.status !== 'observed' || !observed.resource) throw new Error('Original stat unavailable')
    return { ...query, path, operationId: 'ipc-' + path, expectedResource: observed.resource, expectedAbsent: true as const,
      expected: { root: observed.result.observation.root, parent: observed.result.observation.parent } }
  }
  return { ...original, api, source, target, query, request, ipc, sender }
}

it('compiled Native effects cross real Main/preload/Renderer adapters and a stalled consumer terminates only its bounded reader', async () => {
  const f = await fixture(), delivered: any[] = []
  let release!: () => void
  const held = new Promise<void>(yes => { release = yes })
  const reader = await f.api.watch(f.target, f.query, event => { delivered.push(event); if (event.type === 'effect') return held })
  cleanup.push(() => { release(); reader.dispose() }); await reader.start()
  const first = await f.request('first'), env = objectCliEnvironment(f.source.state)
  const cli = async (input: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + f.source.socketPath, 'file', 'mkdir', '--input', '-'], env, JSON.stringify(input))
  const created = await cli(first)
  expect(created.code, created.stdout + created.stderr).toBe(0)
  await vi.waitFor(() => expect(delivered.map(event => event.type)).toEqual(['effect']))
  expect(delivered[0]).toMatchObject({ data: { request: first, receipt: { result: { filesystem: 'created' } } } })
  const second = await cli(await f.request('second'))
  expect(second.code, second.stdout + second.stderr).toBe(0)
  await vi.waitFor(() => expect(delivered.map(event => event.type)).toEqual(['effect', 'error']))
  expect(delivered[1]).toMatchObject({ error: { code: 'FILE_MUTATION_OBSERVATION_GAP' } })
  expect(await readdir(f.source.project)).toContain('second')
  expect(await readdir(f.sources[0]!.project)).not.toContain('first')
}, 60000)

it('the actual IPC owner preserves a Core result obtained before a late cancellation', async () => {
  const f = await fixture(), params = await f.request('settled-before-cancel')
  const call = f.runtime.sourceFilesCall.bind(f.runtime)
  vi.spyOn(f.runtime, 'sourceFilesCall').mockImplementation(async (...args: any[]) => {
    const result = await (call as any)(...args)
    await f.ipc.invoke('sourceFiles:cancel', 'late-cancel')
    return result
  })
  const pending = f.ipc.invoke('sourceFiles:call', 'late-cancel', f.target, 'file.mkdir', params)
  await expect(pending).resolves.toMatchObject({ ok: true, value: { result: { operationId: params.operationId, result: { filesystem: 'created' } } } })
  const response = unwrapSessionInputOperationResult(await pending) as any
  expect(response).toMatchObject({ result: { operationId: params.operationId, result: { filesystem: 'created' } } })
  expect(await readdir(f.source.project)).toContain(params.path)
}, 60000)

it('a real directory registration ACK survives late cancellation through Main, preload and Renderer without another registration', async () => {
  const f = await fixture(), spaces = createRendererSpaceMount(createPreloadSpaceMount(f.ipc as any)), target = f.target
  const selected = await f.api.resolve(target, { kind: 'directory', path: f.sources[0]!.project })
  expect(selected.status).toBe('registration-required')
  if (selected.status !== 'registration-required') throw new Error('Original second directory packet missing')
  const controller = new AbortController(), register = f.runtime.registerFolderSpace.bind(f.runtime)
  const calls = vi.spyOn(f.runtime, 'registerFolderSpace').mockImplementation(async (...args: any[]) => {
    const result = await (register as any)(...args)
    controller.abort()
    return result
  })
  const response = spaces.call('register', { hostId: f.source.id, registration: selected.registration }, controller.signal)
  await expect(response).resolves.toMatchObject({ diskDurability: 'confirmed', created: true, directory: selected.registration.directory })
  expect(calls).toHaveBeenCalledTimes(1)
  const observed = await f.api.resolve(target, { kind: 'directory', path: f.sources[0]!.project, expectedResource: selected.registration.directory })
  expect(observed.status).toBe('located')
  expect(calls).toHaveBeenCalledTimes(1)
}, 60000)
