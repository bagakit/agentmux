// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, HostConfig } from '../src/shared/contracts'
import { registerHostRuntimeObservationIpc } from '../src/main/host-runtime-observation-ipc'
import { createRendererHostObservation } from '../src/renderer/src/lib/host-observation'
import { observeRead } from '../../../packages/core/src/observation-read'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'
class Sender extends EventEmitter { id = 72; isDestroyed() { return false } }
afterEach(() => { bridge.invoke.mockReset() })
it('actual preload and Renderer home adapter reach the exact public Host read through registered Main', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender()
  const call = vi.fn(async () => ({ routeHostId: 'remote-home', homeDirectory: '/Users/remote-original' }))
  const owner = registerHostRuntimeObservationIpc({ handle: (name, handler) => handlers.set(name, handler), call: call as never })
  bridge.invoke.mockImplementation(async (channel, ...values) => { const handler = handlers.get(channel); if (!handler) throw new Error('Unexpected IPC channel'); return await handler({ sender }, ...values) })
  const host: HostConfig = { id: 'remote-home', kind: 'ssh', label: 'Remote', hostname: 'remote.invalid', runtimeId: 'original-owner' }
  try {
    const home = createRendererHostObservation(bridge.api!.hosts.home)
    expect(await home(host)).toEqual({ routeHostId: host.id, homeDirectory: '/Users/remote-original' })
    expect(bridge.invoke.mock.calls[0]![0]).toBe('hosts:home')
    expect(bridge.invoke.mock.calls[0]![1]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(call.mock.calls[0]!.slice(0, 2)).toEqual(['settings.hosts.home', { hostId: host.id, expected: host }])
    expect(sender.listenerCount('destroyed')).toBe(0)
  } finally { owner.dispose() }
})
it('actual preload cancellation ends only that sender’s home reader and removes its abort subscription', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender()
  let signal!: AbortSignal
  const call = vi.fn(async (_method, _params, context: { signal: AbortSignal }) => { signal = context.signal; return await observeRead(new Promise<never>(() => {}), signal) })
  const owner = registerHostRuntimeObservationIpc({ handle: (name, handler) => handlers.set(name, handler), call })
  bridge.invoke.mockImplementation(async (channel, ...values) => handlers.get(channel)!({ sender }, ...values))
  const host: HostConfig = { id: 'local', kind: 'local', label: 'This Mac' }, controller = new AbortController()
  try {
    const home = createRendererHostObservation(bridge.api!.hosts.home)
    const pending = home(host, { signal: controller.signal })
    const token = bridge.invoke.mock.calls[0]![1]
    handlers.get('hosts:cancelInspect')!({ sender: { id: 99 } }, token)
    expect(signal.aborted).toBe(false)
    controller.abort(); await expect(pending).rejects.toBeDefined()
    expect(signal.aborted).toBe(true)
    expect(bridge.invoke.mock.calls.at(-1)).toEqual(['hosts:cancelInspect', token])
    expect(sender.listenerCount('destroyed')).toBe(0)
  } finally { owner.dispose() }
})
