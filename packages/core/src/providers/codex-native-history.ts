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

function extractReasoningText(item: Record<string, unknown>): string | null {
  const content = Array.isArray(item.content)
    ? item.content.filter((line): line is string => typeof line === 'string' && line.length > 0)
    : []
  const summary = Array.isArray(item.summary)
    ? item.summary.filter((line): line is string => typeof line === 'string' && line.length > 0)
    : []
  const lines = content.length > 0 ? content : summary
  return lines.length > 0 ? lines.join('\n') : null
}

function toolCallInput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

function fileChangesInput(changes: unknown): string {
  if (!Array.isArray(changes) || changes.length === 0) return ''
  return changes.map((c) => {
    if (!c || typeof c !== 'object') return String(c)
    const rec = c as Record<string, unknown>
    const kind = typeof rec.kind === 'object' && rec.kind ? (rec.kind as Record<string, unknown>).type : rec.kind
    const path = typeof rec.path === 'string' ? rec.path : ''
    return `${kind || 'update'} ${path}`.trim()
  }).filter(Boolean).join('\n')
}

function fileChangesOutput(changes: unknown, status: unknown): string {
  if (Array.isArray(changes) && changes.length > 0) {
    const diffs = changes.map((c) => {
      if (!c || typeof c !== 'object') return ''
      const rec = c as Record<string, unknown>
      const path = typeof rec.path === 'string' ? rec.path : ''
      return typeof rec.diff === 'string' && rec.diff.length > 0 ? `${path}:\n${rec.diff}` : path
    }).filter(Boolean)
    if (diffs.length > 0) return diffs.join('\n\n')
  }
  return status === 'completed' ? 'Patch applied'
    : status === 'declined' ? 'Patch declined'
    : status === 'failed' ? 'Patch failed'
    : ''
}

function webSearchOutput(action: unknown, results: unknown): string {
  const parts: string[] = []
  if (action && typeof action === 'object') {
    const act = action as Record<string, unknown>
    if (act.type === 'search') {
      const q = typeof act.query === 'string' ? act.query : Array.isArray(act.queries) ? act.queries.join(', ') : ''
      parts.push(q ? `Search: ${q}` : 'Search')
    } else if (act.type === 'openPage') {
      parts.push(act.url ? `Open page: ${act.url}` : 'Open page')
    } else if (act.type === 'findInPage') {
      parts.push(act.pattern ? `Find in page: "${act.pattern}" at ${act.url ?? ''}` : 'Find in page')
    } else if (act.type === 'other') {
      parts.push('Other action')
    } else {
      parts.push(JSON.stringify(action, null, 2))
    }
  }
  if (Array.isArray(results) && results.length > 0) {
    parts.push(JSON.stringify(results, null, 2))
  }
  return parts.join('\n\n')
}

function itemEntry(value: unknown): AgentSessionHistoryItem {
  const entry = object(value)
  const item = object(entry.item)
  const type = string(item.type)
  const id = string(item.id)
  const turnId = string(entry.turnId)
  let kind: AgentSessionHistoryItem['kind'] = 'activity'
  let contentParts: AgentSessionHistoryContentPart[] = []

  if (type === 'userMessage') {
    if (!Array.isArray(item.content)) throw protocolError()
    kind = 'user-message'
    contentParts = item.content.map(userContent)
  } else if (type === 'agentMessage') {
    kind = 'assistant-message'
    contentParts = [{ kind: 'text', text: string(item.text) }]
  } else if (type === 'reasoning') {
    const text = extractReasoningText(item)
    if (text) {
      contentParts = [{ kind: 'reasoning', text }]
    } else {
      contentParts = [{ kind: 'text', text: JSON.stringify(item, null, 2) }]
    }
  } else if (type === 'commandExecution') {
    const command = string(item.command)
    contentParts.push({ kind: 'tool-call', name: 'shell', input: command, callId: id })
    const hasOutput = typeof item.aggregatedOutput === 'string'
    const hasExitCode = typeof item.exitCode === 'number'
    const isTerminal = item.status === 'completed' || item.status === 'failed' || item.status === 'declined'
    if (hasOutput || hasExitCode || isTerminal) {
      const output = hasOutput ? (item.aggregatedOutput as string)
        : hasExitCode ? `Exit code: ${item.exitCode}`
        : item.status === 'completed' ? 'Command completed'
        : item.status === 'declined' ? 'Command declined'
        : 'Command failed'
      const failed = item.status === 'failed' || item.status === 'declined' || (hasExitCode && item.exitCode !== 0)
      contentParts.push({ kind: 'tool-result', output, name: 'shell', callId: id, ...(failed ? { failed: true } : {}) })
    }
  } else if (type === 'fileChange') {
    const input = fileChangesInput(item.changes)
    contentParts.push({ kind: 'tool-call', name: 'apply_patch', input, callId: id })
    const isTerminal = item.status === 'completed' || item.status === 'failed' || item.status === 'declined'
    if (isTerminal) {
      const output = fileChangesOutput(item.changes, item.status)
      const failed = item.status === 'failed' || item.status === 'declined'
      contentParts.push({ kind: 'tool-result', output, name: 'apply_patch', callId: id, ...(failed ? { failed: true } : {}) })
    }
  } else if (type === 'mcpToolCall') {
    const server = string(item.server)
    const tool = string(item.tool)
    const toolName = `${server}/${tool}`
    contentParts.push({ kind: 'tool-call', name: toolName, input: toolCallInput(item.arguments), callId: id })
    const isTerminal = item.status === 'completed' || item.status === 'failed'
    const failed = item.status === 'failed' || Boolean(item.error)
    let emittedAny = false

    if (item.error && typeof item.error === 'object') {
      const msg = typeof (item.error as Record<string, unknown>).message === 'string'
        ? (item.error as Record<string, unknown>).message as string
        : JSON.stringify(item.error, null, 2)
      contentParts.push({ kind: 'tool-result', output: msg, name: toolName, callId: id, failed: true })
      emittedAny = true
    }

    if (item.result && typeof item.result === 'object') {
      const res = item.result as Record<string, unknown>
      if (Array.isArray(res.content)) {
        for (const block of res.content) {
          if (!block || typeof block !== 'object') {
            if (typeof block === 'string' && block.length > 0) {
              contentParts.push({ kind: 'tool-result', output: block, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              emittedAny = true
            }
            continue
          }
          const b = block as Record<string, unknown>
          if (b.type === 'text' && typeof b.text === 'string') {
            contentParts.push({ kind: 'tool-result', output: b.text, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
            emittedAny = true
            if (b._meta !== null && b._meta !== undefined) {
              contentParts.push({ kind: 'tool-result', output: JSON.stringify(b._meta, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
            }
          } else if (b.type === 'image') {
            if (typeof b.data === 'string' && b.data.length > 0 && typeof b.mimeType === 'string' && b.mimeType.length > 0) {
              contentParts.push({ kind: 'resource', resourceType: 'image', reference: `data:${b.mimeType};base64,${b.data}` })
              emittedAny = true
              if (b._meta !== null && b._meta !== undefined) {
                contentParts.push({ kind: 'tool-result', output: JSON.stringify(b._meta, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              }
            } else {
              contentParts.push({ kind: 'tool-result', output: JSON.stringify(b, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              emittedAny = true
            }
          } else if (b.type === 'audio') {
            if (typeof b.data === 'string' && b.data.length > 0 && typeof b.mimeType === 'string' && b.mimeType.length > 0) {
              contentParts.push({ kind: 'resource', resourceType: 'audio', reference: `data:${b.mimeType};base64,${b.data}` })
              emittedAny = true
              if (b._meta !== null && b._meta !== undefined) {
                contentParts.push({ kind: 'tool-result', output: JSON.stringify(b._meta, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              }
            } else {
              contentParts.push({ kind: 'tool-result', output: JSON.stringify(b, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              emittedAny = true
            }
          } else if (b.type === 'resource_link') {
            if (typeof b.uri === 'string' && b.uri.length > 0) {
              const label = typeof b.name === 'string' && b.name.length > 0 ? b.name
                : typeof b.description === 'string' && b.description.length > 0 ? b.description
                : undefined
              contentParts.push({ kind: 'resource', resourceType: 'file', reference: b.uri, ...(label ? { label } : {}) })
              emittedAny = true
              if (b._meta !== null && b._meta !== undefined) {
                contentParts.push({ kind: 'tool-result', output: JSON.stringify(b._meta, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              }
            } else {
              contentParts.push({ kind: 'tool-result', output: JSON.stringify(b, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              emittedAny = true
            }
          } else if (b.type === 'resource') {
            const embedded = b.resource && typeof b.resource === 'object' ? (b.resource as Record<string, unknown>) : null
            if (embedded && typeof embedded.uri === 'string' && embedded.uri.length > 0) {
              const label = typeof embedded.name === 'string' && embedded.name.length > 0 ? embedded.name : undefined
              contentParts.push({ kind: 'resource', resourceType: 'file', reference: embedded.uri, ...(label ? { label } : {}) })
              emittedAny = true

              if (typeof embedded.text === 'string') {
                contentParts.push({ kind: 'tool-result', output: embedded.text, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              } else if (typeof embedded.blob === 'string' && embedded.blob.length > 0) {
                if (typeof embedded.mimeType === 'string' && embedded.mimeType.startsWith('image/')) {
                  contentParts.push({ kind: 'resource', resourceType: 'image', reference: `data:${embedded.mimeType};base64,${embedded.blob}`, ...(label ? { label: `${label} (blob)` } : { label: `${embedded.uri} (blob)` }) })
                } else if (typeof embedded.mimeType === 'string' && embedded.mimeType.startsWith('audio/')) {
                  contentParts.push({ kind: 'resource', resourceType: 'audio', reference: `data:${embedded.mimeType};base64,${embedded.blob}`, ...(label ? { label: `${label} (blob)` } : { label: `${embedded.uri} (blob)` }) })
                } else if (typeof embedded.mimeType === 'string' && embedded.mimeType.length > 0) {
                  contentParts.push({ kind: 'tool-result', output: `data:${embedded.mimeType};base64,${embedded.blob}`, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
                } else {
                  contentParts.push({ kind: 'tool-result', output: embedded.blob, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
                }
              }
              if (b._meta !== null && b._meta !== undefined) {
                contentParts.push({ kind: 'tool-result', output: JSON.stringify(b._meta, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              }
              if (embedded._meta !== null && embedded._meta !== undefined) {
                contentParts.push({ kind: 'tool-result', output: JSON.stringify(embedded._meta, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              }
            } else {
              contentParts.push({ kind: 'tool-result', output: JSON.stringify(b, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
              emittedAny = true
            }
          } else {
            contentParts.push({ kind: 'tool-result', output: JSON.stringify(b, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
            emittedAny = true
          }
        }
      }
      if (res.structuredContent !== null && res.structuredContent !== undefined) {
        contentParts.push({ kind: 'tool-result', output: JSON.stringify(res.structuredContent, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
        emittedAny = true
      }
      if (res._meta !== null && res._meta !== undefined) {
        contentParts.push({ kind: 'tool-result', output: JSON.stringify(res._meta, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
        emittedAny = true
      }
    }

    if (!emittedAny && isTerminal) {
      const output = failed ? 'Tool call failed' : 'Tool call completed'
      contentParts.push({ kind: 'tool-result', output, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
    } else if (failed && !contentParts.some(p => p.kind === 'tool-result' && p.failed === true)) {
      contentParts.push({ kind: 'tool-result', output: 'Tool call failed', name: toolName, callId: id, failed: true })
    }
  } else if (type === 'dynamicToolCall') {
    const toolName = string(item.tool)
    contentParts.push({ kind: 'tool-call', name: toolName, input: toolCallInput(item.arguments), callId: id })
    const isTerminal = item.status === 'completed' || item.status === 'failed'
    const failed = item.status === 'failed' || item.success === false
    let emittedAny = false

    if (Array.isArray(item.contentItems)) {
      for (const ci of item.contentItems) {
        if (!ci || typeof ci !== 'object') {
          if (typeof ci === 'string' && ci.length > 0) {
            contentParts.push({ kind: 'tool-result', output: ci, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
            emittedAny = true
          }
          continue
        }
        const c = ci as Record<string, unknown>
        if (c.type === 'inputText' && typeof c.text === 'string') {
          contentParts.push({ kind: 'tool-result', output: c.text, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
          emittedAny = true
        } else if (c.type === 'inputImage' && typeof c.imageUrl === 'string' && c.imageUrl.length > 0) {
          contentParts.push({ kind: 'resource', resourceType: 'image', reference: c.imageUrl })
          emittedAny = true
        } else if (c.type === 'inputAudio' && typeof c.audioUrl === 'string' && c.audioUrl.length > 0) {
          contentParts.push({ kind: 'resource', resourceType: 'audio', reference: c.audioUrl })
          emittedAny = true
        } else {
          contentParts.push({ kind: 'tool-result', output: JSON.stringify(c, null, 2), name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
          emittedAny = true
        }
      }
    }

    if (!emittedAny && (isTerminal || typeof item.success === 'boolean')) {
      const output = failed ? 'Dynamic tool failed' : 'Dynamic tool completed'
      contentParts.push({ kind: 'tool-result', output, name: toolName, callId: id, ...(failed ? { failed: true } : {}) })
    } else if (failed && !contentParts.some(p => p.kind === 'tool-result' && p.failed === true)) {
      contentParts.push({ kind: 'tool-result', output: 'Dynamic tool failed', name: toolName, callId: id, failed: true })
    }
  } else if (type === 'webSearch') {
    const query = string(item.query)
    contentParts.push({ kind: 'tool-call', name: 'web_search', input: query, callId: id })
    if (item.action !== null && item.action !== undefined || (Array.isArray(item.results) && item.results.length > 0)) {
      const output = webSearchOutput(item.action, item.results)
      if (output) {
        contentParts.push({ kind: 'tool-result', output, name: 'web_search', callId: id })
      }
    }
  } else if (type === 'imageView' && typeof item.path === 'string') {
    contentParts.push(resource('image', item.path))
  } else if (type === 'imageGeneration' && typeof item.savedPath === 'string') {
    contentParts.push(resource('image', item.savedPath))
  } else if (type === 'plan' && typeof item.text === 'string') {
    contentParts.push({ kind: 'text', text: item.text })
  } else {
    // Native activity kinds evolve independently. Preserve their complete readable payload.
    contentParts = [{ kind: 'text', text: JSON.stringify(item, null, 2) }]
  }

  // Only known agentMessage represents genuine assistant speech; unknown types stay neutral activity
  if (type === 'agentMessage') {
    kind = 'assistant-message'
  }

  const timestamp = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError()
    return value as number
  }
  const startedAt = timestamp(entry.startedAtMs)
  const completedAt = timestamp(entry.completedAtMs)
  return { id, turnId, kind, contentParts,
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
