import { vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentMuxSpatialStateStore } from "../../src/spatial-state.js"
import { AgentMuxHostedRuntimeService } from "../../src/hosted-runtime-service.js"
import { createHostRouteInventoryFixture } from "./host-route-inventory-fixture.js"
import { rpcOwnerFixture } from "./public-rpc-owner.js"
import { ContinuousProgressLoopManager } from "../../../../apps/host/src/continuous-progress-loop-manager.js"
import { ContinuousProgressLoopStore } from "../../../../apps/host/src/continuous-progress-loop-store.js"
import { createGoalRuntime } from "../../../../apps/host/src/goal-runtime.js"
import { FileUploadOwner } from '../../../../apps/host/src/file-upload-owner.js'
import type { AgentProgressOwner } from "../../src/agent-progress.js"
import type { AgentMuxClient } from '../../src/client.js'
import type { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'

export async function createSpaceMemberProgressFixture(cleanup: Array<() => Promise<void>>) {
  const root = await mkdtemp(join(tmpdir(), 'amx-member-progress-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  let hostedB!: AgentMuxHostedRuntimeService, coreB!: Awaited<ReturnType<typeof rpcOwnerFixture<AgentMuxClient, AgentMuxFileAgentSessionStore>>>
  let managerB!: ContinuousProgressLoopManager, managerD!: ContinuousProgressLoopManager
  let filesB!: FileUploadOwner, filesD!: FileUploadOwner
  const sourceOwner: AgentProgressOwner = { call: (method, input, context) => managerB.callProgress(method, input, context) }
  let afterExecutionAck: ((method: import('../../src/agent-progress.js').AgentProgressMethod) => Promise<void>) | undefined
  const executionOwner: AgentProgressOwner = { call: async (method, input, context) => {
    const result = await managerD.callProgress(method, input, context)
    await afterExecutionAck?.(method)
    return result
  } }
  const h = await createHostRouteInventoryFixture(cleanup, { spatialState: spatial,
    hostedRuntime: () => hostedB, coreClients: () => coreB.coreClients(), progress: sourceOwner,
    fileUploads: { upload: input => filesB.upload(input), inspect: input => filesB.inspect(input), read: (input, max) => filesB.read(input, max) } },
    { progress: executionOwner, fileUploads: { upload: input => filesD.upload(input), inspect: input => filesD.inspect(input), read: (input, max) => filesD.read(input, max) } })
  coreB = await rpcOwnerFixture(undefined, undefined, undefined, () => ({ creationAuthority: h.b.authority })); cleanup.push(coreB.close)
  hostedB = new AgentMuxHostedRuntimeService(coreB.client, null, () => ({ runtimeId: h.b.identity.runtimeId, ownerInstanceId: 'original-B-instance',
    protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: coreB.client.runtimeIdentity() }))
  cleanup.push(() => hostedB.dispose())
  const tick = vi.fn(async () => 'skipped' as const)
  const manager = (owner: typeof coreB) => {
    const runtime = createGoalRuntime({ clients: owner.coreClients, checkIn: async () => { throw Error('This explicit arrangement probe never checks in') } })
    return new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(owner.root, 'loops.json')), tick, () => 100,
      (loop, tickId, now, signal) => runtime.observeContinuousProgress(loop, tickId, now, signal), runtime)
  }
  managerB = manager(coreB); managerD = manager(h.original)
  filesB = new FileUploadOwner(join(coreB.root, 'uploads')); filesD = new FileUploadOwner(join(h.original.root, 'uploads'))
  cleanup.push(() => managerB.stop(), () => managerD.stop())
  const folder = await spatial.registerFolder({ id: 'original-progress-workspace', hostId: 'local', name: 'Original work', path: coreB.root })
  const reference = { runtimeId: h.b.identity.runtimeId, spaceId: folder.spaceId }, sid = 'recipient'
  const admit = async (foreign: boolean) => {
    const execution = foreign ? h.original : coreB, runtimeId = foreign ? h.d.identity.runtimeId : h.b.identity.runtimeId, operationId = foreign ? 'original-D-progress-C' : 'original-B-progress-C'
    const admitted = await spatial.admitAgentOpen({ request: { schemaVersion: 5, requestId: operationId, operation: 'agent.open',
      content: { kind: 'new-agent', executorId: 'codex', ...(foreign ? { agentTarget: { hostId: 'collision', runtimeId, adoptedRoute: h.route } } : {}) },
      destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true }, focus: false }, agentSessionId: sid,
      execution: { hostId: foreign ? 'collision' : 'local', runtimeId, ...(foreign ? { adoptedRoute: h.route } : {}), executorRevision: 'original-progress-executor', workspacePath: execution.root, workspaceId: foreign ? null : 'original-progress-workspace' },
      ...(foreign ? { placement: { runtimeId: h.b.identity.runtimeId, hostId: 'local', workspacePath: coreB.root, workspaceId: 'original-progress-workspace' } } : {}), regionResource: {} })
    const target = { kind: 'session' as const, reference, regionId: admitted.record.address.regionId, runtimeId, agentSessionId: sid,
      expectedAdmission: { kind: 'creation' as const, operationId } }
    return { target, owner: execution, progress: foreign ? managerD : managerB, inputTarget: { hostId: 'local', agentSessionId: sid, providerId: 'codex', workspacePath: execution.root } }
  }
  await h.configure(h.b, [{ id: 'collision', route: h.route }], [h.grant('A-progress', h.a.identity, h.b.identity, ['space.member.call'])])
  const scopes = ['runtime.owner.identity', 'runtime.invoke/readAgentInputEpoch', 'agent.progress.list', 'agent.progress.create', 'agent.progress.action', 'agent.progress.update', 'file.upload', 'file.upload.inspect']
  await h.configure(h.c, [], [h.grant('B-progress', h.b.identity, h.d.identity, scopes)])
  await h.configure(h.d, [], [h.grant('C-progress', h.c.identity, h.d.identity, scopes)])
  return { ...h, coreB, spatial, tick, admit, filesB, filesD,
    afterExecutionAck(callback: typeof afterExecutionAck) { afterExecutionAck = callback } }
}
