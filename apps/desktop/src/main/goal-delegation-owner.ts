import { isDeepStrictEqual } from 'node:util'
import { prepareGoalDelegationMaterials } from './goal-delegation-materials.js'
import type { FileReadParams, FileReadResult } from '@agentmux/core/files'
import { AgentMuxError } from '@agentmux/core'
import { assertGoalDelegationSource, assertGoalDelegationReply, readGoalDelegationWireReport, goalDelegationReportBody } from '@agentmux/core/goal-delegation'
export { goalDelegationReportBody } from '@agentmux/core/goal-delegation'
import type { GoalDelegationAuthority, GoalDelegationMethod, GoalDelegationParamsMap,
  GoalDelegationResult, GoalDelegationObservation, GoalDelegationsOwner } from '@agentmux/core/goal-delegation'
import type { AgentMuxRpcMethod, AgentMuxRpcParams, AgentMuxRpcResult, AgentMuxRun, AgentMuxRpcCallContext } from '@agentmux/core'
import { validateDemandDelegationReport, type DemandDelegation, type DemandDelegationReportInput } from '@agentmux/demand/delegations'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import type { DemandStore } from '@agentmux/demand'
import type { RuntimeController } from './runtime-controller.js'

export type GoalDelegationCoreMethod = Extract<AgentMuxRpcMethod,
  'message.read' | 'agent.send' | 'message.dispatch.open' | 'message.dispatch.read' | 'message.dispatch.report'>
export interface GoalDelegationCorePort {
  call<M extends GoalDelegationCoreMethod>(hostId: string, method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
  readDispatch?(hostId: string, sourceMessageId: string): Promise<AgentMuxRpcResult<'message.dispatch.read'>>
  observeRun(hostId: string, runId: string): Promise<Pick<AgentMuxRun, 'runId' | 'state'>>
}
/** Original Demand owner and original Host clients; no private journal or second queue. */
export class GoalDelegationOwner implements GoalDelegationsOwner {
  constructor(private readonly demands: DemandStore,
    private readonly runtime: Pick<RuntimeController, 'agentCreation'>,
    private readonly readMaterials?: (input: FileReadParams) => Promise<FileReadResult>,
    private readonly core?: GoalDelegationCorePort,
    private readonly readAttention?: (goalId: string, delegation: DemandDelegation) => Promise<GoalDelegationObservation['attention']>) {}

  async call<M extends GoalDelegationMethod>(method: M, input: GoalDelegationParamsMap[M],
    context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<GoalDelegationResult> {
    context.signal?.throwIfAborted()
    if (method === 'goal.delegation.prepare' || method === 'goal.delegate' || method === 'goal.delegation.bind') {
      const request = input as GoalDelegationParamsMap['goal.delegation.prepare']
      let intent = request.intent
      if (authority.actor.kind !== 'agent' || authority.actor.id !== intent.ownerAgentSessionId ||
          authority.hostId !== intent.hostId) throw new AgentMuxError(
        'Only the exact authenticated Goal Supervisor can prepare this delegation at its original Host. The Agent remains available.', 'CONTROL_PERMISSION_DENIED')
      // A saved original intent remains readable after a Run/relationship changes. The
      // business owner compares the complete frozen intent before returning an idempotent read.
      const original = await this.demands.inspectDelegation(input.goalId, intent.operationId)
      const existingSource = method === 'goal.delegation.bind'
        ? (await this.requireCore().call(intent.hostId, 'message.read', { hostId: intent.hostId, operationId: intent.operationId }, context)).message
        : null
      if (method === 'goal.delegation.bind') {
        if (!existingSource) throw new AgentMuxError('The original message is absent at this exact Host. Binding does not create or resend it.', 'CONTROL_UNAVAILABLE')
        this.assertSource(intent, existingSource)
        if (intent.requestText !== undefined && intent.requestText !== intent.text) throw new AgentMuxError('An existing opaque input cannot attest a different original request. Keep its frozen body.', 'CONTROL_REQUEST_CONFLICT')
        if (intent.context?.some(source => source.availability !== 'unknown')) throw new AgentMuxError('An existing opaque input cannot attest retroactive material availability. Keep references as unknown and inspect the original input.', 'CONTROL_REQUEST_CONFLICT')
        if (request.materials?.length) throw new AgentMuxError(
          'The original message input is frozen. Material or coordination content cannot be added retroactively.', 'CONTROL_REQUEST_CONFLICT')
      }
      if (request.materials?.length) {
        if (original) {
          const originalSources = original.context?.slice(-request.materials.length) ?? []
          if (original.requestText !== intent.text || !isDeepStrictEqual(originalSources.map(source => { try { return JSON.parse(source.scope) } catch { return null } }), request.materials) ||
              !isDeepStrictEqual(original.context?.slice(0, -request.materials.length) ?? [], intent.context ?? []))
            throw new AgentMuxError('The frozen original task or selected material targets changed. Read the saved delegation before sending anything.', 'CONTROL_REQUEST_CONFLICT')
          intent = { ...intent, requestText: original.requestText, text: original.text, context: original.context ?? [] }
        } else {
          const prepared = await prepareGoalDelegationMaterials(request.materials, this.readMaterials ?? (async () => { throw new AgentMuxError('The original Files reader is unavailable; this source is unknown and the task is retained.', 'CONTROL_UNAVAILABLE') }))
          intent = { ...intent, requestText: intent.text, text: intent.text + '\n\n' + prepared.agentMuxNote,
            context: [...intent.context ?? [], ...prepared.sources.map(source => ({ kind: 'file' as const,
              source: 'path' in source ? source.path : source.target.path, revision: 'revision' in source ? source.revision : null,
              scope: JSON.stringify(source.target), availability: source.status === 'read'
                ? source.excerpted ? 'excerpt' as const : 'available' as const
                : source.status === 'deleted' || source.status === 'directory' ? 'missing' as const : 'unknown' as const }))] }
        }
      }
      {
        if (original?.requestText !== undefined && !request.materials?.length && original.requestText === intent.text)
          intent = { ...intent, requestText: original.requestText, text: original.text }
        else if (!original && !existingSource) {
          const coordination = JSON.stringify({ schema: 'agentmux.goal-delegation.v1', goalId: input.goalId,
            operationId: intent.operationId, sourceMessageId: intent.sourceMessageId, threadId: intent.threadId,
            ownerAgentSessionId: intent.ownerAgentSessionId, workerAgentSessionId: intent.workerAgentSessionId,
            hostId: intent.hostId, alignmentRevision: intent.alignmentRevision, criterionIds: intent.criterionIds,
            next: 'Use goal report --input FILE to return every delegated criterion with evidence, gap or unknown under this original dispatch. For a question/block, reply to the original source and record message dispatch report --kind question|escalation. A report is pending collection and human acceptance; exiting or worker_done does not complete the Goal.' })
          intent = { ...intent, requestText: request.intent.text, text: intent.text + '\n\n[AgentMux delegation]\n' + coordination }
        }
      }
      if (!original && !existingSource) {
        const [owner, worker] = await Promise.all([
          this.runtime.agentCreation(intent.hostId, intent.ownerAgentSessionId),
          this.runtime.agentCreation(intent.hostId, intent.workerAgentSessionId)
        ])
        if (owner.agentSessionId !== intent.ownerAgentSessionId || owner.run.runId !== intent.ownerRunId ||
            worker.agentSessionId !== intent.workerAgentSessionId || worker.run.runId !== intent.workerRunId ||
            authority.runId !== intent.ownerRunId) throw new AgentMuxError(
          'The original delegation Session or Run changed before preparation. Inspect the same Goal and keep the original Agent and input.', 'CONTROL_REQUEST_CONFLICT')
      }
      await this.demands.prepareDelegation(input.goalId, intent, authority.actor.id)
      if (method === 'goal.delegate' || method === 'goal.delegation.bind') {
        const saved = (await this.demands.inspectDelegation(input.goalId, intent.operationId))!
        const core = this.requireCore()
        // A successful exact journal read is the only proof that an original logical message
        // does not exist. Delivery/input observation and dispatch absence cannot substitute.
        const existing = await core.call(saved.hostId, 'message.read', { hostId: saved.hostId, operationId: saved.operationId }, context)
        if (existing.message) this.assertSource(saved, existing.message)
        else {
          if (method === 'goal.delegation.bind') throw new AgentMuxError('The original message became unavailable before binding. Keep its original source and body.', 'CONTROL_UNAVAILABLE')
          if (authority.runId !== saved.ownerRunId) throw new AgentMuxError('The saved task owner Run changed before its first submission. Read the original delegation and explicitly continue its responsibility.', 'CONTROL_REQUEST_CONFLICT')
          await core.call(saved.hostId, 'agent.send', { target: { kind: 'agent-session', agentSessionId: saved.workerAgentSessionId },
            operationId: saved.operationId, messageId: saved.sourceMessageId, threadId: saved.threadId,
            correlationId: saved.sourceMessageId, text: saved.text, expectedRun: { runId: saved.workerRunId } }, context)
        }
        await core.call(saved.hostId, 'message.dispatch.open', { sourceMessageId: saved.sourceMessageId }, context)
        const observed = await core.call(saved.hostId, 'message.dispatch.read', { hostId: saved.hostId, sourceMessageId: saved.sourceMessageId }, context)
        this.assertSource(saved, observed.source)
        await this.demands.linkDelegation(input.goalId, saved.operationId, saved.sourceMessageId, authority.actor.id)
      }
    }
    if (method === 'goal.report' || method === 'goal.collect') {
      const request = input as GoalDelegationParamsMap['goal.report'] | GoalDelegationParamsMap['goal.collect']
      const saved = await this.demands.inspectDelegation(input.goalId, request.operationId)
      if (!saved) throw new AgentMuxError('The original delegation is unavailable. Do not replace its identity.', 'CONTROL_UNAVAILABLE')
      const core = this.requireCore()
      if (method === 'goal.report') {
        const report = (input as GoalDelegationParamsMap['goal.report']).report
        if (authority.actor.kind !== 'agent' || authority.actor.id !== saved.workerAgentSessionId || authority.hostId !== saved.hostId)
          throw new AgentMuxError('Only the authenticated original worker can report this delegation.', 'CONTROL_PERMISSION_DENIED')
        validateDemandDelegationReport(saved, report)
        if (!saved.linkedAt) throw new AgentMuxError('The original dispatch association is not yet confirmed. The worker and its results are retained.', 'CONTROL_UNAVAILABLE')
        if (saved.report && goalDelegationReportBody(input.goalId, saved.operationId, saved.report) !== goalDelegationReportBody(input.goalId, saved.operationId, report))
          throw new AgentMuxError('The original worker report is frozen. Read it before continuing.', 'CONTROL_REQUEST_CONFLICT')
        const body = goalDelegationReportBody(input.goalId, saved.operationId, report)
        const existing = await core.call(saved.hostId, 'message.read', { hostId: saved.hostId, operationId: report.operationId }, context)
        if (existing.message) this.assertReply(saved, report, existing.message, body)
        else {
          const owner = await this.runtime.agentCreation(saved.hostId, saved.ownerAgentSessionId)
          await core.call(saved.hostId, 'agent.send', { target: { kind: 'agent-session', agentSessionId: saved.ownerAgentSessionId },
            operationId: report.operationId, messageId: report.replyMessageId, threadId: saved.threadId, correlationId: saved.sourceMessageId,
            replyTo: saved.sourceMessageId, text: body, expectedRun: owner.run }, context)
        }
        await core.call(saved.hostId, 'message.dispatch.report', { sourceMessageId: saved.sourceMessageId, replyMessageId: report.replyMessageId, kind: 'worker_done' }, context)
        const observed = await core.call(saved.hostId, 'message.dispatch.read', { hostId: saved.hostId, sourceMessageId: saved.sourceMessageId }, context)
        this.assertSource(saved, observed.source)
        const reply = observed.replies.find(message => message.envelope.messageId === report.replyMessageId)
        if (!reply) throw new AgentMuxError('The original report reply is unconfirmed. Keep the same report identity and evidence.', 'CONTROL_UNAVAILABLE')
        this.assertReply(saved, report, reply, body)
        await this.demands.submitDelegationReport(input.goalId, saved.operationId, report, authority.actor.id)
      } else {
        const collection = (input as GoalDelegationParamsMap['goal.collect']).collection
        const goal = await this.demands.get(input.goalId)
        if (authority.actor.kind === 'agent' && ![saved.ownerAgentSessionId, goal?.supervisorSessionId].includes(authority.actor.id))
          throw new AgentMuxError('Only the original responsibility owner or current Supervisor can collect this report.', 'CONTROL_PERMISSION_DENIED')
        const observed = await this.readDispatch(saved, context, authority, goal?.supervisorSessionId)
        this.assertSource(saved, observed.source)
        const reply = observed.replies.find(message => message.envelope.messageId === collection.replyMessageId)
        if (!reply)
          throw new AgentMuxError('The original worker report reply is unconfirmed. No result was accepted.', 'CONTROL_UNAVAILABLE')
        const report = saved.report ?? this.readReport(input.goalId, saved, reply)
        if (report.replyMessageId !== collection.replyMessageId) throw new AgentMuxError('Collection refers to another original report.', 'CONTROL_REQUEST_CONFLICT')
        this.assertReply(saved, report, reply, goalDelegationReportBody(input.goalId, saved.operationId, report))
        if (!saved.report) await this.demands.recoverDelegationReport(input.goalId, saved.operationId, report, authority.actor)
        await this.demands.collectDelegationReport(input.goalId, saved.operationId, collection, authority.actor)
      }
    }
    const goal = await this.demands.get(input.goalId)
    if (!goal) throw new AgentMuxError('The original Goal is unavailable. Original Sessions and input remain available.', 'CONTROL_UNAVAILABLE')
    const observations = method === 'goal.delegation.prepare' ? undefined
      : await Promise.all((goal.delegations ?? []).map(delegation => this.observeDelegation(input.goalId, delegation, context, authority, goal.supervisorSessionId)))
    return { goalId: goal.id, goalUpdatedAt: goal.updatedAt, delegations: goal.delegations ?? [],
      ...(observations ? { observations } : {}),
      ...(goal.grounding ? { grounding: goal.grounding } : {}), diskDurability: 'confirmed' }
  }

  private requireCore(): GoalDelegationCorePort {
    if (!this.core) throw new AgentMuxError('The original Core communication owner is unavailable. Frozen input and original Agents are retained.', 'CONTROL_UNAVAILABLE')
    return this.core
  }
  private assertSource = assertGoalDelegationSource
  private assertReply = assertGoalDelegationReply
  private readReport = readGoalDelegationWireReport
  private readDispatch(saved: DemandDelegation, context: AgentMuxRpcCallContext, authority?: GoalDelegationAuthority,
    supervisorSessionId?: string | null): Promise<AgentMuxRpcResult<'message.dispatch.read'>> {
    const core = this.requireCore()
    if (authority?.actor.kind === 'agent' && authority.actor.id === supervisorSessionId &&
      ![saved.ownerAgentSessionId, saved.workerAgentSessionId].includes(authority.actor.id)) {
      // The Goal owner has admitted the current Supervisor. Borrow the original Host's
      // trusted SDK reader; never impersonate a worker/user or widen Core participant reads.
      if (!core.readDispatch) throw new AgentMuxError('The original Host business report reader is unavailable. Current responsibility and original reports are kept.', 'CONTROL_UNAVAILABLE')
      return core.readDispatch(saved.hostId, saved.sourceMessageId)
    }
    return core.call(saved.hostId, 'message.dispatch.read', { hostId: saved.hostId, sourceMessageId: saved.sourceMessageId }, context)
  }
  async observeDelegation(goalId: string, saved: DemandDelegation, context: AgentMuxRpcCallContext, authority?: GoalDelegationAuthority, supervisorSessionId?: string | null): Promise<GoalDelegationObservation> {
    const observation: GoalDelegationObservation = { operationId: saved.operationId }, issues: string[] = []
    const core = this.core
    if (!core) return { ...observation, unknown: 'The original Core communication owner is unavailable. Original input, reports and Agents are retained.' }
    const [communication, worker] = await Promise.allSettled([
      this.readDispatch(saved, context, authority, supervisorSessionId),
      core.observeRun(saved.hostId, saved.workerRunId)
    ])
    if (communication.status === 'fulfilled') {
      try { this.assertSource(saved, communication.value.source); observation.communication = communication.value
        if (!saved.report) {
          const reports: DemandDelegationReportInput[] = []
          for (const reply of communication.value.replies) {
            // Only the explicit Goal wire contract may describe a business report. A
            // plain reply or dispatch event remains communication, never acceptance.
            let schema: unknown
            try { schema = JSON.parse(reply.envelope.body)?.schema } catch { continue }
            if (schema !== 'agentmux.goal-report.v1') continue
            try { reports.push(this.readReport(goalId, saved, reply)) }
            catch (error) { issues.push(error instanceof Error ? error.message : String(error)) }
          }
          if (reports.length === 1) observation.recoverableReport = reports[0]!
          else if (reports.length > 1) issues.push('Multiple original worker report replies require explicit reconciliation; no report was selected.')
        } }
      catch (error) { issues.push(error instanceof Error ? error.message : String(error)) }
    } else issues.push(communication.reason instanceof Error ? communication.reason.message : String(communication.reason))
    if (worker.status === 'fulfilled' && worker.value.runId === saved.workerRunId) observation.workerRun = worker.value
    else issues.push(worker.status === 'rejected' ? worker.reason instanceof Error ? worker.reason.message : String(worker.reason) : 'The observed worker Run differs from the original task.')
    if (this.readAttention) {
      try { const attention = await this.readAttention(goalId, saved); if (attention) observation.attention = attention }
      catch (error) { issues.push(error instanceof Error ? error.message : String(error)) }
    }
    if (issues.length) observation.unknown = issues.join(' ')
    return observation
  }
}
