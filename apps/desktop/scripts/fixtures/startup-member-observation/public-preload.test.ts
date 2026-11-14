// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentMuxPreloadApi } from '../../../src/shared/contracts'
import { createRendererSpaceMount } from '../../../src/renderer/src/lib/space-mount-api'
import { spaceMountTransport } from '../../../test/helpers/space-mount-fixture'
import { createSpaceSessionsFixture } from '../../../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../../../packages/core/src/agent-provider'
import { DEFAULT_CONFIG } from '../../../src/main/config-store'

const exposed = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/isolated-startup-member-observation' }, contextBridge: { exposeInMainWorld: (_name: string, value: AgentMuxPreloadApi) => { exposed.api = value } },
  ipcRenderer: { invoke: exposed.invoke, on: exposed.on, removeListener: exposed.removeListener }, webFrame: { getZoomFactor: () => 1 } }))
import '../../../src/preload/index'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

// Same-realm Core coverage supplements, but never substitutes for, the actual
// sandboxed/context-isolated Electron bridge verifier.
test('a cancellable original member read crosses public Preload and real Core without replacing its Session or source graph', async () => {
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
