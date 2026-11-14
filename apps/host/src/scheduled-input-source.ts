import { AgentMuxError, matchesScheduledInputSource, projectContinuousProgressInput, type ContinuousProgressLoop, type ContinuousProgressInputReference,
  type ContinuousProgressInputReading, type AgentPromptSubmissionRecord, type AgentFuturePromptIntent, type ScheduleHistoryQuery, type ScheduleHistoryPage } from '@agentmux/core'
import { sameAutomaticInputSource } from '@agentmux/core/automatic-input-source'
import type { GoalExecutionClient } from './goal-runtime.js'

type Reference = Omit<ContinuousProgressInputReference, 'preparedAt'>
/** Definition provenance belongs to the original loop. An unpublished preparation
 * is not a selected occurrence, even if its immutable Core object already exists. */
function* publishedScheduleDefinitions(loop: ContinuousProgressLoop) {
  const base = loop.currentDefinition?.baseIntentId ?? loop.futureIntentId
  if (base && loop.creationOperationId) yield { intentId: base, operationId: loop.creationOperationId }
  for (const receipt of loop.guidanceAdoptions ?? [])
    if (receipt.publishedAt !== undefined) yield receipt.newDefinition
}
export function scheduledDefinitionOperation(loop: ContinuousProgressLoop, intentId: string): string | null {
  let original: string | null = null
  for (const definition of publishedScheduleDefinitions(loop)) {
    if (definition.intentId !== intentId) continue
    if (original !== null && original !== definition.operationId) return null
    original = definition.operationId
  }
  return original
}

/** Consistency checks on exact typed owner facts; no nearest-input or text inference. */
export function assertScheduledInputSource(loop: ContinuousProgressLoop, reference: Reference, record: AgentPromptSubmissionRecord | null, intent: AgentFuturePromptIntent | null): void {
  const key = reference.inputKey
  if (key.agentSessionId !== loop.agentSessionId || !sameAutomaticInputSource(reference.managedSource, loop.managedSource) ||
      scheduledDefinitionOperation(loop, reference.futureIntent.intentId) !== reference.definitionOperationId ||
      !matchesScheduledInputSource(reference, record, intent)) {
    throw new AgentMuxError('The exact original scheduled input, definition or source is unconfirmed. Its original operation and Agent remain retained.', 'SCHEDULE_INPUT_SOURCE_UNCONFIRMED')
  }
}

export async function readOriginalScheduledHistory(loop: ContinuousProgressLoop, query: ScheduleHistoryQuery, client: GoalExecutionClient, signal?: AbortSignal): Promise<Pick<ScheduleHistoryPage, 'coverage' | 'entries' | 'nextCursor'>> {
  const published = new Map<string, string | null>()
  for (const { intentId, operationId } of publishedScheduleDefinitions(loop)) {
    const current = published.get(intentId)
    published.set(intentId, current === undefined || current === operationId ? operationId : null)
  }
  const definitions = [...published].flatMap(([intentId, operationId]) => operationId === null ? [] : [{ intentId, operationId }])
  if (!definitions.length) return { coverage: 'unconfirmed' as const, entries: [], nextCursor: null }
  const { agentSessionId, providerId, workspacePath, managedSource } = loop
  const result = await client.readScheduledPromptHistory({ query, target: { agentSessionId, providerId, workspacePath }, definitions,
    ...(managedSource ? { managedSource } : {}) }, signal ? { signal } : {})
  return definitions.length === published.size ? result : { ...result, coverage: 'unconfirmed' as const }
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
