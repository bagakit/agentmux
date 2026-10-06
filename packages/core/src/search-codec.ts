import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseAmuxObjectLink } from './sharing.js'
import { parseAgentSessionHistoryReadPage } from './session-history-read-codec.js'
import { agentMuxSearchTargetKey, type AgentMuxSearchInput, type AgentMuxSearchPage, type AgentMuxSearchTarget } from './search-contract.js'

/** Search may carry a complete original 16 MiB history page plus its provenance;
 * its envelope stays below the original 64 MiB public transport frame budget. */
export const AGENTMUX_SEARCH_MAX_BYTES = 32 * 1024 * 1024
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const fail = (message: string, code = 'INVALID_AGENTMUX_SEARCH'): never => { throw new AgentMuxError(message, code) }
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value) && bytes(value) <= 4096
const count = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
export const agentMuxSearchScope = ({ hostId, agentSessionId, source }: AgentMuxSearchInput) => ({ ...(hostId ? { hostId } : {}), ...(agentSessionId ? { agentSessionId } : {}), ...(source ? { source } : {}) })

export function parseAgentMuxSearchInput(value: unknown): AgentMuxSearchInput {
  const p = rpcRecord(value, ['mode', 'query', 'hostId', 'agentSessionId', 'source', 'limit', 'scanLimit', 'maxBytes', 'cursor'])
  if ((typeof p.mode !== 'string' || !['metadata', 'history'].includes(p.mode)) || typeof p.query !== 'string' || p.query.includes('\0') || bytes(p.query) > 4096 ||
    ['hostId', 'agentSessionId'].some(key => p[key] !== undefined && !id(p[key])) || p.agentSessionId !== undefined && p.hostId === undefined ||
    p.agentSessionId === 'self' || p.source !== undefined && (p.mode !== 'history' || (typeof p.source !== 'string' || !['captured', 'native'].includes(p.source))) ||
    !count(p.limit ?? 30, 1, 100) || !count(p.maxBytes ?? 1024 * 1024, 4096, AGENTMUX_SEARCH_MAX_BYTES) ||
    p.scanLimit !== undefined && (p.mode !== 'history' || !count(p.scanLimit, 1, 10000)) ||
    p.cursor !== undefined && (typeof p.cursor !== 'string' || !p.cursor || /[\0\r\n]/u.test(p.cursor) || p.cursor.length > 65536)) {
    return fail('Search requires metadata/history mode, literal query, exact optional Host/Session scope, and bounded result/scan/byte budgets.')
  }
  if (p.mode === 'metadata' && /^amux:/iu.test(p.query.trim())) {
    try { parseAmuxObjectLink(p.query.trim()) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  }
  return p as AgentMuxSearchInput
}

function target(value: unknown): AgentMuxSearchTarget {
  const t = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR')
  const fields: Record<string, readonly string[]> = {
    agent: ['agentSessionId', 'hostId', 'sourceHostId'], terminal: ['terminalId', 'hostId'],
    project: ['projectId', 'hostId'], workspace: ['workspaceId', 'hostId'], topic: ['topicId', 'hostId'], mote: ['topicId', 'hostId'],
    space: ['spaceId', 'hostId'], zone: ['zoneId', 'hostId'], tab: ['tabId', 'hostId'], region: ['regionId', 'hostId']
  }
  const allowed = fields[String(t.kind)]
  if (typeof t.kind !== 'string' || !allowed || Object.keys(t).some(key => key !== 'kind' && !allowed.includes(key)) || !id(t[allowed[0]!]) ||
    ['hostId', 'sourceHostId'].some(key => t[key] !== undefined && !id(t[key])) ||
    ['agent', 'terminal', 'project', 'workspace', 'topic', 'mote'].includes(String(t.kind)) && !id(t.hostId)) return fail('Search target has no exact original typed identity.', 'CONTROL_PROTOCOL_ERROR')
  return t as AgentMuxSearchTarget
}

export function parseAgentMuxSearchPage(value: unknown, input: AgentMuxSearchInput): AgentMuxSearchPage {
  const bad = (): never => fail('Search result is malformed, over budget or belongs to another query/scope.', 'CONTROL_PROTOCOL_ERROR')
  const p = rpcRecord(value, ['mode', 'query', 'scope', 'hits', 'nextCursor', 'budgetBytes', 'coverage'], 'CONTROL_PROTOCOL_ERROR')
  const scope = rpcRecord(p.scope, ['hostId', 'agentSessionId', 'source'], 'CONTROL_PROTOCOL_ERROR'), expected = agentMuxSearchScope(input)
  if (p.mode !== input.mode || p.query !== input.query || Object.keys(scope).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => scope[key] !== value) || p.budgetBytes !== (input.maxBytes ?? 1024 * 1024) ||
    bytes(JSON.stringify(p)) > (input.maxBytes ?? 1024 * 1024) || !Array.isArray(p.hits) || p.hits.length > (input.limit ?? 30) ||
    !(p.nextCursor === null || typeof p.nextCursor === 'string' && p.nextCursor.length > 0 && p.nextCursor.length <= 65536)) return bad()
  const c = rpcRecord(p.coverage, ['complete', 'examined', 'totalSources', 'completedSources', 'remainingSources', 'unavailableCount', 'unavailable'], 'CONTROL_PROTOCOL_ERROR')
  for (const key of ['examined', 'totalSources', 'completedSources', 'remainingSources', 'unavailableCount']) if (!count(c[key], 0, Number.MAX_SAFE_INTEGER)) return bad()
  if (typeof c.complete !== 'boolean' || (c.completedSources as number) + (c.remainingSources as number) + (c.unavailableCount as number) !== c.totalSources ||
    c.complete !== (p.nextCursor === null && c.unavailableCount === 0) || (p.nextCursor !== null) !== ((c.remainingSources as number) > 0) ||
    input.mode === 'history' && (c.examined as number) > (input.scanLimit ?? 1600) || !Array.isArray(c.unavailable) || c.unavailable.length > (c.unavailableCount as number)) return bad()
  for (const issue of c.unavailable) {
    const row = rpcRecord(issue, ['source', 'hostId', 'agentSessionId', 'code', 'message', 'recovery'], 'CONTROL_PROTOCOL_ERROR')
    if (!id(row.source) || !id(row.code) || typeof row.message !== 'string' || typeof row.recovery !== 'string' || !row.recovery ||
      ['hostId', 'agentSessionId'].some(key => row[key] !== undefined && !id(row[key])) || input.hostId && row.hostId !== undefined && row.hostId !== input.hostId) return bad()
  }
  const seen = new Set<string>()
  for (const hit of p.hits) {
    const h = rpcRecord(hit, undefined, 'CONTROL_PROTOCOL_ERROR')
    if (h.kind === 'history' && input.mode === 'history') {
      rpcRecord(h, ['kind', 'reference', 'page'], 'CONTROL_PROTOCOL_ERROR')
      const ref = rpcRecord(h.reference, ['hostId', 'sourceHostId', 'agentSessionId', 'source'], 'CONTROL_PROTOCOL_ERROR')
      if (![ref.hostId, ref.sourceHostId, ref.agentSessionId].every(id) || (typeof ref.source !== 'string' || !['captured', 'native'].includes(ref.source)) ||
        input.hostId && ref.hostId !== input.hostId || input.agentSessionId && ref.agentSessionId !== input.agentSessionId || input.source && ref.source !== input.source) return bad()
      const original = rpcRecord(h.page, undefined, 'CONTROL_PROTOCOL_ERROR')
      if (!count(original.budgetBytes, 4096, 16 * 1024 * 1024)) return bad()
      const page = parseAgentSessionHistoryReadPage(h.page, { hostId: ref.hostId as string, agentSessionId: ref.agentSessionId as string, source: ref.source as 'captured' | 'native', kind: 'text', query: input.query, limit: 1, scanLimit: 1000, maxBytes: original.budgetBytes as number })
      if (page.items.length !== 1 || page.items[0]!.kind !== 'item') return bad()
      const key = JSON.stringify([ref.hostId, ref.agentSessionId, ref.source, page.nativeSource, page.items[0]!.item.id])
      if (seen.has(key)) return bad(); seen.add(key)
    } else if (h.kind === 'object' && input.mode === 'metadata') {
      rpcRecord(h, ['kind', 'target', 'name', 'locations'], 'CONTROL_PROTOCOL_ERROR')
      const original = target(h.target)
      if (typeof h.name !== 'string' || !Array.isArray(h.locations) || input.hostId && original.hostId !== input.hostId ||
        input.agentSessionId && (original.kind !== 'agent' || original.agentSessionId !== input.agentSessionId)) return bad()
      for (const location of h.locations) {
        const l = rpcRecord(location, ['reference', 'name', 'kind', 'address', 'sessionId'], 'CONTROL_PROTOCOL_ERROR')
        const ref = rpcRecord(l.reference, ['displayWorkspaceId', 'groupId', 'tabId', 'regionId'], 'CONTROL_PROTOCOL_ERROR')
        if (!Object.values(ref).every(id) || Object.keys(ref).length !== 4 || typeof l.name !== 'string' || !id(l.kind) || !id(l.address) || !(l.sessionId === null || id(l.sessionId))) return bad()
      }
      const key = agentMuxSearchTargetKey(original); if (seen.has(key)) return bad(); seen.add(key)
    } else return bad()
  }
  return p as AgentMuxSearchPage
}

/** Shared SDK recovery follows only this search owner's exact query cursor. */
export async function readAgentMuxSearch(input: AgentMuxSearchInput, read: (input: AgentMuxSearchInput, signal?: AbortSignal) => Promise<AgentMuxSearchPage>,
  options: { signal?: AbortSignal; current?: () => boolean } = {}): Promise<AgentMuxSearchPage> {
  let query = input
  // A small caller budget may first need the query envelope, then the original
  // record. Both retries follow monotonically larger exact owner receipts.
  for (let recoveries = 0; ; recoveries++) {
    options.signal?.throwIfAborted()
    try {
      const page = await read(query, options.signal)
      options.signal?.throwIfAborted()
      return parseAgentMuxSearchPage(page, query)
    } catch (error) {
      const failure = error as { code?: unknown; detail?: unknown }; let receipt: { phase?: unknown; cursor?: string; requiredBytes?: number; maxBytes?: number } = {}
      if (failure?.code === 'AGENTMUX_SEARCH_BUDGET' && typeof failure.detail === 'string') { try { receipt = JSON.parse(failure.detail) } catch { /* Keep original failure. */ } }
      if (recoveries >= 2 || options.signal?.aborted || options.current?.() === false || receipt.phase !== 'search-result' ||
        !(typeof receipt.cursor === 'string' && receipt.cursor.length > 0 && receipt.cursor.length <= 65536 && !/[\0\r\n]/u.test(receipt.cursor)) ||
        !count(receipt.requiredBytes, (query.maxBytes ?? 1024 * 1024) + 1, AGENTMUX_SEARCH_MAX_BYTES) || receipt.maxBytes !== AGENTMUX_SEARCH_MAX_BYTES) throw error
      query = { ...query, cursor: receipt.cursor!, maxBytes: receipt.requiredBytes! }
    }
  }
}
