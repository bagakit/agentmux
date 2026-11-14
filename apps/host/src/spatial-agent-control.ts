import { AgentMuxError, spatialCatalog, selectSpatialCatalog, type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext,
  type AgentMuxRpcServiceOptions, type AgentMuxSpatialStateStore, type AgentMuxControlResult } from '@agentmux/core'
import { isBackgroundLocalAgentOpen, isHeadlessSpatialAgentOpen, isSpatialAgentAssociation, spatialAgentAssociationRecord, spatialAgentOpenRecord, spatialAgentOpenDigest, spatialAgentFact, type AgentMuxSpatialAgentAssociationRecord, type AgentMuxSpatialAgentOpenRecord, type AgentMuxSpatialAgentOpenRequest } from '@agentmux/core/spatial-state'
import { openSpatialAgentTarget } from './spatial-agent-target.js'
import { parseAgentOpenLaunchFields } from '@agentmux/core/agent-open-contract'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { configuredExecutor, readOriginalMoteConfiguration, ScratchTopics } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { configuredProfileAgentContext } from './mote-user-profile.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const issue = (error: unknown) => ({ step: 'creation', code: error instanceof AgentMuxError ? error.code : 'AGENT_CREATION_UNCONFIRMED',
  message: error instanceof Error ? error.message : String(error), recovery: 'Inspect this original operation. Do not repeat creation or its first input.' })
const regionDescriptor = (record: Pick<AgentMuxSpatialAgentOpenRecord, 'agentSessionId' | 'execution' | 'placement'>, phase: 'launching' | 'attached') => ({
  workspaceId: record.placement?.workspaceId ?? record.execution.workspaceId, phase, agentPresentation: { sessionId: record.agentSessionId,
    agentSessionId: record.agentSessionId, hostId: record.execution.hostId,
    ...(record.execution.runtimeId ? { runtimeId: record.execution.runtimeId } : {}) } })

/** Original Core spatial admission plus original configured launch policy; no client screen or configuration writer. */
export function createHostSpatialAgentControl(options: { configurationPath: string; spatial: AgentMuxSpatialStateStore; runtime(): AgentMuxHeadlessRuntime;
  agentMuxContext?(request: AgentMuxSpatialAgentOpenRequest): Promise<string | undefined> }): NonNullable<AgentMuxRpcServiceOptions['spatialAgentControl']> {
  const topics = new ScratchTopics()
  function associationReport(record: AgentMuxSpatialAgentAssociationRecord, graph: NonNullable<Awaited<ReturnType<AgentMuxSpatialStateStore['read']>>>['graph'], acknowledgedWrite = false): AgentMuxSpaceMutationReport {
    const region = graph.regions.find(region => region.tabId === record.address.tabId && region.regionId === record.address.regionId)
    const zone = graph.zones.find(zone => zone.zoneId === record.address.zoneId)
    const attached = record.placement.runtimeId === options.runtime().ownerIdentity().runtimeId && region?.kind === 'agent' && region.association?.operationId === record.requestId && region.agentSessionId === null && region.execution === null &&
      zone?.workspaceId === record.placement.workspaceId && zone.hostId === record.placement.hostId && zone.directoryPath === record.placement.workspacePath &&
      graph.bindings.some(binding => binding.spaceId === record.address.spaceId && binding.zoneId === record.address.zoneId)
    return { requestId: record.requestId, outcome: attached ? 'opened' : 'partial', from: null, to: attached ? record.address : null, agent: null, resource: null,
      association: { operationId: record.requestId, reference: record.reference, resource: { runtimeId: record.placement.runtimeId, workspaceId: record.placement.workspaceId, workspacePath: record.placement.workspacePath } },
      save: { layoutApplied: attached, clientStateWritten: false, storageFlushRequested: false, diskDurability: acknowledgedWrite ? 'confirmed' : 'unconfirmed', reason: acknowledgedWrite ? null : 'This current read confirms the retained association, not the original write acknowledgement.' },
      issues: attached ? [] : [{ step: 'association', code: 'SPACE_PLACEMENT_UNKNOWN', message: 'The original association remains retained, but its original occurrence or resource is no longer attached.', recovery: 'Inspect the original L and A Coordinator independently; no creation or input was repeated.' }] }
  }
  async function reconcile(record: AgentMuxSpatialAgentOpenRecord, context: AgentMuxRpcCallContext, initialIssue?: unknown,
    originalRequest?: AgentMuxSpatialAgentOpenRequest): Promise<AgentMuxSpaceMutationReport> {
    const report: AgentMuxSpaceMutationReport = { requestId: record.requestId, outcome: 'unknown', from: null, to: record.address,
      agent: null, resource: null, save: { layoutApplied: true, clientStateWritten: false, storageFlushRequested: false,
        diskDurability: 'confirmed', reason: null }, issues: initialIssue ? [issue(initialIssue)] : [] }
    let borrowed: Awaited<ReturnType<AgentMuxHeadlessRuntime['executionHost']>> | null = null
    try {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (record.execution.hostId !== 'local' && !record.execution.runtimeId) throw new AgentMuxError(
        'The original foreign creation has no confirmed Runtime pin. Keep its Session and operation; a local same-SID lookup cannot confirm it.', 'SPATIAL_CREATION_UNCONFIRMED')
      const access = originalRequest ? { context, call: { method: 'agent.open' as const, params: { operationId: originalRequest.requestId,
        content: originalRequest.content, destination: originalRequest.destination, focus: originalRequest.focus } } }
        : { context, observation: { kind: 'observation' as const, targetRuntimeId: record.execution.runtimeId!, agentSessionIds: [record.agentSessionId],
          source: { kind: 'creation-reader' as const, createOperationId: record.requestId } } }
      const host = borrowed = record.execution.runtimeId ? await options.runtime().executionHost(record.execution.hostId, record.execution.adoptedRoute, access) : null
      if (host && host.runtimeId !== record.execution.runtimeId) throw new AgentMuxError('The original Agent route answers for another Runtime. Keep the original Session and request.', 'RUNTIME_OWNER_MISMATCH')
      if (host && originalRequest && record.execution.adoptedRoute && await host.client.resolveAgentCreationSessionId(record.requestId) !== record.agentSessionId) throw new AgentMuxError(
        'The original creation operation resolves to another Session. Keep both references; no current SID was substituted.', 'SPATIAL_CREATION_UNCONFIRMED')
      const session = await (host?.client ?? options.runtime().client).inspectAgentCreation(record.agentSessionId)
      if (session.kind === 'retired-agent') {
        report.outcome = 'retired'; report.to = null
        report.issues.push(issue(new AgentMuxError('The original Agent was explicitly retired. Its exact Session and creation history remain available.', 'AGENT_SESSION_RETIRED')))
        return report
      }
      const creation = session.creation
      if (!creation || session.agentSessionId !== record.agentSessionId || creation.createOperationId !== record.requestId ||
          session.executorId !== record.executorId || session.workspacePath !== record.execution.workspacePath ||
          record.execution.executorRevision && creation.executorRevision !== record.execution.executorRevision ||
          record.executionBinding && (session.toolExecution?.bindingId !== record.executionBinding.bindingId ||
            session.toolExecution.resourceRuntimeId !== record.placement?.runtimeId || record.placement.runtimeId !== options.runtime().ownerIdentity().runtimeId ||
            session.toolExecution.workspacePath !== record.placement?.workspacePath)) throw new AgentMuxError(
        'Core has not confirmed this original creation identity and execution target. The healthy Session is retained.', 'AGENT_CREATION_UNCONFIRMED')
      report.agent = spatialAgentFact(session, record.execution.hostId)
      const settled = await options.spatial.settleAgentOpen(record.requestId, session, regionDescriptor(record, 'attached'))
      report.to = settled.attached ? record.address : null
      if (!settled.attached) report.issues.push(issue(new AgentMuxError('The original Agent exists, but its reserved Region binding changed. Existing contents were retained.', 'SPACE_PLACEMENT_UNKNOWN')))
      if (record.executionBinding) {
        const binding = await options.runtime().executionBindings.inspect(record.executionBinding.bindingId)
        const original = binding?.continuation
        if (!binding || binding.bindingId !== record.executionBinding.bindingId || binding.agentSessionId !== record.agentSessionId ||
            binding.agentHostId !== record.execution.hostId || binding.resourceHostId !== record.placement?.hostId ||
            binding.resourceWorkspacePath !== record.placement?.workspacePath ||
            !original || original.bindingId !== record.executionBinding.bindingId || original.agentSessionId !== record.agentSessionId ||
            original.createOperationId !== record.requestId) report.issues.push(issue(new AgentMuxError(
          'The original execution binding has no confirmed matching receipt. The Agent and its original operation are retained.', 'EXECUTION_INTENT_UNCONFIRMED')))
        else if (binding.state !== 'connected') report.issues.push(issue(new AgentMuxError(
          binding.diagnostic?.message ?? 'The original execution binding has not been confirmed connected. The Agent remains available.',
          binding.diagnostic?.code ?? 'EXECUTION_OBSERVATION_UNCONFIRMED')))
      }
      if (creation.persistence === 'unconfirmed' || creation.failure || ['unknown', 'unconfirmed'].includes(creation.initialPrompt)) {
        report.issues.push(issue(new AgentMuxError(creation.failure?.message ?? 'The original creation or first input is unconfirmed. Read the same operation without replaying.', creation.failure?.code ?? 'AGENT_CREATION_UNCONFIRMED')))
      }
      report.outcome = report.issues.length ? 'partial' : 'opened'
    } catch (error) { report.issues.push(issue(error)); report.outcome = report.agent ? 'partial' : 'unknown' }
    finally { try { await borrowed?.dispose?.() } catch (error) { report.issues.push(issue(error)); if (report.agent) report.outcome = 'partial' } }
    return report
  }
  return Object.assign(async (request: Parameters<NonNullable<AgentMuxRpcServiceOptions['spatialAgentControl']>>[0], context: AgentMuxRpcCallContext): Promise<AgentMuxControlResult | undefined> => {
    const state = await options.spatial.read()
    if (request.operation === 'space.inspect') {
      if (!('requestId' in request.target)) return undefined
      const association = state ? spatialAgentAssociationRecord(state.graph, request.target.requestId) : null
      if (association && state) return { operation: 'space.inspect', catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }, request: { requestId: request.target.requestId, known: true, report: associationReport(association, state.graph) } }
      const record = state ? spatialAgentOpenRecord(state.graph, request.target.requestId) : null
      return { operation: 'space.inspect', catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
        request: { requestId: request.target.requestId, known: Boolean(record), report: record ? await reconcile(record, context) : null } }
    }
    if (isSpatialAgentAssociation(request)) {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const result = await options.spatial.associateAgentOpen(request, options.runtime().ownerIdentity().runtimeId, async () => { context.signal?.throwIfAborted(); await context.assertCurrent?.() })
      return { operation: 'agent.open', ...associationReport(result.record, result.state.graph, result.admitted) }
    }
    if (isHeadlessSpatialAgentOpen(request, state?.graph) && request.content.agentTarget) {
      if (!state) throw new AgentMuxError('The original spatial document is unavailable. Keep the chosen Space and original request.', 'SPATIAL_STATE_ABSENT')
      return await openSpatialAgentTarget({ ...options, reconcile, descriptor: regionDescriptor }, request, state, context)
    }
    if (!isBackgroundLocalAgentOpen(request, state?.graph)) return undefined
    if (!state) throw new AgentMuxError('The original spatial document is unavailable. Keep the chosen Space and read its original owner before creation.', 'SPATIAL_STATE_ABSENT')
    const previous = spatialAgentOpenRecord(state.graph, request.requestId)
    if (previous) {
      if (previous.digest !== spatialAgentOpenDigest(request)) throw new AgentMuxError('This operation belongs to another original spatial creation intent.', 'SPACE_REQUEST_CONFLICT')
      const observed = await reconcile(previous, context)
      if (observed.agent || observed.outcome === 'retired') return { operation: 'agent.open', ...observed }
      // An explicit continuation enters the original idempotent Core creation
      // owner. No observation error is interpreted here as permission to start.
    }
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const { spaceId, zoneId, tabId, regionId } = request.destination
    const catalog = selectSpatialCatalog(spatialCatalog(state.graph), { ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), ...(tabId ? { tabId } : {}), ...(regionId ? { regionId } : {}) })
    if (catalog.zones.length !== 1) throw new AgentMuxError('Choose the exact original execution Zone.', 'SPACE_ZONE_REQUIRED')
    const zone = catalog.zones[0]!
    const raw = await readOriginalMoteConfiguration(options.configurationPath)
    if (!object(raw)) throw new AgentMuxError('The original launch configuration is unreadable. Saved settings and healthy Agents remain available.', 'EXECUTOR_CONFIGURATION_UNAVAILABLE')
    const executor = configuredExecutor(raw, request.content.executorId)
    const execution = { hostId: zone.hostId ?? '', workspacePath: zone.directoryPath ?? '', workspaceId: zone.workspaceId }
    if (execution.hostId !== 'local') throw new AgentMuxError('This background local creator has no original foreign execution route. Its chosen target and existing Agents remain available.', 'UNKNOWN_HOST')
    if (!execution.workspacePath) throw new AgentMuxError('The selected original execution directory is unconfirmed. No Agent was started.', 'SPACE_RESOURCE_UNKNOWN')
    const client = options.runtime().client, agentSessionId = await client.resolveAgentCreationSessionId(request.requestId)
    // A Core creation can predate this spatial owner. Its missing placement is
    // unknown, never permission to dispatch or attach the same operation again.
    if (!previous) try {
      const original = await client.inspectAgentCreation(agentSessionId)
      return { operation: 'agent.open', requestId: request.requestId, outcome: original.kind === 'retired-agent' ? 'retired' : 'unknown',
        from: null, to: null, agent: original.kind === 'agent' ? spatialAgentFact(original, execution.hostId) : null, resource: null,
        save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'The original Core creation has no confirmed spatial association on this owner.' },
        issues: [issue(new AgentMuxError('The original creation is retained, but its original spatial association is unobserved. Inspect that operation; no creation or input was repeated.', 'SPATIAL_CREATION_UNCONFIRMED'))] }
    } catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'AGENT_CREATION_UNKNOWN') throw error
      // Unknown is not absence. This permits recording only the spatial intent;
      // the original Core same-SID/operation claim alone decides any start.
    }
    const platformContext = await options.agentMuxContext?.(request)
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const admission = await options.spatial.admitAgentOpen({ request, agentSessionId, execution, regionResource: regionDescriptor({ agentSessionId, execution }, 'launching') })
    try {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      let prepared: Awaited<ReturnType<ScratchTopics['prepareAgent']>> | undefined
      if (zone.kind === 'home' && zone.workspaceId === SCRATCH_WORKSPACE_ID) {
        const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces.filter(value => object(value) && value.id === SCRATCH_WORKSPACE_ID) : []
        const workspace = workspaces.length === 1 ? workspaces[0] : null
        if (!object(workspace) || typeof workspace.path !== 'string' || workspace.hostId !== 'local') throw new AgentMuxError('The original Topic resource Workspace is unconfirmed.', 'SPACE_RESOURCE_UNKNOWN')
        const original = await topics.readForDirectory({ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspace.path }, execution.workspacePath)
        if (!original) throw new AgentMuxError('The exact original Topic resource is unconfirmed. No substitute directory was created.', 'SPACE_RESOURCE_UNKNOWN')
        prepared = await topics.prepareAgent({ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspace.path }, original.id, { providerId: executor.providerId, sessionId: agentSessionId })
        if (prepared.absolutePath !== execution.workspacePath) throw new AgentMuxError('The original Topic directory changed. Its admitted identity is retained.', 'SPACE_RESOURCE_UNKNOWN')
      }
      const note = [prepared?.prompt, platformContext, configuredProfileAgentContext(raw.profile)].filter(Boolean).join('\n\n')
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      await client.createAgentWithDelivery({ providerId: executor.providerId, executorId: request.content.executorId,
        agentSessionId, createOperationId: request.requestId, workspacePath: execution.workspacePath, commandOverride: executor.command,
        args: executor.args, env: executor.env, injectAgentMuxGuide: executor.injectAgentMuxGuide,
        ...parseAgentOpenLaunchFields(request.content),
        ...(note ? { sourceAgentMuxNote: note } : {}), ...(prepared ? { optionalContext: prepared.optionalContext } : {}),
        ...(request.content.prompt === undefined ? {} : { prompt: request.content.prompt }),
        ...(request.caller ? { creationCaller: { agentSessionId: request.caller.agentSessionId, capability: request.caller.capability ?? '' } } : {}),
        ...(request.caller && request.content.prompt !== undefined ? { initialMessage: { callerAgentSessionId: request.caller.agentSessionId, capability: request.caller.capability ?? '' } } : {}) })
      return { operation: 'agent.open', ...await reconcile(admission.record, context) }
    } catch (error) { return { operation: 'agent.open', ...await reconcile(admission.record, context, error) } }
  }, { describe: () => ({ ordinaryLaunch: { revision: 1 as const, destination: 'source-zone-background' as const }, externalAssociation: 1 as const }) })
}
