import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { pathToFileURL } from 'node:url'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import type { AgentMuxHeadlessRuntime } from '../../../packages/core/src/headless-runtime.js'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture.js'
import { createHostSpatialAgentControl } from '../src/spatial-agent-control.js'
import { createHostGoals } from '../src/goals.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec.js'
import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup)
  await f.b.put('namesake-SID'); await f.d.put('namesake-SID')
  const forbidden = vi.fn(async () => { throw Error('Business association Save cannot qualify, create or input at A') })
  const bRuntime = { client: f.b.core, ownerIdentity: () => f.b.owner, executionHost: forbidden,
    executionBindings: { create: forbidden, continueOriginal: forbidden } } as unknown as AgentMuxHeadlessRuntime
  const source = createHostSpatialAgentControl({ configurationPath: join(f.b.root, 'no-A-connection.json'), spatial: f.b.spatial, runtime: () => bRuntime })
  const sourceServer = new AgentMuxControlServer({ socketPath: join(f.b.root, 'goal-source.sock'), spatialState: f.b.spatial,
    coreClients: () => [{ hostId: 'local', client: f.b.core }], hostedRuntime: () => f.b.hosted, spatialAgentControl: source })
  await sourceServer.start(); cleanup.push(() => sourceServer.stop())
  const bRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: sourceServer.path } }); cleanup.push(() => bRpc.dispose())
  const sourceCalls = vi.spyOn(bRpc, 'call')
  const calls: string[] = []
  const client = await connectHostedAgentMux({ rpc: bRpc, connectOnDemand: true, subscribeRpc: bRpc.subscribe.bind(bRpc),
    forwardRpc: async (method, params, context) => { calls.push(method); return bRpc.call(method, params, { ...(context?.signal ? { signal: context.signal } : {}), ...(context?.runtimeFence ? { runtimeFence: context.runtimeFence } : {}), ...(context?.caller ? { credentials: context.caller } : {}), ...(context?.principal?.kind === 'device' && context.forwarding ? { forwarding: context.forwarding } : {}) }) } })
  cleanup.push(() => client.dispose())
  const configurationPath = join(f.d.root, 'goals-config.json'); await writeFile(configurationPath, '{}')
  let server!: AgentMuxControlServer
  const runtime = () => ({ client: f.d.core, server, ownerIdentity: () => f.d.owner }) as AgentMuxHeadlessRuntime
  const goals = createHostGoals({ configurationPath, runtime, clients: () => [{ hostId: 'configured-B', client }], projects: async () => [],
    coreCall: async (hostId, method, params, context) => {
      if (hostId !== 'local') throw Error('No private A Coordinator carrier is configured')
      return server.callRpc(method, params, context)
    } })
  cleanup.push(() => goals.dispose())
  server = new AgentMuxControlServer({ socketPath: join(f.d.root, 'goal-owner.sock'), spatialState: f.d.spatial,
    coreClients: () => [{ hostId: 'local', client: f.d.core }], hostedRuntime: () => f.d.hosted, goalControl: goals.execute, goalDelegations: goals.goalDelegations })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  await seedStoredDemand(goals.demands, { id: 'original-goal', title: 'Original', sessionIds: ['legacy-original'] })
  const carrier = { source: { hostId: 'configured-B' } }
  return { ...f, goals, rpc, bRpc, forbidden, calls, sourceCalls, carrier, socketPath: server.path }
}

it('the actual Goal public owner saves Source L without A private qualification, and old-reference edits never read B', async () => {
  const f = await fixture(), state = (await f.b.spatial.read())!, zone = state.graph.zones[0]!
  const coordinator = { kind: 'coordinator-agent' as const, runtimeId: 'unavailable-original-A',
    binding: { bindingId: 'original-A-binding', agentSessionId: 'namesake-SID', createOperationId: 'original-A-C' } }
  const opened = await f.bRpc.call('agent.open', { operationId: 'original-B-L', content: { kind: 'agent-session', reference: coordinator,
    expectedResource: { runtimeId: f.b.owner.runtimeId, workspaceId: zone.workspaceId, workspacePath: zone.directoryPath! } },
    destination: { spaceId: f.reference.spaceId, zoneId: zone.zoneId, newTab: true }, focus: false })
  const reference: DemandSpaceMemberReference = { kind: 'space-member', source: { ...f.reference, regionId: opened.to!.regionId,
    admission: { kind: 'association', operationId: 'original-B-L' } }, execution: { runtimeId: coordinator.runtimeId, agentSessionId: coordinator.binding.agentSessionId } }
  const before = (await f.goals.demands.get('original-goal'))!
  const wrong = { ...reference, execution: { ...reference.execution, runtimeId: 'another-A-with-same-SID' } }
  const refused = await f.rpc.call('goal.update', { goalId: before.id, patch: { assigneeSessionIds: [wrong] }, relationAccess: [{ reference: wrong, access: f.carrier }] }).then(value => ({ value }), error => ({ error }))
  expect(refused).toMatchObject({ error: { code: 'GOAL_RELATION_SOURCE_UNCONFIRMED' } })
  expect(await f.goals.demands.get(before.id)).toEqual(before)
  const priorReads = f.calls.length, priorSourceReads = f.sourceCalls.mock.calls.length
  const saved = await f.rpc.call('goal.update', { goalId: before.id, expectedUpdatedAt: before.updatedAt,
    patch: { assigneeSessionIds: [reference], supervisorSessionId: reference }, relationAccess: [{ reference, access: f.carrier }] })
  expect(saved.goal.assigneeSessionIds).toEqual([reference]); expect(saved.goal.supervisorSessionId).toEqual(reference)
  expect(saved.goal.sessionIds).toEqual(['legacy-original', reference]); expect(saved.goal.dispatches ?? []).toEqual([])
  expect(f.calls.slice(priorReads).filter(method => method === 'runtime.owner.identity')).toHaveLength(1)
  expect(f.calls.slice(priorReads).filter(method => method === 'space.inspect')).toHaveLength(1)
  const readCount = f.calls.length, sourceReadCount = f.sourceCalls.mock.calls.length
  expect(f.sourceCalls.mock.calls.slice(priorSourceReads).every(([method]) => method === 'runtime.owner.identity' || method === 'space.inspect')).toBe(true)
  const edit = await f.rpc.call('goal.update', { goalId: before.id, patch: { description: 'offline field edit', assigneeSessionIds: [structuredClone(reference)] } })
  expect(edit.goal.assigneeSessionIds).toEqual([reference]); expect(f.calls).toHaveLength(readCount); expect(f.sourceCalls.mock.calls).toHaveLength(sourceReadCount)
  const shown = await f.rpc.call('goal.inspect', { goalId: before.id })
  expect(shown.goal?.sessionIds).toEqual(['legacy-original', reference]); expect(f.forbidden).not.toHaveBeenCalled()
  const responsibility = await f.rpc.call('goal.delegations', { goalId: before.id })
  expect(responsibility.goalState?.supervisorSessionId).toEqual(reference)
  expect(responsibility.responsibility?.supervisor).toMatchObject({ agentSessionId: null, agentReference: reference, state: 'unknown' })
  expect(f.forbidden).not.toHaveBeenCalled(); expect(f.sourceCalls.mock.calls).toHaveLength(sourceReadCount)
  const loader = process.env.T012_RELATIONS_CLI_LOADER ? pathToFileURL(process.env.T012_RELATIONS_CLI_LOADER) : new URL('./helpers/goal-relations-source-loader.mjs', import.meta.url)
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.socketPath, 'goal', 'inspect', '--goal', before.id], objectCliEnvironment(f.d.root), '', 15000, loader)
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.goal.sessionIds).toEqual(['legacy-original', reference])
  expect(f.sourceCalls.mock.calls).toHaveLength(sourceReadCount)
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})

it('a new creation relation reads only its Source business cut and preserves namesake Runtime distinctions', async () => {
  const f = await fixture(), admission = await f.admit('D-in-B', f.d.owner.runtimeId, 'namesake-SID', 'business-C')
  const reference: DemandSpaceMemberReference = { kind: 'space-member', source: { ...f.reference, regionId: admission.address.regionId,
    admission: { kind: 'creation', operationId: admission.requestId } }, execution: { runtimeId: f.d.owner.runtimeId, agentSessionId: 'namesake-SID' } }
  const original = (await f.goals.demands.get('original-goal'))!
  const wrong = { ...reference, execution: { ...reference.execution, runtimeId: 'namesake-other-Runtime' } }
  const rejected = await f.rpc.call('goal.update', { goalId: original.id, patch: { assigneeSessionIds: [wrong] }, relationAccess: [{ reference: wrong, access: f.carrier }] }).then(value => ({ value }), error => ({ error }))
  expect(rejected).toMatchObject({ error: { code: 'GOAL_RELATION_SOURCE_UNCONFIRMED' } })
  expect(await f.goals.demands.get(original.id)).toEqual(original)
  const result = await f.rpc.call('goal.update', { goalId: original.id, patch: { assigneeSessionIds: [reference] }, relationAccess: [{ reference, access: f.carrier }] })
  expect(result.goal.assigneeSessionIds).toEqual([reference]); expect(result.goal.dispatches ?? []).toEqual([])
  expect(f.forbidden).not.toHaveBeenCalled(); expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})

it('the actual CLI and public codec keep current access outside the Goal patch and keep qualified identity exact', async () => {
  const reference: DemandSpaceMemberReference = { kind: 'space-member', source: { runtimeId: 'B', spaceId: 'S', regionId: 'R', admission: { kind: 'association', operationId: 'L' } }, execution: { runtimeId: 'A', agentSessionId: 'SID' } }
  const relationAccess = [{ reference, access: { source: { hostId: 'configured-B' } } }]
  const parsed = await parseAgentMuxCliInvocation(['goal', 'update', '--goal', 'g', '--assignees', JSON.stringify([reference]), '--supervisor-ref', JSON.stringify(reference), '--relation-access', JSON.stringify(relationAccess)])
  expect(parsed.params).toMatchObject({ goalId: 'g', patch: { assigneeSessionIds: [reference], supervisorSessionId: reference }, relationAccess })
  expect(parsed.params.patch).not.toHaveProperty('relationAccess')
  const request = rpcControlRequest('goal.update', parsed.params)
  expect(request).toMatchObject({ operation: 'demand.update', patch: { assigneeSessionIds: [reference] }, relationAccess })
  expect(demandAgentReferenceKey(reference)).not.toBe(demandAgentReferenceKey('SID'))
})
