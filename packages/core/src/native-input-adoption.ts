import { isDeepStrictEqual } from 'node:util'
import { nativeInputCorrelationKey, nativeInputSourceId } from './native-input-correlation.js'
import type { ConversationRef } from './conversation.js'
import type { AgentPromptInputKey } from './agent-prompt-condition.js'
import type { AgentSessionHistoryItem, AgentSessionHistorySource, AgentPromptSubmissionRecord } from './types.js'

/** Original claim lookup only. Reading cannot settle, dispatch or rewrite an input. */
export async function confirmNativeInputAdoption(item: AgentSessionHistoryItem, ref: ConversationRef, source: AgentSessionHistorySource,
  readClaim: (key: AgentPromptInputKey) => Promise<AgentPromptSubmissionRecord | null>, signal?: AbortSignal): Promise<AgentSessionHistoryItem> {
  const native = item.conversation?.nativeInput
  const { adoptedInput: _untrusted, ...conversation } = item.conversation ?? {}
  const original = item.conversation ? { ...item, conversation } : item
  if (!native) return original
  const key = nativeInputCorrelationKey(native.clientCorrelation)
  if (!key && !native.clientCorrelation.startsWith('amux-input-v1.')) return original
  const unconfirmed = (): AgentSessionHistoryItem => ({ ...original, conversationDiagnostic: { code: 'CONVERSATION_INPUT_ADOPTION_UNCONFIRMED',
    message: 'The original native input cannot be confirmed against its exact durable claim. Its complete record remains readable; no input is replayed.' } })
  if (!key || !ref.hostId || key.agentSessionId !== ref.agentSessionId || item.kind !== 'user-message' || native.turnId !== item.turnId ||
      !isDeepStrictEqual(native.source, source)) return unconfirmed()
  try {
    signal?.throwIfAborted()
    const record = await readClaim(key), claim = record?.admission, intent = claim?.intent, plan = claim?.transport === 'native' ? claim.native.plan : undefined
    signal?.throwIfAborted()
    if (!record || !claim || !intent || !plan || record.agentSessionId !== ref.agentSessionId || record.run.runId !== key.expectedRun.runId ||
        !isDeepStrictEqual(claim.inputKey, key) || !isDeepStrictEqual(intent.run, key.expectedRun) || !isDeepStrictEqual(intent.plan, plan) ||
        plan.clientCorrelation !== native.clientCorrelation || plan.sourceId !== nativeInputSourceId(source) ||
        plan.threadId !== source.nativeSessionId ||
        plan.expectedTurnId !== undefined && plan.expectedTurnId !== native.turnId || claim.transport !== 'native' ||
        claim.native.outcome === 'not-applied' || claim.native.outcome === 'admitted' && plan.operation !== 'queue-idle' && claim.native.turnId !== native.turnId) return unconfirmed()
    const target = intent.admissionIntent
    const addressed = plan.operation !== 'queue-idle' && target?.kind === 'native-conversation' && isDeepStrictEqual(target.expectedRun, key.expectedRun) &&
      isDeepStrictEqual(target.source, source) && plan.expectedTurnId === target.expectedTurnId
    const questionReply = key.kind === 'prompt' && intent.message?.questionReply
    const defaultInput = (key.kind === 'message' || questionReply && isDeepStrictEqual(questionReply.source, source)) &&
      target?.kind === 'exact-condition' && isDeepStrictEqual(target.condition.expectedRun, key.expectedRun) &&
      (intent.execution ?? 'default') === 'default' && plan.operation === 'start-or-steer' && plan.expectedTurnId === undefined
    const sessionInput = target?.kind === 'session-conversation' && isDeepStrictEqual(target.expectedRun, key.expectedRun) &&
      intent.execution === 'immediate' && plan.operation === 'start-or-steer' && plan.expectedTurnId === undefined
    // Native queue entries can be edited by their original user. Correlation alone
    // cannot turn that edited content back into the frozen platform notification.
    const notification = key.kind === 'prompt' && intent.message?.a2aNotificationId === key.submissionId &&
      intent.message.systemContext === intent.prompt && intent.message.userContent === undefined &&
      intent.message.authorAgentSessionId === undefined && intent.message.authorHuman === undefined && intent.message.authorExternal === undefined &&
      target?.kind === 'exact-condition' && isDeepStrictEqual(target.condition.expectedRun, key.expectedRun) &&
      (intent.execution ?? 'default') === 'default' && plan.operation === 'queue-idle' && plan.expectedTurnId === undefined &&
      item.contentParts.length === 1 && item.contentParts[0]?.kind === 'text' && item.contentParts[0].text === intent.prompt
    if (!addressed && !defaultInput && !sessionInput && !notification) return unconfirmed()
    return { ...original, conversation: { ...conversation, adoptedInput: { key, ...(notification ? { purpose: 'a2a-notification' as const } : {}) } } }
  } catch {
    signal?.throwIfAborted()
    return unconfirmed()
  }
}

/** One bounded page; repeated canonical candidates query their exact original claim once. */
export async function confirmNativeInputAdoptions(items: readonly AgentSessionHistoryItem[], ref: ConversationRef, source: AgentSessionHistorySource,
  readClaim: (key: AgentPromptInputKey) => Promise<AgentPromptSubmissionRecord | null>, signal?: AbortSignal): Promise<AgentSessionHistoryItem[]> {
  const claims = new Map<string, Promise<AgentPromptSubmissionRecord | null>>()
  return await Promise.all(items.map(item => confirmNativeInputAdoption(item, ref, source, key => {
    const id = JSON.stringify(key); let reading = claims.get(id)
    if (!reading) { reading = readClaim(key); claims.set(id, reading) }
    return reading
  }, signal)))
}
