import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { defaultAgentMuxControlSocketPath } from '../../../packages/core/src/runtime-paths.js'
import { createNameControlClient } from '../../../packages/core/src/name-control-client.js'
import { connectDesktopAgentMuxHost, callOriginalDesktopHost } from '../src/main/desktop-host.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'

const platform = vi.hoisted(() => ({ start: vi.fn(async () => { throw Error('A serving private Unix owner must not launch a host') }) }))
vi.mock('@agentmux/host/macos-service', () => ({ macosHostService: (x: unknown) => x, ensureMacosHostService: platform.start }))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function fixture() {
  const f = await rpcOwnerFixture(['original']); cleanup.push(f.close)
  const session = await f.store.readMetadata('original'); if (!session) throw Error('Original fixture Session absent')
  await f.store.compareAndSwap(session, { ...session, creation: { createOperationId: 'original-C', initialPrompt: 'unknown' } })
  const owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance', protocolVersion: 2 as const,
    processId: process.pid, ctxmux: null, availability: 'connected' as const }
  const hosted = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => owner); cleanup.push(() => hosted.dispose())
  const cold = deferred(), originalCall = hosted.call.bind(hosted), calls: Array<{method: string; invocation?: string; expectedRuntimeId?: unknown}> = []
  let identities = 0
  vi.spyOn(hosted, 'call').mockImplementation(async (method, params, context) => {
    calls.push({ method, ...(method === 'runtime.invoke' ? { invocation: (params as { invocation: { method: string } }).invocation.method } : {}),
      ...(method === 'runtime.owner.identity' ? { expectedRuntimeId: (params as { expectedRuntimeId?: unknown }).expectedRuntimeId } : {}) })
    if (method === 'runtime.owner.identity' && ++identities === 1) await cold.promise
    return await originalCall(method, params, context)
  })
  // Native/PTY is not part of this metadata scenario. The original all-Session owner alone fails.
  const inventory = vi.spyOn(f.client, 'readAgentSessions').mockRejectedValue(Error('Unrelated all-Session metadata read unavailable'))
  const native = vi.spyOn(f.client, 'connectRuntime').mockRejectedValue(Error('Metadata must not connect Native'))
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  const nameRead = vi.spyOn(spatial, 'readDisplayLabel')
  const server = new AgentMuxControlServer({ socketPath: defaultAgentMuxControlSocketPath(), spatialState: spatial,
    coreClients: f.coreClients, hostedRuntime: () => hosted })
  cleanup.push(() => server.stop()); await server.start()
  const client = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, f.store)
  cleanup.push(async () => { cold.resolve(); await client.dispose() })
  await vi.waitFor(() => expect(identities).toBe(1))
  expect('runtimeOwnerIdentity' in client && client.runtimeOwnerIdentity()).toBeNull()
  const controller = Object.assign(Object.create(RuntimeController.prototype), { hosts: new Map([['local', { client }]]), hostReconfigurationReservations: new Map() }) as RuntimeController
  return { ...f, owner, client, controller, spatial, cold, calls, inventory, native, nameRead }
}

it.each(['identity', 'name', 'coordinator-target'] as const)('the real local connector does not gate %s on an unrelated all-Session read', async kind => {
  const f = await fixture()
  const names = createNameControlClient({ call: (method, params) => callOriginalDesktopHost(f.client, method, params, {}) })
  const observed = await (kind === 'coordinator-target' ? f.controller.executionCoordinatorTarget() : kind === 'identity'
    ? callOriginalDesktopHost(f.client, 'runtime.owner.identity', { expectedRuntimeId: f.owner.runtimeId }, {})
    : names.inspectAgent({ runtimeId: f.owner.runtimeId, agentSessionId: 'original', createOperationId: 'original-C' }))
    .then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  if (process.env.T011_LOCAL_OWNER_EVIDENCE) await writeFile(join(process.env.T011_LOCAL_OWNER_EVIDENCE, kind + '-observation.json'), JSON.stringify({ kind, observed,
    calls: f.calls, inventoryReads: f.inventory.mock.calls.length, nativeConnects: f.native.mock.calls.length,
    labelReads: f.nameRead.mock.calls.length, platformStarts: platform.start.mock.calls.length }, null, 2))
  expect(observed).toHaveProperty('value')
  expect(f.inventory).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(platform.start).not.toHaveBeenCalled()
  if ('value' in observed && kind === 'identity') expect(observed.value).toMatchObject({ owner: f.owner })
  if ('value' in observed && kind === 'name') expect(observed.value).toMatchObject({ target: { runtimeId: f.owner.runtimeId, id: 'original' }, diskAcknowledgement: 'not-observed' })
  if ('value' in observed && kind === 'coordinator-target') expect(observed.value).toEqual({ hostId: 'local', runtimeId: f.owner.runtimeId })
})

it('warm metadata keeps the original actor, instance fence, device boundary and reader cancellation', async () => {
  const f = await fixture(), target = { runtimeId: f.owner.runtimeId, agentSessionId: 'original', createOperationId: 'original-C' }
  const names = createNameControlClient({ call: (method, params) => callOriginalDesktopHost(f.client, method, params, { caller: f.credentials }) })
  const changed = await names.changeAgent({ ...target, change: { kind: 'rename', operationId: 'original-name-OP', name: 'Original Agent', expectedNameRevision: 0, source: 'manual' } })
  expect(changed.record.context.actor).toEqual({ kind: 'agent', id: 'original', verified: true })
  expect(changed.save.diskDurability).toBe('confirmed')
  const discoveries = () => f.calls.filter(call => call.method === 'runtime.owner.identity' && call.expectedRuntimeId === undefined).length
  const before = discoveries()
  expect((await names.inspectAgent(target)).current.override).toBe('Original Agent')
  expect(await f.controller.executionCoordinatorTarget()).toEqual({ hostId: 'local', runtimeId: f.owner.runtimeId })
  expect(discoveries()).toBe(before)
  const mutations = vi.spyOn(f.spatial, 'mutateDisplayLabel')
  await expect(callOriginalDesktopHost(f.client, 'agent.name.inspect', target, {}, { runtimeId: f.owner.runtimeId, ownerInstanceId: 'another-instance' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  const calls = f.calls.length
  await expect(callOriginalDesktopHost(f.client, 'agent.name.inspect', target, { principal: { kind: 'device', id: 'device-without-forwarding' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const abort = new AbortController(); abort.abort(new AgentMuxError('Original reader cancelled', 'CONTROL_CANCELLED'))
  await expect(callOriginalDesktopHost(f.client, 'runtime.owner.identity', {}, { signal: abort.signal })).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(f.calls).toHaveLength(calls); expect(mutations).not.toHaveBeenCalled()
  expect(f.inventory).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(platform.start).not.toHaveBeenCalled()
})
