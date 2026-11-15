import { goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { isDeepStrictEqual } from 'node:util'
import { prepareGoalDelegationMaterials } from './goal-delegation-materials.js'
import type { FileReadParams, FileReadResult } from '@agentmux/core/files'
import { AgentMuxError, sessionSemanticResumeSourceRuns } from '@agentmux/core'
import { assertGoalDelegationSource, assertGoalDelegationReply, readGoalDelegationWireReport, readGoalDelegationSource, goalDelegationReportBody, goalDelegationApplication, goalReportApplication } from '@agentmux/core/goal-delegation'
export { goalDelegationReportBody } from '@agentmux/core/goal-delegation'
import type { GoalDelegationAuthority, GoalDelegationMethod, GoalDelegationParamsMap,
  GoalDelegationResult, GoalDelegationResultMap, GoalActivePlanQuery, GoalActivePlanResult, GoalDelegationObservation, GoalDelegationsOwner } from '@agentmux/core/goal-delegation'
import type { AgentMuxRpcMethod, AgentMuxRpcParams, AgentMuxRpcResult, AgentMuxRun, AgentMuxRpcCallContext } from '@agentmux/core'
import { delegationWorkerHostId, validateDemandDelegationReport, type DemandDelegation, type DemandDelegationReportInput, type GoalDeliveryScope } from '@agentmux/demand/delegations'
import { hostGoalAddress, hostGoalPlan } from './goal-projection.js'
import { submitGoalSourceReport } from './goal-source-report.js'
import { assertPlanWorkRole, changeGoalPlanAssignment } from './goal-plan-assignment.js'
import { isGoalSupervisor } from './goal-supervisor-identity.js'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import type { DemandStore, Demand, DemandDispatch, GoalStartObservation } from '@agentmux/demand'
import { goalPlanClaimToken, type GoalPlanProposalReceipt } from '@agentmux/demand/goal-plan'
import { formatGoalTicketLink, hasOriginalGoalBinding, parseAmuxObjectLink } from '@agentmux/core/sharing'
import type { GoalRuntimePort } from './goal-runtime.js'
import type { GoalPatrolOwner } from './goal-patrol-owner.js'
import type { GoalResponsibilityOwner } from './goal-responsibility-owner.js'

export type GoalDelegationCoreMethod = Extract<AgentMuxRpcMethod,
  'message.read' | 'agent.send' | 'message.dispatch.open' | 'message.dispatch.read' | 'message.dispatch.report' | 'message.dispatch.sync'>
export interface GoalDelegationCorePort {
  call<M extends GoalDelegationCoreMethod>(hostId: string, method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>>
  readDispatch?(hostId: string, sourceMessageId: string): Promise<AgentMuxRpcResult<'message.dispatch.read'>>
  syncDispatch?(ownerHostId: string, sourceMessageId: string, workerHostId: string): Promise<AgentMuxRpcResult<'message.dispatch.sync'>>
  observeRun(hostId: string, runId: string): Promise<Pick<AgentMuxRun, 'runId' | 'state'>>
}
/** Original Demand owner and original Host clients; no private journal or second queue. */
export class GoalDelegationOwner implements GoalDelegationsOwner {
  constructor(private readonly demands: DemandStore,
    private readonly runtime: Pick<GoalRuntimePort, 'agentCreation'> & Partial<Pick<GoalRuntimePort, 'resolveGoalAgent' | 'locateGoalAgentHost'>>,
    private readonly readMaterials?: (input: FileReadParams) => Promise<FileReadResult>,
    private readonly core?: GoalDelegationCorePort,
    private readonly readAttention?: (goalId: string, delegation: DemandDelegation) => Promise<GoalDelegationObservation['attention']>,
    private readonly readStart?: (goal: Demand, start: DemandDispatch) => Promise<GoalStartObservation>,
    private readonly responsibility?: Pick<GoalResponsibilityOwner, 'observe' | 'progress'>,
    private readonly patrol?: Pick<GoalPatrolOwner, 'request' | 'continue' | 'report' | 'observe'>,
    private readonly planOwner?: () => Promise<{ runtimeId: string; namespace: string }>) {}

  async call<M extends GoalDelegationMethod>(method: M, request: GoalDelegationParamsMap[M],
    context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<GoalDelegationResultMap[M]> {
    context.signal?.throwIfAborted()
    if (method === 'goal.plan.active') return await this.readActivePlan(request as GoalActivePlanQuery, authority) as GoalDelegationResultMap[M]
    const input = request as GoalDelegationParamsMap[Exclude<GoalDelegationMethod, 'goal.plan.active'>]
    const planRequest = method === 'goal.plan' || method === 'goal.plan.assignment' || method === 'goal.plan.claim'
    const owner = planRequest || method === 'goal.plan.revise' || method === 'goal.plan.review' ? await this.planOwner?.().catch(() => undefined) : undefined
    if (planRequest) {
      const expected = (input as GoalDelegationParamsMap['goal.plan']).expectedOwner
      if (expected) {
        if (expected.runtimeId !== owner?.runtimeId || expected.namespace !== owner.namespace)
          throw new AgentMuxError('This request names another Goal owner. Read the plan at its original Runtime and store.', 'CONTROL_REQUEST_CONFLICT')
      }
      if (method === 'goal.plan.claim' && !owner)
        throw new AgentMuxError('The original Goal claim owner is unconfirmed. Keep the task and read the original plan.', 'CONTROL_UNAVAILABLE')
      if (method !== 'goal.plan') await changeGoalPlanAssignment(this.demands, this.runtime,
        input as GoalDelegationParamsMap['goal.plan.assignment' | 'goal.plan.claim'], context, authority, owner)
    }
    if (method === 'goal.report' && (input as GoalDelegationParamsMap['goal.report']).sourceMessageId !== undefined)
      return await submitGoalSourceReport(this.requireCore(), this.runtime, input as GoalDelegationParamsMap['goal.report'], context, authority) as GoalDelegationResultMap[M]
    if (method === 'goal.patrol' || method === 'goal.patrol.continue' || method === 'goal.patrol.report') {
      if (!this.patrol) throw new AgentMuxError('The original Goal patrol owner is unavailable; retain original requests and native input.', 'CONTROL_UNAVAILABLE')
      if (method === 'goal.patrol') {
        const p = input as GoalDelegationParamsMap['goal.patrol']; await this.patrol.request(p.goalId, p.operationId, context, authority)
      } else if (method === 'goal.patrol.continue') {
        const p = input as GoalDelegationParamsMap['goal.patrol.continue']; await this.patrol.continue(p.goalId, p.patrolOperationId, p.operationId, p.expectedRunId, context, authority)
      } else {
        const p = input as GoalDelegationParamsMap['goal.patrol.report']; await this.patrol.report(p.goalId, p.patrolOperationId, p.report, authority)
      }
    }
    if (method === 'goal.plan.revise') {
      const goal = await this.demands.get(input.goalId)
      if (!goal) throw new AgentMuxError('The original Goal is unavailable. Original Sessions and input remain available.', 'CONTROL_UNAVAILABLE')
      // People edit the plan freely; among Agents only the current Supervisor maintains it.
      if (!await isGoalSupervisor(goal, authority, this.runtime))
        throw new AgentMuxError('Only this Goal\'s current Supervisor or a person can revise its plan. Read goal plan and ask the Supervisor.', 'CONTROL_PERMISSION_DENIED')
      const revision = (input as GoalDelegationParamsMap['goal.plan.revise']).revision
      const saved = goal.plan?.history.find(entry => entry.operationId === revision.operationId)
      const proposals = saved?.proposals ?? await Promise.all((revision.proposals ?? []).map(async proposal => {
        const attempt = goal.delegations?.find(entry => entry.operationId === proposal.delegationOperationId)
        if (!attempt?.linkedAt) throw new AgentMuxError('The original Ticket proposal attempt is unconfirmed.', 'CONTROL_UNAVAILABLE')
        const { communication } = await this.readDispatch(attempt, context, authority, goal)
        this.assertSource(attempt, communication.source, goal.id)
        const reply = communication.replies.find(message => message.envelope.messageId === proposal.replyMessageId)
        const wire = reply?.envelope
        const runtimeId = reply ? (await this.deliveryScope(attempt, reply))?.authorRuntimeId : undefined
        if (!wire || !runtimeId || wire.replyTo !== attempt.sourceMessageId || wire.threadId !== attempt.threadId ||
            wire.senderSessionId !== attempt.workerAgentSessionId || wire.recipientSessionId !== attempt.ownerAgentSessionId ||
            wire.sender.kind !== 'agent-session' || wire.sender.agentSessionId !== attempt.workerAgentSessionId ||
            attempt.runtimeIdentity && attempt.runtimeIdentity.workerRuntimeId !== runtimeId)
          throw new AgentMuxError('The original Ticket proposal reply and authenticated author do not match its attempt.', 'CONTROL_REQUEST_CONFLICT')
        return { ...proposal, sourceMessageId: attempt.sourceMessageId, proposalOperationId: wire.operationId,
          author: { agentSessionId: attempt.workerAgentSessionId, runtimeId } } satisfies GoalPlanProposalReceipt
      }))
      await this.demands.revisePlan(input.goalId, revision,
        { ...authority.actor, ...(authority.hostId ? { hostId: authority.hostId } : {}), ...(authority.runtimeId ? { runtimeId: authority.runtimeId } : {}) }, proposals)
    }
    if (method === 'goal.plan.review') {
      // The store refuses the node's own executor; any other admitted Agent or person may review.
      await this.demands.reviewPlanNode(input.goalId, (input as GoalDelegationParamsMap['goal.plan.review']).review,
        { ...authority.actor, ...(authority.hostId ? { hostId: authority.hostId } : {}), ...(authority.runtimeId ? { runtimeId: authority.runtimeId } : {}) })
    }
    if (method === 'goal.progress') {
      if (!this.responsibility) throw new AgentMuxError('The original Goal responsibility owner is unavailable. Original work and native input remain available.', 'CONTROL_UNAVAILABLE')
      await this.responsibility.progress(input.goalId, (input as GoalDelegationParamsMap['goal.progress']).progress, context, authority)
    }
    if (method === 'goal.delegation.prepare' || method === 'goal.delegate' || method === 'goal.delegation.bind') {
      const request = input as GoalDelegationParamsMap['goal.delegation.prepare']
      let intent = request.intent
      if (authority.actor.kind !== 'agent' || authority.actor.id !== intent.ownerAgentSessionId ||
          authority.hostId !== intent.hostId) throw new AgentMuxError(
        'Only the exact authenticated Goal Supervisor can prepare this delegation at its original Host. The Agent remains available.', 'CONTROL_PERMISSION_DENIED')
      // A saved original intent remains readable after a Run/relationship changes. The
      // business owner compares the complete frozen intent before returning an idempotent read.
      const original = await this.demands.inspectDelegation(input.goalId, intent.operationId)
      if (original?.runtimeIdentity && authority.runtimeId !== original.runtimeIdentity.ownerRuntimeId) throw new AgentMuxError(
        'This saved delegation belongs to another original owner Runtime. Keep the original operation and source.', 'CONTROL_PERMISSION_DENIED')
      if (!original) {
        const goal = await this.demands.get(input.goalId)
        if (!goal || !await isGoalSupervisor(goal, authority, this.runtime)) throw new AgentMuxError(
          'A new delegation requires this Goal\'s exact current Supervisor Host and Session. Original messages and native input remain available.', 'CONTROL_PERMISSION_DENIED')
      }
      const existingSource = method === 'goal.delegation.bind'
        ? (await this.requireCore().call(intent.hostId, 'message.read', { hostId: intent.hostId, operationId: intent.operationId }, context)).message
        : null
      if (method === 'goal.delegation.bind') {
        if (!existingSource) throw new AgentMuxError('The original message is absent at this exact Host. Binding does not create or resend it.', 'CONTROL_UNAVAILABLE')
        this.assertSource(intent, existingSource, input.goalId)
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
          const guidance = goalRoleGuidance({ role: 'executor', goalId: input.goalId, agentSessionId: intent.workerAgentSessionId, runId: intent.workerRunId, source: { kind: 'goal-delegation', operationId: intent.operationId, sourceMessageId: intent.sourceMessageId, threadId: intent.threadId } })
          const coordination = JSON.stringify({ schema: 'agentmux.goal-delegation.v1', goalId: input.goalId,
            operationId: intent.operationId, sourceMessageId: intent.sourceMessageId, threadId: intent.threadId,
            ownerAgentSessionId: intent.ownerAgentSessionId, workerAgentSessionId: intent.workerAgentSessionId,
            hostId: intent.hostId, alignmentRevision: intent.alignmentRevision, criterionIds: intent.criterionIds, ...(intent.planNodeId ? { planNodeId: intent.planNodeId } : {}),
            next: 'Read the verified envelope.application for frozen criteria. Use goal report --input FILE with this sourceMessageId to return every delegated criterion with evidence, gap or unknown at your own Core; keep kind:report-submission distinct from owner collection. For a question/block, reply to the original source and record message dispatch report --kind question|escalation. A report is pending collection and human acceptance; exiting or worker_done does not complete the Goal.' })
          intent = { ...intent, requestText: request.intent.text, text: intent.text + '\n\n[AgentMux delegation]\n' + coordination + '\n\n' + guidance }
        }
      }
      if (!original && !existingSource) {
        const [owner, worker] = await Promise.all([
          this.runtime.agentCreation(intent.hostId, intent.ownerAgentSessionId),
          this.runtime.agentCreation(delegationWorkerHostId(intent), intent.workerAgentSessionId)
        ])
        if (owner.kind === 'retired-agent' || worker.kind === 'retired-agent') throw new AgentMuxError(
          'An original delegation participant is closed. Its Goal, request and history are retained; explicitly recover the Session before a new delegation.', 'AGENT_SESSION_RETIRED')
        if (owner.kind !== 'agent' || worker.kind !== 'agent') throw new AgentMuxError('An original delegation creation is unconfirmed. Keep its exact request and participants.', 'CONTROL_UNAVAILABLE')
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
        if (existing.message) {
          this.assertSource(saved, existing.message, input.goalId)
          if (saved.linkedAt === undefined) await this.assertTicketLink(input.goalId, saved, existing.message)
        }
        const remote = delegationWorkerHostId(saved) !== saved.hostId
        const reconcileRemote = remote && saved.linkedAt === undefined && method === 'goal.delegate'
        if (!existing.message || reconcileRemote) {
          if (method === 'goal.delegation.bind') throw new AgentMuxError('The original message became unavailable before binding. Keep its original source and body.', 'CONTROL_UNAVAILABLE')
          if (!existing.message && authority.runId !== saved.ownerRunId) throw new AgentMuxError('The saved task owner Run changed before its first submission. Read the original delegation and explicitly continue its responsibility.', 'CONTROL_REQUEST_CONFLICT')
          const submission = existing.message ? undefined : await this.demands.confirmDelegationSubmission(input.goalId, saved.operationId)
          const owner = submission && saved.planNodeId ? await this.planOwner?.().catch(() => undefined) : undefined
          const ticketLink = owner && submission && saved.planNodeId ? formatGoalTicketLink(input.goalId,
            hostGoalAddress({ id: input.goalId, ...(submission.creationOrigin ? { creationOrigin: submission.creationOrigin } : {}) }, owner), saved.planNodeId) : undefined
          const application = existing.message?.envelope.application ?? goalDelegationApplication(input.goalId, saved, ticketLink)
          // Only an explicit delegate retries this original outbox operation. A local save
          // cannot attest receipt; Core reconciles the exact target without renotifying it.
          const received = await core.call(saved.hostId, 'agent.send', { target: { kind: 'agent-session', agentSessionId: saved.workerAgentSessionId, hostId: delegationWorkerHostId(saved) },
            operationId: saved.operationId, messageId: saved.sourceMessageId, threadId: saved.threadId,
            correlationId: saved.sourceMessageId, text: saved.text, application, expectedRun: { runId: saved.workerRunId },
            ...(submission?.workerRuntimeId ? { expectedRecipientRuntimeId: submission.workerRuntimeId } : {}) }, context)
          this.assertSource(saved, received, input.goalId)
          if (remote && (!received.provenance || received.deliveryMode !== 'reference' || received.transport?.state !== 'received' ||
              received.transport.targetRuntimeId !== received.provenance.target.runtimeId || received.envelope.recipientRuntimeId !== received.provenance.target.runtimeId ||
              existing.message?.provenance && !isDeepStrictEqual(existing.message.provenance, received.provenance)))
            throw new AgentMuxError('The original worker receipt is unconfirmed. The signed outbox is retained; explicitly reconcile this same delegation after restoring its exact route or trust.', 'CONTROL_UNAVAILABLE')
        }
        await core.call(saved.hostId, 'message.dispatch.open', { sourceMessageId: saved.sourceMessageId }, context)
        const confirmBinding = remote && saved.linkedAt === undefined && method === 'goal.delegation.bind'
        const observed = confirmBinding
          ? await core.call(saved.hostId, 'message.dispatch.sync', { hostId: delegationWorkerHostId(saved), sourceMessageId: saved.sourceMessageId }, context)
          : await core.call(saved.hostId, 'message.dispatch.read', { hostId: saved.hostId, sourceMessageId: saved.sourceMessageId }, context)
        this.assertSource(saved, observed.source, input.goalId)
        if (saved.linkedAt === undefined && !existing.message) await this.assertTicketLink(input.goalId, saved, observed.source)
        if (confirmBinding) this.assertRemoteSourceReceipt(saved, observed)
        await this.demands.linkDelegation(input.goalId, saved.operationId, saved.sourceMessageId, authority.actor.id,
          observed.source.provenance && observed.source.envelope.senderRuntimeId && observed.source.envelope.recipientRuntimeId
            ? { ownerRuntimeId: observed.source.envelope.senderRuntimeId, workerRuntimeId: observed.source.envelope.recipientRuntimeId } : undefined)
      }
    }
    if (method === 'goal.report' || method === 'goal.collect') {
      const request = input as GoalDelegationParamsMap['goal.report'] | GoalDelegationParamsMap['goal.collect']
      const saved = await this.demands.inspectDelegation(input.goalId, request.operationId)
      if (!saved) throw new AgentMuxError('The original delegation is unavailable. Do not replace its identity.', 'CONTROL_UNAVAILABLE')
      const core = this.requireCore()
      if (method === 'goal.report') {
        const report = (input as GoalDelegationParamsMap['goal.report']).report
        let workerMatches = authority.actor.kind === 'agent' && this.participant(saved, authority, 'worker')
        if (workerMatches && authority.runId !== saved.workerRunId) {
          const worker = await this.runtime.agentCreation(delegationWorkerHostId(saved), saved.workerAgentSessionId)
          workerMatches = worker.kind === 'agent' && worker.run.runId === authority.runId && sessionSemanticResumeSourceRuns(worker).includes(saved.workerRunId)
        }
        if (!workerMatches)
          throw new AgentMuxError('Only the authenticated original worker can report this delegation.', 'CONTROL_PERMISSION_DENIED')
        validateDemandDelegationReport(saved, report)
        if (!saved.linkedAt) throw new AgentMuxError('The original dispatch association is not yet confirmed. The worker and its results are retained.', 'CONTROL_UNAVAILABLE')
        if (saved.report && goalDelegationReportBody(input.goalId, saved.operationId, saved.report) !== goalDelegationReportBody(input.goalId, saved.operationId, report))
          throw new AgentMuxError('The original worker report is frozen. Read it before continuing.', 'CONTROL_REQUEST_CONFLICT')
        const body = goalDelegationReportBody(input.goalId, saved.operationId, report)
        const existing = await core.call(delegationWorkerHostId(saved), 'message.read', { hostId: delegationWorkerHostId(saved), operationId: report.operationId }, context)
        if (existing.message) await this.assertReply(saved, report, existing.message, body)
        else {
          const owner = await this.runtime.agentCreation(saved.hostId, saved.ownerAgentSessionId)
          if (owner.kind === 'retired-agent') throw new AgentMuxError(
            'The original report recipient is closed. Keep the worker report and its original operation; explicitly recover the recipient before sending.', 'AGENT_SESSION_RETIRED')
          if (owner.kind !== 'agent') throw new AgentMuxError('The original report recipient creation is unconfirmed. Keep its exact report and operation.', 'CONTROL_UNAVAILABLE')
          if (!sessionSemanticResumeSourceRuns(owner).includes(saved.ownerRunId)) throw new AgentMuxError(
            'The original report recipient has no confirmed semantic recovery to its current Run. Inspect that Session recovery; the report, operation and healthy input are retained.', 'CONTROL_REQUEST_CONFLICT')
          await core.call(delegationWorkerHostId(saved), 'agent.send', { target: { kind: 'agent-session', agentSessionId: saved.ownerAgentSessionId, hostId: saved.hostId },
            operationId: report.operationId, messageId: report.replyMessageId, threadId: saved.threadId, correlationId: saved.sourceMessageId,
            replyTo: saved.sourceMessageId, text: body, application: goalReportApplication(input.goalId, saved.operationId, report), expectedRun: owner.run }, context)
        }
        await core.call(saved.hostId, 'message.dispatch.report', { sourceMessageId: saved.sourceMessageId, replyMessageId: report.replyMessageId, kind: 'worker_done' }, context)
        const observed = await core.call(saved.hostId, 'message.dispatch.read', { hostId: saved.hostId, sourceMessageId: saved.sourceMessageId }, context)
        this.assertSource(saved, observed.source, input.goalId)
        const reply = observed.replies.find(message => message.envelope.messageId === report.replyMessageId)
        if (!reply) throw new AgentMuxError('The original report reply is unconfirmed. Keep the same report identity and evidence.', 'CONTROL_UNAVAILABLE')
        await this.assertReply(saved, report, reply, body, observed.source)
        await this.demands.submitDelegationReport(input.goalId, saved.operationId, report, authority.actor.id,
          await this.deliveryScope(saved, reply, authority.runtimeId))
      } else {
        const collection = (input as GoalDelegationParamsMap['goal.collect']).collection
        const goal = await this.demands.get(input.goalId)
        const originalOwner = this.participant(saved, authority, 'owner')
        if (authority.actor.kind === 'agent' && !originalOwner && (!goal || !await isGoalSupervisor(goal, authority, this.runtime)))
          throw new AgentMuxError('Only the original responsibility owner or current Supervisor can collect this report.', 'CONTROL_PERMISSION_DENIED')
        const { communication: observed, syncIssue } = await this.readDispatch(saved, context, authority, goal)
        this.assertSource(saved, observed.source, input.goalId)
        const reply = observed.replies.find(message => message.envelope.messageId === collection.replyMessageId)
        if (!reply)
          throw new AgentMuxError(syncIssue ?? 'The original worker report reply is unconfirmed. No result was accepted.', 'CONTROL_UNAVAILABLE')
        const report = saved.report ?? await this.readReport(input.goalId, saved, reply, observed.source)
        if (report.replyMessageId !== collection.replyMessageId) throw new AgentMuxError('Collection refers to another original report.', 'CONTROL_REQUEST_CONFLICT')
        await this.assertReply(saved, report, reply, goalDelegationReportBody(input.goalId, saved.operationId, report), observed.source)
        if (!saved.report) await this.demands.recoverDelegationReport(input.goalId, saved.operationId, report, authority.actor,
          await this.deliveryScope(saved, reply))
        await this.demands.collectDelegationReport(input.goalId, saved.operationId, collection, authority.actor)
      }
    }
    const goal = await this.demands.get(input.goalId)
    if (!goal) throw new AgentMuxError('The original Goal is unavailable. Original Sessions and input remain available.', 'CONTROL_UNAVAILABLE')
    const quiet = method === 'goal.plan.assignment' || method === 'goal.plan.claim' || method === 'goal.delegation.prepare' || method === 'goal.plan' || method === 'goal.plan.revise' || method === 'goal.plan.review'
    const observations = quiet ? undefined
      : await Promise.all((goal.delegations ?? []).map(delegation => this.observeDelegation(input.goalId, delegation, context, authority, goal)))
    const startObservations = quiet || !this.readStart ? undefined
      : await Promise.all((goal.dispatches ?? []).filter(start => start.execution === 'finite').map(start => this.readStart!(goal, start)))
    const address = owner && goal.plan ? hostGoalAddress(goal, owner) : undefined
    const ticketLinks = address && goal.plan ? goal.plan.nodes.map(node => formatGoalTicketLink(goal.id, address, node.id)) : undefined
    const result: GoalDelegationResult = { ...(address && ticketLinks ? { address, ticketLinks } : {}), goalId: goal.id, goalUpdatedAt: goal.updatedAt, delegations: goal.delegations ?? [], ...hostGoalPlan(goal, owner),
      goalState: { status: goal.status, supervisorSessionId: goal.supervisorSessionId, ...(goal.alignment ? { alignment: goal.alignment } : {}) },
      ...(startObservations ? { dispatches: goal.dispatches ?? [], startObservations } : {}),
      ...(observations ? { observations } : {}),
      ...(goal.progressUpdates ? { progressUpdates: goal.progressUpdates } : {}),
      ...(goal.patrols ? { patrols: goal.patrols, ...(this.patrol ? { patrolObservations: await this.patrol.observe(goal) } : {}) } : {}),
      ...(goal.grounding ? { grounding: goal.grounding } : {}), diskDurability: 'confirmed' }
    if (this.responsibility && !quiet) result.responsibility = await this.responsibility.observe(goal, result)
    return result as GoalDelegationResultMap[M]
  }

  private assertRemoteSourceReceipt(saved: DemandDelegation, observed: AgentMuxRpcResult<'message.dispatch.sync'>): void {
    const receipt = observed.remoteSource, source = observed.source, proof = source.provenance
    if (!proof || !receipt || receipt.kind !== 'recipient-inbox' || receipt.diskDurability !== 'confirmed' || receipt.deliveryMode !== 'reference' ||
        receipt.runtimeId !== proof.target.runtimeId || receipt.runtimeId !== source.envelope.recipientRuntimeId ||
        receipt.keyFingerprint !== proof.targetKeyFingerprint || receipt.messageId !== saved.sourceMessageId || receipt.operationId !== saved.operationId ||
        receipt.intentDigest !== proof.intentDigest || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1)
      throw new AgentMuxError('The original worker inbox receipt differs from this exact source. No delegation link was confirmed; keep the source and inspect its exact target.', 'CONTROL_PROTOCOL_ERROR')
  }

  private requireCore(): GoalDelegationCorePort {
    if (!this.core) throw new AgentMuxError('The original Core communication owner is unavailable. Frozen input and original Agents are retained.', 'CONTROL_UNAVAILABLE')
    return this.core
  }
  private async deliveryScope(saved: DemandDelegation, reply: DurableAgentMuxMessage, authorRuntimeId?: string): Promise<GoalDeliveryScope | undefined> {
    if (!saved.planNodeId || !saved.predecessors) return undefined
    const owner = await this.planOwner?.().catch(() => undefined)
    if (!owner) return undefined
    const originalAuthor = reply.provenance?.source.runtimeId ?? authorRuntimeId ??
      (saved.hostId === delegationWorkerHostId(saved) ? owner.runtimeId : undefined)
    return originalAuthor ? { ownerRuntimeId: owner.runtimeId, namespace: owner.namespace, authorRuntimeId: originalAuthor } : undefined
  }

  private async readActivePlan(query: GoalActivePlanQuery, authority: GoalDelegationAuthority): Promise<GoalActivePlanResult> {
    const owner = await this.planOwner?.().catch(() => undefined)
    if (!owner) throw new AgentMuxError('The original Goal owner is unconfirmed. Existing work and its history are retained.', 'CONTROL_UNAVAILABLE')
    if (query.expectedOwner && (query.expectedOwner.runtimeId !== owner.runtimeId || query.expectedOwner.namespace !== owner.namespace))
      throw new AgentMuxError('This request names another original Goal owner.', 'CONTROL_REQUEST_CONFLICT')
    const claiming = query.view === 'claimable'
    if (claiming && (authority.actor.kind !== 'agent' || !authority.hostId || !authority.runtimeId))
      throw new AgentMuxError('Claimable work requires the original authenticated Agent, Host and Runtime.', 'CONTROL_PERMISSION_DENIED')
    const read = await this.demands.readActivePlans({
      ...(query.goalId === undefined ? {} : { goalId: query.goalId }),
      ...(authority.actor.kind === 'agent' ? { agentSessionId: authority.actor.id } : {}),
    })
    const goals: GoalActivePlanResult['goals'] = []
    for (const { role, goalId, goalUpdatedAt, nodes } of read) {
      try { assertPlanWorkRole(role, claiming, authority, this.runtime) }
      catch (error) {
        if (query.goalId !== undefined || !(error instanceof AgentMuxError) || error.code !== 'CONTROL_PERMISSION_DENIED') throw error
        continue
      }
      const active = nodes.flatMap(({ claim, ...node }) => claiming
        ? claim ? [{ ...node, claimToken: goalPlanClaimToken({ ...owner, goalId }, claim.openingOperationId, claim.basis) }] : []
        : [node])
      if (active.length) goals.push({ goalId, goalUpdatedAt, nodes: active })
    }
    return { owner, view: query.view, goals }
  }

  private async assertTicketLink(goalId: string, saved: DemandDelegation, message: DurableAgentMuxMessage): Promise<void> {
    if (!message.envelope.application) return
    const { ticketLink } = readGoalDelegationSource(message)
    if (!ticketLink) return
    const [goal, owner] = await Promise.all([this.demands.get(goalId), this.planOwner?.().catch(() => undefined)])
    const target = parseAmuxObjectLink(ticketLink)
    if (!goal || !owner || target.kind !== 'goal' || target.nodeId === undefined)
      throw new AgentMuxError('The original Ticket address is unconfirmed. Retain this source and its original body.', 'CONTROL_UNAVAILABLE')
    const address = hostGoalAddress(goal, owner)
    const ownerMatches = target.runtimeId === undefined ? hasOriginalGoalBinding(goalId, address)
      : target.runtimeId === address.runtimeId && target.namespace === address.namespace
    if (!ownerMatches || target.goalId !== goalId || target.nodeId !== saved.planNodeId)
      throw new AgentMuxError('The original Core source names another Goal owner or Ticket. Retain the original input.', 'CONTROL_REQUEST_CONFLICT')
  }

  private assertSource = assertGoalDelegationSource
  private async replyRuns(saved: DemandDelegation, reply: DurableAgentMuxMessage) {
    if (reply.provenance) return undefined
    const chain = async (hostId: string, agentSessionId: string) => {
      const session = await this.runtime.agentCreation(hostId, agentSessionId)
      return session.kind === 'agent' ? sessionSemanticResumeSourceRuns(session) : []
    }
    const [workerSourceRuns, ownerSourceRuns] = await Promise.all([
      reply.envelope.senderRunId === saved.workerRunId ? undefined : chain(delegationWorkerHostId(saved), saved.workerAgentSessionId),
      reply.envelope.recipientRunId === saved.ownerRunId ? undefined : chain(saved.hostId, saved.ownerAgentSessionId)
    ])
    return { ...(workerSourceRuns ? { workerSourceRuns } : {}), ...(ownerSourceRuns ? { ownerSourceRuns } : {}) }
  }
  private async assertReply(saved: DemandDelegation, report: DemandDelegationReportInput, reply: DurableAgentMuxMessage, body: string, source?: DurableAgentMuxMessage) {
    assertGoalDelegationReply(saved, report, reply, body, source, await this.replyRuns(saved, reply))
  }
  private async readReport(goalId: string, saved: DemandDelegation, reply: DurableAgentMuxMessage, source?: DurableAgentMuxMessage) {
    return readGoalDelegationWireReport(goalId, saved, reply, source, await this.replyRuns(saved, reply))
  }
  private participant(saved: DemandDelegation, authority: GoalDelegationAuthority | undefined, role: 'owner' | 'worker'): boolean {
    if (authority?.actor.kind !== 'agent' || authority.actor.id !== (role === 'owner' ? saved.ownerAgentSessionId : saved.workerAgentSessionId)) return false
    return saved.runtimeIdentity ? authority.runtimeId === (role === 'owner' ? saved.runtimeIdentity.ownerRuntimeId : saved.runtimeIdentity.workerRuntimeId)
      : authority.hostId === (role === 'owner' ? saved.hostId : delegationWorkerHostId(saved))
  }
  private async readDispatch(saved: DemandDelegation, context: AgentMuxRpcCallContext, authority?: GoalDelegationAuthority,
    goal?: Demand | null): Promise<{ communication: AgentMuxRpcResult<'message.dispatch.read'>; syncIssue?: string }> {
    const core = this.requireCore()
    const owner = this.participant(saved, authority, 'owner'), worker = this.participant(saved, authority, 'worker')
    const supervisor = authority?.actor.kind === 'agent' && !owner && !worker && goal ? await isGoalSupervisor(goal, authority, this.runtime) : false
    const trustedReader = !authority || authority.actor.kind !== 'agent' || supervisor
    let syncIssue: string | undefined
    if (delegationWorkerHostId(saved) !== saved.hostId) {
      try {
        const communication = trustedReader && core.syncDispatch
          ? await core.syncDispatch(saved.hostId, saved.sourceMessageId, delegationWorkerHostId(saved))
          : await core.call(saved.hostId, 'message.dispatch.sync', { sourceMessageId: saved.sourceMessageId, hostId: delegationWorkerHostId(saved) }, context)
        return { communication }
      } catch (error) { syncIssue = 'Reading the original signed worker replies is unconfirmed: ' + (error instanceof Error ? error.message : String(error)) }
    }
    if (supervisor) {
      // The Goal owner has admitted the current Supervisor. Borrow the original Host's
      // trusted SDK reader; never impersonate a worker/user or widen Core participant reads.
      if (!core.readDispatch) throw new AgentMuxError('The original Host business report reader is unavailable. Current responsibility and original reports are kept.', 'CONTROL_UNAVAILABLE')
      return { communication: await core.readDispatch(saved.hostId, saved.sourceMessageId), ...(syncIssue ? { syncIssue } : {}) }
    }
    return { communication: await core.call(saved.hostId, 'message.dispatch.read', { hostId: saved.hostId, sourceMessageId: saved.sourceMessageId }, context), ...(syncIssue ? { syncIssue } : {}) }
  }
  async observeDelegation(goalId: string, saved: DemandDelegation, context: AgentMuxRpcCallContext, authority?: GoalDelegationAuthority, goal?: Demand | null): Promise<GoalDelegationObservation> {
    const observation: GoalDelegationObservation = { operationId: saved.operationId }, issues: string[] = []
    const core = this.core
    if (!core) return { ...observation, unknown: 'The original Core communication owner is unavailable. Original input, reports and Agents are retained.' }
    const [communication, worker] = await Promise.allSettled([
      this.readDispatch(saved, context, authority, goal),
      core.observeRun(delegationWorkerHostId(saved), saved.workerRunId)
    ])
    if (communication.status === 'fulfilled') {
      const observed = communication.value.communication
      if (communication.value.syncIssue) issues.push(communication.value.syncIssue)
      try { this.assertSource(saved, observed.source, goalId); observation.communication = observed
        if (!saved.report) {
          const reports: DemandDelegationReportInput[] = []
          for (const reply of observed.replies) {
            // Only the explicit Goal wire contract may describe a business report. A
            // plain reply or dispatch event remains communication, never acceptance.
            let schema: unknown = reply.envelope.application?.schema
            if (schema === undefined) { try { schema = JSON.parse(reply.envelope.body)?.schema } catch { continue } }
            if (schema !== 'agentmux.goal-report.v1') continue
            try { reports.push(await this.readReport(goalId, saved, reply, observed.source)) }
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
