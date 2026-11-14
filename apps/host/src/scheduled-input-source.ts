import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, agentPromptInputId, projectContinuousProgressInput, type ContinuousProgressLoop, type ContinuousProgressInputReference,
  type ContinuousProgressInputReading, type AgentPromptSubmissionRecord, type AgentFuturePromptIntent } from '@agentmux/core'
import { sameAutomaticInputSource } from '@agentmux/core/automatic-input-source'
import type { GoalExecutionClient } from './goal-runtime.js'

type Reference = Omit<ContinuousProgressInputReference, 'preparedAt'>
/** Definition provenance belongs to the original loop. An unpublished preparation
 * is not a selected occurrence, even if its immutable Core object already exists. */
export function scheduledDefinitionOperation(loop: ContinuousProgressLoop, intentId: string): string | null {
  const operations = new Set<string>()
  const base = loop.currentDefinition?.baseIntentId ?? loop.futureIntentId
  if (base === intentId && loop.creationOperationId) operations.add(loop.creationOperationId)
  for (const receipt of loop.guidanceAdoptions ?? []) if (receipt.publishedAt !== undefined && receipt.newDefinition.intentId === intentId) operations.add(receipt.newDefinition.operationId)
  return operations.size === 1 ? [...operations][0]! : null
}

/** Consistency checks on exact typed owner facts; no nearest-input or text inference. */
export function assertScheduledInputSource(loop: ContinuousProgressLoop, reference: Reference, record: AgentPromptSubmissionRecord | null, intent: AgentFuturePromptIntent | null): void {
  const key = reference.inputKey, admission = record?.admission, message = admission?.intent?.message
  if (key.agentSessionId !== loop.agentSessionId || !sameAutomaticInputSource(reference.managedSource, loop.managedSource) ||
      scheduledDefinitionOperation(loop, reference.futureIntent.intentId) !== reference.definitionOperationId ||
      !record || record.agentSessionId !== key.agentSessionId || !isDeepStrictEqual(record.run, key.expectedRun) ||
      !isDeepStrictEqual(admission?.inputKey, key) || admission?.submissionId !== agentPromptInputId(key) ||
      !isDeepStrictEqual(admission.futureIntent, reference.futureIntent) || !isDeepStrictEqual(admission.intent?.run, key.expectedRun) ||
      !intent || intent.operationId !== reference.definitionOperationId || !sameAutomaticInputSource(intent.continuitySource, reference.managedSource) ||
      !message || message.userContent !== intent.message.userContent || message.systemContext !== intent.message.systemContext) {
    throw new AgentMuxError('The exact original scheduled input, definition or source is unconfirmed. Its original operation and Agent remain retained.', 'SCHEDULE_INPUT_SOURCE_UNCONFIRMED')
  }
}

/** Only an original owner-held reference enters this reader, never a wire key.
 * It returns a minimal projection, preserving the private input API unchanged. */
export async function readOriginalScheduledInput(loop: ContinuousProgressLoop, client: GoalExecutionClient): Promise<ContinuousProgressInputReading | undefined> {
  const reference = loop.lastInputRef
  if (!reference) return undefined
  try {
    // Refuse a foreign pointer before asking a private archive for any contents.
    if (reference.inputKey.agentSessionId !== loop.agentSessionId || !sameAutomaticInputSource(reference.managedSource, loop.managedSource) ||
        scheduledDefinitionOperation(loop, reference.futureIntent.intentId) !== reference.definitionOperationId) return projectContinuousProgressInput(reference, null)
    const record = await client.inspectAgentPromptSubmission(reference.inputKey)
    const intent = await client.readAgentFuturePromptIntent(loop.agentSessionId, reference.futureIntent.intentId)
    assertScheduledInputSource(loop, reference, record, intent)
    return projectContinuousProgressInput(reference, record)
  } catch { return projectContinuousProgressInput(reference, null) }
}
