import { resolve } from 'node:path'
import { defineConfig, defaultExclude } from 'vitest/config'
import owning from '../../../vitest.config'
const root = resolve(import.meta.dirname, '../../..')
const inputOwner = 'packages/core/src/agent-session-continuity-input.ts'
const mutations: Record<string, { file?: string; before: string; after: string }> = {
  'launch-store-carrier': { file: 'apps/desktop/src/renderer/src/store.ts', before: 'if (resumeInputIntent) {', after: 'if (false) {' },
  'launch-live-receipt': { file: 'apps/desktop/src/renderer/src/store.ts', before: '...projectResumeInputReceipts({ ...state, ...next }, core.session.agentSessionId),', after: '' },
  'launch-concurrent-records': { file: 'packages/core/src/agent-session-store.ts', before: 'continuityOperations: { ...next.continuityOperations, ...previous.continuityOperations,', after: 'continuityOperations: { ...next.continuityOperations,' },
  'launch-pending-freeze': { file: 'packages/core/src/client.ts', before: 'if (saved && receipt.launchInput && !isDeepStrictEqual(saved.input, receipt.launchInput.input))', after: 'if (false)' },
  'launch-early-freeze': { file: 'packages/core/src/client.ts', before: 'if (!prior && input.input && current) receipt.launchInput = prepareContinuityLaunchInput', after: 'if (false) receipt.launchInput = prepareContinuityLaunchInput' },
  'postlaunch-original-claim': { file: 'packages/core/src/prompt-submission.ts', before: 'if (control?.onlyIfUnclaimed && original)', after: 'if (false)' },
  'postlaunch-known-unknown': { file: 'packages/core/src/client.ts', before: 'if (record) return this.postLaunchPromptConfirmed(record, text, message)', after: 'if (false) return this.postLaunchPromptConfirmed(record, text, message)' },
  'postlaunch-same-op': { file: 'packages/core/src/client.ts', before: "if (prior.launchInput?.delivery === 'post-launch' && prior.launchInput.state !== 'terminal-confirmed')", after: 'if (false)' },
  'postlaunch-lost-start': { file: 'packages/core/src/client.ts', before: "if (carried?.delivery === 'post-launch' && prepared.continuity) return await this.settleContinuityPostLaunchInput(restored, prepared.continuity.operationId)", after: '' },
  'launch-reconcile-history': { file: 'packages/core/src/client.ts', before: "if (carried?.delivery === 'launch' && carried.state === 'launch-carried')", after: 'if (false)' },
  'launch-mailbox-carrier': { file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', before: '...(entry.resumeInputReceipt ? { resumeInputReceipt: entry.resumeInputReceipt } : {}),', after: '' },
  'launch-history-key': { file: 'packages/core/src/client.ts', before: 'continuity?.launchInput?.input.submissionId ?? lifecycleOperationId', after: 'lifecycleOperationId' },
  'launch-rpc-inspect': { file: 'packages/core/src/rpc-native-codec.ts', before: 'original.terminalPromptSubmission?.submissionId ?? original.launch?.input.submissionId', after: 'original.terminalPromptSubmission?.submissionId' },
  'launch-carrier': { file: 'packages/core/src/client.ts', before: '...(receipt.launchInput ? { prompt: receipt.launchInput.input.prompt,', after: '...(false ? { prompt: receipt.launchInput!.input.prompt,' },
  'launch-atomic-receipt': { file: 'packages/core/src/client.ts', before: '        bindContinuityLaunchInput(next.continuity, next.run)', after: '        void next.continuity' },
  'launch-unknown-restart': { file: 'packages/core/src/client.ts', before: "if (prior?.kind === 'starting' || prior?.reason === 'operation-unconfirmed') {", after: 'if (false) {' },
  'launch-frozen-source': { file: 'packages/core/src/client.ts', before: 'if (prior && (!prior.launchInput || !isDeepStrictEqual(prior.launchInput.input, input.input)))', after: 'if (false)' },
  'launch-record': { file: 'packages/core/src/agent-session-store.ts', before: "if (launch?.delivery === 'launch' && launch.state === 'launch-carried' && launch.key) originals.push({", after: 'if (false) originals.push({' },
  'launch-reconcile-args': { file: 'packages/core/src/client.ts', before: 'if (launched && (!launched.launchPlan || launched.launchPlan.program !== run.program ||', after: 'if (false && (!launched!.launchPlan || launched!.launchPlan.program !== run.program ||' },
  'launch-post-original-key': { file: 'packages/core/src/client.ts', before: 'originalSubmissionId ?? `launch-prompt:${lifecycleOperationId}`', after: '`launch-prompt:${lifecycleOperationId}`' },
  'selected-body': { before: 'continuation: part(inputs.continuation)', after: "continuation: part('Changed continuation body')" },
  'optional-native-gate': { before: 'const evidence = provider.readPromptExecutionEvidence',
    after: "if (!provider.readPromptExecutionEvidence || !provider.verifyPromptExecutionTransport) throw new AgentMuxError('Required optional probes', 'CONTINUITY_INPUT_UNCONFIRMED')\n      const evidence = provider.readPromptExecutionEvidence" },
  'input-trigger': { file: 'packages/core/src/client.ts',
    before: "receipt.recoveryInputs = { reminder: receipt.trigger !== 'input' && admission?.kind === 'resume'",
    after: "receipt.recoveryInputs = { reminder: admission?.kind === 'resume'" },
  'unknown-replay': { before: "const phase = accepted ? 'accepted' : notApplied ? 'not-applied' : 'unknown'", after: `const phase = accepted ? 'accepted' : notApplied ? 'not-applied' : 'unknown'
    if (phase === 'unknown') await this.deps.submit({ agentSessionId: id, expectedRun: delivery.key.expectedRun, afterSubmissionId: null,
      operationId: delivery.key.submissionId, prompt: delivery.continuation.text, agentMuxNote: delivery.reminder.text }, {})` },
  'atomic-claim': { before: "if (value.phase !== 'waiting') throw new AgentMuxError", after: 'if (false) throw new AgentMuxError' },
  'frozen-receipt': { before: `if (!claim?.intent || !isDeepStrictEqual(claim.inputKey, delivery.key) || record.run.runId !== delivery.key.expectedRun.runId ||
      claim.intent.prompt !== composed.text || claim.intent.message?.userContent !== (delivery.continuation.text.trim() ? delivery.continuation.text : undefined) ||
      claim.intent.message?.systemContext !== composed.systemContext) {`, after: 'if (false) {' },
  'latest-pointer': { before: 'const operation = this.deps.read(id).continuityOperations?.[operationId], delivery = operation?.recoveryDelivery',
    after: 'const operation = this.deps.read(id).continuity, delivery = operation?.recoveryDelivery' },
  'handshake-credit': { before: '? handshake.inputByteRange.endByte : start', after: '? start : start' },
  'new-user-priority': { before: 'if (session.promptCompletionAdmission !== undefined) throw new AgentMuxError', after: 'if (false) throw new AgentMuxError' },
  'native-target': { before: '!isDeepStrictEqual(session.nativeHandle, operation.nativeTarget)', after: 'false' },
  'native-transport': { before: 'provider.verifyPromptExecutionTransport && !await', after: 'false && !await' },
  'observed-foreign-source': { before: "if (source?.run.runId === session.run.runId && source.state === 'changed' || observed &&\n      (observed.kind !== 'provider' || observed.providerId !== operation.nativeTarget.providerId || observed.sessionId !== operation.nativeTarget.sessionId)) {", after: 'if (false) {' },
  'observer-unknown-gate': { before: 'const phase = operation.recoveryDelivery?.phase',
    after: "if (source?.run.runId === session.run.runId && source.state !== 'changed') throw new AgentMuxError('Required source observation', 'CONTINUITY_INPUT_UNCONFIRMED')\n    const phase = operation.recoveryDelivery?.phase" },
  'native-idle': { before: "evidence.state === 'working'", after: 'false' },
  'dispose-observer': { before: 'this.controller.abort(); this.operations.clear();', after: 'this.operations.clear();' },
  'live-projection': { file: 'apps/desktop/src/renderer/src/lib/session-state.ts',
    before: '...(core.session.continuityOperations ? { continuityOperations: structuredClone(core.session.continuityOperations) } : {}),', after: '' },
  'persistent-notice': { file: 'apps/desktop/src/renderer/src/lib/session-service-notices.ts',
    before: 'if (delivery && delivery.key.expectedRun.runId === session.control.run.runId &&',
    after: 'if (false && delivery && delivery.key.expectedRun.runId === session.control.run.runId &&' }
}
const mutation = process.env.AGENTMUX_CONTINUITY_INPUT_MUTATION ? mutations[process.env.AGENTMUX_CONTINUITY_INPUT_MUTATION] : undefined
if (process.env.AGENTMUX_CONTINUITY_INPUT_MUTATION && !mutation) throw new Error('Unknown continuity input mutation')
export default defineConfig({ ...owning, root,
  plugins: mutation ? [{ name: 'loaded-continuity-input-mutation', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== resolve(root, mutation.file ?? inputOwner)) return
    if (code.split(mutation.before).length !== 2) throw new Error('The actual input owner mutation must match exactly once')
    return { code: code.replace(mutation.before, mutation.after), map: null }
  } }] : [],
  test: { ...owning.test, exclude: defaultExclude,
    include: ['apps/desktop/test/session-continuity-launch-mailbox.test.tsx', 'apps/desktop/test/session-continuity-launch-consumer.test.ts', 'packages/core/test/session-continuity-launch-input.test.ts', 'packages/core/test/session-continuity-input.test.ts', 'apps/desktop/test/session-continuity-notices.test.tsx', 'apps/desktop/test/session-continuity-live-projection.test.ts'], passWithNoTests: false, maxWorkers: 1 }
})
