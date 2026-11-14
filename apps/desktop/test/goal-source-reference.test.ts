import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { readSpaceSnapshot } from '../../../packages/core/src/space-authority-stream'
import { createHostSpatialAgentControl } from '../../host/src/spatial-agent-control'
import type { AgentMuxHeadlessRuntime } from '../../../packages/core/src/headless-runtime'
import { goalSourceReference } from '../src/renderer/src/lib/goal-source-reference'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('the Goal locator consumes the original public Source C and L occurrences without a local SID or a selected target becoming identity', async () => {
  const f = await createSpaceSessionsFixture(cleanup), created = await f.admit('D-in-B', f.d.owner.runtimeId, 'same-SID', 'source-C')
  const graph = (await f.b.spatial.read())!.graph, zone = graph.zones[0]!
  const target = { hostId: 'B-in-viewer', reference: f.reference, zoneId: zone.zoneId, workspaceId: zone.workspaceId! }
  const source = createHostSpatialAgentControl({ configurationPath: join(f.b.root, 'original-configuration.json'), spatial: f.b.spatial,
    runtime: () => ({ client: f.b.core, ownerIdentity: () => f.b.owner } as AgentMuxHeadlessRuntime) })
  const server = new AgentMuxControlServer({ socketPath: join(f.b.root, 'goal-reference-source.sock'), spatialState: f.b.spatial,
    coreClients: () => [{ hostId: 'local', client: f.b.core }], hostedRuntime: () => f.b.hosted, spatialAgentControl: source })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const snapshot = await readSpaceSnapshot(rpc, f.reference)
  // Only Source membership is confirmed here. No physical Agent or input ACK is claimed.
  const cReport = { operationId: 'source-C', outcome: 'unknown' as const, from: null, to: created.address, agent: null, resource: null,
    save: { layoutApplied: true, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'confirmed' as const, reason: null }, issues: [] }
  expect(goalSourceReference(target, 'source-C', cReport, snapshot)).toEqual({ kind: 'space-member',
    source: { ...f.reference, regionId: created.address.regionId, admission: { kind: 'creation', operationId: 'source-C' } },
    execution: { runtimeId: f.d.owner.runtimeId, agentSessionId: 'same-SID' } })
  expect(() => goalSourceReference({ ...target, reference: { ...target.reference, runtimeId: 'another-B' } }, 'source-C', cReport, snapshot)).toThrow('not confirmed')
  expect(() => goalSourceReference(target, 'changed-C', cReport, snapshot)).toThrow('not confirmed')
  const reference = { kind: 'coordinator-agent' as const, runtimeId: 'independent-A', binding: { bindingId: 'original-Main-binding', agentSessionId: 'same-SID', createOperationId: 'original-Main-C' } }
  const lRequest = { operationId: 'original-B-L', content: { kind: 'agent-session' as const, reference,
    expectedResource: { runtimeId: f.reference.runtimeId, workspaceId: target.workspaceId, workspacePath: zone.directoryPath! } },
    destination: { spaceId: f.reference.spaceId, zoneId: target.zoneId, newTab: true as const }, focus: false }
  const lReport = await rpc.call('agent.open', lRequest)
  const linked = await readSpaceSnapshot(rpc, f.reference)
  expect(goalSourceReference(target, 'original-B-L', lReport, linked, lRequest)).toEqual({ kind: 'space-member',
    source: { ...f.reference, regionId: lReport.to!.regionId, admission: { kind: 'association', operationId: 'original-B-L' } },
    execution: { runtimeId: reference.runtimeId, agentSessionId: 'same-SID' } })
  const region = linked.scope.regions.find(value => value.regionId === lReport.to!.regionId)!
  expect(region.agentSessionId).toBeNull(); expect(region.execution).toBeNull()
  expect(() => goalSourceReference(target, 'original-B-L', { ...lReport, to: cReport.to }, linked, lRequest)).toThrow('not confirmed')
  expect(() => goalSourceReference(target, 'original-B-L', { ...lReport, association: { ...lReport.association!, resource: { ...lReport.association!.resource, workspacePath: '/another/project' } } }, linked, lRequest)).toThrow('not confirmed')
  for (const changed of [{ ...reference, runtimeId: 'another-A' }, { ...reference, binding: { ...reference.binding, bindingId: 'another-binding' } }, { ...reference, binding: { ...reference.binding, createOperationId: 'another-C' } }])
    expect(() => goalSourceReference(target, 'original-B-L', { ...lReport, association: { ...lReport.association!, reference: changed } }, linked, lRequest)).toThrow('not confirmed')
  for (const counter of [f.b.inventory, f.d.inventory, f.b.runs, f.d.runs]) expect(counter).not.toHaveBeenCalled()
})
