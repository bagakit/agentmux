import { AgentMuxError } from './errors.js'
import type {
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem,
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
  if (Buffer.byteLength(JSON.stringify(value)) > SESSION_HISTORY_MAX_PAGE_BYTES) {
    throw new AgentMuxError('Native history page exceeds its byte budget.', 'AGENT_SESSION_HISTORY_TOO_LARGE')
  }
  const ids = new Set<string>()
  const items: AgentSessionHistoryItem[] = page.items.map((value: unknown) => {
    const item = object(value)
    const id = nonempty(item.id)
    if (ids.has(id)) return invalid()
    ids.add(id)
    if (item.kind !== 'user-message' && item.kind !== 'assistant-message' && item.kind !== 'activity') return invalid()
    if (!Array.isArray(item.contentParts)) return invalid()
    const contentParts: AgentSessionHistoryContentPart[] = item.contentParts.map((value: unknown) => {
      const part = object(value)
      if (part.kind === 'text' && typeof part.text === 'string') return { kind: 'text', text: part.text }
      if (part.kind === 'reasoning' && typeof part.text === 'string') return { kind: 'reasoning', text: part.text }
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
      if (part.kind !== 'resource' || !['image', 'audio', 'file', 'other'].includes(part.resourceType as string)) return invalid()
      if (part.label !== undefined && typeof part.label !== 'string') return invalid()
      return { kind: 'resource', resourceType: part.resourceType as 'image' | 'audio' | 'file' | 'other',
        reference: nonempty(part.reference), ...(part.label === undefined ? {} : { label: part.label }) }
    })
    if (item.title !== undefined && typeof item.title !== 'string') return invalid()
    const startedAt = optionalTime(item.startedAt)
    const completedAt = optionalTime(item.completedAt)
    return { id, kind: item.kind, contentParts,
      ...(item.turnId === undefined ? {} : { turnId: nonempty(item.turnId) }),
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }) }
  })
  return { source: { ...source }, items, nextCursor: page.nextCursor as string | null }
}

export * from './session-user-messages.js'
