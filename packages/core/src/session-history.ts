import { AgentMuxError } from './errors.js'
import type {
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryCollaboration,
  AgentSessionHistoryItem,
  AgentSessionHistoryQuestionRequest,
  AgentSessionHistoryQuestionAnswer,
  AgentSessionHistorySource
} from './types.js'

export const SESSION_HISTORY_MAX_PAGE_BYTES = 4 * 1024 * 1024
export const SESSION_HISTORY_TIMEOUT_MS = 10_000

function invalid(): never {
  throw new AgentMuxError('Provider returned an invalid native history page.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function nonempty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return invalid()
  return value
}

function optionalTime(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid()
  return value as number
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalid()
  return value as T
}

function nativeReference(value: unknown): AgentSessionHistorySource {
  const reference = object(value)
  return { providerId: nonempty(reference.providerId), nativeSessionId: nonempty(reference.nativeSessionId) }
}

function collaboration(value: unknown): AgentSessionHistoryCollaboration {
  const record = object(value)
  if (record.kind === 'agent-activity') {
    if (record.path !== undefined && typeof record.path !== 'string') return invalid()
    return { kind: 'agent-activity',
      event: choice(record.event, ['started', 'interacted', 'interrupted', 'completed']),
      agent: nativeReference(record.agent),
      ...(record.path === undefined ? {} : { path: record.path }) }
  }
  if (record.kind !== 'operation' || !Array.isArray(record.receivers) || !Array.isArray(record.agentStates)) return invalid()
  if (record.prompt !== undefined && typeof record.prompt !== 'string') return invalid()
  return { kind: 'operation',
    ...(record.operation === undefined ? {} : { operation: choice(record.operation,
      ['spawn', 'send-input', 'send-message', 'followup', 'wait', 'resume', 'interrupt', 'close', 'list']) }),
    ...(record.status === undefined ? {} : { status: choice(record.status, ['running', 'completed', 'failed', 'interrupted']) }),
    ...(record.sender === undefined ? {} : { sender: nativeReference(record.sender) }),
    receivers: record.receivers.map(nativeReference),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
    agentStates: record.agentStates.map(value => {
      const agent = object(value)
      if (agent.message !== undefined && typeof agent.message !== 'string') return invalid()
      return { source: nativeReference(agent.source),
        ...(agent.state === undefined ? {} : { state: choice(agent.state,
          ['pending', 'running', 'completed', 'failed', 'interrupted', 'stopped', 'not-found']) }),
        ...(agent.message === undefined ? {} : { message: agent.message }) }
    }) }
}

function questionRequest(value: unknown): AgentSessionHistoryQuestionRequest {
  const request = object(value)
  if (request.delivery !== 'async' || !Array.isArray(request.questions) || !request.questions.length) return invalid()
  const ids = new Set<string>()
  return { delivery: 'async', questions: request.questions.map(value => {
    const question = object(value), id = nonempty(question.id)
    if (ids.has(id) || !Array.isArray(question.options) || typeof question.acceptsText !== 'boolean') return invalid()
    ids.add(id)
    const optionIds = new Set<string>()
    const options = question.options.map(value => {
      const option = object(value), id = nonempty(option.id)
      if (optionIds.has(id)) return invalid()
      optionIds.add(id)
      return { id, label: nonempty(option.label) }
    })
    if (!options.length && !question.acceptsText) return invalid()
    return { id, prompt: nonempty(question.prompt), options, acceptsText: question.acceptsText }
  }) }
}

function questionAnswers(value: unknown): AgentSessionHistoryQuestionAnswer[] {
  if (!Array.isArray(value) || !value.length) return invalid()
  return value.map(value => {
    const answer = object(value)
    if (typeof answer.answer !== 'string' || answer.prompt !== undefined && typeof answer.prompt !== 'string') return invalid()
    return { questionId: nonempty(answer.questionId), answer: answer.answer,
      ...(answer.prompt === undefined ? {} : { prompt: answer.prompt }) }
  })
}

export function normalizeSessionHistoryPage(
  source: AgentSessionHistorySource,
  value: unknown,
  limit: number
): AgentProviderSessionHistoryPage {
  const page = object(value)
  const actualSource = object(page.source)
  if (actualSource.providerId !== source.providerId || actualSource.nativeSessionId !== source.nativeSessionId) {
    throw new AgentMuxError('Native history source does not match the main Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  }
  if (!Array.isArray(page.items) || page.items.length > limit ||
    (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) return invalid()
  // Invalid optional size metadata must not prevent an otherwise valid history page from being read.
  const { sourceSizeBytes: _sourceSizeBytes, ...pageBody } = page
  if (Buffer.byteLength(JSON.stringify(pageBody)) > SESSION_HISTORY_MAX_PAGE_BYTES) {
    throw new AgentMuxError('Native history page exceeds its byte budget.', 'AGENT_SESSION_HISTORY_TOO_LARGE')
  }
  const ids = new Set<string>()
  const items: AgentSessionHistoryItem[] = page.items.map((value: unknown) => {
    const item = object(value)
    const id = nonempty(item.id)
    if (ids.has(id)) return invalid()
    ids.add(id)
    if (item.kind !== 'user-message' && item.kind !== 'assistant-message' && item.kind !== 'system-message' && item.kind !== 'activity') return invalid()
    if (!Array.isArray(item.contentParts)) return invalid()
    const contentParts: AgentSessionHistoryContentPart[] = item.contentParts.map((value: unknown) => {
      const part = object(value)
      if (part.kind === 'text' && typeof part.text === 'string') {
        const readingRange = part.readingRange === undefined ? undefined : object(part.readingRange)
        if (readingRange && (!Number.isSafeInteger(readingRange.start) || !Number.isSafeInteger(readingRange.end) ||
          (readingRange.start as number) < 0 || (readingRange.end as number) < (readingRange.start as number) ||
          (readingRange.end as number) > part.text.length)) return invalid()
        return { kind: 'text', text: part.text, ...(readingRange === undefined ? {} : {
          readingRange: { start: readingRange.start as number, end: readingRange.end as number }
        }) }
      }
      if (part.kind === 'reasoning' && typeof part.text === 'string') {
        if (part.signature !== undefined && typeof part.signature !== 'string') return invalid()
        if (part.redacted !== undefined && typeof part.redacted !== 'boolean') return invalid()
        return {
          kind: 'reasoning',
          text: part.text,
          ...(part.signature !== undefined ? { signature: part.signature } : {}),
          ...(part.redacted !== undefined ? { redacted: part.redacted } : {})
        }
      }
      if (part.kind === 'tool-call' || part.kind === 'tool-result') {
        const callId = part.callId === undefined ? {} : { callId: nonempty(part.callId) }
        if (part.kind === 'tool-call') {
          if (typeof part.input !== 'string') return invalid()
          return { kind: 'tool-call', name: nonempty(part.name), input: part.input, ...callId }
        }
        if (typeof part.output !== 'string' || (part.failed !== undefined && typeof part.failed !== 'boolean')) return invalid()
        return { kind: 'tool-result', output: part.output, ...callId,
          ...(part.name === undefined ? {} : { name: nonempty(part.name) }),
          ...(part.failed === undefined ? {} : { failed: part.failed }) }
      }
      if (part.kind !== 'resource' || !['image', 'audio', 'file', 'other', 'text'].includes(part.resourceType as string)) return invalid()
      if (part.label !== undefined && typeof part.label !== 'string') return invalid()
      const content = part.content === undefined ? undefined : object(part.content)
      if (part.resourceType === 'text' ? !content : content !== undefined) return invalid()
      if (content && (content.encoding !== 'json-utf8' || !['text', 'reasoning', 'tool-call', 'tool-result', 'resource'].includes(String(content.kind)) ||
        !Number.isSafeInteger(content.byteLength) || (content.byteLength as number) < 1 || typeof content.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(content.sha256))) return invalid()
      return { kind: 'resource', resourceType: part.resourceType as 'image' | 'audio' | 'file' | 'other' | 'text',
        reference: nonempty(part.reference), ...(part.label === undefined ? {} : { label: part.label }),
        ...(content === undefined ? {} : { content: { encoding: 'json-utf8' as const,
          kind: content.kind as 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'resource', byteLength: content.byteLength as number, sha256: content.sha256 as string } }) }
    })
    if (item.title !== undefined && typeof item.title !== 'string') return invalid()
    const startedAt = optionalTime(item.startedAt)
    const completedAt = optionalTime(item.completedAt)
    if (item.messagePhase !== undefined && item.kind !== 'assistant-message') return invalid()
    if (item.collaboration !== undefined && item.kind !== 'activity') return invalid()
    if (item.questionRequest !== undefined && item.kind !== 'assistant-message') return invalid()
    if (item.questionAnswers !== undefined && item.kind !== 'user-message') return invalid()
    const questionDiagnostic = item.questionDiagnostic === undefined ? undefined : object(item.questionDiagnostic)
    if (questionDiagnostic && item.kind !== 'assistant-message') return invalid()
    return { id, kind: item.kind, contentParts,
      ...(item.messagePhase === undefined ? {} : { messagePhase: choice(item.messagePhase, ['progress', 'final']) }),
      ...(item.questionRequest === undefined ? {} : { questionRequest: questionRequest(item.questionRequest) }),
      ...(item.questionAnswers === undefined ? {} : { questionAnswers: questionAnswers(item.questionAnswers) }),
      ...(questionDiagnostic === undefined ? {} : { questionDiagnostic: {
        code: nonempty(questionDiagnostic.code), message: nonempty(questionDiagnostic.message)
      } }),
      ...(item.collaboration === undefined ? {} : { collaboration: collaboration(item.collaboration) }),
      ...(item.turnId === undefined ? {} : { turnId: nonempty(item.turnId) }),
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }) }
  })
  return { source: { ...source }, items, nextCursor: page.nextCursor as string | null,
    ...(Number.isSafeInteger(page.sourceSizeBytes) && (page.sourceSizeBytes as number) >= 0
      ? { sourceSizeBytes: page.sourceSizeBytes as number } : {}) }
}

export * from './session-user-messages.js'
