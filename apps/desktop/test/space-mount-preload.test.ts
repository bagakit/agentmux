// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { createRendererSpaceMount } from '../src/renderer/src/lib/space-mount-api'
import { spaceMountFixture } from './helpers/space-mount-fixture'

const exposed = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: AgentMuxPreloadApi) => { exposed.api = value } },
  ipcRenderer: { invoke: exposed.invoke, on: exposed.on, removeListener: exposed.removeListener }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await spaceMountFixture(cleanup)
  exposed.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => await f.handlers.get(channel)!(f.event, ...args))
  exposed.on.mockImplementation(f.renderer.on.bind(f.renderer)); exposed.removeListener.mockImplementation(f.renderer.removeListener.bind(f.renderer))
  expect(exposed.api?.spaceMounts).toBeDefined()
  return { ...f, original: createRendererSpaceMount(exposed.api!.spaceMounts) }
}

test('the complete public preload entry exposes the original mounted Space consumer through trusted Main and real Core', async () => {
  const f = await fixture(), b = f.cores[1]!, resources = await f.original.call('resources', { hostId: b.id })
  expect(resources).toMatchObject({ runtimeId: b.identity.runtimeId, workspaces: [{ workspaceId: b.workspace.id, path: b.workspace.path }] })
  expect(await b.store.read()).toBeNull(); expect(await f.cores[0]!.store.read()).toBeNull()
  await expect(f.original.call('snapshot', { hostId: b.id, reference: { runtimeId: 'another-original-runtime', spaceId: 'unadmitted' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(await b.store.read()).toBeNull()
})

test('the full preload entry releases only its original source reader and keeps the source graph and other reader', async () => {
  const f = await fixture(), b = f.cores[1]!, registered = await b.rpc.call('space.folder.register', { runtimeId: b.identity.runtimeId, workspaceId: b.workspace.id,
    expectedResource: { hostId: b.workspace.hostId, workspacePath: b.workspace.path, projectRootPath: b.workspace.path } })
  const target = { hostId: b.id, reference: registered.reference }, abort = new AbortController()
  const first = await f.original.watch(target, () => {}, abort.signal), second = await f.original.watch(target, () => {})
  cleanup.push(() => first.dispose(), () => second.dispose())
  expect(f.renderer.listenerCount('spaceMounts:event')).toBe(2)
  const before = await b.store.read(); abort.abort()
  await vi.waitFor(() => expect(f.renderer.listenerCount('spaceMounts:event')).toBe(1))
  expect(await b.store.read()).toEqual(before)
  expect(second.initial.reference).toEqual(registered.reference)
})
