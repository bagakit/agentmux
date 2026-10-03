import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcCount, rpcRecord, rpcString } from './rpc-business-codec.js'
import type { AgentMuxClient } from './client.js'
import type { AgentSessionHistoryDescriptor, AgentSessionHistoryPage, AgentTimelineSnapshot } from './types.js'

export type AgentContextParams = { hostId: string; agentSessionId: string; cursor?: string; limit?: number }
export type AgentContextIssue = { source: 'captured' | 'native' | 'session' | 'status' | 'runtime'; code: string; message: string; recovery: string }
export type AgentContextPage = {
  /** Exact requested route; configured client names are not durable Core identities. */
  hostId: string
  /** Original semantic owner's durable Host namespace, preserved across forwarding. */
  sourceHostId: string
  agentSessionId: string
  descriptor: AgentSessionHistoryDescriptor
  session: Awaited<ReturnType<AgentMuxClient['readAgentSessions']>>[number] | null
  status: Awaited<ReturnType<AgentMuxClient['statusAgent']>> | null
  runtimeDiagnostics: Awaited<ReturnType<AgentMuxClient['runtimeDiagnostics']>> | null
  captured: AgentTimelineSnapshot | null
  native: AgentSessionHistoryPage | null
  unavailable: AgentContextIssue[]
  nextCursor: string | null
}
export type AgentContextOwner = Pick<AgentMuxClient, 'sessionTimeline' | 'sessionHistorySources' | 'sessionHistoryPage' | 'readAgentSessions' | 'statusAgent' | 'runtimeDiagnostics'>
type Cursor = { version: 1; hostId: string; agentSessionId: string; binding: string; capturedAnchorId: string | null; capturedCount: number | null; capturedIdsHash: string | null; capturedOffset: number; capturedDone: boolean; nativeCursor: string | null; nativeDone: boolean }
const CURSOR_FIELDS = ['version', 'hostId', 'agentSessionId', 'binding', 'capturedAnchorId', 'capturedCount', 'capturedIdsHash', 'capturedOffset', 'capturedDone', 'nativeCursor', 'nativeDone'] as const
const invalidCursor = (): never => { throw new AgentMuxError('Context cursor does not belong to these original sources. Read a fresh page for this exact Host and Session.', 'AGENT_CONTEXT_SOURCE_CHANGED') }
const binding = (source: AgentSessionHistoryDescriptor) => createHash('sha256').update(JSON.stringify({ hostId: source.hostId, agentSessionId: source.agentSessionId, history: source.history ?? null })).digest('hex')
const itemIdsHash = (items: AgentTimelineSnapshot['items']) => createHash('sha256').update(JSON.stringify(items.map(item => item.id))).digest('hex')

export function parseAgentContextParams(value: unknown): AgentContextParams {
  const p = rpcRecord(value, ['hostId', 'agentSessionId', 'cursor', 'limit', 'operationId'])
  const hostId = rpcString(p.hostId, 'Exact Host ID'), agentSessionId = rpcString(p.agentSessionId, 'Exact Session ID')
  if (agentSessionId === 'self') throw new AgentMuxError('Context requires the exact original Session ID.', 'INVALID_CONTROL_REQUEST')
  if (p.cursor !== undefined && (typeof p.cursor !== 'string' || !p.cursor || p.cursor.length > 131_072 || !/^[\w-]+$/u.test(p.cursor))) invalidCursor()
  const limit = p.limit === undefined ? 30 : rpcCount(p.limit, 30, 100)
  if (limit < 1) throw new AgentMuxError('Context limit must be from 1 to 100 per source.', 'INVALID_CONTROL_REQUEST')
  return { hostId, agentSessionId, limit, ...(p.cursor === undefined ? {} : { cursor: p.cursor as string }) }
}
/** Preserve the configured route as well as the remote owner's original cursor. */
export function forwardAgentContextParams(input: AgentContextParams): { params: AgentContextParams; sourceHostId?: string } {
  if (!input.cursor) return { params: { ...input, hostId: 'local' } }
  try {
    const envelope = rpcRecord(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')), ['version', 'routeHostId', 'agentSessionId', 'sourceHostId', 'cursor'])
    if (envelope.version !== 1 || envelope.routeHostId !== input.hostId || envelope.agentSessionId !== input.agentSessionId) return invalidCursor()
    const sourceHostId = rpcString(envelope.sourceHostId, 'Original source Host ID')
    if (typeof envelope.cursor !== 'string' || !envelope.cursor || envelope.cursor.length > 65_536) return invalidCursor()
    return { params: { ...input, hostId: 'local', cursor: envelope.cursor }, sourceHostId }
  } catch { return invalidCursor() }
}
export function forwardAgentContextPage(page: AgentContextPage, input: AgentContextParams, expectedSourceHostId?: string): AgentContextPage {
  if (page.hostId !== 'local' || page.agentSessionId !== input.agentSessionId ||
    page.descriptor.agentSessionId !== input.agentSessionId || page.descriptor.hostId !== page.sourceHostId ||
    expectedSourceHostId !== undefined && page.sourceHostId !== expectedSourceHostId) return invalidCursor()
  return { ...page, hostId: input.hostId, nextCursor: page.nextCursor === null ? null : Buffer.from(JSON.stringify({
    version: 1, routeHostId: input.hostId, agentSessionId: input.agentSessionId, sourceHostId: page.sourceHostId, cursor: page.nextCursor
  })).toString('base64url') }
}
function cursorFor(input: AgentContextParams, descriptor: AgentSessionHistoryDescriptor): Cursor {
  if (!input.cursor) return { version: 1, hostId: input.hostId, agentSessionId: input.agentSessionId, binding: binding(descriptor), capturedAnchorId: null, capturedCount: null, capturedIdsHash: null, capturedOffset: 0, capturedDone: false, nativeCursor: null, nativeDone: false }
  try {
    const cursor = rpcRecord(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')), CURSOR_FIELDS) as unknown as Cursor
    if (cursor.version !== 1 || cursor.hostId !== input.hostId || cursor.agentSessionId !== input.agentSessionId || cursor.binding !== binding(descriptor) ||
      !(cursor.capturedCount === null || Number.isSafeInteger(cursor.capturedCount) && cursor.capturedCount >= 0) ||
      !(cursor.capturedAnchorId === null || typeof cursor.capturedAnchorId === 'string' && cursor.capturedAnchorId.length > 0) ||
      !(cursor.capturedIdsHash === null || typeof cursor.capturedIdsHash === 'string' && /^[a-f0-9]{64}$/u.test(cursor.capturedIdsHash)) ||
      !Number.isSafeInteger(cursor.capturedOffset) || cursor.capturedOffset < 0 || typeof cursor.capturedDone !== 'boolean' || typeof cursor.nativeDone !== 'boolean' ||
      !(cursor.nativeCursor === null || typeof cursor.nativeCursor === 'string' && cursor.nativeCursor.length > 0)) invalidCursor()
    if (cursor.capturedCount === null ? cursor.capturedAnchorId !== null || cursor.capturedIdsHash !== null || cursor.capturedOffset !== 0 || cursor.capturedDone
      : cursor.capturedOffset > cursor.capturedCount || cursor.capturedIdsHash === null || cursor.capturedCount > 0 && cursor.capturedAnchorId === null) invalidCursor()
    return cursor
  } catch { return invalidCursor() }
}

/** Combines existing durable owners. It never connects, sends input, or controls a Run. */
export async function readAgentContext(owner: AgentContextOwner, input: AgentContextParams, descriptor: AgentSessionHistoryDescriptor): Promise<AgentContextPage> {
  if (descriptor.agentSessionId !== input.agentSessionId || descriptor.hostId !== input.hostId) throw new AgentMuxError('Context belongs to another Host or Session.', 'AGENT_CONTEXT_TARGET_MISMATCH')
  const cursor = cursorFor(input, descriptor), unavailable: AgentContextIssue[] = []
  async function read<T>(source: AgentContextIssue['source'], action: () => Promise<T>): Promise<T | null> {
    try { return await action() } catch (error) {
      if (error instanceof AgentMuxError && error.code === 'AGENT_CONTEXT_SOURCE_CHANGED') throw error
      unavailable.push({ source, code: error instanceof AgentMuxError ? error.code : 'AGENT_CONTEXT_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), recovery: 'Retry this exact Host and Session. Existing original work remains available.' })
      return null
    }
  }
  const [timeline, native, sessions, status, runtimeDiagnostics] = await Promise.all([
    read('captured', () => owner.sessionTimeline(input.agentSessionId)),
    cursor.nativeDone ? Promise.resolve(null) : read('native', () => owner.sessionHistoryPage(input.agentSessionId, { limit: input.limit ?? 30, ...(cursor.nativeCursor === null ? {} : { cursor: cursor.nativeCursor }) })),
    read('session', () => owner.readAgentSessions()),
    descriptor.state === 'retired' ? Promise.resolve(null) : read('status', () => owner.statusAgent(input.agentSessionId)),
    read('runtime', () => owner.runtimeDiagnostics())
  ])
  let captured: AgentTimelineSnapshot | null = null
  if (timeline) {
    if (timeline.agentSessionId !== input.agentSessionId) invalidCursor()
    if (cursor.capturedCount === null) {
      cursor.capturedCount = timeline.items.length
      cursor.capturedAnchorId = timeline.items.at(-1)?.id ?? null
      cursor.capturedIdsHash = itemIdsHash(timeline.items)
    }
    let items: AgentTimelineSnapshot['items'] = []
    if (!cursor.capturedDone) {
      // New output may append while the original Agent keeps working. Read the
      // original ID window, allowing its records to finish/update in place.
      const windowEnd = cursor.capturedCount === 0 ? 0 : timeline.items.findIndex(item => item.id === cursor.capturedAnchorId) + 1
      const windowStart = windowEnd - cursor.capturedCount
      if (windowStart < 0) invalidCursor()
      const window = timeline.items.slice(windowStart, windowEnd)
      if (itemIdsHash(window) !== cursor.capturedIdsHash) invalidCursor()
      const end = cursor.capturedCount - cursor.capturedOffset, start = Math.max(0, end - (input.limit ?? 30))
      items = window.slice(start, end)
      cursor.capturedOffset += items.length
      cursor.capturedDone = start === 0
    }
    captured = { agentSessionId: timeline.agentSessionId, revision: timeline.revision, items }
  }
  if (native) {
    if (native.agentSessionId !== input.agentSessionId) throw new AgentMuxError('Native context belongs to another Session.', 'AGENT_CONTEXT_TARGET_MISMATCH')
    cursor.nativeCursor = native.nextCursor
    cursor.nativeDone = native.nextCursor === null
  }
  // The native reader may confirm and save a missing original locator. Bind that
  // durable fact once; later pages reject changes rather than mixing sources.
  const observedSources = await read('session', () => owner.sessionHistorySources())
  const current = observedSources === null ? descriptor : observedSources.find(source => source.agentSessionId === input.agentSessionId && source.hostId === input.hostId)
  if (!current) return invalidCursor()
  if (input.cursor && cursor.binding !== binding(current)) invalidCursor()
  cursor.binding = binding(current)
  const hasMore = timeline !== null && !cursor.capturedDone || native !== null && !cursor.nativeDone
  return { hostId: input.hostId, sourceHostId: current.hostId, agentSessionId: input.agentSessionId, descriptor: current,
    session: sessions?.find(session => session.agentSessionId === input.agentSessionId && session.hostId === input.hostId) ?? null,
    status, runtimeDiagnostics, captured, native, unavailable,
    nextCursor: hasMore ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null }
}
