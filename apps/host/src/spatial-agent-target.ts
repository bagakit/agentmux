import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseAgentOpenLaunchFields } from '@agentmux/core/agent-open-contract'
import { AgentMuxError, selectSpatialCatalog, spatialCatalog, type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext,
  type AgentMuxSpatialState, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { spatialAgentOpenDigest, spatialAgentOpenRecord, spatialAgentFact,
  type AgentMuxSpatialAgentOpenRecord, type AgentMuxSpatialAgentOpenRequest } from '@agentmux/core/spatial-state'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'

type NewAgentRequest = Omit<AgentMuxSpatialAgentOpenRequest, 'content'> & {
  content: Extract<AgentMuxSpatialAgentOpenRequest['content'], { kind: 'new-agent' }>
}
/** Explicit source-owned placement with another Core's original execution owner.
 * No Desktop, copied executor configuration, or alternate creation journal. */
export async function openSpatialAgentTarget(options: {
  spatial: AgentMuxSpatialStateStore
  runtime(): AgentMuxHeadlessRuntime
  reconcile(record: AgentMuxSpatialAgentOpenRecord, context: AgentMuxRpcCallContext, issue?: unknown, originalRequest?: AgentMuxSpatialAgentOpenRequest): Promise<AgentMuxSpaceMutationReport>
  descriptor(record: Pick<AgentMuxSpatialAgentOpenRecord, 'agentSessionId' | 'execution' | 'placement'>, phase: 'launching' | 'attached'): import('@agentmux/core/spatial-state').SpatialJson
  agentMuxContext?(request: AgentMuxSpatialAgentOpenRequest): Promise<string | undefined>
}, request: NewAgentRequest, state: AgentMuxSpatialState, context: AgentMuxRpcCallContext) {
  // Same owner boundary as public agent.execution.create: a managed Agent cannot
  // mint the host-user resource grant by choosing a different spatial entry.
  if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind) || request.caller) throw new AgentMuxError(
    'Split execution requires its original transport-approved person or device. Existing Agents and the chosen project are retained.', 'CONTROL_PERMISSION_DENIED')
  const target = request.content.agentTarget!
  const previous = spatialAgentOpenRecord(state.graph, request.requestId)
  if (previous && previous.digest !== spatialAgentOpenDigest(request)) throw new AgentMuxError('This operation belongs to another original spatial creation intent.', 'SPACE_REQUEST_CONFLICT')
  if (previous) {
    const observed = await options.reconcile(previous, context, undefined, request)
    if (observed.outcome === 'opened' || observed.outcome === 'retired') return { operation: 'agent.open' as const, ...observed }
  }
  context.signal?.throwIfAborted(); await context.assertCurrent?.()
  const catalog = selectSpatialCatalog(spatialCatalog(state.graph), request.destination)
  if (catalog.zones.length !== 1) throw new AgentMuxError('Choose the exact original project Zone.', 'SPACE_ZONE_REQUIRED')
  const zone = catalog.zones[0]!
  if (zone.hostId !== 'local' || !zone.directoryPath) throw new AgentMuxError('This source has no confirmed local project resource for the chosen split execution. Keep the project and original request.', 'SPACE_RESOURCE_UNKNOWN')
  if (previous && (!previous.placement || !previous.execution.runtimeId || !previous.execution.executorRevision)) throw new AgentMuxError(
    'The original source admission has no confirmed frozen target. Keep its original operation; current settings cannot replace it.', 'SPATIAL_CREATION_UNCONFIRMED')
  const adoptedRoute = previous ? previous.execution.adoptedRoute : target.adoptedRoute
  const runtime = options.runtime(), host = await runtime.executionHost(previous?.execution.hostId ?? target.hostId, adoptedRoute, { context,
    call: { method: 'agent.open', params: { operationId: request.requestId, content: request.content, destination: request.destination, focus: request.focus } } })
  let response: AgentMuxSpaceMutationReport & { operation: 'agent.open' } | undefined
  try {
    const expectedRuntime = previous?.execution.runtimeId ?? target.runtimeId
    if (host.runtimeId !== expectedRuntime) throw new AgentMuxError('The selected Agent route answers for another original Runtime. No Agent or project was substituted.', 'RUNTIME_OWNER_MISMATCH')
    const local = runtime.ownerIdentity(), sameRuntime = host.runtimeId === local.runtimeId
    const placement = previous ? previous.placement! : { runtimeId: local.runtimeId, hostId: zone.hostId, workspacePath: zone.directoryPath, workspaceId: zone.workspaceId }
    if (placement.runtimeId !== local.runtimeId) throw new AgentMuxError('The original project belongs to another frozen source Runtime. No resource or coordinator was substituted.', 'RUNTIME_OWNER_MISMATCH')
    const agentSessionId = previous?.agentSessionId ?? await host.client.resolveAgentCreationSessionId(request.requestId)
    const binding = previous ? previous.executionBinding : (!sameRuntime ? {
      bindingId: createHash('sha256').update(JSON.stringify([local.runtimeId, target.hostId, agentSessionId, request.requestId])).digest('hex'),
      agentSessionId, createOperationId: request.requestId
    } : undefined)
    if (previous && !sameRuntime && !binding) throw new AgentMuxError('The original split creation has no confirmed coordinator reference. Keep its request; no replacement binding was constructed.', 'SPATIAL_CREATION_UNCONFIRMED')
    // A lost Core admission reply leaves no Source record. Consult the original
    // journal before current inventory, home or generated launch context.
    const retained = !previous && binding ? await runtime.executionBindings.inspect(binding.bindingId, 'association', context) : null
    const witness = retained?.association
    if (retained && (!binding || retained.bindingId !== binding.bindingId || retained.agentSessionId !== agentSessionId ||
        !isDeepStrictEqual(retained.agentRoute, adoptedRoute) || retained.resourceRoute !== undefined ||
        retained.agentHostId !== target.hostId || retained.resourceHostId !== placement.hostId || retained.resourceWorkspacePath !== placement.workspacePath ||
        retained.continuation?.bindingId !== binding.bindingId || retained.continuation.agentSessionId !== agentSessionId || retained.continuation.createOperationId !== request.requestId ||
        witness?.state !== 'confirmed' || witness.reference.bindingId !== binding.bindingId || witness.reference.agentSessionId !== agentSessionId || witness.reference.createOperationId !== request.requestId ||
        witness.agentRuntimeId !== host.runtimeId || witness.resourceRuntimeId !== placement.runtimeId || witness.resourceWorkspacePath !== placement.workspacePath ||
        witness.sourceRequestDigest !== spatialAgentOpenDigest(request) || !witness.agent || witness.agent.executorId !== request.content.executorId)) throw new AgentMuxError(
      'The original frozen intent does not confirm this Source request and placement. Current settings were not substituted.', 'EXECUTION_INTENT_UNCONFIRMED')
    const originalAgent = witness?.state === 'confirmed' ? witness.agent : undefined
    const inventory = previous || retained ? undefined : await host.client.listHostExecutors({ refresh: false, executorId: request.content.executorId })
    if (inventory && inventory.runtimeId !== host.runtimeId) throw new AgentMuxError('The executor inventory belongs to another original Agent Core.', 'RUNTIME_OWNER_MISMATCH')
    const matches = inventory?.executors.filter(executor => executor.executorId === request.content.executorId)
    if (matches && matches.length !== 1) throw new AgentMuxError('Choose an executor registered on the original Agent Core.', 'UNKNOWN_EXECUTOR')
    const launch = parseAgentOpenLaunchFields(request.content), note = !previous && !retained ? await options.agentMuxContext?.(request) : undefined
    if (!previous && !retained && (Object.keys(launch).length || Boolean(note)) && matches![0]!.creationContract?.ordinaryLaunch !== 1) throw new AgentMuxError(
      'The selected execution Core has no confirmed handler for this complete launch input. Keep this request and update or confirm that Core; no Agent or helper was started.', 'AGENT_OPEN_CONTRACT_UNCONFIRMED')
    const execution = previous?.execution ?? { hostId: sameRuntime ? 'local' : target.hostId, runtimeId: host.runtimeId,
      workspacePath: originalAgent ? originalAgent.workspacePath : sameRuntime ? placement.workspacePath : (await host.client.hostEnvironment()).homeDirectory,
      workspaceId: sameRuntime ? placement.workspaceId : null, executorRevision: originalAgent?.executorRevision ?? matches![0]!.configRevision,
      ...(adoptedRoute ? { adoptedRoute } : {}) }
    if (!execution.runtimeId || !execution.executorRevision) throw new AgentMuxError('The original target admission has no confirmed execution identity. Keep its request; no new target was chosen.', 'SPATIAL_CREATION_UNCONFIRMED')
    if (!previous && !retained) try {
      const original = await host.client.inspectAgentCreation(agentSessionId)
      return response = { operation: 'agent.open' as const, requestId: request.requestId, outcome: original.kind === 'retired-agent' ? 'retired' as const : 'unknown' as const,
        from: null, to: null, agent: original.kind === 'agent' ? spatialAgentFact(original, execution.hostId) : null, resource: null,
        save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed' as const, reason: 'The original Agent has no confirmed association with this source Space.' },
        issues: [{ step: 'creation', code: 'SPATIAL_CREATION_UNCONFIRMED', message: 'The original creation has no confirmed source placement.', recovery: 'Inspect the original creation; do not recreate or resend its input.' }] }
    } catch (error) { if (!(error instanceof AgentMuxError) || error.code !== 'AGENT_CREATION_UNKNOWN') throw error }
    if (binding && !previous && !retained) {
      if (!runtime.executionBindings.admit) throw new AgentMuxError(
        'The original Core cannot acknowledge this frozen execution intent. Keep the request; no Source placement or helper was created.', 'CONTROL_UNAVAILABLE')
      const agent = { agentSessionId, createOperationId: request.requestId, executorId: request.content.executorId,
        executorRevision: execution.executorRevision, workspacePath: execution.workspacePath, ...launch,
        ...(request.content.prompt === undefined ? {} : { prompt: request.content.prompt }), ...(note ? { sourceAgentMuxNote: note } : {}) }
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const acknowledged = await runtime.executionBindings.admit({ bindingId: binding.bindingId, agentHostId: execution.hostId, agentRuntimeId: execution.runtimeId,
        ...(execution.adoptedRoute ? { agentRoute: execution.adoptedRoute } : {}), sourceRequestDigest: spatialAgentOpenDigest(request),
        resourceHostId: placement.hostId, resourceRuntimeId: placement.runtimeId, resourceWorkspacePath: placement.workspacePath,
        resourceGrant: { scope: 'host-user', bindingId: binding.bindingId }, agent }, context)
      if (acknowledged.bindingId !== binding.bindingId || acknowledged.agentSessionId !== agentSessionId || acknowledged.createOperationId !== request.requestId)
        throw new AgentMuxError('The Core did not acknowledge this original frozen intent. No Source placement was admitted.', 'EXECUTION_INTENT_UNCONFIRMED')
    }
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const admission = await options.spatial.admitAgentOpen({ request, agentSessionId, placement, execution,
      ...(binding ? { executionBinding: binding } : {}), regionResource: options.descriptor({ agentSessionId, execution, placement }, 'launching') })
    try {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (binding) await runtime.executionBindings.continueOriginal(binding, context)
      else {
        const sourceNote = previous ? await options.agentMuxContext?.(request) : note
        const agent = { agentSessionId, createOperationId: request.requestId, executorId: request.content.executorId,
          executorRevision: execution.executorRevision, workspacePath: execution.workspacePath,
          ...launch,
          ...(request.content.prompt === undefined ? {} : { prompt: request.content.prompt }), ...(sourceNote ? { sourceAgentMuxNote: sourceNote } : {}) }
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        await host.client.createHostAgentWithDelivery({ ...agent, spatialIntent: { tabId: admission.record.address.tabId,
          regionId: admission.record.address.regionId, executionWorkspaceId: placement.workspaceId } })
      }
      return response = { operation: 'agent.open' as const, ...await options.reconcile(admission.record, context, undefined, request) }
    } catch (error) { return response = { operation: 'agent.open' as const, ...await options.reconcile(admission.record, context, error, request) } }
  } finally {
    try { await host.dispose?.() }
    catch (error) {
      if (response) {
        response.issues.push({ step: 'observation', code: 'HOST_OBSERVATION_RELEASE_UNCONFIRMED',
          message: error instanceof Error ? error.message : String(error), recovery: 'Inspect this original operation; no creation or first input was repeated.' })
        if (response.outcome === 'opened') response.outcome = 'partial'
      } else console.warn('HOST_OBSERVATION_RELEASE_UNCONFIRMED', error instanceof Error ? error.message : String(error))
    }
  }
}
