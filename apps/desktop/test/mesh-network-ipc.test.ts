import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { registerMeshNetworkIpc } from '../src/main/mesh-network-ipc'
import { createRendererMeshNetwork } from '../src/renderer/src/lib/mesh-network-client'
import { defaultMeshNetworkConfiguration } from '../../../packages/core/src/mesh-network'
import { localMeshIdentity, localMeshIdentityNamespace } from '../src/main/local-identity-setup'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
class Sender extends EventEmitter { id = 32; isDestroyed() { return false } }
it('actual Renderer bridge and registered Main route only declared original-Core methods with unchanged Runtime fence', async () => {
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender(), owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' }
  const settings = { owner, identity: null, revision: 'r1', configuration: defaultMeshNetworkConfiguration(), operation: null }
  const call = vi.fn(async () => settings)
  const resources = registerMeshNetworkIpc({ handle: (name, fn) => handlers.set(name, fn), call: call as never })
  const renderer = createRendererMeshNetwork({ call: async (method, params, context) => await handlers.get('mesh:call')!({ sender }, 'exact-read', method, params, context?.expectedOwner) })
  const observed = await renderer.call('settings.mesh.inspect', {}, { expectedOwner: owner }).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
  expect(observed).toEqual({ status: 'fulfilled', value: settings })
  expect(call.mock.calls).toHaveLength(1); expect((call.mock.calls[0] as any)[0]).toBe('settings.mesh.inspect'); expect((call.mock.calls[0] as any)[2].runtimeFence).toEqual(owner)
  const rejected = await handlers.get('mesh:call')!({ sender }, 'bad', 'settings.mesh.configure', { expectedRevision: 'r1', operationId: 'original-save', configuration: settings.configuration }, undefined)
  expect(rejected).toMatchObject({ ok: false, error: { controlFailure: { disposition: 'not_applied' } } }); expect(call).toHaveBeenCalledTimes(1)
  const foreign = await handlers.get('mesh:call')!({ sender }, 'bad', 'agent.input', {}, owner); expect(foreign.ok).toBe(false); expect(call).toHaveBeenCalledTimes(1)
  resources.dispose()
})

it('uses the same separate Mesh Core through Main and Renderer after its real process restarts', async () => {
  const { privateCore } = createRequire(import.meta.url)(resolve('apps/desktop/scripts/fixtures/mesh-settings/private-core.mjs'))
  const directory = await mkdtemp('/tmp/amux-inline-mesh-'), original = join(directory, 'original')
  await mkdir(original)
  const namespace = await localMeshIdentityNamespace(original)
  const witness = join(original, 'workbench.json')
  await writeFile(witness, 'original workbench')
  let child: Awaited<ReturnType<typeof privateCore>> | undefined
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender()
  const separate = localMeshIdentity(original)
  const originalCall = vi.fn()
  const resources = registerMeshNetworkIpc({ handle: (name, fn) => handlers.set(name, fn), call: originalCall as never, separate: separate.call })
  let sequence = 0
  const bridge = createRendererMeshNetwork({ call: async (method, params, context) =>
    await handlers.get('mesh:call')!({ sender }, 'separate-read-' + ++sequence, method, params, context?.expectedOwner, context?.separateRuntimeId) })
  try {
    child = await privateCore({ namespace, host: true })
    const first = await separate.prepare()
    const choice = { separateRuntimeId: first.runtimeId }
    const before = await bridge.call('settings.mesh.inspect', {}, choice)
    expect(before.owner).toEqual(first)
    const configuration = { ...before.configuration, networkId: 'separate-draft' }
    const saved = await bridge.call('settings.mesh.configure', { expectedRevision: before.revision, operationId: 'preserve-separate-save', configuration }, { ...choice, expectedOwner: first })
    expect(saved.diskDurability).toBe('confirmed')
    await expect(bridge.call('settings.mesh.inspect', {}, { separateRuntimeId: 'another-runtime' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    await child.close(); child = undefined
    child = await privateCore({ namespace, host: true })
    const after = await bridge.call('settings.mesh.inspect', { operationId: 'preserve-separate-save' }, choice)
    expect(after.owner.runtimeId).toBe(first.runtimeId)
    expect(after.owner.ownerInstanceId).not.toBe(first.ownerInstanceId)
    expect(after.operation).toMatchObject({ status: 'confirmed', revision: saved.settings.revision })
    expect(after.configuration).toEqual(configuration)
    expect(await separate.prepare(first.runtimeId)).toEqual(after.owner)
    expect(originalCall).not.toHaveBeenCalled()
    expect(await readFile(witness, 'utf8')).toBe('original workbench')
  } finally {
    resources.dispose()
    await child?.close()
    await rm(namespace.runtime, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
