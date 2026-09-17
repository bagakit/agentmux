// Role/content interpretation follows Paseo PiHistoryMapper (3c6e4e39, Apache-2.0,
// Copyright (c) 2025-present Mohamed Boudra). Modified for native v3 JSONL and exact ordered resources.
// Branch semantics follow Pi 0.84.3 SessionManager._buildIndex/getBranch (ccfe79ed, MIT):
// last durable entry, parent traversal, including history before compaction; no mutating loader.
import { AgentMuxError } from '../errors.js'
import { NativeJsonlHistoryReader } from '../native-jsonl-history-reader.js'
import type { AgentProviderSessionHistoryContext, AgentProviderSessionHistoryPage,
  AgentSessionHistoryContentPart, AgentSessionHistoryItem } from '../types.js'

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parts(content: unknown): AgentSessionHistoryContentPart[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return content === undefined ? [] : [{ kind: 'text', text: JSON.stringify(content) }]
  return content.map((value): AgentSessionHistoryContentPart => {
    const block = object(value)
    if (block?.type === 'text' && typeof block.text === 'string') return { kind: 'text', text: block.text }
    if (block?.type === 'thinking' && typeof block.thinking === 'string') return { kind: 'text', text: block.thinking }
    if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return { kind: 'resource', resourceType: 'image', reference: `data:${block.mimeType};base64,${block.data}` }
    }
    return { kind: 'text', text: JSON.stringify(value) }
  })
}

function invalid(message: string): never { throw new AgentMuxError(message, 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT') }

function convert(entry: Record<string, unknown>): AgentSessionHistoryItem {
  const message = entry.type === 'message' ? object(entry.message) : undefined
  const role = message?.role
  const content = message?.content ?? (entry.type === 'custom_message' ? entry.content : entry.summary)
  const hasActivity = Array.isArray(content) && content.some((block) => {
    const type = object(block)?.type
    return type !== 'text' && type !== 'image'
  })
  const kind = !hasActivity && role === 'user' ? 'user-message'
    : !hasActivity && role === 'assistant' ? 'assistant-message' : 'activity'
  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return { id: entry.id as string, kind,
    contentParts: content === undefined ? [{ kind: 'text', text: JSON.stringify(entry) }] : parts(content),
    ...(kind === 'activity' ? { title: `Pi ${typeof role === 'string' ? role : String(entry.type)}` } : {}),
    ...(Number.isSafeInteger(time) && time >= 0 ? { startedAt: time } : {}) }
}

export async function readPiSessionHistoryPage(context: AgentProviderSessionHistoryContext): Promise<AgentProviderSessionHistoryPage> {
  const reader = await NativeJsonlHistoryReader.open(context)
  try {
    const header = await reader.readFirst()
    if (header?.type !== 'session' || header.version !== 3 || header.id !== context.source.nativeSessionId ||
      header.cwd !== context.workspacePath) {
      throw new AgentMuxError('Pi requires this native Session\'s v3 transcript and workspace.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    }
    let parent = reader.continuation
    const visited = new Set<string>()
    const items: AgentSessionHistoryItem[] = []
    while (items.length < context.limit) {
      const record = await reader.readPrevious()
      if (!record || record.value.type === 'session') {
        if (parent !== undefined) invalid('Pi transcript is missing a selected branch parent.')
        break
      }
      const entry = record.value
      if (typeof entry.id !== 'string' || !entry.id ||
        (entry.parentId !== null && (typeof entry.parentId !== 'string' || !entry.parentId))) {
        invalid('Pi transcript contains an invalid v3 entry.')
      }
      if (parent !== undefined && entry.id !== parent) continue
      if (visited.has(entry.id as string)) invalid('Pi transcript contains a branch cycle.')
      visited.add(entry.id as string)
      items.push(convert(entry))
      if (entry.parentId === null) { parent = undefined; break }
      parent = entry.parentId as string
    }
    const nextCursor = parent === undefined ? (await reader.verifyUnchanged(), null) : await reader.nextCursor(parent)
    return { source: context.source, items: items.reverse(), nextCursor }
  } finally { await reader.close() }
}
