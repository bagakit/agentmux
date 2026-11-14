import { afterEach, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../src/host.js'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })

test('the actual Host does not label a delegated original actor as its own local input device', async () => {
  const original = await rpcOwnerFixture(['original-SID'], core)
  cleanup.push(original.close); await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try { host = await startAgentMuxHost({ store: original.store, socketPath: join(original.root, 'D.sock'), desktopSocketPath: join(original.root, 'no-desktop.sock'), mobileBuildDirectory: join(original.root, 'no-mobile') }) }
  finally { connect.mockRestore() }
  cleanup.push(() => host.dispose())
  const device = await host.deviceAuthority()
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(original.root, 'D.sock') } }); cleanup.push(() => rpc.dispose())
  const identity = await rpc.call('route.identity', {}), owner = (await rpc.call('runtime.owner.identity', {})).owner
  const prompt = { agentSessionId: 'original-SID', expectedRun: { runId: 'run-original-SID' }, operationId: 'original-local-prompt', prompt: 'original body', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
  const leaf = vi.spyOn(host.client, 'submitAgentPrompt').mockResolvedValue(undefined)
  const params = { consumerId: 'known-original-reader', fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, invocation: { method: 'submitAgentPrompt' as const, args: [prompt] } }
  await rpc.call('runtime.invoke', params)
  expect(leaf.mock.calls.at(-1)?.[0].sourceDevice).toEqual(device.operationSource({ kind: 'user', id: 'local-user' }))
  expect(leaf.mock.calls.at(-1)?.[0].sourceDevice?.deviceId).toBe('local')
  const authority = new core.AgentMuxCreationAuthority({ stateDirectory: join(original.root, 'A-key'), runtimeId: 'original-A-runtime' })
  const source = await authority.identity(), route = { source, hops: [{ edgeId: 'D', target: identity }] }
  let server: core.AgentMuxControlServer
  const gateway = new core.HostRouteGateway({ stateDirectory: join(original.root, 'A-key'), authority, edge: () => core.hostRouteTransport(rpc),
    call: (method, input, context) => server.callRpc(method, input, context), subscribe: (method, input, emit, context) => server.subscribeRpc(method, input, emit, context) })
  server = new core.AgentMuxControlServer({ hostRoutes: gateway }, join(original.root, 'A.sock')); await server.start()
  cleanup.push(async () => { gateway.dispose(); await server.stop() })
  const sourceRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(original.root, 'A.sock') } }); cleanup.push(() => sourceRpc.dispose())
  const actor = { source, kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
  const sourceSettings = await sourceRpc.call('route.inspect', {}), receiverSettings = await rpc.call('route.inspect', {})
  await sourceRpc.call('route.configure', { expectedRevision: sourceSettings.revision, operationId: 'original-A-route', configuration: { routes: [{ id: 'D', route }], grants: [] } })
  await rpc.call('route.configure', { expectedRevision: receiverSettings.revision, operationId: 'original-D-grant', configuration: { routes: [], grants: [{ id: 'A-input', delegator: source, actor, destination: identity, scopes: ['runtime.invoke/submitAgentPrompt'] }] } })
  const delegated = { ...params, invocation: { method: 'submitAgentPrompt' as const, args: [{ ...prompt, operationId: 'original-A-prompt' }] } }
  const result = await sourceRpc.call('route.call', { routeId: 'D', adoptedRoute: route, requestId: 'original-correlation', call: { method: 'runtime.invoke', params: delegated } })
  expect(leaf).toHaveBeenCalledTimes(2)
  expect(leaf.mock.calls.at(-1)?.[0].sourceDevice).toBeUndefined()
  expect(result.observation.actor).toEqual(actor)
  expect(result.observation.route.hops.at(-1)?.target.runtimeId).toBe(owner.runtimeId)
})
