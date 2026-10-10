import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcCallContext, AgentMuxRpcServiceOptions } from '../../../packages/core/src/public-rpc-service'
import type { AppWindowMethod, AppWindowParamsMap } from '@agentmux/core/control'

const fixture = vi.hoisted(() => ({
  service: null as AgentMuxRpcServiceOptions | null,
  effect: vi.fn(), dispose: vi.fn(), stop: vi.fn()
}))
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual,
    startHeadlessAgentMux: vi.fn(async (options: Parameters<typeof actual.startHeadlessAgentMux>[0]) => {
      // Isolate native Runtime startup; retain the production Host's service closure.
      fixture.service = options?.service ?? null
      return { client: {}, hosted: null, server: {}, stop: fixture.stop }
    }),
    connectAgentMuxRpc: vi.fn(async () => ({ call: fixture.effect, dispose: fixture.dispose }))
  }
})

import { connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { startAgentMuxHost } from '../../host/src/host'

const target = { kind: 'region', displayWorkspaceId: 'original-workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' } as const
const open = { operationId: 'original-operation', target }
const pair = { operationId: 'original-operation', windowId: 'original-window', documentGeneration: 'original-document' }
const inputs: { [M in AppWindowMethod]: AppWindowParamsMap[M] } = {
  'app.window.ls': {}, 'app.window.open': open, 'app.window.focus': pair, 'app.window.return': pair
}
const device: AgentMuxRpcCallContext = { principal: { kind: 'device', id: 'original-device' }, transport: 'relay' }
let host: Awaited<ReturnType<typeof startAgentMuxHost>>
function forward() {
  expect(fixture.service?.forwardControl).toBeTypeOf('function')
  return fixture.service!.forwardControl!
}

beforeEach(async () => {
  vi.clearAllMocks()
  fixture.effect.mockReset().mockResolvedValue({ windows: [], recordedOperation: null })
  fixture.service = null
  host = await startAgentMuxHost({ store: {} as never, socketPath: 'original-control.sock', desktopSocketPath: 'original-desktop.sock' })
})
afterEach(async () => { await host?.dispose() })

for (const method of Object.keys(inputs) as AppWindowMethod[]) {
  it(`rejects authenticated device ${method} before desktop connection or effect through the actual Host factory`, async () => {
    const service = new AgentMuxRpcService(fixture.service!)
    await expect(service.call(method, inputs[method], device)).rejects.toMatchObject({
      code: 'CONTROL_UNAVAILABLE', message: expect.stringMatching(/device identity.*original workfaces and Agents remain available/)
    })
    expect(connectAgentMuxRpc).not.toHaveBeenCalled()
    expect(fixture.effect).not.toHaveBeenCalled()
    expect(fixture.dispose).not.toHaveBeenCalled()
    expect(fixture.stop).not.toHaveBeenCalled()
  })
}

it('keeps the authenticated local user window path, exact intent, signal and original receipt', async () => {
  const page = { windows: [], recordedOperation: { method: 'app.window.open', input: open,
    actor: { kind: 'user', id: 'original-user' }, state: 'confirmed', windowId: pair.windowId,
    documentGeneration: pair.documentGeneration, message: null } }
  fixture.effect.mockResolvedValueOnce(page)
  const signal = new AbortController().signal
  const service = new AgentMuxRpcService(fixture.service!)
  expect(await service.call('app.window.open', open, { principal: { kind: 'user', id: 'original-user' }, signal })).toEqual(page)
  expect(connectAgentMuxRpc).toHaveBeenCalledExactlyOnceWith({ endpoint: { transport: 'unix', path: 'original-desktop.sock' } })
  expect(fixture.effect).toHaveBeenCalledExactlyOnceWith('app.window.open', open, { signal })
  expect(fixture.dispose).toHaveBeenCalledExactlyOnceWith()
  expect(fixture.stop).not.toHaveBeenCalled()
})

it('retains the exact managed Agent credentials even when the receiving transport also has a device principal', async () => {
  const caller = { agentSessionId: 'original-session', capability: 'original-capability' }
  const signal = new AbortController().signal
  const page = { windows: [], recordedOperation: null }
  fixture.effect.mockResolvedValueOnce(page)
  // Core authenticates this caller before forwarding. The actual Host must preserve
  // those credentials instead of replacing them with the transport's device author.
  expect(await forward()('app.window.ls', {}, { ...device, caller, signal })).toBe(page)
  expect(connectAgentMuxRpc).toHaveBeenCalledExactlyOnceWith({ endpoint: { transport: 'unix', path: 'original-desktop.sock' }, credentials: caller })
  expect(vi.mocked(connectAgentMuxRpc).mock.calls[0]![0]!.credentials).toBe(caller)
  expect(fixture.effect).toHaveBeenCalledExactlyOnceWith('app.window.ls', {}, { signal })
  expect(fixture.dispose).toHaveBeenCalledExactlyOnceWith()
})

it('keeps unrelated device control on its original route', async () => {
  const result = { original: 'unrelated-desktop-result' }
  fixture.effect.mockResolvedValueOnce(result)
  expect(await forward()('app.inspect', {}, device)).toBe(result)
  expect(connectAgentMuxRpc).toHaveBeenCalledExactlyOnceWith({ endpoint: { transport: 'unix', path: 'original-desktop.sock' } })
  expect(fixture.effect).toHaveBeenCalledExactlyOnceWith('app.inspect', {}, {})
  expect(fixture.dispose).toHaveBeenCalledExactlyOnceWith()
})

it('disposes the original desktop connection and preserves a forwarding failure', async () => {
  const error = new Error('original-desktop-cause')
  fixture.effect.mockRejectedValueOnce(error)
  await expect(forward()('app.window.ls', {}, { principal: { kind: 'user', id: 'original-user' } })).rejects.toBe(error)
  expect(fixture.effect).toHaveBeenCalledExactlyOnceWith('app.window.ls', {}, {})
  expect(fixture.dispose).toHaveBeenCalledExactlyOnceWith()
})
