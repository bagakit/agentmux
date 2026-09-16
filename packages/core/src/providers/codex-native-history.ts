import { withCodexNativeRead } from './codex-native-read.js'
import { AgentMuxError } from '../errors.js'
import type {
  AgentProviderSessionHistoryContext,
  AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart,
  AgentSessionHistoryItem
} from '../types.js'

function protocolError(): AgentMuxError {
  return new AgentMuxError('Native history returned an invalid protocol response.', 'INVALID_AGENT_SESSION_HISTORY_PAGE')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError()
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw protocolError()
  return value
}

function resource(
  resourceType: 'image' | 'audio' | 'file' | 'other',
  reference: unknown,
  label?: unknown
): AgentSessionHistoryContentPart {
  return { kind: 'resource', resourceType, reference: string(reference),
    ...(label === undefined ? {} : { label: string(label) }) }
}

function userContent(value: unknown): AgentSessionHistoryContentPart {
  const part = object(value)
  switch (part.type) {
    case 'text': return { kind: 'text', text: string(part.text) }
    case 'image': return resource('image', part.url ?? part.fileId)
    case 'localImage': return resource('image', part.path)
    case 'audio': return resource('audio', part.url)
    case 'localAudio': return resource('audio', part.path)
    case 'skill': case 'mention': return resource('file', part.path, part.name)
    default: return { kind: 'text', text: JSON.stringify(part, null, 2) }
  }
}

function itemEntry(value: unknown): AgentSessionHistoryItem {
  const entry = object(value)
  const item = object(entry.item)
  const type = string(item.type)
  let kind: AgentSessionHistoryItem['kind'] = 'activity'
  let contentParts: AgentSessionHistoryContentPart[]
  if (type === 'userMessage') {
    if (!Array.isArray(item.content)) throw protocolError()
    kind = 'user-message'
    contentParts = item.content.map(userContent)
  } else if (type === 'agentMessage') {
    kind = 'assistant-message'
    contentParts = [{ kind: 'text', text: string(item.text) }]
  } else {
    // Native activity kinds evolve independently. Preserve their complete readable payload.
    contentParts = [{ kind: 'text', text: JSON.stringify(item, null, 2) }]
    if (type === 'imageView') contentParts.push(resource('image', item.path))
    if (type === 'imageGeneration' && typeof item.savedPath === 'string') contentParts.push(resource('image', item.savedPath))
  }
  const timestamp = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError()
    return value as number
  }
  const startedAt = timestamp(entry.startedAtMs)
  const completedAt = timestamp(entry.completedAtMs)
  return { id: string(item.id), turnId: string(entry.turnId), kind, contentParts,
    ...(kind === 'activity' ? { title: type } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }) }
}

/** History metadata and indexed items remain owned by this Provider reader. */
export async function readCodexSessionHistoryPage(
  context: AgentProviderSessionHistoryContext
): Promise<AgentProviderSessionHistoryPage> {
  return await withCodexNativeRead(context, 'history', async request => {
    const metadata = object(object(await request('thread/read', {
      threadId: context.source.nativeSessionId, includeTurns: false
    })).thread)
    if (metadata.id !== context.source.nativeSessionId) throw new AgentMuxError(
      'Native history metadata belongs to another Session.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    )
    if (metadata.historyMode !== 'paginated') throw new AgentMuxError(
      'This native Session does not expose indexed history pages.', 'AGENT_SESSION_HISTORY_UNSUPPORTED'
    )
    const result = object(await request('thread/items/list', {
      threadId: context.source.nativeSessionId, limit: context.limit, sortDirection: 'desc',
      ...(context.cursor === undefined ? {} : { cursor: context.cursor })
    }))
    if (!Array.isArray(result.data) || result.data.length > context.limit) throw protocolError()
    if (result.nextCursor !== null && typeof result.nextCursor !== 'string') throw protocolError()
    return { source: { ...context.source }, items: result.data.map(itemEntry).reverse(),
      nextCursor: result.nextCursor as string | null }
  })
}
