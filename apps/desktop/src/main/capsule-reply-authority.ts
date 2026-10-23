import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, type CapsuleInputPort, type CapsuleInputRequest, type CapsuleInputResult,
  type AgentInputSubmissionReceipt } from '@agentmux/core'
import { parseCapsuleRpcParams, type CapsuleInteraction, type CapsuleParamsMap, type CapsulePort,
  type CapsulePreparedReply, type CapsuleInputObservation, type CapsuleJson } from '@agentmux/core/capsule'
import type { RuntimeController } from './runtime-controller.js'

type Reply = CapsuleParamsMap['capsule.interaction.reply']
type Confirmation = { params: Reply; original: CapsuleInteraction; runId: string;
  retainedInput?: { inputOperationId: string; expectedRun: { runId: string } };
  prepared?: CapsulePreparedReply; dispatched: boolean }
const principal = () => ({ kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` })

/** Owns only this live native confirmation. Durable answer/input facts stay with Capsule and Core. */
export class CapsuleReplyAuthority implements CapsuleInputPort {
  private readonly confirmations = new Map<string, Confirmation>()
  constructor(private readonly capsules: CapsulePort, private readonly runtime: Pick<RuntimeController,
    'observeGoalAgent' | 'submitPrompt' | 'callOriginalCore'>) {}

  /** The caller must have checked the original App main-frame sender before invoking this method. */
  async confirm(value: unknown) {
    let enteredOwner = false
    try {
      const params = parseCapsuleRpcParams('capsule.interaction.reply', value)
      const assertNotInProgress = () => {
        if (this.confirmations.has(params.operationId)) throw new AgentMuxError('This exact confirmation is already in progress. Inspect the original operation.',
          'CONTROL_REQUEST_CONFLICT', undefined, { disposition: 'unknown', confirmedInputBytes: null })
      }
      assertNotInProgress()
      const { interaction } = await this.capsules.call('capsule.interaction.inspect', { capsuleId: params.capsuleId, interactionId: params.interactionId })
      if (!interaction.target) throw new AgentMuxError('The original page request has no confirmed recipient. Keep the request and ask its producer to bind an exact Agent Session.', 'CAPSULE_TARGET_REQUIRED')
      const retainedReply = interaction.reply?.operationId === params.operationId && interaction.status === 'answered' &&
        interaction.answer === params.answer && interaction.revision === params.expectedRevision + 1
      if (retainedReply && interaction.reply?.phase !== 'prepared') {
        enteredOwner = true
        return await this.capsules.call('capsule.interaction.reply', params)
      }
      if (interaction.revision !== params.expectedRevision && !retainedReply) throw new AgentMuxError('The original request changed before confirmation. Read its current question and draft before submitting.', 'CAPSULE_REVISION_CONFLICT')
      const current = await this.runtime.observeGoalAgent(interaction.target.hostId, interaction.target.agentSessionId)
      if (current.session.agentSessionId !== interaction.target.agentSessionId || current.run.state !== 'running')
        throw new AgentMuxError('The exact recipient Run is not currently running. The original answer and request are retained; resume that Session explicitly.', 'SESSION_NOT_RUNNING')
      const retainedInput = retainedReply ? interaction.reply!.delivery : undefined
      if (retainedInput && current.run.runId !== retainedInput.expectedRun.runId)
        throw new AgentMuxError('The saved answer belongs to another Run. Inspect its original input; this confirmation cannot retarget it.', 'CAPSULE_RUN_CONFLICT')
      // Inspection may await; a second native confirmation cannot replace the first binding.
      assertNotInProgress()
      const binding: Confirmation = { params, original: interaction, runId: current.run.runId, dispatched: false,
        ...(retainedInput ? { retainedInput: { inputOperationId: retainedInput.inputOperationId, expectedRun: { ...retainedInput.expectedRun } } } : {}) }
      this.confirmations.set(params.operationId, binding)
      enteredOwner = true
      try { return await this.capsules.call('capsule.interaction.reply', params) }
      finally { if (this.confirmations.get(params.operationId) === binding) this.confirmations.delete(params.operationId) }
    } catch (error) {
      if (enteredOwner || error instanceof AgentMuxError && error.controlFailure) throw error
      const failure = error as { message?: string; code?: string; detail?: string }
      throw new AgentMuxError(failure?.message ?? 'This confirmation could not be prepared. The answer is retained.',
        failure?.code ?? 'CONTROL_UNAVAILABLE', failure?.detail, { disposition: 'not_applied', confirmedInputBytes: 0 })
    }
  }

  async call(input: CapsuleInputRequest): Promise<CapsuleInputResult> {
    if (input.phase === 'inspect') return { phase: 'inspect', observation: await this.inspect(input.prepared) }
    if (input.phase === 'prepare') {
      const { request } = input
      const confirmation = this.confirmations.get(request.operationId)
      if (!confirmation || confirmation.dispatched || confirmation.retainedInput || request.answer !== confirmation.params.answer ||
        confirmation.prepared && confirmation.prepared.inputOperationId !== request.inputOperationId ||
        request.interaction.capsuleId !== confirmation.params.capsuleId || request.interaction.interactionId !== confirmation.params.interactionId ||
        request.interaction.question !== confirmation.original.question || !isDeepStrictEqual(request.interaction.target, confirmation.original.target) ||
        request.interaction.revision !== confirmation.original.revision)
        throw new AgentMuxError('No current App confirmation matches this exact page question, answer and target. The original request is retained.', 'CONTROL_PERMISSION_DENIED')
      const { operation } = await this.capsules.call('capsule.operation.inspect', { operationId: request.operationId })
      if (this.confirmations.get(request.operationId) !== confirmation || confirmation.dispatched || !operation ||
        operation.operationId !== request.operationId || operation.capsuleId !== request.interaction.capsuleId ||
        operation.method !== 'capsule.interaction.reply' || operation.status !== 'pending' || operation.inputOperationId !== request.inputOperationId)
        throw new AgentMuxError('The original Capsule owner has not reserved this exact input. No human preparation was granted.', 'CONTROL_PERMISSION_DENIED')
      const prepared: CapsulePreparedReply = { version: 1, operationId: request.operationId, capsuleId: confirmation.params.capsuleId,
        interactionId: confirmation.params.interactionId, inputOperationId: request.inputOperationId,
        target: { ...confirmation.original.target! }, expectedRun: { runId: confirmation.runId }, principal: principal(),
        // Page content remains explicitly attributed data in the person's confirmed answer.
        prompt: JSON.stringify({ source: 'capsule-response', capsuleId: confirmation.params.capsuleId,
          interactionId: confirmation.params.interactionId, question: confirmation.original.question, answer: request.answer }) }
      confirmation.prepared = prepared
      return { phase: 'prepare', prepared }
    }
    const prepared = input.prepared, confirmation = this.confirmations.get(prepared.operationId)
    if (!confirmation || prepared.capsuleId !== confirmation.params.capsuleId || prepared.interactionId !== confirmation.params.interactionId ||
      !isDeepStrictEqual(prepared.target, confirmation.original.target) || prepared.expectedRun.runId !== confirmation.runId ||
      !isDeepStrictEqual(prepared.principal, principal()) || prepared.prompt !== JSON.stringify({ source: 'capsule-response',
        capsuleId: confirmation.params.capsuleId, interactionId: confirmation.params.interactionId,
        question: confirmation.original.question, answer: confirmation.params.answer }) ||
      (confirmation.retainedInput ? prepared.inputOperationId !== confirmation.retainedInput.inputOperationId ||
        !isDeepStrictEqual(prepared.expectedRun, confirmation.retainedInput.expectedRun)
        : !confirmation.prepared || !isDeepStrictEqual(confirmation.prepared, prepared)))
      throw new AgentMuxError('The original human confirmation or recipient Run is no longer current. No input was retargeted.', 'CONTROL_PERMISSION_DENIED')
    if (confirmation.dispatched) return { phase: 'submit', observation: await this.inspect(prepared) ?? this.unknown(prepared) }
    const { interaction } = await this.capsules.call('capsule.interaction.inspect', { capsuleId: prepared.capsuleId, interactionId: prepared.interactionId })
    if (this.confirmations.get(prepared.operationId) !== confirmation || interaction.status !== 'answered' ||
      interaction.answer !== confirmation.params.answer || interaction.question !== confirmation.original.question ||
      !isDeepStrictEqual(interaction.target, prepared.target) || interaction.reply?.operationId !== prepared.operationId ||
      interaction.reply.phase !== 'dispatch-started' || interaction.reply.delivery.inputOperationId !== prepared.inputOperationId ||
      !isDeepStrictEqual(interaction.reply.delivery.expectedRun, prepared.expectedRun))
      throw new AgentMuxError('The original Capsule answer and dispatch boundary are not durably confirmed for this exact input. No Core input was submitted.', 'CONTROL_PERMISSION_DENIED')
    if (confirmation.dispatched) return { phase: 'submit', observation: await this.inspect(prepared) ?? this.unknown(prepared) }
    confirmation.prepared = prepared
    confirmation.dispatched = true
    const receipt = await this.runtime.submitPrompt({ kind: 'agent', hostId: prepared.target.hostId,
      agentSessionId: prepared.target.agentSessionId, run: prepared.expectedRun }, prepared.prompt, prepared.inputOperationId,
      { expectedRun: prepared.expectedRun, admissionIntent: { kind: 'manual-actor' } }, undefined,
      { execution: 'immediate' }, true, undefined, 'question-reply')
    return { phase: 'submit', observation: receipt ? this.observation(prepared, receipt) : await this.inspect(prepared) ?? this.unknown(prepared) }
  }
  private unknown(prepared: CapsulePreparedReply): CapsuleInputObservation {
    return { status: 'unknown', inputOperationId: prepared.inputOperationId, expectedRun: prepared.expectedRun,
      reason: 'The original Core input has no confirmed receipt. Inspect this same operation; do not resubmit.' }
  }
  private observation(prepared: CapsulePreparedReply, receipt: AgentInputSubmissionReceipt): CapsuleInputObservation {
    if (receipt.key.kind !== 'prompt' || receipt.key.agentSessionId !== prepared.target.agentSessionId ||
      receipt.key.expectedRun.runId !== prepared.expectedRun.runId || receipt.key.submissionId !== prepared.inputOperationId)
      throw new AgentMuxError('The original Core input receipt belongs to another intent.', 'CONTROL_PROTOCOL_ERROR')
    return { status: receipt.status === 'unknown' ? 'unknown' : 'submitted', inputOperationId: prepared.inputOperationId,
      expectedRun: prepared.expectedRun, inputStatus: receipt.status, receipt: JSON.parse(JSON.stringify(receipt)) as CapsuleJson }
  }
  private async inspect(prepared: CapsulePreparedReply): Promise<CapsuleInputObservation | null> {
    const result = await this.runtime.callOriginalCore(prepared.target.hostId, 'agent.input.inspect', {
      key: { kind: 'prompt', agentSessionId: prepared.target.agentSessionId, expectedRun: prepared.expectedRun, submissionId: prepared.inputOperationId }
    }, { transport: 'unix', principal: principal() })
    return result.input ? this.observation(prepared, result.input) : null
  }
}
