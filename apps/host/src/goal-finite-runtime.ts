import { AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS } from '@agentmux/core/control'
import { observeRead } from '@agentmux/core/observation-read'
import { inspectCoordinatorAgentReference } from '@agentmux/core/agent-open-reference'
import { AgentMuxError, connectHostedAgentMux, connectSpaceMember, observeSpaceSessionStates,
  type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext } from '@agentmux/core'
import { demandAgentReferenceKey, type DemandSpaceMemberReference } from '@agentmux/demand/relations'
import type { DemandQualifiedDispatchIntent } from '@agentmux/demand'
import { assertGoalSourceRelation, goalSourceRpc } from './goal-source-relations.js'
import type { GoalExecutionClient, GoalFiniteAccessInput, GoalFiniteInputPort, GoalFiniteInspectionInput, GoalFiniteInspectionPort } from './goal-runtime.js'

type Rpc = Awaited<ReturnType<typeof goalSourceRpc>>
/** Read one original Source member's Run. This observes related Space metadata,
 * never the observer's same-SID Session, provider history or terminal. */
async function creationRun(rpc: Rpc, reference: DemandSpaceMemberReference, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  let resolve!: (runId: string) => void, reject!: (error: unknown) => void, seen = false
  const observed = new Promise<string>((yes, no) => { resolve = yes; reject = no }); void observed.catch(() => {})
  let reader: Awaited<ReturnType<typeof observeSpaceSessionStates>> | undefined
  const close = async () => {
    const opened = reader; reader = undefined
    await opened?.dispose().catch(error => { console.warn('Closing this original Goal Source reader was unconfirmed; other readers and Agent controls remain retained.', error) })
  }
  const deadline = setTimeout(() => controller.abort(new AgentMuxError('The original Source current Run is not confirmed within the read budget. Keep its relation and current Agent.', 'GOAL_RELATION_SOURCE_UNCONFIRMED')), AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS)
  const cancelled = () => reject(controller.signal.reason ?? new AgentMuxError('The original Source read was cancelled.', 'CONTROL_CANCELLED'))
  controller.signal.addEventListener('abort', cancelled, { once: true })
  try {
    signal?.throwIfAborted()
    const opening = observeSpaceSessionStates(rpc, { reference: { runtimeId: reference.source.runtimeId, spaceId: reference.source.spaceId } }, {
      signal: controller.signal, onError: reject, onObservation: value => {
        if (value.type === 'membership-complete') {
          if (!seen) reject(new AgentMuxError('The original Source occurrence is not observed. Keep its relation and current Agent.', 'GOAL_RELATION_SOURCE_UNCONFIRMED'))
          return
        }
        if (value.type !== 'member' || value.member.runtimeId !== reference.execution.runtimeId || value.member.agentSessionId !== reference.execution.agentSessionId) return
        const occurrence = value.occurrences?.find(item => item.regionId === reference.source.regionId)
        if (value.reference.runtimeId !== reference.source.runtimeId || value.reference.spaceId !== reference.source.spaceId ||
            value.source.runtimeId !== reference.source.runtimeId || occurrence?.creationOperationId !== reference.source.admission.operationId) return
        seen = true
        if (value.state.status === 'pending') return
        if (value.state.status !== 'observed') { reject(new AgentMuxError('The original Source has no confirmed current member observation. Its original Agent remains retained.', 'GOAL_RELATION_SOURCE_UNCONFIRMED')); return }
        if (value.state.authority.runtimeId !== reference.execution.runtimeId || value.state.session.agentSessionId !== reference.execution.agentSessionId) {
          reject(new AgentMuxError('The Source Session observation belongs to another Runtime or member.', 'CONTROL_PROTOCOL_ERROR')); return
        }
        resolve(value.state.session.run.runId)
      }
    }).then(opened => {
      reader = opened
      if (controller.signal.aborted) void close()
      return opened
    })
    await observeRead(opening, controller.signal)
    return await observeRead(observed, controller.signal)
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelled)
    controller.abort()
    await close()
  }
}

/** One invocation borrows the original configured carriers. No access selector is
 * saved as authority and disposing this SDK consumer never disposes its transport. */
async function openGoalFiniteCarrier(options: { runtime(): AgentMuxHeadlessRuntime; clients(): readonly { hostId: string; client: GoalExecutionClient }[] },
  input: GoalFiniteAccessInput, context: AgentMuxRpcCallContext) {
  const reference = input.reference
  const source = await goalSourceRpc(options, input.access.source, reference.source.runtimeId, context)
  const fact = await assertGoalSourceRelation(source, reference, context.signal)
  let runId: string
  let client: Pick<Awaited<ReturnType<typeof connectHostedAgentMux>>, 'readAgentSession' | 'submitAgentPrompt' | 'inspectAgentInput' | 'inspectAgentPromptSubmission' | 'rejoinAgentInputWaiting' | 'dispose'>
  if (fact.kind === 'creation') {
    runId = input.originalRunId ?? await creationRun(source, reference, context.signal)
    client = await connectSpaceMember(source, { reference: { runtimeId: reference.source.runtimeId, spaceId: reference.source.spaceId }, regionId: reference.source.regionId,
      runtimeId: reference.execution.runtimeId, agentSessionId: reference.execution.agentSessionId, expectedRun: { runId }, expectedAdmission: reference.source.admission })
  } else {
    if (!input.access.coordinator) throw new AgentMuxError('This association needs independent current access to its original Coordinator. Source membership does not grant input access.', 'CONTROL_UNAVAILABLE')
    const coordinator = await goalSourceRpc(options, input.access.coordinator, reference.execution.runtimeId, context)
    const original = await inspectCoordinatorAgentReference(coordinator, fact.association.reference, fact.association.resource, context.signal ? { signal: context.signal } : {})
    if (original.state !== 'confirmed') throw new AgentMuxError(original.issue.message, original.issue.code)
    runId = input.originalRunId ?? original.run.runId
    client = await connectHostedAgentMux({ rpc: coordinator, connectOnDemand: true, expectedRuntimeId: reference.execution.runtimeId, agentSessionIds: [reference.execution.agentSessionId] })
  }
  return { client, runId }
}

export async function openGoalFiniteInput(options: Parameters<typeof openGoalFiniteCarrier>[0],
  input: GoalFiniteAccessInput, context: AgentMuxRpcCallContext): Promise<GoalFiniteInputPort> {
  const { client, runId } = await openGoalFiniteCarrier(options, input, context)
  return goalFiniteInputPort(client, input.reference, runId)
}

/** Check an existing frozen input using the explicitly selected current owner.
 * An independent Coordinator read does not assert current Source membership or
 * input eligibility, and a refusal never switches to another carrier. */
export async function openGoalFiniteInspection(options: Parameters<typeof openGoalFiniteInput>[0],
  input: GoalFiniteInspectionInput, context: AgentMuxRpcCallContext): Promise<GoalFiniteInspectionPort> {
  if (input.access.coordinator) {
    const rpc = await goalSourceRpc(options, input.access.coordinator, input.reference.execution.runtimeId, context)
    const client = await connectHostedAgentMux({ rpc, connectOnDemand: true, expectedRuntimeId: input.reference.execution.runtimeId, agentSessionIds: [input.reference.execution.agentSessionId] })
    return originalInputReader(client, input.reference, input.originalRunId)
  }
  const { client, runId } = await openGoalFiniteCarrier(options, input, context)
  return originalInputReader(client, input.reference, runId)
}

/** Bind the already qualified carrier to its one original member and Run. */
export function goalFiniteInputPort(client: Pick<Awaited<ReturnType<typeof connectHostedAgentMux>>, 'submitAgentPrompt' | 'inspectAgentInput' | 'inspectAgentPromptSubmission' | 'rejoinAgentInputWaiting' | 'dispose'>,
  reference: DemandSpaceMemberReference, runId: string): GoalFiniteInputPort {
  const assertTarget = (value: DemandQualifiedDispatchIntent) => assertOriginalTarget(reference, runId, value)
  return {
    ...originalInputReader(client, reference, runId),
    readCurrent: async () => ({ runId }),
    submit: async value => {
      assertTarget(value)
      const receipt = await client.submitAgentPrompt({ agentSessionId: reference.execution.agentSessionId, expectedRun: { runId }, operationId: value.operationId,
        admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: false, sourceChannel: 'api', prompt: value.prompt,
        ...(value.agentMuxNote === undefined ? {} : { agentMuxNote: value.agentMuxNote }) })
      if (!receipt || !('key' in receipt)) throw new AgentMuxError('The original controlled input receipt is unconfirmed. Keep this same Goal operation; no alternate input path was used.', 'CONTROL_UNAVAILABLE')
      return receipt
    },
    rejoinOriginal: async (value, ref) => {
      assertTarget(value)
      if (ref.key.kind !== 'prompt' || ref.key.agentSessionId !== reference.execution.agentSessionId || ref.key.expectedRun.runId !== runId ||
          ref.key.submissionId !== value.operationId || ref.key.attemptId !== undefined)
        throw new AgentMuxError('This waiting reference belongs to another original Goal input. Its target was not changed.', 'CONTROL_REQUEST_CONFLICT')
      return await client.rejoinAgentInputWaiting({ ref })
    }
  }
}

function assertOriginalTarget(reference: DemandSpaceMemberReference, runId: string, value: DemandQualifiedDispatchIntent) {
  if (demandAgentReferenceKey(value.target) !== demandAgentReferenceKey(reference) || value.runId !== runId)
    throw new AgentMuxError('This Goal input carrier belongs to another original Source member or Run.', 'CONTROL_REQUEST_CONFLICT')
}

function originalInputReader(client: Pick<Awaited<ReturnType<typeof connectHostedAgentMux>>, 'inspectAgentInput' | 'inspectAgentPromptSubmission' | 'dispose'>,
  reference: DemandSpaceMemberReference, runId: string): GoalFiniteInspectionPort {
  return {
    inspectOriginal: async value => {
      assertOriginalTarget(reference, runId, value)
      const key = { kind: 'prompt' as const, agentSessionId: reference.execution.agentSessionId, expectedRun: { runId }, submissionId: value.operationId }
      const input = await client.inspectAgentInput({ key })
      if (!input && await client.inspectAgentPromptSubmission(key)) throw new AgentMuxError('The original Core retains an input claim without a controlled waiting receipt. Keep this operation and inspect its original owner; no input was replayed.', 'CONTROL_UNAVAILABLE')
      return input
    },
    dispose: async () => { await client.dispose() }
  }
}
