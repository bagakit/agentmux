import { cancelOriginalTakeover } from './takeover-cancellation.js'
import { takeoverCancellationRecord } from '@agentmux/core/agent-takeover'
import { assertAgentInputEpoch, optionalInputEpoch } from '@agentmux/core/prompt-condition'
import { takeoverRequiresPromotion } from '@agentmux/core/agent-takeover'
import { assertPromotionEnabled } from './promotion-policy.js'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, spatialCatalog, selectSpatialCatalog, type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext,
  type AgentMuxRpcServiceOptions, type AgentMuxSpatialStateStore, type AgentMuxControlResult, type AgentMuxHostAgentCreateInput } from '@agentmux/core'
import { isBackgroundLocalAgentOpen, isHeadlessSpatialAgentOpen, isSpatialAgentAssociation, originalAgentOpenRegion, spatialAgentAssociationRecord, spatialAgentOpenRecord, spatialAgentOpenDigest, spatialAgentFact, type AgentMuxSpatialAgentAssociationRecord, type AgentMuxSpatialAgentOpenRecord, type AgentMuxSpatialAgentOpenRequest } from '@agentmux/core/spatial-state'
import { openSpatialAgentTarget } from './spatial-agent-target.js'
import { parseAgentOpenLaunchFields } from '@agentmux/core/agent-open-contract'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { readOriginalMoteConfiguration, ScratchTopics } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { configuredProfileAgentContext } from './mote-user-profile.js'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const canReadSourceExecution = (context: AgentMuxRpcCallContext) => Boolean(context.caller ||
  context.principal && ['user', 'device'].includes(context.principal.kind) && typeof context.principal.id === 'string' &&
  context.principal.id.trim() && !context.principal.id.includes('\0'))
const issue = (error: unknown, step = 'creation') => ({ step, code: error instanceof AgentMuxError ? error.code : 'AGENT_CREATION_UNCONFIRMED',
  message: error instanceof Error ? error.message : String(error), recovery: 'Inspect this original operation. Do not repeat creation or its first input.',
  ...(error instanceof AgentMuxError && error.executionFailure ? { executionFailure: error.executionFailure } : {}) })
const regionDescriptor = (record: Pick<AgentMuxSpatialAgentOpenRecord, 'agentSessionId' | 'execution' | 'placement'>, phase: 'launching' | 'attached') => ({
  workspaceId: record.placement?.workspaceId ?? record.execution.workspaceId, phase, agentPresentation: { sessionId: record.agentSessionId,
    agentSessionId: record.agentSessionId, hostId: record.execution.hostId,
    ...(record.execution.runtimeId ? { runtimeId: record.execution.runtimeId } : {}) } })

/** Original Core spatial admission plus original configured launch policy; no client screen or configuration writer. */
export function createHostSpatialAgentControl(options: { configurationPath: string; spatial: AgentMuxSpatialStateStore; runtime(): AgentMuxHeadlessRuntime;
  agentMuxContext?(request: AgentMuxSpatialAgentOpenRequest): Promise<string | undefined> }): NonNullable<AgentMuxRpcServiceOptions['spatialAgentControl']> {
  const topics = new ScratchTopics()
  async function createOriginalLocalTakeover(record: AgentMuxSpatialAgentOpenRecord, request: AgentMuxSpatialAgentOpenRequest) {
    const content = record.takeoverContent
    if (!content || typeof record.takeoverSourceAgentMuxNote !== 'string' || !record.execution.executorRevision || !record.execution.workspaceId) throw new AgentMuxError(
      'The original complete Takeover invocation is unconfirmed. Keep its Session and inspect the original operation.', 'AGENT_TAKEOVER_ADMISSION_UNCONFIRMED')
    const create: AgentMuxHostAgentCreateInput = { executorId: record.executorId, executorRevision: record.execution.executorRevision,
      agentSessionId: record.agentSessionId, createOperationId: record.requestId, workspacePath: record.execution.workspacePath,
      spatialIntent: { tabId: record.address.tabId, regionId: record.address.regionId, executionWorkspaceId: record.execution.workspaceId },
      ...parseAgentOpenLaunchFields(content), ...optionalInputEpoch(record.execution.inputEpoch), sourceAgentMuxNote: record.takeoverSourceAgentMuxNote,
      ...(record.takeoverOptionalContext === undefined ? {} : { optionalContext: record.takeoverOptionalContext }),
      ...(content.prompt === undefined ? {} : { prompt: content.prompt }) }
    await options.runtime().client.createSpatialHostAgentWithDelivery(create, options.spatial,
      request.caller ? { agentSessionId: request.caller.agentSessionId, capability: request.caller.capability ?? '' } : undefined)
  }
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
    originalRequest?: AgentMuxSpatialAgentOpenRequest, observedGraph?: NonNullable<Awaited<ReturnType<AgentMuxSpatialStateStore['read']>>>['graph']): Promise<AgentMuxSpaceMutationReport> {
    const placement = !observedGraph || Boolean(originalAgentOpenRegion(observedGraph, record))
    const report: AgentMuxSpaceMutationReport = { requestId: record.requestId, outcome: 'unknown', from: null, to: placement ? record.address : null,
      agent: null, resource: null, save: { layoutApplied: placement, clientStateWritten: false, storageFlushRequested: false,
        diskDurability: observedGraph ? 'unconfirmed' : 'confirmed', reason: observedGraph ? 'This read observes the original placement and does not acknowledge its write.' : null },
      issues: initialIssue ? [issue(initialIssue)] : [] }
    if (record.takeover?.source.organizationIssue) report.issues.push(issue(new AgentMuxError(record.takeover.source.organizationIssue, 'AGENT_TAKEOVER_ORGANIZATION_UNCONFIRMED'), 'observation'))
    let borrowed: Awaited<ReturnType<AgentMuxHeadlessRuntime['executionHost']>> | null = null
    // Exact Source reads expose a safe original-operation projection to the
    // already authenticated reader. The owner resolves its own admission; the
    // caller cannot use a self-reported binding tuple as authority.
    if (record.executionBinding) {
      if (record.placement?.runtimeId !== options.runtime().ownerIdentity().runtimeId) {
        report.issues.push(issue(new AgentMuxError('The original execution Coordinator belongs to another Source Runtime.', 'RUNTIME_OWNER_MISMATCH'), 'observation'))
      } else {
        report.execution = { coordinatorRuntimeId: record.placement.runtimeId, reference: record.executionBinding, inspection: null, placement: 'retained' }
        const bindings = options.runtime().executionBindings
        if (bindings.sourceDiagnostics && canReadSourceExecution(context)) try {
          report.execution.diagnostics = await bindings.sourceDiagnostics(record.requestId, context)
        } catch {
          context.signal?.throwIfAborted(); await context.assertCurrent?.()
          report.issues.push(issue(new AgentMuxError('The original Source diagnostic metadata is unconfirmed. Its request and helpers remain retained.', 'EXECUTION_DIAGNOSTIC_UNAVAILABLE'), 'observation'))
        }
        // Full binding and private details keep their original user/device
        // boundary. Safe diagnostics are independent, never a denied-read fallback.
        if (!context.caller) try {
          const binding = await options.runtime().server.callRpc('agent.execution.binding', { bindingId: record.executionBinding.bindingId }, context)
          if (binding && (binding.bindingId !== record.executionBinding.bindingId || binding.agentSessionId !== record.agentSessionId ||
            binding.agentHostId !== record.execution.hostId || binding.resourceHostId !== record.placement.hostId ||
            binding.resourceWorkspacePath !== record.placement.workspacePath || binding.continuation &&
              (binding.continuation.bindingId !== record.executionBinding.bindingId || binding.continuation.agentSessionId !== record.agentSessionId || binding.continuation.createOperationId !== record.requestId)))
            throw new AgentMuxError('The original execution observation identifies another creation or resource.', 'EXECUTION_INTENT_UNCONFIRMED')
          report.execution.inspection = binding
        } catch (error) { report.issues.push(issue(error, 'observation')) }
      }
    }
    try {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (record.execution.hostId !== 'local' && !record.execution.runtimeId) throw new AgentMuxError(
        'The original foreign creation has no confirmed Runtime pin. Keep its Session and operation; a local same-SID lookup cannot confirm it.', 'SPATIAL_CREATION_UNCONFIRMED')
      const access = originalRequest ? { context, call: { method: 'agent.open' as const, params: { operationId: originalRequest.requestId,
        content: originalRequest.content, destination: originalRequest.destination, focus: originalRequest.focus } } }
        : { context, observation: { kind: 'observation' as const, targetRuntimeId: record.execution.runtimeId!, agentSessionIds: [record.agentSessionId],
          source: { kind: 'creation-reader' as const, createOperationId: record.requestId } } }
      if (record.execution.hostId === 'local' && record.execution.runtimeId &&
          (await options.runtime().client.agentCreationAuthority()).runtimeId !== record.execution.runtimeId) throw new AgentMuxError(
        'The original local creation belongs to another Runtime. Keep its Session and request.', 'RUNTIME_OWNER_MISMATCH')
      const host = borrowed = record.execution.runtimeId && record.execution.hostId !== 'local' ? await options.runtime().executionHost(record.execution.hostId, record.execution.adoptedRoute, access) : null
      if (host && host.runtimeId !== record.execution.runtimeId) throw new AgentMuxError('The original Agent route answers for another Runtime. Keep the original Session and request.', 'RUNTIME_OWNER_MISMATCH')
      if (host && originalRequest && record.execution.adoptedRoute && await host.client.resolveAgentCreationSessionId(record.requestId) !== record.agentSessionId) throw new AgentMuxError(
        'The original creation operation resolves to another Session. Keep both references; no current SID was substituted.', 'SPATIAL_CREATION_UNCONFIRMED')
      const session = await (host?.client ?? options.runtime().client).inspectAgentCreation(record.agentSessionId)
      if (session.kind === 'retired-agent') {
        const history = session.history
        if (session.agentSessionId !== record.agentSessionId || !history || history.creation?.createOperationId !== record.requestId ||
            history.executorId !== record.executorId || history.workspacePath !== record.execution.workspacePath ||
            record.execution.executorRevision && history.creation.executorRevision !== record.execution.executorRevision ||
            record.executionBinding && (history.toolExecution?.bindingId !== record.executionBinding.bindingId ||
              history.toolExecution.resourceRuntimeId !== record.placement?.runtimeId || history.toolExecution.workspacePath !== record.placement?.workspacePath))
          throw new AgentMuxError('The retired Session has no confirmed history for this original creation. Its identity and request are retained.', 'AGENT_CREATION_UNCONFIRMED')
        report.agent = { ...spatialAgentFact({ ...history, agentSessionId: session.agentSessionId, run: session.run }, record.execution.hostId),
          ...(record.takeover ? { takeover: record.takeover } : {}), retirement: { source: session.source, observedAt: session.observedAt } }
        report.outcome = 'retired'; report.to = null
        report.issues.push(issue(new AgentMuxError('The original Agent was explicitly retired. Its exact Session and creation history remain available.', 'AGENT_SESSION_RETIRED')))
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        return report
      }
      if (session.kind !== 'agent') throw new AgentMuxError('The original creation is not a committed Session. Its exact prepared or closed receipt is retained.', 'AGENT_CREATION_UNCONFIRMED')
      const creation = session.creation
      if (record.takeover && !record.executionBinding && !isDeepStrictEqual(record.takeover, creation?.takeover) || !creation || session.agentSessionId !== record.agentSessionId || creation.createOperationId !== record.requestId ||
          session.executorId !== record.executorId || session.workspacePath !== record.execution.workspacePath ||
          record.execution.executorRevision && creation.executorRevision !== record.execution.executorRevision ||
          record.executionBinding && (session.toolExecution?.bindingId !== record.executionBinding.bindingId ||
            session.toolExecution.resourceRuntimeId !== record.placement?.runtimeId || record.placement?.runtimeId !== options.runtime().ownerIdentity().runtimeId ||
            session.toolExecution.workspacePath !== record.placement?.workspacePath)) throw new AgentMuxError(
        'Core has not confirmed this original creation identity and execution target. The healthy Session is retained.', 'AGENT_CREATION_UNCONFIRMED')
      report.agent = { ...spatialAgentFact(session, record.execution.hostId), ...(record.takeover ? { takeover: record.takeover } : {}) }
      const attached = observedGraph ? placement : (await options.spatial.settleAgentOpen(record.requestId, session, regionDescriptor(record, 'attached'))).attached
      report.to = attached ? record.address : null
      report.save.layoutApplied = attached
      if (!attached) report.issues.push(issue(new AgentMuxError('The original Agent exists, but its reserved Region binding changed. Existing contents were retained.', 'SPACE_PLACEMENT_UNKNOWN')))
      if (record.executionBinding && report.execution && !context.caller) {
        const binding = report.execution?.inspection
        const original = binding?.continuation
        if (!binding || binding.bindingId !== record.executionBinding.bindingId || binding.agentSessionId !== record.agentSessionId ||
            binding.agentHostId !== record.execution.hostId || binding.resourceHostId !== record.placement?.hostId ||
            binding.resourceWorkspacePath !== record.placement?.workspacePath ||
            !original || original.bindingId !== record.executionBinding.bindingId || original.agentSessionId !== record.agentSessionId ||
            original.createOperationId !== record.requestId) report.issues.push(issue(new AgentMuxError(
          'The original execution binding has no confirmed matching receipt. The Agent and its original operation are retained.', 'EXECUTION_INTENT_UNCONFIRMED'), 'observation'))
        else if (binding.state !== 'connected') report.issues.push(issue(new AgentMuxError(
          binding.diagnostic?.message ?? 'The original execution binding has not been confirmed connected. The Agent remains available.',
          binding.diagnostic?.code ?? 'EXECUTION_OBSERVATION_UNCONFIRMED'), 'observation'))
      }
      if (creation.persistence === 'unconfirmed' || creation.failure || ['unknown', 'unconfirmed'].includes(creation.initialPrompt)) {
        report.issues.push(issue(new AgentMuxError(creation.failure?.message ?? 'The original creation or first input is unconfirmed. Read the same operation without replaying.', creation.failure?.code ?? 'AGENT_CREATION_UNCONFIRMED')))
      }
      report.outcome = report.issues.length ? 'partial' : 'opened'
    } catch (error) { report.issues.push(issue(error, 'observation')); report.outcome = report.agent ? 'partial' : 'unknown' }
    finally { try { await borrowed?.dispose?.() } catch (error) { report.issues.push(issue(error, 'observation')); if (report.agent) report.outcome = 'partial' } }
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    return report
  }
  return Object.assign(async (request: Parameters<NonNullable<AgentMuxRpcServiceOptions['spatialAgentControl']>>[0], context: AgentMuxRpcCallContext): Promise<AgentMuxControlResult | undefined> => {
    const state = await options.spatial.read()
    if (request.operation === 'space.inspect') {
      if (!('requestId' in request.target)) return undefined
      const association = state ? spatialAgentAssociationRecord(state.graph, request.target.requestId) : null
      if (association && state) return { operation: 'space.inspect', catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }, request: { requestId: request.target.requestId, known: true, report: associationReport(association, state.graph) } }
      const requestId = request.target.requestId, record = state ? spatialAgentOpenRecord(state.graph, requestId) : null
      const runtime = options.runtime()
      let admission: Awaited<ReturnType<NonNullable<typeof runtime.executionBindings.sourceDiagnostics>>> | undefined
      let observationIssue: { code: string; message: string } | undefined
      if (!record && canReadSourceExecution(context)) try {
        admission = await runtime.executionBindings.sourceDiagnostics?.(requestId, context)
      } catch (error) {
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        observationIssue = error instanceof AgentMuxError && error.code === 'EXECUTION_DIAGNOSTIC_SCOPE_UNCONFIRMED'
          ? { code: error.code, message: 'The frozen Source intent could not be uniquely verified. Keep the original operation.' }
          : { code: 'EXECUTION_DIAGNOSTIC_UNAVAILABLE', message: 'The original Coordinator admission could not be observed. Keep the original operation.' }
      }
      const report: AgentMuxSpaceMutationReport | null = state && record ? await reconcile(record, context, undefined, undefined, state.graph)
        : admission?.state === 'matched' ? {
          requestId, outcome: 'unknown', from: null, to: null, agent: null, resource: null,
          execution: { coordinatorRuntimeId: admission.sourceRuntimeId, reference: admission.reference, inspection: null,
            diagnostics: admission, placement: 'unconfirmed' },
          save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed',
            reason: 'The original execution intent is retained. Its Source placement is unconfirmed.' },
          issues: [issue(new AgentMuxError('The frozen execution intent is retained. Its original Source placement is unconfirmed.', 'SPACE_PLACEMENT_UNKNOWN'), 'observation')]
        } : null
      return { operation: 'space.inspect', catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
        request: { requestId, known: Boolean(report), report, ...(observationIssue ? { observationIssue } : {}) } }
    }
    if (request.operation !== 'agent.open') return undefined
    const cancelled = state && takeoverCancellationRecord(state.graph, request.requestId)
    if (cancelled) {
      if (cancelled.input.expectedRuntimeId !== options.runtime().ownerIdentity().runtimeId) throw new AgentMuxError('The retained cancellation belongs to another original Runtime.', 'AGENT_TAKEOVER_CANCELLATION_UNCONFIRMED')
      const { operationId, ...body } = cancelled.input.request
      if (spatialAgentOpenDigest({ schemaVersion: 5, operation: 'agent.open', requestId: operationId, ...body }) !== spatialAgentOpenDigest(request)) throw new AgentMuxError('This cancellation belongs to another original request.', 'SPACE_REQUEST_CONFLICT')
      throw new AgentMuxError('This original Takeover was cancelled. Its original work is retained.', 'AGENT_TAKEOVER_CANCELLED')
    }
    let takeover: AgentMuxRpcCallContext['agentTakeover']
    const assertTakeover = async (admission: Parameters<NonNullable<Parameters<AgentMuxSpatialStateStore['admitAgentOpen']>[1]>>[0]) => {
      if (!takeover) return
      if (takeoverRequiresPromotion(admission.graph, admission.record.address, takeover.preparation.source)) await assertPromotionEnabled(options.configurationPath)
    }
    if (request.operation === 'agent.open' && request.content.kind === 'takeover-agent') {
      const previous = state ? spatialAgentOpenRecord(state.graph, request.requestId) : null
      if (previous) {
        if (!previous.takeover || previous.takeoverRequestDigest !== spatialAgentOpenDigest(request)) throw new AgentMuxError('This operation belongs to another original Takeover.', 'SPACE_REQUEST_CONFLICT')
        if (!previous.executionBinding) {
          // C is the frozen invocation, not evidence that Native creation is absent.
          // Only an explicit continuation enters Core's original same-operation claim.
          const observed = await reconcile(previous, context)
          if (observed.agent || observed.outcome === 'retired' || previous.execution.hostId !== 'local' || typeof previous.takeoverSourceAgentMuxNote !== 'string') return { operation: 'agent.open', ...observed }
          try {
            context.signal?.throwIfAborted(); await context.assertCurrent?.()
            await createOriginalLocalTakeover(previous, request)
            return { operation: 'agent.open', ...await reconcile(previous, context) }
          } catch (error) { return { operation: 'agent.open', ...await reconcile(previous, context, error) } }
        }
        if (!previous.takeoverContent?.agentTarget) return { operation: 'agent.open', ...await reconcile(previous, context) }
        request = { ...request, content: previous.takeoverContent }
        return await openSpatialAgentTarget({ ...options, reconcile, descriptor: regionDescriptor }, request as Parameters<typeof openSpatialAgentTarget>[1], state!, context)
      }
      takeover = context.agentTakeover
      if (!takeover || takeover.requestId !== request.requestId || takeover.requestDigest !== spatialAgentOpenDigest(request)) throw new AgentMuxError('The original Core Takeover preparation is unavailable. Keep the source and exact request.', 'CONTROL_UNAVAILABLE')
      const targetGraph = state!.graph, targetDestination = request.destination
      const targetZone = targetDestination.zoneId ?? targetGraph.tabs.find(tab => tab.tabId === targetDestination.tabId || tab.regionIds.includes(targetDestination.regionId ?? ''))?.zoneId ?? null
      if (takeoverRequiresPromotion(targetGraph, { spaceId: request.destination.spaceId ?? null, zoneId: targetZone }, takeover.preparation.source)) await assertPromotionEnabled(options.configurationPath)
      request = { ...request, content: { ...(request.content.agentTarget ? { agentTarget: request.content.agentTarget } : {}), kind: 'new-agent', executorId: request.content.executorId, ...parseAgentOpenLaunchFields(request.content), prompt: takeover.prompt } }
    }
    if (isSpatialAgentAssociation(request)) {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      const result = await options.spatial.associateAgentOpen(request, options.runtime().ownerIdentity().runtimeId, async () => { context.signal?.throwIfAborted(); await context.assertCurrent?.() })
      return { operation: 'agent.open', ...associationReport(result.record, result.state.graph, result.admitted) }
    }
    if (request.content.kind === 'new-agent' && request.content.agentTarget && (takeover || isHeadlessSpatialAgentOpen(request, state?.graph))) {
      if (!state) throw new AgentMuxError('The original spatial document is unavailable. Keep the chosen Space and original request.', 'SPATIAL_STATE_ABSENT')
      return await openSpatialAgentTarget({ ...options, reconcile, descriptor: regionDescriptor, assertTakeover }, request as Parameters<typeof openSpatialAgentTarget>[1], state, context)
    }
    const candidate = takeover ? { ...request, destination: { ...request.destination, displayWorkspaceId: undefined, groupId: undefined } } : request
    // A Takeover's explicit display IDs are Core topology, never native focus or an execution override.
    const takeoverZone = takeover && state?.graph.zones.find(zone => zone.zoneId === request.destination.zoneId)
    const takeoverBackground = takeover && request.focus === false && takeoverZone?.hostId === 'local' && !request.destination.newZone && !request.destination.split &&
      (request.destination.newTab === true || request.destination.tabId && request.destination.regionId)
    if (!takeoverBackground && !isBackgroundLocalAgentOpen(candidate, state?.graph)) {
      if (takeover) throw new AgentMuxError('This Takeover requires its original background local Zone owner. The exact source and destination are kept.', 'CONTROL_UNAVAILABLE')
      return undefined
    }
    if (request.content.kind !== 'new-agent') return undefined
    if (!state) throw new AgentMuxError('The original spatial document is unavailable. Keep the chosen Space and read its original owner before creation.', 'SPATIAL_STATE_ABSENT')
    const previous = spatialAgentOpenRecord(state.graph, request.requestId)
    if (previous) {
      if (previous.digest !== spatialAgentOpenDigest(request)) throw new AgentMuxError('This operation belongs to another original spatial creation intent.', 'SPACE_REQUEST_CONFLICT')
      const observed = await reconcile(previous, context)
      // Inspection can reconcile the original Core prepared start. A retained
      // spatial reservation alone never authorizes rebuilding its invocation
      // from today's Executor settings or resending its original first input.
      return { operation: 'agent.open', ...observed }
    }
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const { spaceId, zoneId, tabId, regionId } = request.destination
    const catalog = selectSpatialCatalog(spatialCatalog(state.graph), { ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), ...(tabId ? { tabId } : {}), ...(regionId ? { regionId } : {}) })
    if (catalog.zones.length !== 1) throw new AgentMuxError('Choose the exact original execution Zone.', 'SPACE_ZONE_REQUIRED')
    const zone = catalog.zones[0]!
    const execution = { hostId: zone.hostId ?? '', workspacePath: zone.directoryPath ?? '', workspaceId: zone.workspaceId }
    if (execution.hostId !== 'local') throw new AgentMuxError('This background local creator has no original foreign execution route. Its chosen target and existing Agents remain available.', 'UNKNOWN_HOST')
    if (!execution.workspacePath) throw new AgentMuxError('The selected original execution directory is unconfirmed. No Agent was started.', 'SPACE_RESOURCE_UNKNOWN')
    const client = options.runtime().client, agentSessionId = await client.resolveAgentCreationSessionId(request.requestId)
    // A Core creation can predate this spatial owner. Its missing placement is
    // unknown, never permission to dispatch or attach the same operation again.
    try {
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
    const inventory = await client.listHostExecutors({ refresh: false, executorId: request.content.executorId })
    const authority = await client.agentCreationAuthority()
    if (inventory.runtimeId !== authority.runtimeId) throw new AgentMuxError('The chosen Executor belongs to another original Runtime.', 'RUNTIME_OWNER_MISMATCH')
    const requestedExecutor = request.content.executorId
    const executors = inventory.executors.filter(item => item.executorId === requestedExecutor)
    if (executors.length !== 1) throw new AgentMuxError('Choose an Executor configured on the original execution Host.', 'UNKNOWN_EXECUTOR')
    const executor = executors[0]!
    if (request.content.inputRuntimeId !== undefined && request.content.inputRuntimeId !== authority.runtimeId) throw new AgentMuxError('The original input belongs to another execution Runtime.', 'RUNTIME_OWNER_MISMATCH')
    assertAgentInputEpoch(optionalInputEpoch(await client.readAgentInputEpoch()), request.content)
    const frozenExecution = { ...execution, ...optionalInputEpoch(request.content.inputEpoch), runtimeId: authority.runtimeId, executorRevision: executor.configRevision }
    let raw: unknown, configurationIssue: unknown
    try { raw = await readOriginalMoteConfiguration(options.configurationPath) } catch (error) { configurationIssue = error }
    if (!object(raw)) configurationIssue ??= new AgentMuxError('The original Profile and Topic directory configuration is unconfirmed.', 'EXECUTOR_CONFIGURATION_UNAVAILABLE')
    const platformContext = await options.agentMuxContext?.(request)
    let prepared: Awaited<ReturnType<ScratchTopics['prepareAgent']>> | undefined, note = ''
    const prepareContext = async () => {
      if (zone.kind === 'home' && zone.workspaceId === SCRATCH_WORKSPACE_ID) {
        const workspaces = object(raw) && Array.isArray(raw.workspaces) ? raw.workspaces.filter(value => object(value) && value.id === SCRATCH_WORKSPACE_ID) : []
        const workspace = workspaces.length === 1 ? workspaces[0] : null
        if (!object(workspace) || typeof workspace.path !== 'string' || workspace.hostId !== 'local') throw new AgentMuxError('The original Topic resource Workspace is unconfirmed.', 'SPACE_RESOURCE_UNKNOWN')
        const original = await topics.readForDirectory({ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspace.path }, execution.workspacePath)
        if (!original) throw new AgentMuxError('The exact original Topic resource is unconfirmed. No substitute directory was created.', 'SPACE_RESOURCE_UNKNOWN')
        prepared = await topics.prepareAgent({ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspace.path }, original.id, { providerId: executor.providerId, sessionId: agentSessionId })
        if (prepared.absolutePath !== execution.workspacePath) throw new AgentMuxError('The original Topic directory changed. Its admitted identity is retained.', 'SPACE_RESOURCE_UNKNOWN')
      }
      note = [prepared?.prompt, platformContext, configuredProfileAgentContext(object(raw) ? raw.profile : undefined)].filter(Boolean).join('\n\n')
    }
    if (takeover) await prepareContext()
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    const admission = await options.spatial.admitAgentOpen({ request, agentSessionId, ...(takeover ? { takeover: { preparation: takeover.preparation, requestDigest: takeover.requestDigest, sourceAgentMuxNote: note, ...(prepared ? { optionalContext: prepared.optionalContext } : {}) } } : {}), execution: frozenExecution, regionResource: regionDescriptor({ agentSessionId, execution: frozenExecution }, 'launching') }, assertTakeover)
    try {
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (!takeover) await prepareContext()
      context.signal?.throwIfAborted(); await context.assertCurrent?.()
      if (admission.record.takeover) await createOriginalLocalTakeover(admission.record, request)
      else {
        const create: AgentMuxHostAgentCreateInput = { executorId: request.content.executorId, executorRevision: executor.configRevision,
          agentSessionId, createOperationId: request.requestId, workspacePath: execution.workspacePath,
          spatialIntent: { tabId: admission.record.address.tabId, regionId: admission.record.address.regionId, executionWorkspaceId: execution.workspaceId },
          ...parseAgentOpenLaunchFields(request.content), ...optionalInputEpoch(admission.record.execution.inputEpoch),
          ...(note ? { sourceAgentMuxNote: note } : {}), ...(prepared ? { optionalContext: prepared.optionalContext } : {}),
          ...(request.content.prompt === undefined ? {} : { prompt: request.content.prompt }) }
        if (request.caller) await client.createLocalHostAgentWithDelivery(create, { agentSessionId: request.caller.agentSessionId, capability: request.caller.capability ?? '' })
        else await client.createHostAgentWithDelivery(create)
      }
      const observed = await reconcile(admission.record, context)
      if (configurationIssue) {
        observed.issues.push({ step: 'context', code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE', message: 'The original Profile configuration could not be confirmed. The registered Executor and its original Run remain available.', recovery: 'Check the original Host configuration; no replacement settings were selected.' })
        if (observed.agent) observed.outcome = 'partial'
      }
      return { operation: 'agent.open', ...observed }
    } catch (error) { return { operation: 'agent.open', ...await reconcile(admission.record, context, error) } }
  }, { describe: () => ({ ordinaryLaunch: { revision: 1 as const, destination: 'source-zone-background' as const }, externalAssociation: 1 as const, takeover: 1 as const }),
    cancelTakeover: (input: import('@agentmux/core/agent-takeover').AgentTakeoverCancellationInput, context: AgentMuxRpcCallContext, inspectOnly?: boolean, actor?: {kind:'user'|'device';id:string}) => cancelOriginalTakeover(options, input, context, inspectOnly, actor),
    describeExecution: async (input: import('@agentmux/core/agent-open-contract').AgentOpenExecutionSelector, context: AgentMuxRpcCallContext) => {
      if (context.caller || !context.principal || !['user','device'].includes(context.principal.kind)) throw new AgentMuxError('Preparing a new input cut requires the original person or device.', 'CONTROL_PERMISSION_DENIED')
      const runtime = options.runtime(), target = input.agentTarget
      if (!target) return { hostId: 'local', runtimeId: runtime.ownerIdentity().runtimeId, inputEpoch: await runtime.client.readAgentInputEpoch() ?? null }
      const host = await runtime.executionHost(target.hostId, target.adoptedRoute, { context, observation: { kind: 'observation', targetRuntimeId: target.runtimeId,
        agentSessionIds: [], source: { kind: 'input-epoch-reader', targetRuntimeId: target.runtimeId, ...(target.adoptedRoute ? { agentRoute: target.adoptedRoute } : {}) } } })
      try {
        if (host.runtimeId !== target.runtimeId) throw new AgentMuxError('The exact input target answers for another Runtime.', 'RUNTIME_OWNER_MISMATCH')
        return { hostId: target.hostId, runtimeId: host.runtimeId, inputEpoch: await host.client.readAgentInputEpoch() ?? null }
      } finally { await host.dispose?.() }
    } })
}
