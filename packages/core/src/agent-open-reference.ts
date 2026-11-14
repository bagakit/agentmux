import { connectHostedAgentMux } from './hosted-client.js'
import { observeRead } from './observation-read.js'
import { AgentMuxError } from './errors.js'
import { parseAgentAssociationResource, parseCoordinatorAgentReference, type AgentAssociationResource, type CoordinatorAgentReference } from './agent-open-contract.js'
import type { AgentExecutionAssociationWitness } from './agent-execution-contract.js'
import type { AgentMuxRpcClient } from './public-rpc-client.js'
import type { AgentMuxRunRef } from './types.js'

export type CoordinatorAgentReferenceObservation = {
  state: 'confirmed'
  reference: CoordinatorAgentReference
  witness: Extract<AgentExecutionAssociationWitness, { state: 'confirmed' }>
  /** A read from the original Agent registry, not a claim that its process is running. */
  run: AgentMuxRunRef
} | {
  state: 'unconfirmed'
  reference: CoordinatorAgentReference
  witness?: AgentExecutionAssociationWitness
  issue: { code: string; message: string }
}

/** Qualify A's own reference using that one original authenticated SDK carrier.
 * B still independently owns its Workspace/Space/Region association. No reverse
 * carrier, borrowed actor, general Host stream, creation or input is introduced. */
export async function inspectCoordinatorAgentReference(rpc: AgentMuxRpcClient, rawReference: CoordinatorAgentReference,
  rawResource: AgentAssociationResource, options: { signal?: AbortSignal } = {}): Promise<CoordinatorAgentReferenceObservation> {
  const reference = parseCoordinatorAgentReference(rawReference), resource = parseAgentAssociationResource(rawResource)
  const client = await connectHostedAgentMux({ rpc, expectedRuntimeId: reference.runtimeId, connectOnDemand: true, agentSessionIds: [reference.binding.agentSessionId] })
  let witness: AgentExecutionAssociationWitness | undefined
  const unknown = (code: string, message: string): CoordinatorAgentReferenceObservation => ({ state: 'unconfirmed', reference,
    ...(witness ? { witness } : {}), issue: { code, message } })
  try {
    const owner = await client.readRuntimeOwnerIdentity(options)
    const original = await rpc.call('agent.execution.binding', { bindingId: reference.binding.bindingId, view: 'association' }, {
      ...(options.signal ? { signal: options.signal } : {}), runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    witness = original?.association
    if (!witness || witness.state !== 'confirmed') return unknown('AGENT_ASSOCIATION_WITNESS_UNCONFIRMED', 'The original Coordinator has no confirmed frozen Runtime/resource witness. Keep its original reference.')
    if (witness.reference.bindingId !== reference.binding.bindingId || witness.reference.agentSessionId !== reference.binding.agentSessionId ||
        witness.reference.createOperationId !== reference.binding.createOperationId || witness.agentRuntimeId !== reference.runtimeId ||
        witness.resourceRuntimeId !== resource.runtimeId || witness.resourceWorkspacePath !== resource.workspacePath) return unknown(
      'AGENT_ASSOCIATION_TARGET_MISMATCH', 'The original Coordinator intent names another Runtime, creation or project resource. No Session was substituted.')
    const session = await observeRead(client.inspectAgentCreation(reference.binding.agentSessionId), options.signal)
    if (session.kind !== 'agent' || session.agentSessionId !== reference.binding.agentSessionId ||
        session.creation?.createOperationId !== reference.binding.createOperationId || session.toolExecution?.bindingId !== reference.binding.bindingId ||
        session.toolExecution.resourceRuntimeId !== resource.runtimeId || session.toolExecution.workspacePath !== resource.workspacePath) return unknown(
      'AGENT_ASSOCIATION_CREATION_UNCONFIRMED', 'The original Agent registry does not confirm this creation and resource binding. Its reference and existing work remain available.')
    return { state: 'confirmed', reference, witness, run: structuredClone(session.run) }
  } catch (error) {
    return unknown(error instanceof AgentMuxError ? error.code : 'AGENT_ASSOCIATION_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  } finally { await client.dispose() }
}
