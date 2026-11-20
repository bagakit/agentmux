import { getAmuxProtocolTemplate, renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import { optionalInputEpoch } from '@agentmux/core/prompt-condition'
import { confirmSpatialGoalDiscussionLauncher } from './goal-discussion-launcher.js'
import { contributeGoalDiscussionBinding, readGoalDiscussionBinding, resolveGoalDiscussionBinding } from './goal-discussion-bindings.js'
import { AgentMuxError, agentPromptCondition, spatialCatalog, type AgentMuxRpcCallContext, type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { spatialAgentOpenRecord } from '@agentmux/core/spatial-state'
import { deriveObjectId } from '@agentmux/core/object-id'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core/control'
import type { Demand, DemandStore, DemandDiscussionIntent } from '@agentmux/demand'
import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { isDemandStoreError } from '@agentmux/demand'
import { goalPmoOperation } from './goal-pmo-origin.js'
import { goalProjectContext, goalProjectContextText } from './goal-project-context.js'
import type { ProjectWorkspace } from './workspace-projects.js'
import { globalGoalPatrolPrompt } from '@agentmux/core/goal-patrol'
import { readOriginalMoteConfiguration, ScratchTopics, configuredExecutor } from './mote-resources.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { projectHostGoal } from './goal-projection.js'
import type { GoalDelegationAuthority } from '@agentmux/core/goal-delegation'
import type { DemandPatrol } from '@agentmux/demand'
import type { GoalRuntimePort } from './goal-runtime.js'

type Request = Extract<AgentMuxControlRequest, { operation: 'demand.discuss' }>
type TaskMode = 'grill' | 'grounding'
type DiscussionRequest = Omit<Request, 'mode'> & { mode: 'open' | TaskMode }
const discussionPrompt = (mode: TaskMode) => getAmuxProtocolTemplate('goal-task', mode === 'grill' ? 'clarify' : 'inspect')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Original Goal request text, shared by every client through the domain owner. */
function discussionTask(goal: Demand, mode: TaskMode): string {
  return renderAmuxProtocol('goal-task', 'discussion', {
    goalId: goal.id,
    missing: !goal.alignment && !goal.description.trim() ? getAmuxProtocolTemplate('goal-task', 'undefined') + '\n\n' : '',
    task: getAmuxProtocolTemplate('goal-task', mode === 'grill' ? 'alignment' : 'grounding')
  })
}
export function createHostGoalDiscussions(options: {
  configurationPath: string
  demands: DemandStore
  spatial?: AgentMuxSpatialStateStore
  runtime: GoalRuntimePort
  requestPlan?(goalId: string, operationId: string, context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<DemandPatrol>
  confirmParticipation(input: import('@agentmux/core').GoalParticipationConfirm, context: AgentMuxRpcCallContext): Promise<unknown>
  call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext, hostId?: string): Promise<AgentMuxRpcResult<M>>
}) {
  const topics = new ScratchTopics()
  const current = async (context: AgentMuxRpcCallContext) => { context.signal?.throwIfAborted(); await context.assertCurrent?.() }
  const unavailable = (message: string): never => { throw new AgentMuxError(message + ' Original Goal, Tab, Session and manual input are retained.', 'GOAL_DISCUSSION_UNCONFIRMED') }
  const saved = async (id: string) => { const value = await options.demands.get(id); if (!value) throw new AgentMuxError('The original Goal is unavailable.', 'GOAL_NOT_FOUND'); return value }
  const primaryMote = async (choice?: string) => {
    const state = await options.spatial?.read()
    if (!state) return unavailable('The original spatial document is unavailable for this discussion.')
    const catalog = spatialCatalog(state.graph)
    const motes = catalog.spaces.filter(space => space.kind === 'mote' && space.topicId === PMO_TEAMS_TOPIC_ID && space.hostId === 'local')
    if (motes.length !== 1) return unavailable('The original primary Mote is unavailable or ambiguous.')
    const mote = motes[0]!, zones = catalog.zones.filter(zone => zone.kind === 'home' && zone.hostId === 'local' && zone.workspaceId === SCRATCH_WORKSPACE_ID && catalog.bindings.some(binding => binding.spaceId === mote.spaceId && binding.zoneId === zone.zoneId))
    if (zones.length !== 1) return unavailable('The original primary Mote home Zone is unconfirmed.')
    const raw = await readOriginalMoteConfiguration(options.configurationPath)
    const workspaces = object(raw) && Array.isArray(raw.workspaces) ? raw.workspaces.filter(value => object(value) && value.id === SCRATCH_WORKSPACE_ID && value.hostId === 'local' && typeof value.path === 'string') : []
    if (workspaces.length !== 1 || !object(workspaces[0])) return unavailable('The original primary Mote Workspace is unconfirmed.')
    const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspaces[0].path as string }
    const topic = await topics.read(workspace, PMO_TEAMS_TOPIC_ID)
    if (!topic || topic.kind !== 'mote' || !topic.identityDirectoryPath || topic.physicalDirectoryPath !== zones[0]!.directoryPath) return unavailable('The original primary Mote directory does not match this Zone.')
    if (topic.quickMode?.status === 'unconfirmed') return unavailable(topic.quickMode.message)
    const defaults = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults : {}
    let executorId = defaults.executorId
    if (!executorId) {
      const reference = defaults.conversation
      const tabs = state.graph.tabs.filter(tab => tab.zoneId === zones[0]!.zoneId)
      const regions = state.graph.regions.filter(region => region.kind === 'agent' && region.agentSessionId && tabs.some(tab => tab.tabId === region.tabId))
      const exact = reference ? regions.filter(region => reference.hostId === 'local' && region.tabId === reference.tabId && region.regionId === reference.regionId && region.agentSessionId === reference.sessionId &&
        state.graph.layouts[reference.displayWorkspaceId]?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId))) : regions
      if (!regions.length && !reference && choice) executorId = choice
      else {
      if (!exact.length || reference && exact.length !== 1) return unavailable('The original primary Mote bot is unconfirmed. Keep this request and choose its Agent in the original Mote launcher or preferences before sending.')
      const configurations = new Set<string>()
      for (const region of exact) {
        if (region.execution?.hostId !== 'local' || !region.runId) return unavailable('The original primary Mote bot execution Host or Run is unconfirmed here. Its foreign or retained context was not replaced.')
        const bot = await options.runtime.agentCreation('local', region.agentSessionId!)
        if (bot.kind !== 'agent' || bot.run.runId !== region.runId || bot.workspacePath !== topic.physicalDirectoryPath) return unavailable('The exact original primary Mote bot configuration is unconfirmed.')
        const configured = configuredExecutor(raw, bot.executorId)
        if (configured.providerId !== bot.providerId) return unavailable('The original primary Mote bot Provider no longer matches its Executor.')
        configurations.add(bot.executorId)
      }
      // Several dedicated discussions may retain the same known bot setup.
      // This proves one configuration; it does not select or merge a recipient.
      if (configurations.size !== 1) return unavailable('The original primary Mote bot configuration is ambiguous. Select the intended original conversation in its Mote preferences before sending.')
      executorId = configurations.values().next().value!
      }
    }
    if (choice && choice !== executorId) throw new AgentMuxError('The explicit Agent choice conflicts with the original primary Mote bot. Its retained context remains available.', 'CONTROL_REQUEST_CONFLICT')
    configuredExecutor(raw, executorId)
    return { executorId, spaceId: mote.spaceId, zoneId: zones[0]!.zoneId }
  }
  const projectContext = async (goal: Demand) => {
    if (!goal.projectId) return goalProjectContextText(null)
    const raw = await readOriginalMoteConfiguration(options.configurationPath)
    const workspaces = object(raw) && Array.isArray(raw.workspaces) ? raw.workspaces.filter((value): value is ProjectWorkspace => object(value) &&
      ['id','name','hostId','path'].every(key => typeof value[key] === 'string') && (value.repoPath === undefined || typeof value.repoPath === 'string')) : []
    const hosts = object(raw) && Array.isArray(raw.hosts) ? raw.hosts.filter((value): value is { id: string } => object(value) && typeof value.id === 'string') : []
    const original = goalProjectContext({ workspaces, hosts }, goal.projectId)
    return goalProjectContextText(original, goal.projectId)
  }
  const intent = async (goal: Demand, request: DiscussionRequest, context: AgentMuxRpcCallContext): Promise<DemandDiscussionIntent> => {
    if (goal.discussionIntent) {
      if (goal.discussionIntent.requestOperationId === request.requestId && (goal.discussionIntent.mode !== request.mode || request.executorId !== undefined && goal.discussionIntent.executorId !== request.executorId))
        throw new AgentMuxError('The original Goal discussion request belongs to another mode. Keep its same operation and original input.', 'CONTROL_REQUEST_CONFLICT')
      return goal.discussionIntent
    }
    const operationId = goal.discussionOperationId ?? await goalPmoOperation({ goalId: goal.id, creationOperationId: request.requestId }, 'discussion-create')
    const source = await primaryMote(request.executorId)
    const body = request.mode === 'open' ? undefined : discussionTask(goal, request.mode)
    const note = [goalRoleGuidance({ role: 'manager', goalId: goal.id, source: { kind: 'goal-pmo-launch', operationId } }),
      body, await projectContext(goal), renderAmuxProtocol('goal-task', 'facts', { facts: JSON.stringify({ id: goal.id, title: goal.title, description: goal.description, projectId: goal.projectId, assigneeSessionIds: goal.assigneeSessionIds, supervisorSessionId: goal.supervisorSessionId, alignment: goal.alignment, grounding: goal.grounding }) })].filter(Boolean).join('\n\n')
    const birth = goal.discussionOperationId ? goal.creationOrigin : { ...optionalInputEpoch(await options.runtime.readInputEpoch('local')) }
    const value: DemandDiscussionIntent = { ...optionalInputEpoch(birth?.inputEpoch), ...(birth && 'inputRuntimeId' in birth && typeof birth.inputRuntimeId === 'string' ? { inputRuntimeId: birth.inputRuntimeId } : {}), requestOperationId: request.requestId, mode: request.mode, ...source, agentMuxNote: note,
      ...(context.caller ? { callerAgentSessionId: context.caller.agentSessionId } : {}),
      ...(request.mode === 'open' ? {} : { prompt: discussionPrompt(request.mode) }) }
    await current(context)
    try { return (await options.demands.prepareDiscussion(goal.id, operationId, value, goal.updatedAt)).demand.discussionIntent! }
    catch (error) {
      if (!isDemandStoreError(error) || error.code !== 'INVALID_INPUT' || error.phase !== 'validate') throw error
      const winner = await saved(goal.id)
      if (winner.updatedAt === goal.updatedAt || !winner.discussionOperationId || !winner.discussionIntent) throw error
      // A concurrent first request owns the source. Read its frozen intent;
      // never overwrite it or create from this loser's proposed operation.
      return intent(winner, request, context)
    }
  }
  const taskContext = async (goal: Demand, mode: TaskMode) => [discussionTask(goal, mode), await projectContext(goal)].join('\n\n')
  return {
    async ownsRecipient(goal: Demand, hostId: string, sessionId: string): Promise<boolean> {
      const state = await options.spatial?.read()
      if (!state) return false
      const binding = readGoalDiscussionBinding(state.graph, goal.id)
      if (!binding || binding.recipient.kind !== 'agent' || binding.recipient.hostId !== hostId || binding.recipient.agentSessionId !== sessionId) return false
      resolveGoalDiscussionBinding(state.graph, binding)
      return true
    },
    async patrol(request: Extract<AgentMuxControlRequest, { operation: 'demand.patrol-all' }>, context: AgentMuxRpcCallContext): Promise<Extract<AgentMuxControlResult, { operation: 'demand.patrol-all' }>> {
      await current(context)
      const state = await options.spatial?.read(), original = state && spatialAgentOpenRecord(state.graph, request.requestId)
      const source = original ? { executorId: original.executorId, spaceId: original.address.spaceId, zoneId: original.address.zoneId } : await primaryMote(request.executorId)
      if (!source.spaceId || !source.zoneId || request.executorId && request.executorId !== source.executorId) throw new AgentMuxError('The exact original patrol destination or Agent choice changed. Its request remains retained.', 'CONTROL_REQUEST_CONFLICT')
      // Scope is always read by the actual PMO through the original Goal owner.
      // Keeping the request independent of a transient list count also preserves
      // its exact Core creation digest across observation gaps and restarts.
      const result = await options.call('agent.open', { operationId: request.requestId, content: { kind: 'new-agent', executorId: source.executorId, prompt: globalGoalPatrolPrompt() },
        destination: { spaceId: source.spaceId, zoneId: source.zoneId, newTab: true }, focus: false, ...(request.caller ? { caller: request.caller } : {}) }, context)
      const { operationId, ...report } = result
      return { ...report, requestId: operationId, operation: 'demand.patrol-all' }
    },
    async contextForSpatialOpen(request: Extract<AgentMuxControlRequest, { operation: 'agent.open' }>): Promise<string | undefined> {
      // Only this Host's immutable business source can supply platform context;
      // public content fields cannot declare a Goal role or source.
      if (!request.requestId.startsWith('goal_pmo_create_')) return undefined
      const goals = await options.demands.list()
      const matches = goals.filter(goal => goal.discussionOperationId === request.requestId && goal.discussionIntent)
      if (matches.length > 1) return unavailable('The original discussion operation has ambiguous Goal provenance.')
      if (!matches.length) return undefined
      const original = matches[0]!.discussionIntent!
      const frozenRequestMatches = !(request.content.kind !== 'new-agent' || request.content.executorId !== original.executorId || request.content.prompt !== original.prompt ||
          request.content.inputEpoch !== original.inputEpoch || request.content.inputRuntimeId !== original.inputRuntimeId || Object.keys(request.content).some(key => !['kind','executorId','prompt','inputEpoch','inputRuntimeId'].includes(key)) || request.destination.spaceId !== original.spaceId || request.destination.zoneId !== original.zoneId ||
          request.destination.newTab !== true || Object.keys(request.destination).some(key => !['spaceId','zoneId','newTab'].includes(key)) || request.focus !== false || request.caller?.agentSessionId !== original.callerAgentSessionId)
      if (!frozenRequestMatches)
        throw new AgentMuxError('The original Goal discussion creation changed its frozen request.', 'CONTROL_REQUEST_CONFLICT')
      return original.agentMuxNote
    },
    async execute(request: Request, context: AgentMuxRpcCallContext, authority?: GoalDelegationAuthority): Promise<Extract<AgentMuxControlResult, { operation: 'demand.discuss' }>> {
      await current(context)
      let goal = await saved(request.demandId)
      if (request.mode === 'plan') {
        const retained = goal.patrols?.find(item => (item.operationId === request.requestId || item.requestOperationIds?.includes(request.requestId)))
        if (retained && retained.purpose !== 'plan') throw new AgentMuxError('This operation already belongs to an inspection. Keep its original request.', 'CONTROL_REQUEST_CONFLICT')
        // An old frozen discussion input stays at its exact original recipient. Read
        // both public input producers across every retained Run; absence is not inferred
        // from the current screen or current Run alone.
        const frozen = goal.discussionIntent?.requestOperationId === request.requestId
        if (frozen && goal.discussionIntent!.mode !== 'plan') throw new AgentMuxError('The original discussion operation has another purpose.', 'CONTROL_REQUEST_CONFLICT')
        let originalBinding: ReturnType<typeof readGoalDiscussionBinding> = null
        let claimed = false
        if (!retained && options.spatial) {
          const state = await options.spatial.read()
          if (!state) return unavailable('The original discussion bindings could not be observed while reconciling this planning operation.')
          originalBinding = readGoalDiscussionBinding(state.graph, goal.id)
          if (originalBinding?.recipient.kind === 'agent') {
            const recipient = originalBinding.recipient, original = await options.runtime.agentCreation(recipient.hostId, recipient.agentSessionId)
            if (frozen && original.kind === 'agent' && original.creation && original.creation.createOperationId === goal.discussionOperationId) {
              if (original.creation.initialPrompt !== 'confirmed') return unavailable('The frozen original discussion creation input is unconfirmed; it was not replayed or redirected.')
              claimed = true
            }
            const runs = original.kind === 'agent' ? [original.run, ...original.retiredRuns] : []
            for (const run of runs) for (const producer of ['prompt', 'message'] as const) {
              const prior = await options.runtime.inspectGoalAttention({ hostId: recipient.hostId, supervisorAgentSessionId: recipient.agentSessionId,
                supervisorRunId: run.runId, operationId: producer === 'prompt' ? request.requestId : deriveObjectId('goal-discussion-message', request.requestId),
                ...(producer === 'message' ? { producer } : {}) })
              if (prior) { claimed = true; if (!prior.admission?.acknowledged) return unavailable('The original planning input in the dedicated discussion is unconfirmed; it is retained without resending or redirecting.') }
            }
            resolveGoalDiscussionBinding(state.graph, originalBinding)
          }
        }
        if (!retained && (frozen || claimed)) {
          if (!originalBinding || originalBinding.recipient.kind !== 'agent' || !claimed) return unavailable('The original frozen planning discussion is retained. Inspect its original creation and input; no new planning body was sent.')
          return { operation: request.operation, demand: projectHostGoal(goal), receipt: { demandId: goal.id, requestId: request.requestId, mode: 'plan', route: 'discussion',
            tabId: originalBinding.tabId, regionId: originalBinding.regionId, hostId: originalBinding.recipient.hostId, agentSessionId: originalBinding.recipient.agentSessionId } }
        }
        if (!options.requestPlan || !authority) throw new AgentMuxError('The original Supervisor planning request owner or authenticated requester is unavailable. Keep this request and original work.', 'CONTROL_UNAVAILABLE')
        const planned = await options.requestPlan(goal.id, request.requestId, context, authority), target = planned.attempts.at(-1)?.target
        return { operation: request.operation, demand: projectHostGoal(await saved(goal.id)), receipt: { demandId: goal.id, requestId: request.requestId, mode: 'plan', route: 'supervisor',
          requestOperationId: planned.operationId, agentSessionId: planned.supervisorAgentSessionId!, hostId: target?.hostId ?? null, runId: target?.runId ?? null } }
      }
      if (!options.spatial) return unavailable('The original Core spatial owner is unavailable.')
      let state = await options.spatial.read()
      if (!state) return unavailable('The original Core spatial document is unavailable.')
      let binding = readGoalDiscussionBinding(state.graph, goal.id)
      const original = goal.discussionIntent || !binding ? await intent(goal, { ...request, mode: request.mode }, context) : undefined
      goal = await saved(goal.id)
      if (!binding) {
        // Another caller/profile can contribute a retained binding while the
        // Demand source is reserved. The earlier absence is not a creation lease.
        state = await options.spatial.read()
        if (!state) return unavailable('The original Core spatial document is unavailable before discussion creation.')
        binding = readGoalDiscussionBinding(state.graph, goal.id)
        if (binding) {
          const created = goal.discussionOperationId && spatialAgentOpenRecord(state.graph, goal.discussionOperationId)
          if (!created || binding.recipient.kind !== 'agent' || binding.tabId !== created.address.tabId || binding.regionId !== created.address.regionId ||
              binding.recipient.hostId !== created.execution.hostId || binding.recipient.agentSessionId !== created.agentSessionId)
            return unavailable('A retained discussion was contributed while this source was being prepared. Inspect both original sources; no replacement was created.')
        }
      }
      if (!binding) {
        const operationId = goal.discussionOperationId!
        const opened = await options.call('agent.open', { content: { kind: 'new-agent', executorId: original!.executorId, ...optionalInputEpoch(original!.inputEpoch), ...(original!.inputRuntimeId === undefined ? {} : { inputRuntimeId: original!.inputRuntimeId }), ...(original!.prompt === undefined ? {} : { prompt: original!.prompt }) },
          destination: { spaceId: original!.spaceId, zoneId: original!.zoneId, newTab: true }, focus: false, operationId }, context)
        if (!opened.to || !opened.agent || opened.outcome !== 'opened') return unavailable('The original dedicated discussion creation is unconfirmed. Inspect its same operation without choosing another recipient.')
        state = await options.spatial.read()
        const record = state && spatialAgentOpenRecord(state.graph, operationId)
        if (!record || record.agentSessionId !== opened.agent.agentSessionId) return unavailable('The original discussion creation workface is unconfirmed.')
        binding = { schema: 'agentmux.goal-discussion-binding.v1', tabId: record.address.tabId, regionId: record.address.regionId,
          recipient: { kind: 'agent', hostId: record.execution.hostId, agentSessionId: record.agentSessionId } }
        await current(context)
        state = (await contributeGoalDiscussionBinding({ spatial: options.spatial, goalId: goal.id, binding })).state
      }
      if (binding.recipient.kind === 'launcher') {
        const confirmed = await confirmSpatialGoalDiscussionLauncher({ spatial: options.spatial, original: { goalId: goal.id, binding }, agent: options.runtime.agentCreation, candidates: options.runtime.spatialCreationCandidates })
        if (confirmed) { state = confirmed.state; binding = readGoalDiscussionBinding(state.graph, goal.id)! }
      }
      resolveGoalDiscussionBinding(state.graph, binding)
      const receipt = () => ({ demandId: goal.id, requestId: request.requestId, mode: request.mode, route: 'discussion' as const, tabId: binding.tabId, regionId: binding.regionId,
        hostId: binding.recipient.kind === 'agent' ? binding.recipient.hostId : null, agentSessionId: binding.recipient.kind === 'agent' ? binding.recipient.agentSessionId : null })
      if (binding.recipient.kind === 'launcher') {
        if (request.mode !== 'open') return unavailable('Open the original discussion launcher and explicitly choose its Agent before sending this request.')
        return { operation: request.operation, demand: projectHostGoal(goal), receipt: receipt() }
      }
      const recipient = binding.recipient
      if (original?.prompt && request.requestId === original.requestOperationId) {
        const created = await options.runtime.agentCreation(recipient.hostId, recipient.agentSessionId)
        const creation = created.kind === 'agent' ? created.creation : undefined
        if (created.kind !== 'agent' || creation?.createOperationId !== goal.discussionOperationId || !creation?.createdRun)
          return unavailable('The original discussion creation input and Run are unconfirmed.')
        const originalGoalCreation = goal.creationOrigin && !goal.creationOrigin.requesterParticipationId &&
          goal.discussionOperationId === await goalPmoOperation({ goalId: goal.id, creationOperationId: goal.creationOrigin.operationId }, 'create')
        await options.confirmParticipation({ goalId: goal.id, ...(originalGoalCreation ? { creationOperationId: goal.creationOrigin!.operationId } : {}), hostId: recipient.hostId,
          agentSessionId: recipient.agentSessionId, expectedRun: creation.createdRun, evidence: 'creation-input', operationId: goal.discussionOperationId! }, context)
      }
      if (request.mode !== 'open' && request.requestId !== original?.requestOperationId) {
        let frozen = goal.discussionInputs?.find(item => item.operationId === request.requestId)
        if (frozen && (frozen.mode !== request.mode || frozen.hostId !== recipient.hostId || frozen.agentSessionId !== recipient.agentSessionId || frozen.callerAgentSessionId !== context.caller?.agentSessionId)) throw new AgentMuxError('The original discussion request belongs to another frozen input or recipient.', 'CONTROL_REQUEST_CONFLICT')
        const observed = await options.runtime.observeGoalAgent(recipient.hostId, recipient.agentSessionId)
        if (!frozen) {
          const condition = agentPromptCondition(observed.session)
          const prepared = await options.demands.prepareDiscussionInput(goal.id, { operationId: request.requestId, mode: request.mode,
            hostId: recipient.hostId, agentSessionId: recipient.agentSessionId, runId: condition.expectedRun.runId,
            ...optionalInputEpoch(await options.runtime.readInputEpoch(recipient.hostId)), afterSubmissionId: condition.afterSubmissionId,
            prompt: discussionPrompt(request.mode), agentMuxNote: await taskContext(goal, request.mode),
            ...(context.caller ? { callerAgentSessionId: context.caller.agentSessionId } : {}) })
          frozen = prepared.demand.discussionInputs!.find(item => item.operationId === request.requestId)!
        }

        const key = { kind: 'prompt' as const, agentSessionId: recipient.agentSessionId, expectedRun: { runId: frozen.runId }, submissionId: request.requestId }
        const messageId = deriveObjectId('goal-discussion-message', request.requestId)
        const inputId = context.caller ? messageId : request.requestId
        const session = await options.runtime.agentCreation(recipient.hostId, recipient.agentSessionId)
        if (session.kind !== 'agent') return unavailable('The original discussion Session was explicitly retired. Keep its history and recover that exact Session before sending.')
        const runs = [...new Map([session.run, ...session.retiredRuns].map(run => [run.runId, run])).values()]
        let prior: Awaited<ReturnType<GoalRuntimePort['inspectGoalAttention']>> = null
        for (const run of runs) {
          prior = await options.runtime.inspectGoalAttention({ hostId: recipient.hostId, supervisorAgentSessionId: recipient.agentSessionId, supervisorRunId: run.runId, operationId: inputId, ...(context.caller ? { producer: 'message' as const } : {}) })
          if (prior) break
        }
        if (prior && !prior.admission?.acknowledged) return unavailable('The original discussion request input is unconfirmed; it was not automatically repeated.')
        if (prior && !context.caller && prior.admission?.intent?.message?.userContent !== discussionPrompt(request.mode))
          throw new AgentMuxError('This original discussion input belongs to another frozen request. Its input and recipient remain retained.', 'CONTROL_REQUEST_CONFLICT')
        if (!prior) {
          if (context.caller) {
            await options.call('agent.send', { target: { kind: 'agent-session', agentSessionId: recipient.agentSessionId }, expectedRun: key.expectedRun,
              operationId: request.requestId, messageId, correlationId: deriveObjectId('goal-discussion-' + request.mode, goal.id),
              text: frozen.agentMuxNote, ...(frozen.inputEpoch === undefined ? {} : { recipientInputEpoch: frozen.inputEpoch }), execution: 'immediate', sourceChannel: 'api' }, context, recipient.hostId)
          } else {
          await options.runtime.submitPrompt({ kind: 'agent', hostId: recipient.hostId, agentSessionId: recipient.agentSessionId, run: key.expectedRun },
            frozen.prompt, request.requestId, { expectedRun: key.expectedRun, afterSubmissionId: frozen.afterSubmissionId, ...optionalInputEpoch(frozen.inputEpoch) }, undefined, undefined, true,
            frozen.agentMuxNote, 'api', undefined, context)
          }
          prior = await options.runtime.inspectGoalAttention({ hostId: recipient.hostId, supervisorAgentSessionId: recipient.agentSessionId, supervisorRunId: key.expectedRun.runId, operationId: inputId, ...(context.caller ? { producer: 'message' as const } : {}) })
        }
        if (!prior?.admission?.acknowledged) return unavailable('The original discussion input remains unconfirmed. Its operation and recipient are retained; it was not repeated.')
        if (context.caller) {
          const { message } = await options.call('message.read', { hostId: recipient.hostId, operationId: request.requestId }, context)
          if (message?.envelope.messageId !== messageId || message.envelope.correlationId !== deriveObjectId('goal-discussion-' + request.mode, goal.id) || message.envelope.body !== frozen.agentMuxNote)
            throw new AgentMuxError('The original discussion message belongs to another business request. Its actual sender, recipient and input remain retained.', 'CONTROL_REQUEST_CONFLICT')
        }
        await options.confirmParticipation({ goalId: goal.id, hostId: recipient.hostId, agentSessionId: recipient.agentSessionId, expectedRun: prior.run, evidence: context.caller ? 'message-input' : 'prompt-input', operationId: request.requestId }, context)
      }
      return { operation: request.operation, demand: projectHostGoal(await saved(goal.id)), receipt: receipt() }
    }
  }
}
