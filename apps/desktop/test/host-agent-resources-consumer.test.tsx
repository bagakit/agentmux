// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { NodePublishingOwner } from '../../../packages/core/src/node-publishing-owner'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { registerHostRuntimeObservationIpc } from '../src/main/host-runtime-observation-ipc'
import { assertAppDocumentSender } from '../src/main/ipc-sender-trust'
import { createRendererHostAgentResources, createRendererHostObservation } from '../src/renderer/src/lib/host-observation'
import { HostRuntimePanel } from '../src/renderer/src/components/settings/HostRuntimePanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import type { AgentMuxPreloadApi, HostConfig } from '../src/shared/contracts'
const preloadBridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { preloadBridge.api = api } }, ipcRenderer: { invoke: preloadBridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'
const dom = composerDOM()
vi.mock('@agentmux/editor-extensions/engines/vega-worker', () => ({ createVegaPreview: () => ({ replaceData() {}, resize() {}, dispose() {} }) }))
it('actual trusted Main/preload/Renderer public consumers show exact saved Agents separately from two Native thin passes, with original Share false', async () => {
  const original = await rpcOwnerFixture(['current', 'saved-not-running'])
  const identity = { runtimeId: 'service-runtime', ownerInstanceId: 'service-instance', protocolVersion: 2, processId: process.pid, ctxmux: original.client.runtimeIdentity(), availability: 'connected' as const }
  Object.assign(original.client, { runtimeOwnerIdentity: () => identity })
  const runs = ['run-current', 'terminal', 'helper', 'retired-run', 'another-helper'].map(id => ({ id, backend: 'native' as const, pid: 1, state: { type: 'running' as const }, latest_output_bytes: 1000, retained_output_bytes: 12, attachments: 1 }))
  const listPage = vi.fn(async (cursor: string | null) => ({ runs: cursor === null ? runs.slice(0, 3) : runs.slice(3), nextCursor: cursor === null ? 'second-page' : null }))
  const status = vi.fn(async () => { throw Error('No per-Run status hydration for service observation') })
  Object.assign(original.inner.kernel, { client: { listPage, status } })
  const host: HostConfig = { id: 'selected', kind: 'ssh', label: 'Original service', hostname: 'private.invalid', runtimeId: identity.runtimeId }
  const hosted = new AgentMuxHostedRuntimeService(original.client, null, () => identity)
  const node = new NodePublishingOwner({ stateDirectory: original.root, runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId })
  const server = new AgentMuxControlServer({ socketPath: join(original.root, 'observations.sock'), hostedRuntime: () => hosted, nodePublishing: node,
    hostConfiguration: id => id === host.id ? host : null, coreClients: () => [{ hostId: host.id, client: original.client }] })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  class Sender extends EventEmitter { id = 73; mainFrame = { url: 'file:///private/service/index.html', detached: false, isDestroyed: () => false }; isDestroyed() { return false } }
  const sender = new Sender(), event = { sender, senderFrame: sender.mainFrame }, handlers = new Map<string, (...args: any[]) => any>()
  const calls: Array<{ method: string; params: unknown }> = []
  const readOwner = registerHostRuntimeObservationIpc({ handle: (channel, handler) => handlers.set(channel, (event, ...args) => {
    assertAppDocumentSender(event, sender, { current: { mode: 'prod', filePath: '/private/service/index.html' }, loading: null }); return handler(event, ...args)
  }), call: (method, params, context) => { calls.push({ method, params }); return rpc.call(method, params, context) } })
  preloadBridge.invoke.mockImplementation(async (channel, ...args) => handlers.get(channel)!(event, ...args))
  const agentRead = createRendererHostAgentResources(preloadBridge.api!.hosts.agentResources)
  vi.spyOn(api.hosts, 'agentResources').mockImplementation(agentRead)
  vi.spyOn(api.hosts, 'inspect').mockImplementation(createRendererHostObservation(preloadBridge.api!.hosts.inspect))
  vi.spyOn(api.nodePublishing, 'owner').mockImplementation(async (_target, method, params) => rpc.call(method, params))
  try {
    const before = await rpc.call('settings.node.inspect', {})
    expect(before.policy.shareResources).toBe(false)
    await dom.render(<HostRuntimePanel host={host} committed={host} active />)
    await vi.waitFor(() => expect([...dom.container.querySelectorAll('[aria-label="Agent record measurements"] strong')].map(n => n.textContent)).toEqual(['Agent records', '2', '1', '0']))
    await vi.waitFor(() => expect(listPage.mock.calls).toHaveLength(4))
    expect(listPage.mock.calls.filter(([cursor]) => cursor === null)).toHaveLength(2)
    expect(dom.container.querySelector('[aria-label="Native workload measurements"]')?.textContent).toContain('5 retained in total')
    await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Core I/O operations"]')?.textContent).toContain('cumulative'))
    expect(calls.filter(call => call.method === 'settings.hosts.agent-resources').map(call => call.params)).toEqual([
      { hostId: host.id, expected: host, kind: 'records', expectedRuntimeId: identity.runtimeId },
      { hostId: host.id, expected: host, kind: 'running', expectedRuntimeId: identity.runtimeId }
    ])
    expect(preloadBridge.invoke.mock.calls.some(call => call[0] === 'hosts:agentResources' && call[2] === host && call[3] === 'records')).toBe(true)
    await dom.click('[aria-label="Refresh Runtime observation"]')
    await vi.waitFor(() => expect(listPage.mock.calls).toHaveLength(8))
    expect(status).not.toHaveBeenCalled()
    await expect(agentRead({ ...host, hostname: 'changed.invalid' }, 'records', identity.runtimeId)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
    await expect(agentRead(host, 'records', 'foreign-runtime')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_UNCONFIRMED' })
    expect(() => handlers.get('hosts:agentResources')!({ ...event, senderFrame: { ...sender.mainFrame } }, 'foreign-frame', host, 'records')).toThrow('Untrusted application')
    expect((await rpc.call('settings.node.inspect', {})).policyRevision).toBe(before.policyRevision)
    expect(original.inner.kernel.stop).not.toHaveBeenCalled(); expect(original.rawInput).not.toHaveBeenCalled()
  } finally { await dom.render(<div />); readOwner.dispose(); await rpc.dispose(); await server.stop(); await hosted.dispose(); await original.close() }
})

it('actual fixed Agent read cancels only its sending frame lease and preserves the original error envelope', async () => {
  class Sender extends EventEmitter { id = 91; isDestroyed() { return false } }
  const sender = new Sender(), handlers = new Map<string, (...args: any[]) => any>()
  let signal!: AbortSignal
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, handler) => handlers.set(channel, handler), call: async (_method, _params, context) => {
    signal = context.signal
    return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('Only this original reader cancelled'), { code: 'CANCELLED' })), { once: true }))
  } })
  preloadBridge.invoke.mockImplementation(async (channel, ...args) => handlers.get(channel)!({ sender }, ...args))
  try {
    const controller = new AbortController(), read = createRendererHostAgentResources(preloadBridge.api!.hosts.agentResources)
    const pending = read({ id: 'original', kind: 'local', label: 'Original' }, 'running', undefined, { signal: controller.signal })
    expect(signal.aborted).toBe(false); const rejected = expect(pending).rejects.toBeDefined(); controller.abort()
    await rejected; expect(signal.aborted).toBe(true)
    expect(sender.listenerCount('destroyed')).toBe(0)
  } finally { owner.dispose() }
})
