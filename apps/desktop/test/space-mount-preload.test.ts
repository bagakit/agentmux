// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { createRendererSpaceMount } from '../src/renderer/src/lib/space-mount-api'
import { spaceMountFixture } from './helpers/space-mount-fixture'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { createPreloadSpaceMount } from '../src/preload/space-mount'

// Electron preserves callable proxies, but not an AbortSignal's prototype.
// Exercise every nested surface through that same serialization boundary.
const exposed = vi.hoisted(() => {
  const bridge = (value: any): any => {
    if (typeof value === 'function') return (...args: unknown[]) => {
      const result = value(...args.map(bridge))
      return result instanceof Promise ? result.then(bridge) : bridge(result)
    }
    if (value && typeof value === 'object') {
      if (value instanceof AbortSignal) return {}
      if (Array.isArray(value)) return value.map(bridge)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bridge(item)]))
    }
    return value
  }
  return { api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), bridge }
})
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/agentmux-startup-observation-fixture' }, contextBridge: { exposeInMainWorld: (_name: string, value: AgentMuxPreloadApi) => { exposed.api = exposed.bridge(value) } },
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

test('a cancellable original member read crosses the public preload and actual Core without replacing its Session or source graph', async () => {
  const original = await createSpaceSessionsFixture(cleanup), sid = 'startup-original-member'
  original.d.core.providers.register(new AgentProviderRegistry().get('codex'))
  const session = await original.d.put(sid), admission = await original.admit('D-in-B', original.d.owner.runtimeId, sid, 'startup-original-creation')
  const f = spaceMountTransport(cleanup, [{ id: 'original-source', carrier: {
    forwardRpc: original.b.rpc.call.bind(original.b.rpc), subscribeRpc: original.b.rpc.subscribe.bind(original.b.rpc)
  } }], structuredClone(DEFAULT_CONFIG))
  exposed.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => await f.handlers.get(channel)!(f.event, ...args))
  exposed.on.mockImplementation(f.renderer.on.bind(f.renderer)); exposed.removeListener.mockImplementation(f.renderer.removeListener.bind(f.renderer))
  const port = createRendererSpaceMount(exposed.api!.spaceMounts), controller = new AbortController()
  const target = { hostId: 'original-source', target: { reference: original.reference, regionId: admission.address.regionId,
    runtimeId: original.d.owner.runtimeId, agentSessionId: sid, expectedRun: session.run } }
  const before = await original.b.spatial.read(), beforeSession = await original.d.core.readAgentSession(sid)
  const surface = await port.member(target, () => {}, controller.signal)
  cleanup.push(() => surface.dispose())
  const read = await surface.call('read', {}, controller.signal)
  expect(read).toMatchObject({ id: surface.initial.id, control: { agentSessionId: sid, run: session.run } })
  expect(await original.b.spatial.read()).toEqual(before)
  expect(await original.d.core.readAgentSession(sid)).toEqual(beforeSession)
  controller.abort()
  await vi.waitFor(() => expect(f.renderer.listenerCount('spaceMounts:memberEvent')).toBe(0))
  expect(await original.d.core.readAgentSession(sid)).toEqual(beforeSession)
})

test('nested bridged read and conversation calls cancel only their own original IPC token', async () => {
  const calls: Array<{ token: string; memberToken: string; method: string; input: any }> = [], cancelled: string[] = []
  const waiting = new Map<string, (value: unknown) => void>()
  const ipc = { on() {}, removeListener() {}, invoke: async (channel: string, ...args: any[]) => {
    if (channel === 'spaceMounts:member') return { ok: true, value: { id: 'original-member', hostId: 'original-carrier' } }
    if (channel === 'spaceMounts:cancel') { cancelled.push(args[0]); return }
    expect(channel).toBe('spaceMounts:memberCall')
    const [token, memberToken, method, input] = args; calls.push({ token, memberToken, method, input })
    if (input.input?.cursor) return await new Promise(resolve => waiting.set(input.input.cursor, resolve))
    return { ok: true, value: { originalMethod: method } }
  } }
  const port = createRendererSpaceMount(exposed.bridge(createPreloadSpaceMount(ipc as never)))
  const target = { hostId: 'original-carrier', target: { reference: { runtimeId: 'source', spaceId: 'original-space' }, regionId: 'original-region',
    runtimeId: 'execution', agentSessionId: 'original-agent', expectedRun: { runId: 'original-run' } } }
  const surface = await port.member(target, () => {})
  for (const [method, input] of [['read', {}], ['conversationRead', { input: { limit: 3, maxBytes: 65536 } }], ['conversationWatch', {}]] as const) {
    expect(await surface.call(method, input, new AbortController().signal)).toEqual({ originalMethod: method })
  }
  const one = new AbortController(), two = new AbortController()
  const a = surface.call('conversationRead', { input: { cursor: 'original-a' } }, one.signal).then(value => ({ value }), error => ({ error }))
  const b = surface.call('conversationRead', { input: { cursor: 'original-b' } }, two.signal)
  await vi.waitFor(() => expect(waiting.size).toBe(2)); one.abort()
  expect(cancelled).toEqual([calls.find(call => call.input.input?.cursor === 'original-a')!.token])
  waiting.get('original-a')!({ ok: true, value: { originalMethod: 'conversationRead' } })
  waiting.get('original-b')!({ ok: true, value: { originalMethod: 'conversationRead' } })
  expect(await a).toHaveProperty('error')
  expect(await b).toEqual({ originalMethod: 'conversationRead' })
  expect(new Set(calls.map(call => call.memberToken)).size).toBe(1)
  expect(calls.slice(0, 3).map(call => call.method)).toEqual(['read', 'conversationRead', 'conversationWatch'])
  await surface.dispose()
})
