import { parseAgentLearningTarget, type AgentLearningSource, type AgentLearningTarget } from '@agentmux/core/agent-learning'

/** User input and request references only; Host operations and approval receipts are never copied. */
export type AgentLearningReviewDraft = {
  source: AgentLearningSource
  operationId: string | null
  executorId: string | null
  target: AgentLearningTarget | null
  draft: { expectedRevision: number; content: string } | null
  extraction: { operationId: string; executorId: string } | null
}
export const learningReviewKey = (source: AgentLearningSource) => JSON.stringify([source.hostId, source.agentSessionId])
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)

export function restoredLearningReviewDrafts(value: unknown): Record<string, AgentLearningReviewDraft> {
  const result: Record<string, AgentLearningReviewDraft> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as AgentLearningReviewDraft
    if (!entry.source || !id(entry.source.hostId) || !id(entry.source.agentSessionId) || learningReviewKey(entry.source) !== key ||
      entry.operationId !== null && !id(entry.operationId) || entry.executorId !== null && !id(entry.executorId) ||
      entry.draft !== null && (!entry.draft || !Number.isSafeInteger(entry.draft.expectedRevision) || entry.draft.expectedRevision < 1 || typeof entry.draft.content !== 'string') ||
      entry.extraction !== null && (!entry.extraction || !id(entry.extraction.operationId) || !id(entry.extraction.executorId) || entry.extraction.operationId !== entry.operationId)) continue
    let target: AgentLearningTarget | null = null
    try { if (entry.target !== null) target = parseAgentLearningTarget(entry.target) } catch { /* Keep text and request references even when a saved selection is unreadable. */ }
    result[key] = { source: { hostId: entry.source.hostId, agentSessionId: entry.source.agentSessionId }, operationId: entry.operationId, executorId: entry.executorId, target,
      draft: entry.draft ? { expectedRevision: entry.draft.expectedRevision, content: entry.draft.content } : null,
      extraction: entry.extraction ? { operationId: entry.extraction.operationId, executorId: entry.extraction.executorId } : null }
  }
  return result
}
