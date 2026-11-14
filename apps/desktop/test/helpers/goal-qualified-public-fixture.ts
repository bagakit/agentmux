// Original public Goal fixture, kept separate from test registrations. Native Runtime/Provider leaves are explicit.
import {expect,vi} from "vitest"
import {join} from "node:path"
import {writeFile} from "node:fs/promises"
import {rpcOwnerFixture} from "../../../../packages/core/test/helpers/public-rpc-owner"
import {AgentMuxSpatialStateStore} from "../../../../packages/core/src/spatial-state"
import {AgentMuxHostedRuntimeService} from "../../../../packages/core/src/hosted-runtime-service"
import {AgentMuxControlServer} from "../../../../packages/core/src/public-rpc-server"
import {connectAgentMuxRpc} from "../../../../packages/core/src/public-rpc-client"
import {connectHostedAgentMux} from "../../../../packages/core/src/hosted-client"
import type {AgentProvider} from "../../../../packages/core/src/agent-provider"
import type {AgentMuxHeadlessRuntime} from "../../../../packages/core/src/headless-runtime"
import type {DemandSpaceMemberReference} from "@agentmux/demand/relations"
import {createHostGoals} from "../../../host/src/goals"

export async function createGoalQualifiedPublicFixture(cleanup: Array<() => unknown | Promise<unknown>>, localMember = false) {
  const d = await rpcOwnerFixture(['original-SID']); cleanup.push(d.close)
  expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(d.root); expect(process.env.AGENTMUX_STATE_DIRECTORY).toBe(join(d.root, 'state'))
  const b = localMember ? d : await rpcOwnerFixture(['B-namesake']); if (!localMember) cleanup.push(b.close)
  expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(b.root); expect(process.env.AGENTMUX_STATE_DIRECTORY).toBe(join(b.root, 'state'))
  expect(d.client.agentMessageQueuePath().startsWith(d.root + '/')).toBe(true)
  expect(b.client.agentMessageQueuePath().startsWith(b.root + '/')).toBe(true)
  if (!localMember) expect(d.client.agentMessageQueuePath()).not.toBe(b.client.agentMessageQueuePath())
  const bOwner = { runtimeId: 'runtime-b', ownerInstanceId: 'original-B-instance', protocolVersion: 2 as const, processId: process.pid, availability: 'connected' as const, ctxmux: null }
  const dOwner = localMember ? bOwner : { ...bOwner, runtimeId: 'runtime-d', ownerInstanceId: 'original-D-instance' }
  const session = (await d.store.readMetadata('original-SID'))!, actor = { protocolId: 'public-goal-native', actorId: 'original-D-actor', lifecycleOperationId: 'original-lifecycle', token: 'b'.repeat(64), launch: { command: 'codex', args: [] } }
  await d.store.compareAndSwapMetadata(session, { ...session, nativeActor: actor, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-D-native' } })
  await d.inner.registry.load('local')
  d.inner.kernel.status = async (id: string) => ({ ...d.run(id), pid: 2345 })
  const raw = localMember ? vi.mocked(d.inner.kernel.input as (...args: unknown[]) => Promise<unknown>)
    : vi.fn(async () => { throw Error('A qualified Goal must never use terminal fallback') })
  const stop = vi.fn(); d.inner.kernel.input = raw; d.inner.kernel.stop = stop
  const provider = d.client.providers.get('codex'), previous = provider.prepareNativeInput
  const send = vi.fn<NonNullable<Awaited<ReturnType<NonNullable<AgentProvider['prepareNativeInput']>>>>['send']>(async () => ({ outcome: 'admitted', turnId: 'original-public-turn' }))
  provider.prepareNativeInput = async (_context, selected) => ({ plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), threadId: selected.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose: async () => {} })
  cleanup.push(() => { if (previous) provider.prepareNativeInput = previous; else delete provider.prepareNativeInput })
  const spatial = new AgentMuxSpatialStateStore(join(b.root, 'spatial.json')), folder = await spatial.registerFolder({ id: 'original-B-resource', hostId: 'local', name: 'Original B Project', path: localMember ? d.root : '/original/B/project' })
  const admitted = await spatial.admitAgentOpen({ request: { schemaVersion: 5, requestId: 'original-C', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'codex', ...(!localMember ? { agentTarget: { hostId: 'D-in-B', runtimeId: dOwner.runtimeId } } : {}) }, destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true }, focus: false }, agentSessionId: session.agentSessionId,
    execution: { hostId: localMember ? 'local' : 'D-in-B', runtimeId: dOwner.runtimeId, executorRevision: 'original-executor-revision', workspacePath: d.root, workspaceId: localMember ? 'original-B-resource' : null }, ...(!localMember ? { placement: { runtimeId: bOwner.runtimeId, hostId: 'local', workspacePath: '/original/B/project', workspaceId: 'original-B-resource' } } : {}), regionResource: {} })
  const reference: DemandSpaceMemberReference = { kind: 'space-member', source: { runtimeId: bOwner.runtimeId, spaceId: folder.spaceId, regionId: admitted.record.address.regionId, admission: { kind: 'creation', operationId: 'original-C' } }, execution: { runtimeId: dOwner.runtimeId, agentSessionId: session.agentSessionId } }
  const bHosted = new AgentMuxHostedRuntimeService(b.client, b.store.path, () => bOwner), dHosted = new AgentMuxHostedRuntimeService(d.client, d.store.path, () => dOwner)
  cleanup.push(() => bHosted.dispose(), () => dHosted.dispose())
  const socketPath = join(b.root, 'goal-public.sock'), dServer = new AgentMuxControlServer({ socketPath: join(d.root, 'execution.sock'), coreClients: d.coreClients, hostedRuntime: () => dHosted })
  await dServer.start(); cleanup.push(() => dServer.stop())
  const dRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: dServer.path } }); cleanup.push(() => dRpc.dispose())
  const configuredD = await connectHostedAgentMux({ rpc: dRpc, connectOnDemand: true, subscribeRpc: dRpc.subscribe.bind(dRpc), forwardRpc: (method, params, context = {}) => dRpc.call(method, params, { ...(context.signal === undefined ? {} : { signal: context.signal }), ...(context.caller === undefined ? {} : { credentials: context.caller }), ...(context.runtimeFence === undefined ? {} : { runtimeFence: context.runtimeFence }), ...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {}) }) }); cleanup.push(() => configuredD.dispose())
  const configurationPath = join(b.root, 'goal-config.json'); await writeFile(configurationPath, '{}')
  let goalServer!: AgentMuxControlServer
  const runtime = { client: b.client, get server() { return goalServer }, ownerIdentity: () => bOwner } as unknown as AgentMuxHeadlessRuntime
  const goals = createHostGoals({ configurationPath, runtime: () => runtime, clients: () => localMember ? [] : [{ hostId: 'D-current', client: configuredD }], projects: async () => [], coreCall: (hostId, method, params, context) => { if (hostId !== 'local') throw Error('No alternate target'); return goalServer.callRpc(method, params, context) } })
  cleanup.push(() => goals.dispose())
  goalServer = new AgentMuxControlServer({ socketPath, spatialState: spatial, hostedRuntime: () => bHosted, coreClients: () => [{ hostId: 'local', client: b.client }, { hostId: 'D-in-B', client: configuredD }], goalControl: goals.execute, goalDelegations: goals.goalDelegations })
  await goalServer.start(); cleanup.push(() => goalServer.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: goalServer.path } }); cleanup.push(() => rpc.dispose())
  const goal = (await goals.demands.create({ id: 'original-goal', title: 'Original public Goal', description: 'Original frozen public input', assigneeSessionIds: [reference] })).demand
  const access = { source: { hostId: 'local' } }
  const bInventory = vi.spyOn(b.client, 'readAgentSessions'), dInventory = vi.spyOn(d.client, 'readAgentSessions'), bRuns = vi.spyOn(b.client, 'listRuns'), dRuns = vi.spyOn(d.client, 'listRuns')
  return { sourceRoot: b.root, spatial, b: { inventory: bInventory, runs: bRuns }, d: { core: d.client, store: d.store, inner: d.inner, inventory: dInventory, runs: dRuns }, goal, goals, goalServer, configuredD, rpc, reference, access, send, raw, stop, session }
}
