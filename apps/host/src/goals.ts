import { createHostGoalDiscussions } from './goal-discussions.js'
import { resolveGoalsPreferences, type GoalsPreferences } from './goals-preferences.js'
import { deriveObjectId } from '@agentmux/core/object-id'
import { goalPmoOperation } from './goal-pmo-origin.js'
import { dirname, join } from 'node:path'
import { AgentMuxError, agentPromptCondition, type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext,
  type AgentMuxSpatialStateStore, type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core/control'
import type { AgentMuxNameContext } from '@agentmux/core/spatial-graph'
import { isDemandStoreError, openDemandStore, type Demand, type DemandParticipationSource, type DemandStore } from '@agentmux/demand'
import type { GoalDelegationCorePort, GoalDelegationCoreMethod } from './goal-delegation-owner.js'
import { GoalDelegationOwner } from './goal-delegation-owner.js'
import { GoalDelegationAttentionOwner } from './goal-delegation-attention.js'
import { GoalStartResponsibilityOwner } from './goal-start-responsibility.js'
import { GoalResponsibilityOwner } from './goal-responsibility-owner.js'
import { GoalPatrolOwner } from './goal-patrol-owner.js'
import { GoalDispatchInputOwner } from './goal-dispatch-input.js'
import { goalRoleInputNote } from './goal-role-input.js'
import { createGoalRuntime, type GoalExecutionClient } from './goal-runtime.js'
import { ContinuousProgressLoopManager } from './continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from './continuous-progress-loop-store.js'
import { deliverContinuousProgress } from './continuous-progress-delivery.js'
import { checkInHumanObservation } from './agent-schedule-check-in.js'
import { createGoalParticipationOwner } from './goal-participation-owner.js'
import { admittedDemandParticipation } from './demand-participation.js'
import { hostNameHistory } from './name-history.js'
import { ScratchTopics } from './mote-resources.js'
import { projectHostGoal } from './goal-projection.js'
import { createGoalAutomationPause } from './goal-automation-pause.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import type { FileReadParams, FileReadResult } from '@agentmux/core/files'

type GoalRequest = Extract<AgentMuxControlRequest, { operation: `demand.${string}` }>
const person = { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** One original Demand store and automatic input owner, independent of every presentation client. */
export function createHostGoals(options: {
  configurationPath: string
  runtime(): AgentMuxHeadlessRuntime
  clients?(): readonly { hostId: string; client: GoalExecutionClient }[]
  subscribeClients?(listener: () => void): () => void
  spatial?: AgentMuxSpatialStateStore
  files?(input: FileReadParams): Promise<FileReadResult>
  coreCall<M extends AgentMuxRpcMethod>(hostId: string, method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
  projects(): Promise<readonly { projectId: string; name: string }[]>
  changed?(ids: string[]): void
  /** Injection only qualifies an explicit client veto, never a Host-owned draft projection. */
  inputOccupied?: Parameters<typeof createGoalRuntime>[0]['inputOccupied']
  subscribeInputOccupation?: Parameters<typeof createGoalRuntime>[0]['subscribeInputOccupation']
}) {
  const root = dirname(options.configurationPath)
  const demands = openDemandStore({ root: join(root, 'demands') })
  const inputCancellations = new Set<(control: import('./goal-runtime.js').GoalAgentControl) => void>()
  const clients = () => [{ hostId: 'local', client: options.runtime().client }, ...(options.clients?.() ?? [])]
  const exact = (hostId: string) => {
    const values = clients().filter(value => value.hostId === hostId)
    if (values.length !== 1) throw new AgentMuxError('The original Goal Host is unavailable or ambiguous. Its identities and input are retained.', 'CONTROL_UNAVAILABLE')
    return values[0]!.client
  }
  const runtime = createGoalRuntime({ clients,
    ...(options.subscribeClients ? { subscribeClients: options.subscribeClients } : {}),
    ...(options.inputOccupied ? { inputOccupied: options.inputOccupied } : {}),
    subscribeInputOccupation: listener => {
      inputCancellations.add(listener)
      const external = options.subscribeInputOccupation?.(listener)
      return () => { inputCancellations.delete(listener); external?.() }
    },
    checkIn: async (target, now, signal) => {
      const client = exact(target.hostId), before = await client.statusAgent(target.agentSessionId)
      signal.throwIfAborted()
      const timeline = await client.sessionTimeline(target.agentSessionId)
      const page = await client.sessionHistoryPage(target.agentSessionId, { limit: 100, refreshNativeSource: true, requireCurrentSource: true, signal })
      const after = await client.statusAgent(target.agentSessionId), handle = after.session.nativeHandle
      signal.throwIfAborted()
      if (before.session.run.runId !== after.session.run.runId || JSON.stringify(before.session.nativeHandle) !== JSON.stringify(handle) ||
          handle?.kind !== 'provider' || handle.providerId !== page.source.providerId || handle.sessionId !== page.source.nativeSessionId)
        return { known: false, reason: 'The original Run or current conversation source changed. No human silence or response was inferred.' }
      return checkInHumanObservation(target.agentSessionId, timeline, page, now)
    } })
  const progress = new ContinuousProgressLoopManager(ContinuousProgressLoopStore.forUserData(root),
    (loop, operationId, isCurrent, signal) => deliverContinuousProgress(runtime, loop, operationId, isCurrent, signal), undefined,
    (loop, tickId, now, signal) => runtime.observeContinuousProgress(loop, tickId, now, signal), runtime,
    { read: id => demands.get(id), subscribe: listener => demands.subscribe(snapshot => listener(snapshot.demands)),
      inspectInitial: loop => runtime.inspectContinuousProgressInitial(loop) })
  const dispatch = new GoalDispatchInputOwner(demands, runtime)
  const automaticInput = createGoalAutomationPause({ ownerInstanceId: () => options.runtime().ownerIdentity().ownerInstanceId,
    get client() { return options.runtime().client }, progress,
    cancel: control => { for (const listener of inputCancellations) listener(control) } })
  let attention: GoalDelegationAttentionOwner, starts: GoalStartResponsibilityOwner,
    responsibility: GoalResponsibilityOwner, patrol: GoalPatrolOwner
  const changeReaders = new Set<(change: import('@agentmux/core').GoalChanges) => void | Promise<void>>()
  const changed = (ids: string[]) => { options.changed?.(ids); for (const listener of changeReaders) void Promise.resolve(listener({ goalIds: ids })).catch(error => console.warn('Original Goal invalidation delivery is unconfirmed.', error)) }
  const releaseStoreChanges = demands.subscribe((_snapshot, ids) => changed([...ids]))
  const core: GoalDelegationCorePort = { call: options.coreCall, observeRun: (hostId, runId) => runtime.observeOriginalRun(hostId, runId),
    readDispatch: (hostId, sourceMessageId) => options.coreCall(hostId, 'message.dispatch.read', { sourceMessageId }, { principal: person }) }
  const delegations = new GoalDelegationOwner(demands, runtime, options.files, core,
    (goalId, saved) => attention.observe(goalId, saved), (goal, saved) => starts.observe(goal, saved),
    { observe: (goal, work) => responsibility.observe(goal, work), progress: (id, input, context, authority) => responsibility.progress(id, input, context, authority) },
    { request: (id, op, context, authority) => patrol.request(id, op, context, authority),
      continue: (id, patrolId, op, run, context, authority) => patrol.continue(id, patrolId, op, run, context, authority),
      report: (id, patrolId, report, authority) => patrol.report(id, patrolId, report, authority), observe: goal => patrol.observe(goal) })
  const readDelegations = (goalId: string, context: AgentMuxRpcCallContext) => delegations.call('goal.delegations', { goalId }, context, { actor: person })
  attention = new GoalDelegationAttentionOwner(demands, runtime, delegations, changed)
  starts = new GoalStartResponsibilityOwner(demands, runtime, changed)
  responsibility = new GoalResponsibilityOwner(demands, runtime, readDelegations, changed)
  patrol = new GoalPatrolOwner(demands, runtime, readDelegations, changed)
  let starting: Promise<void> | undefined
  const start = () => starting ??= (async () => {
    const outcomes = await Promise.allSettled([progress.start(), attention.start(), starts.start(), responsibility.start(), patrol.start()])
    const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Some original Goal observers could not start; healthy domains and Agents remain available.')
  })()
  const discussions = createHostGoalDiscussions({ configurationPath: options.configurationPath, demands, ...(options.spatial ? { spatial: options.spatial } : {}), runtime,
    confirmParticipation: (input, context) => participation.confirm(input, context),
    call: (method, params, context, hostId = 'local') => options.coreCall(hostId, method, params, context) })
  const participation = createGoalParticipationOwner({ demands, client: exact,
    discussion: (goal, hostId, sessionId) => discussions.ownsRecipient(goal, hostId, sessionId),
    activeContinuation: async id => (await progress.listGoals(id)).some(loop => loop.status !== 'stopped'),
    source: async (hostId, agentSessionId, workspacePath) => {
      const context: AgentMuxNameContext = { source: 'core-input', transport: null, entryPoint: 'goal.participation.confirm', actor: { kind: 'agent', id: agentSessionId, verified: true },
        location: { hostId, callerSessionId: agentSessionId, callerCwd: workspacePath } }
      // Mote directory metadata decorates an already exact source. A metadata read
      // failure never erases the confirmed Core author or the original request.
      const raw = await readOriginalMoteConfiguration(options.configurationPath).catch(() => null)
      const workspaces = record(raw) && Array.isArray(raw.workspaces) ? raw.workspaces.filter(value => record(value) &&
        value.hostId === hostId && value.id === '__scratch__' && typeof value.path === 'string') as import('./content-types.js').WorkspaceRecord[] : []
      return (await admittedDemandParticipation(context, 'discussion', { workspaces }, new ScratchTopics()))!
    } })
  const get = async (id: string) => {
    const goal = await demands.get(id)
    if (!goal) throw new AgentMuxError('The original Goal was not found. Its Session and saved requests remain available.', 'GOAL_NOT_FOUND')
    return goal
  }
  const current = async (context: AgentMuxRpcCallContext) => { context.signal?.throwIfAborted(); await context.assertCurrent?.() }
  const participant = (context: AgentMuxNameContext | undefined, kind: DemandParticipationSource['kind']): DemandParticipationSource | undefined => {
    if (!context?.actor.verified || context.actor.kind !== 'agent' || !context.actor.id || context.location.callerSessionId !== context.actor.id || !context.location.hostId) return undefined
    return { kind, agentSessionId: context.actor.id, hostId: context.location.hostId, entryPoint: context.entryPoint }
  }
  const project = async (id: string | null | undefined) => {
    if (!id) return null
    const choices = (await options.projects()).filter(project => project.projectId === id)
    if (choices.length !== 1) throw new AgentMuxError('The exact original Project is unavailable or ambiguous. The Goal and input are retained.', 'UNKNOWN_WORKSPACE')
    return choices[0]!
  }
  const update = async (goal: Demand, patch: Parameters<DemandStore['update']>[1], operationId: string, name: AgentMuxNameContext | undefined, context: AgentMuxRpcCallContext, expectedUpdatedAt?: number) => {
    const originalProject = Object.hasOwn(patch, 'projectId') ? await project(patch.projectId) : undefined
    const participation = patch.description !== undefined || patch.alignment !== undefined ? participant(name, 'requirements') : undefined
    await current(context)
    return await demands.update(goal.id, { ...patch, ...(originalProject === undefined ? {} : { projectName: originalProject?.name ?? null }) },
      { ...(name ? { context: name } : {}), operationId, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }), ...(participation ? { participation } : {}) })
  }
  const saveDecision = async (id: string, decision: import('@agentmux/core/control').AgentMuxDemandDecision, operationId: string, context: AgentMuxRpcCallContext) => {
    await current(context)
    await demands.addDecision(id, { id: 'routing:' + operationId, question: decision.input, decision: decision.selectedProjectId ?? '(unassigned)',
      rationale: decision.candidates.map(candidate => candidate.reason).join('; ') || 'Explicit routing decision', actorId: decision.sourceSessionId })
  }
  const execute = async (request: AgentMuxControlRequest, name: AgentMuxNameContext | undefined, context: AgentMuxRpcCallContext = {}): Promise<AgentMuxControlResult | undefined> => {
    if (!request.operation.startsWith('demand.')) return undefined
    await current(context)
    const req = request as GoalRequest
    if (req.operation === 'demand.list') return { operation: req.operation, demands: (await demands.list()).map(projectHostGoal) }
    if (req.operation === 'demand.show') {
      if (req.dispatchOperationId) await dispatch.reconcile({ goalId: req.demandId, operationId: req.dispatchOperationId }, () => current(context))
      const goal = await demands.get(req.demandId)
      return { operation: req.operation, demand: goal ? projectHostGoal(goal) : null, goalContinuations: await progress.listGoals(req.demandId) }
    }
    if (req.operation === 'demand.create') {
      const goalId = req.demandId ?? deriveObjectId('goal-create', req.requestId)
      const selected = await project(req.projectId)
      if (!req.decision || req.decision.risk === 'unknown' || req.decision.confirmation === 'pending') throw new AgentMuxError('The original Goal write requires its explicit confirmation and resolved routing.', 'CONTROL_REQUEST_CONFLICT')
      const raw = await readOriginalMoteConfiguration(options.configurationPath), preferences = record(raw) && record(raw.goals) ? raw.goals : {}
      const participation = participant(name, 'create')
      await current(context)
      const saved = await demands.create({ id: goalId, title: req.title, description: req.description ?? '', projectId: req.projectId ?? null, projectName: selected?.name ?? null,
        ...(req.priority ? { priority: req.priority } : {}), ...(req.status ? { status: req.status } : {}), ...(req.assigneeSessionIds ? { assigneeSessionIds: req.assigneeSessionIds } : {}),
        ...(req.supervisorSessionId === undefined ? {} : { supervisorSessionId: req.supervisorSessionId }), ...(req.sessionIds ? { sessionIds: req.sessionIds } : {}), ...(req.tags ? { tags: req.tags } : {}), ...(req.plannedStartAt === undefined ? {} : { plannedStartAt: req.plannedStartAt }), ...(req.targetAt === undefined ? {} : { targetAt: req.targetAt }), ...(req.parentDemandId === undefined ? {} : { parentDemandId: req.parentDemandId }), ...(req.phaseIndex === undefined ? {} : { phaseIndex: req.phaseIndex }), ...(req.contentRefs ? { contentRefs: req.contentRefs } : {}) },
        { operationId: req.requestId, discussionOperationId: await goalPmoOperation({ goalId, creationOperationId: req.requestId }, 'create'), ...(name ? { context: name } : {}), ...(participation ? { participation } : {}), creationOrigin: { requesterAsSupervisor: resolveGoalsPreferences(preferences as GoalsPreferences).requesterAsSupervisor } })
      if (req.decision) await saveDecision(saved.demand.id, req.decision, req.requestId, context)
      return { operation: req.operation, demand: projectHostGoal(await get(saved.demand.id)), receipt: { demandId: saved.demand.id, createdAt: saved.demand.createdAt } }
    }
    if (req.operation === 'demand.activity.inspect') {
      const original = await demands.inspectActivity(req.demandId, req.requestId)
      return { operation: req.operation, demandId: original.demandId, requestId: original.operationId, activity: original.activity, diskDurability: original.diskDurability }
    }
    if (req.operation === 'demand.activity.read') return { operation: req.operation, ...await demands.readActivities(req.demandId) }
    if (req.operation === 'demand.discuss') return await discussions.execute(req, context)
    if (req.operation === 'demand.patrol-all') return await discussions.patrol(req, context)
    const goal = await get(req.demandId)
    if (req.operation === 'demand.decision-log') return { operation: req.operation, demandId: goal.id, decisions: goal.decisions }
    if (req.operation === 'demand.update') {
      const { activityLog, ...patch } = req.patch
      const originalLog = goal.activities.map(activity => `${activity.kind}: ${activity.message}`)
      if (activityLog && originalLog.some((message, index) => activityLog[index] !== message)) throw new AgentMuxError('Goal activity is append-only. Original records remain available.', 'CONTROL_REQUEST_CONFLICT')
      await update(goal, patch, req.requestId, name, context, req.expectedUpdatedAt)
      for (const [index, message] of (activityLog?.slice(originalLog.length) ?? []).entries()) { await current(context); await demands.addActivity(goal.id, { kind: 'board', message, actorId: name?.actor.id ?? null, operationId: req.requestId + ':activity:' + index }) }
      if (req.decision) await saveDecision(goal.id, req.decision, req.requestId, context)
      const saved = await get(goal.id)
      return { operation: req.operation, demand: projectHostGoal(saved), receipt: { demandId: goal.id, updatedAt: saved.updatedAt } }
    }
    if (req.operation === 'demand.confirm') {
      const saved = await demands.confirmAlignment(goal.id, req.expectedRevision)
      return { operation: req.operation, demand: projectHostGoal(saved.demand), receipt: { demandId: goal.id, confirmedRevision: saved.demand.alignment!.revision, confirmedAt: saved.demand.alignment!.confirmedAt! } }
    }
    if (req.operation === 'demand.accept') {
      const saved = await demands.acceptGrounding(goal.id, req.expectedAlignmentRevision, req.expectedSubmissionId, req.acceptGaps, req.finish)
      return { operation: req.operation, demand: projectHostGoal(saved.demand), receipt: { demandId: goal.id, alignmentRevision: saved.demand.grounding!.alignmentRevision, submissionId: saved.demand.grounding!.submissionId, acceptedAt: saved.demand.grounding!.acceptedAt!, acceptedWithGaps: saved.demand.grounding!.checks.some(check => check.outcome === 'gap') } }
    }
    if (req.operation === 'demand.delete') {
      await demands.delete(goal.id)
      return { operation: req.operation, demand: projectHostGoal(goal), receipt: { demandId: goal.id, deletedAt: Date.now() } }
    }
    if (req.operation === 'demand.activity.append') {
      if (!name?.actor.verified) throw new AgentMuxError('The original Goal activity author is unconfirmed. Manual Agent input remains available.', 'CONTROL_PERMISSION_DENIED')
      const participation = req.kind === 'requirements' ? participant(name, 'requirements') : undefined
      const saved = await demands.addActivity(goal.id, { kind: req.kind, message: req.message, actorId: name.actor.id, operationId: req.requestId }, participation ? { participation } : {})
      const activity = saved.demand.activities.find(value => value.operationId === req.requestId)
      if (!activity) throw new AgentMuxError('The original Goal activity receipt is unconfirmed. Inspect this exact operation.', 'CONTROL_UNAVAILABLE')
      return { operation: req.operation, demand: projectHostGoal(saved.demand), activity, receipt: { demandId: goal.id, requestId: req.requestId, activityId: activity.id, diskDurability: 'confirmed', replayed: saved.replayed === true } }
    }
    if (req.operation === 'demand.continuation-action') return { operation: req.operation, demandId: goal.id,
      continuation: await progress.goalAction(goal.id, req.loopId, req.action, req.expectedRevision, req.requestId, context), diskDurability: 'confirmed' }
    if (req.operation === 'demand.link-session') {
      await runtime.resolveGoalAgent(req.sessionId); await current(context)
      const saved = await update(goal, { sessionIds: [...new Set([...goal.sessionIds, req.sessionId])] }, req.requestId, name, context)
      return { operation: req.operation, demand: projectHostGoal(saved.demand), receipt: { demandId: goal.id, sessionId: req.sessionId } }
    }
    if (req.operation === 'demand.link-project') {
      const saved = await update(goal, { projectId: req.projectId }, req.requestId, name, context)
      return { operation: req.operation, demand: projectHostGoal(saved.demand), receipt: { demandId: goal.id, projectId: req.projectId } }
    }
    if (req.operation === 'demand.assign' || req.operation === 'demand.handoff') {
      const saved = await update(goal, { ...(req.assigneeSessionIds ? { assigneeSessionIds: req.assigneeSessionIds } : req.operation === 'demand.handoff' && req.sessionId ? { assigneeSessionIds: [req.sessionId] } : {}),
        ...(req.supervisorSessionId === undefined ? {} : { supervisorSessionId: req.supervisorSessionId }), ...(req.operation === 'demand.assign' && req.projectId !== undefined ? { projectId: req.projectId } : {}) }, req.requestId, name, context, req.expectedUpdatedAt ?? goal.updatedAt)
      if (req.operation === 'demand.assign') {
        if (req.start) await startGoal(saved.demand, req.sessionId, req.requestId, context)
        return { operation: req.operation, demand: projectHostGoal((await get(goal.id))), receipt: { demandId: goal.id, assignedAt: saved.demand.updatedAt, startRequested: req.start } }
      }
      return { operation: req.operation, demand: projectHostGoal(saved.demand), receipt: { demandId: goal.id, handedOffAt: saved.demand.updatedAt, sessionId: req.sessionId ?? null } }
    }
    if (req.operation === 'demand.start') return await startGoal(goal, req.sessionId, req.requestId, context, req.continuation, req.expectedUpdatedAt)
    return undefined
  }
  const startGoal = async (goal: Demand, sessionId: string | undefined, operationId: string, context: AgentMuxRpcCallContext,
    continuation?: { intervalMs: number; alignmentRevision: number }, expectedUpdatedAt?: number): Promise<Extract<AgentMuxControlResult, { operation: 'demand.start' }>> => {
    const original = await demands.inspectDispatch(goal.id, operationId)
    if (original && (sessionId !== undefined && original.agentSessionId !== sessionId || Boolean(continuation) !== (original.execution === 'continue'))) throw new AgentMuxError('The original Goal Start target or execution changed. Inspect that operation without replaying it.', 'CONTROL_REQUEST_CONFLICT')
    const selected = original?.agentSessionId ?? sessionId ?? (goal.assigneeSessionIds.length === 1 ? goal.assigneeSessionIds[0] : undefined)
    if (!selected || !original && !goal.assigneeSessionIds.includes(selected)) throw new AgentMuxError('Choose the exact responsible Agent before starting this Goal. Creation or assignment alone does not start it.', 'INVALID_CONTROL_REQUEST')
    if (original?.stage === 'confirmed') {
      const loop = original.loopId ? (await progress.listGoals(goal.id)).find(value => value.loopId === original.loopId) : undefined
      return { operation: 'demand.start', demand: projectHostGoal(await get(goal.id)), ...(loop ? { continuation: loop } : {}), receipt: { demandId: goal.id, startedAt: original.preparedAt, sessionId: selected } }
    }
    const resolved = original ? { hostId: original.hostId, status: await runtime.observeGoalAgent(original.hostId, selected) } : await runtime.resolveGoalAgent(selected)
    const session = resolved.status.session
    await runtime.authorizeFutureIntent({ hostId: resolved.hostId, agentSessionId: selected, providerId: session.providerId, workspacePath: session.workspacePath }, context)
    if (original && original.runId !== session.run.runId) throw new AgentMuxError('The original Goal Start belongs to another Run. Its unknown input is retained without resending.', 'CONTROL_REQUEST_CONFLICT')
    const loop = continuation ? await progress.prepareGoal({ goalId: goal.id, agentSessionId: selected, hostId: resolved.hostId, providerId: session.providerId, workspacePath: session.workspacePath,
      intervalMs: continuation.intervalMs, alignmentRevision: continuation.alignmentRevision, operationId, prompt: original?.prompt ?? (goal.description.trim() || goal.title) }, context) : undefined
    const prompt = original?.prompt ?? loop?.initialDelivery?.prompt ?? (goal.description.trim() || goal.title)
    await current(context)
    const prepared = await demands.prepareDispatch(goal.id, { operationId, agentSessionId: selected, hostId: resolved.hostId, runId: session.run.runId,
      execution: loop ? 'continue' : 'finite', prompt, ...(loop ? { loopId: loop.loopId, alignmentRevision: continuation!.alignmentRevision } : {}) }, original ? undefined : expectedUpdatedAt ?? goal.updatedAt).catch(error => {
        const cause = isDemandStoreError(error) && record(error.cause) ? error.cause : undefined
        if (!original && cause?.kind === 'goal-start-version-conflict' && cause.goalId === goal.id && cause.operationId === operationId &&
            Number.isSafeInteger(cause.currentUpdatedAt) && Number(cause.currentUpdatedAt) >= 0)
          throw new AgentMuxError(error.message, 'CONTROL_REQUEST_CONFLICT', undefined, { disposition: 'not_applied', confirmedInputBytes: 0 })
        throw error
      })
    const condition = loop?.initialDelivery?.condition ?? agentPromptCondition(session)
    const control = { kind: 'agent' as const, hostId: resolved.hostId, agentSessionId: selected, run: session.run }
    const note = goalRoleInputNote(undefined, { role: 'executor', goalId: goal.id, agentSessionId: selected, runId: session.run.runId,
      source: { kind: loop ? 'goal-native-continuation' : 'goal-start', operationId } }, await runtime.inspectGoalStart(prepared.demand.dispatches!.find(value => value.operationId === operationId)!))
    await dispatch.submit({ goalId: goal.id, operationId }, control, operationId, prompt, async () => {
      await current(context)
      if (loop) await progress.submitGoalInitial(control, goal.id, loop.loopId, operationId, prompt, condition,
        async (isCurrent, signal) => { await runtime.submitPrompt(control, prompt, operationId, condition, { isCurrent, signal }, undefined, false, note, undefined, undefined, context) })
      else await runtime.submitPrompt(control, prompt, operationId, condition, undefined, undefined, false, note, undefined, undefined, context)
    }, loop ? { goalId: goal.id, loopId: loop.loopId } : undefined)
    await demands.update(goal.id, { status: 'in_progress' })
    const confirmed = loop ? await progress.initialGoalInput(loop, loop.loopId, operationId, 'confirm') : undefined
    return { operation: 'demand.start', demand: projectHostGoal(await get(goal.id)), ...(confirmed ? { continuation: confirmed } : {}), receipt: { demandId: goal.id, startedAt: prepared.demand.dispatches!.find(value => value.operationId === operationId)!.preparedAt, sessionId: selected } }
  }
  return { execute, goalChanges: { subscribe: async (listener: (change: import('@agentmux/core').GoalChanges) => void | Promise<void>, _end: (error?: Error) => void | Promise<void>, signal: AbortSignal) => {
      signal.throwIfAborted(); changeReaders.add(listener)
      try { const initial = { goalIds: (await demands.list()).map(goal => goal.id) }; signal.throwIfAborted(); return { initial, dispose: () => { changeReaders.delete(listener) } } }
      catch (error) { changeReaders.delete(listener); throw error }
    } }, progress: { call: progress.callProgress.bind(progress) }, schedules: progress, goalDelegations: delegations, automaticInput, participation, contextForSpatialOpen: discussions.contextForSpatialOpen, nameHistory: (query: import('@agentmux/core').AgentMuxNameHistoryQuery) => {
      if (!options.spatial) throw new AgentMuxError('The original name history owner is unavailable. Original Goal names are retained.', 'CONTROL_UNAVAILABLE')
      return hostNameHistory(options.spatial, demands, query)
    }, demands, runtime, start,
    list: async () => (await demands.list()).map(projectHostGoal),
    async dispose() { releaseStoreChanges(); changeReaders.clear(); attention.dispose(); starts.dispose(); responsibility.dispose(); patrol.dispose(); await progress.stop() } }
}
