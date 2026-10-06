import { isDeepStrictEqual } from 'node:util'
import { prepareGoalDelegationMaterials } from './goal-delegation-materials.js'
import type { FileReadParams, FileReadResult } from '@agentmux/core/files'
import { AgentMuxError } from '@agentmux/core'
import type { GoalDelegationAuthority, GoalDelegationMethod, GoalDelegationParamsMap,
  GoalDelegationResult, GoalDelegationsOwner } from '@agentmux/core/goal-delegation'
import type { AgentMuxRpcCallContext } from '@agentmux/core'
import type { DemandStore } from '@agentmux/demand'
import type { RuntimeController } from './runtime-controller.js'

/** Original Demand owner and original Host clients; no private journal or second queue. */
export class GoalDelegationOwner implements GoalDelegationsOwner {
  constructor(private readonly demands: DemandStore,
    private readonly runtime: Pick<RuntimeController, 'agentCreation'>,
    private readonly readMaterials?: (input: FileReadParams) => Promise<FileReadResult>) {}

  async call<M extends GoalDelegationMethod>(method: M, input: GoalDelegationParamsMap[M],
    context: AgentMuxRpcCallContext, authority: GoalDelegationAuthority): Promise<GoalDelegationResult> {
    context.signal?.throwIfAborted()
    if (method === 'goal.delegation.prepare') {
      const request = input as GoalDelegationParamsMap['goal.delegation.prepare']
      let intent = request.intent
      if (authority.actor.kind !== 'agent' || authority.actor.id !== intent.ownerAgentSessionId ||
          authority.hostId !== intent.hostId) throw new AgentMuxError(
        'Only the exact authenticated Goal Supervisor can prepare this delegation at its original Host. The Agent remains available.', 'CONTROL_PERMISSION_DENIED')
      // A saved original intent remains readable after a Run/relationship changes. The
      // business owner compares the complete frozen intent before returning an idempotent read.
      const original = await this.demands.inspectDelegation(input.goalId, intent.operationId)
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
      if (!original) {
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
    }
    const goal = await this.demands.get(input.goalId)
    if (!goal) throw new AgentMuxError('The original Goal is unavailable. Original Sessions and input remain available.', 'CONTROL_UNAVAILABLE')
    return { goalId: goal.id, delegations: goal.delegations ?? [],
      ...(goal.grounding ? { grounding: goal.grounding } : {}), diskDurability: 'confirmed' }
  }
}
