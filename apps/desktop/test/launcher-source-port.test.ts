import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createHostRouteInventoryFixture } from '../../../packages/core/test/helpers/host-route-inventory-fixture'
import type { AgentMuxRpcMethod, AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxRpcCallContext } from '../../../packages/core/src/public-rpc-service'
import { spaceMountFixture, spaceMountTransport } from './helpers/space-mount-fixture'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('ordinary Source discovery reaches the original Core through trusted Main/Preload and reports its actual missing launch contract', async () => {
  const f = await spaceMountFixture(cleanup), b = f.cores[1]!, local = f.cores[0]!
  const target = { hostId: b.id, reference: { runtimeId: b.identity.runtimeId, spaceId: 'original-space' } }
  const description = await f.api.call('describe', target)
  expect(description).toEqual({ source: { runtimeId: b.identity.runtimeId, ownerInstanceId: b.identity.ownerInstanceId },
    contracts: { ordinaryLaunch: null, externalAssociation: null, takeover: null } })
  const source = { hostId: b.id, expectedRuntimeId: b.identity.runtimeId }
  expect(await f.api.call('describe', source)).toEqual(description)
  expect(await f.api.call('hostChoices', source)).toMatchObject({ runtimeId: b.identity.runtimeId, hosts: [
    { hostId: 'local', kind: 'local', runtimeId: b.identity.runtimeId }, { hostId: b.id + '-original-remote', kind: 'ssh', runtimeId: b.id + '-remote-runtime' }
  ] })
  await expect(f.api.call('describe', { ...target, expectedRuntimeId: b.identity.runtimeId })).rejects.toThrow('Choose one exact original Source address')
  expect(await b.store.read()).toBeNull(); expect(await local.store.read()).toBeNull()
  await expect(f.api.call('describe', { ...target, hostId: local.id })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(() => f.handlers.get('spaceMounts:call')!({ ...f.event, senderFrame: { ...f.sender.mainFrame } } as never,
    'foreign-frame', 'describe', target)).toThrow('Untrusted application')
})

it('ordinary selected inventory keeps Source-realm direct and routed targets separate and returns only the actual selected Provider declaration', async () => {
  const route = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>)
  await route.collision.client.configureHostExecutor({ executorId: 'selected-executor', config: { label: 'C original', providerId: 'codex',
    command: '/private/C/original', args: [], env: {}, injectAgentMuxGuide: false } })
  await route.original.client.configureHostExecutor({ executorId: 'selected-executor', config: { label: 'D original', providerId: 'claude', command: '/private/D/original', args: [], env: {}, injectAgentMuxGuide: false } })
  const direct = vi.spyOn(route.collision.client, 'listHostExecutors')
  const calls: Array<{ method: string; params: unknown }> = []
  async function forwardRpc<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context?: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>> {
    calls.push({ method, params })
    // B control identity is the explicit metadata leaf, as in the existing
    // route GUI fixture. Original signed Core route/Provider owners stay real.
    if (method === 'runtime.owner.identity') return { owner: { runtimeId: route.b.identity.runtimeId, ownerInstanceId: 'B-original-instance',
      protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' } } as AgentMuxRpcResult<M>
    if (method === 'settings.executors.discover') {
      const input = params as AgentMuxRpcParams<'settings.executors.discover'>
      expect(input.hostId).toBe('collision')
      const inventory = await route.collision.client.listHostExecutors({ ...(input.executorId === undefined ? {} : { executorId: input.executorId }), refresh: false })
      return { ...inventory, routeHostId: input.hostId } as AgentMuxRpcResult<M>
    }
    return await route.rpc.call(method, params, context)
  }
  const bridge = spaceMountTransport(cleanup, [{ id: 'saved-source-B', carrier: { forwardRpc, subscribeRpc: route.rpc.subscribe.bind(route.rpc) } }])
  const target = { hostId: 'saved-source-B', reference: { runtimeId: route.b.identity.runtimeId, spaceId: 'original-space' } }
  const directRead = await bridge.api.call('executors', { ...target, agentHostId: 'collision', executorId: 'selected-executor' })
  const selected = (await bridge.api.call('routeChoices', target)).routes.find(choice => choice.id === 'collision')!
  const routedRead = await bridge.api.call('routeExecutors', { ...target, agentTarget: selected.agentTarget, executorId: 'selected-executor' })
  expect(direct).toHaveBeenCalledWith({ executorId: 'selected-executor', refresh: false })
  expect(route.inventory).toHaveBeenCalledWith({ executorId: 'selected-executor', refresh: false })
  expect(directRead.executors).toHaveLength(1); expect(routedRead.inventory.executors).toHaveLength(1)
  expect(directRead.executors[0]).toMatchObject({ executorId: 'selected-executor', providerId: 'codex', creationContract: { ordinaryLaunch: 1 } })
  expect(routedRead.inventory.executors[0]).toMatchObject({ executorId: 'selected-executor', providerId: 'claude', creationContract: { ordinaryLaunch: 1 } })
  expect(directRead.executors[0]!.launchOptions).toEqual(route.collision.client.catalog().find(provider => provider.id === 'codex')!.launchOptions)
  expect(routedRead.inventory.executors[0]!.launchOptions).toEqual(route.original.client.catalog().find(provider => provider.id === 'claude')!.launchOptions)
  expect(routedRead.agentTarget).toEqual(selected.agentTarget)
  expect(calls.find(call => call.method === 'route.executors')?.params).toMatchObject({ agentTarget: selected.agentTarget, executorId: 'selected-executor', refresh: false })
  expect(route.creation).not.toHaveBeenCalled(); expect(route.native).not.toHaveBeenCalled(); expect(route.connect).not.toHaveBeenCalled()
})
