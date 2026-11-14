import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { registerMeshNetworkIpc } from '../src/main/mesh-network-ipc'
import { createRendererMeshNetwork } from '../src/renderer/src/lib/mesh-network-client'
import { defaultMeshNetworkConfiguration } from '../../../packages/core/src/mesh-network'
class Sender extends EventEmitter { id = 32; isDestroyed() { return false } }
it('actual Renderer bridge and registered Main route only declared original-Core methods with unchanged Runtime fence', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender(), owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' }
  const settings = { owner, identity: null, revision: 'r1', configuration: defaultMeshNetworkConfiguration(), operation: null }
  const call = vi.fn(async () => settings)
  const resources = registerMeshNetworkIpc({ handle: (name, fn) => handlers.set(name, fn), call: call as never })
  const renderer = createRendererMeshNetwork({ call: async (method, params, context) => await handlers.get('mesh:call')!({ sender }, 'exact-read', method, params, context?.expectedOwner) })
  await expect(renderer.call('settings.mesh.inspect', {}, { expectedOwner: owner })).resolves.toEqual(settings)
  expect(call.mock.calls).toHaveLength(1); expect((call.mock.calls[0] as any)[0]).toBe('settings.mesh.inspect'); expect((call.mock.calls[0] as any)[2].runtimeFence).toEqual(owner)
  const rejected = await handlers.get('mesh:call')!({ sender }, 'bad', 'settings.mesh.configure', { expectedRevision: 'r1', operationId: 'original-save', configuration: settings.configuration }, undefined)
  expect(rejected).toMatchObject({ ok: false, error: { controlFailure: { disposition: 'not_applied' } } }); expect(call).toHaveBeenCalledTimes(1)
  const foreign = await handlers.get('mesh:call')!({ sender }, 'bad', 'agent.input', {}, owner); expect(foreign.ok).toBe(false); expect(call).toHaveBeenCalledTimes(1)
  resources.dispose()
})
