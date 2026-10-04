import { expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import { AgentMuxError, readAgentPromptPreparationWait } from '@agentmux/core'

// The real production Runtime/IPC input consumer. Its hosted SDK boundary is a private
// controlled receiver: it records the exact request and never controls a user Run.
it('forwards the original retry fence through Desktop Runtime and retains the typed reason across IPC', async () => {
  const wait = { reason: 'context-compaction', retrySafe: true, agentSessionId: 'original-session', runId: 'original-run',
    operationId: 'original-operation', inputByte: 17, nativeSourceId: 'original-native-source' }
  const refusal = new AgentMuxError('Agent is compacting; retry shortly.', 'AGENT_PROMPT_PREPARATION_FAILED',
    JSON.stringify({ preparationWait: wait }), { disposition: 'not_applied', confirmedInputBytes: 0 })
  const submit = vi.fn().mockRejectedValue(refusal)
  const runtime = Object.create(RuntimeController.prototype) as RuntimeController
  Object.assign(runtime, { trackHostLifecycleOperation: (_host: string, call: () => Promise<void>) => call(),
    connectedClient: async () => ({ statusAgent: async () => ({ run: { runId: 'original-run', state: 'running' } }), submitAgentPrompt: submit }) })
  const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: 'original-session', run: { runId: 'original-run' } }
  const condition = { expectedRun: control.run, afterSubmissionId: 'original-predecessor' }
  const result = await sessionInputWriteResult(() => runtime.submitPrompt(control, 'Original body', 'original-operation', condition,
    undefined, { allowUncertainTurn: true, execution: 'immediate', preparationRetry: { inputByte: 17, nativeSourceId: 'original-native-source' } }, true))
  expect(submit).toHaveBeenCalledExactlyOnceWith({ agentSessionId: control.agentSessionId, ...condition, operationId: 'original-operation',
    prompt: 'Original body', sourceChannel: 'message-tool', allowUncertainTurn: true, execution: 'immediate', authorHuman: true,
    preparationRetry: { inputByte: 17, nativeSourceId: 'original-native-source' } })
  let observed: unknown
  try { unwrapSessionInputWriteResult(structuredClone(result)) } catch (error) { observed = error }
  expect(readAgentPromptPreparationWait(observed)).toEqual(wait)
})
