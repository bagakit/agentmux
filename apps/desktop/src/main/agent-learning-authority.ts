import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, type AgentMuxRpcCallContext } from '@agentmux/core'
import { parseAgentLearningParams, type AgentLearningBinding, type AgentLearningMethod, type AgentLearningParamsMap,
  type AgentLearningPort, type AgentLearningResultMap } from '@agentmux/core/agent-learning'
import type { RuntimeController } from './runtime-controller.js'

const principal = () => ({ kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` })

/** Holds only the actual App action. Durable candidate, approval and input facts remain in the Host/Core. */
export class AgentLearningAuthority implements AgentLearningPort {
  private readonly confirmations = new Map<string, { binding: AgentLearningBinding; used: boolean }>()
  constructor(private readonly runtime: Pick<RuntimeController, 'callOriginalCore'>) {}

  /** The original trusted App main-frame IPC must be checked before entering this method. */
  async confirm(raw: unknown) {
    const input = parseAgentLearningParams('agent.learning.confirm', raw)
    if (input.hostId !== 'local') throw new AgentMuxError('This App confirmation supports its original local Host owner only. No source or target was remapped.', 'LEARNING_HOST_UNSUPPORTED')
    if (this.confirmations.has(input.confirmationId)) throw new AgentMuxError('This exact confirmation is already in progress. Inspect the original operation.', 'CONTROL_REQUEST_CONFLICT')
    const { operation } = await this.runtime.callOriginalCore('local', 'agent.learning.inspect', { hostId: 'local', operationId: input.operationId }, { transport: 'unix', principal: principal() })
    if (!operation?.candidate || operation.ownerRuntimeId !== input.ownerRuntimeId || operation.revision !== input.expectedRevision || createHash('sha256').update(operation.candidate.content).digest('hex') !== input.candidateDigest)
      throw new AgentMuxError('The original candidate changed before confirmation. Review its complete current content; the draft and Agents are kept.', 'LEARNING_REVISION_CONFLICT')
    const binding: AgentLearningBinding = { operationId: operation.operationId, ownerRuntimeId: operation.ownerRuntimeId, source: operation.source,
      candidateRevision: operation.revision, candidateDigest: createHash('sha256').update(operation.candidate.content).digest('hex'), target: input.target, executorId: input.executorId }
    if (this.confirmations.has(input.confirmationId)) throw new AgentMuxError('This original confirmation is already in progress. Inspect the original operation.', 'CONTROL_REQUEST_CONFLICT')
    const live = { binding, used: false }
    this.confirmations.set(input.confirmationId, live)
    try {
      return await this.runtime.callOriginalCore('local', 'agent.learning.confirm', input, { transport: 'unix', principal: principal() })
    } finally { if (this.confirmations.get(input.confirmationId) === live) this.confirmations.delete(input.confirmationId) }
  }

  async call<M extends AgentLearningMethod>(method: M, raw: AgentLearningParamsMap[M], context: AgentMuxRpcCallContext): Promise<AgentLearningResultMap[M]> {
    if (method !== 'agent.learning.confirmation') throw new AgentMuxError('Use the original Host learning owner. The Desktop only supplies its live native confirmation; existing Agents remain available.', 'CONTROL_UNAVAILABLE')
    const input = parseAgentLearningParams('agent.learning.confirmation', raw), live = this.confirmations.get(input.confirmationId)
    if (context.caller || context.transport !== 'unix' || !isDeepStrictEqual(context.principal, principal()) || !live || live.used || !isDeepStrictEqual(live.binding, input.binding))
      throw new AgentMuxError('No actual App action confirms this exact candidate, source and target. Ordinary text or transport parameters cannot approve learning.', 'CONTROL_PERMISSION_DENIED')
    live.used = true
    return { confirmationId: input.confirmationId, binding: structuredClone(live.binding) } as AgentLearningResultMap[M]
  }
}
