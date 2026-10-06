import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { searchAgentMuxMetadata } from './search-metadata.js'
import { parseAgentMuxSearchInput, parseAgentMuxSearchPage, agentMuxSearchScope, AGENTMUX_SEARCH_MAX_BYTES } from './search-codec.js'
import { sessionHistoryQueryBudgetRecovery } from './session-history-query-budget.js'
import { parseAgentSessionHistoryReadPage, type AgentSessionHistoryReadInput, type AgentSessionHistoryReadPage } from './session-history-read-codec.js'
import type { AgentSessionHistorySource } from './types.js'
import { agentMuxSearchTargetKey, type AgentMuxSearchHistoryReference, type AgentMuxSearchInput, type AgentMuxSearchIssue,
  type AgentMuxSearchMetadataObservation, type AgentMuxSearchObjectHit, type AgentMuxSearchPage } from './search-contract.js'

export type AgentMuxSearchReadContext = { signal?: AbortSignal; authority?: string }
export type AgentMuxSearchSource = AgentMuxSearchHistoryReference & { nativeSource?: AgentSessionHistorySource }
export type AgentMuxSearchOwner<C extends AgentMuxSearchReadContext = AgentMuxSearchReadContext> = {
  metadata(input: AgentMuxSearchInput, context: C): Promise<AgentMuxSearchMetadataObservation>
  sources(input: AgentMuxSearchInput, context: C): Promise<{ sources: AgentMuxSearchSource[]; issues: AgentMuxSearchIssue[] }>
  history(input: AgentSessionHistoryReadInput, context: C): Promise<AgentSessionHistoryReadPage>
}
type Stream = { kind: 'history'; source: AgentMuxSearchSource } | { kind: 'metadata'; hits: AgentMuxSearchObjectHit[]; examined: number } | { kind: 'unavailable'; issue: AgentMuxSearchIssue }
type View = { id: string; scope: string; streams: readonly Stream[]; touchedAt: number; bytes: number }
type Position = { index: number; offset: number; completed: number; unavailable: number; sourceCursor: string | null }
type Cursor = Position & { version: 1; viewId: string; scope: string }
// Authenticated outer cursor (64 KiB) plus three bounded original reference IDs
// and framing (16 KiB); the original source page already budgets its own cursor.
const resultOverhead = 80 * 1024
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const changed = (): never => { throw new AgentMuxError('The original search continuation expired, changed scope or belongs to another reader authority. Search again; original objects and Runs remain available.', 'AGENTMUX_SEARCH_SOURCE_CHANGED') }
const scopeOf = (input: AgentMuxSearchInput, context: AgentMuxSearchReadContext) => digest(JSON.stringify([input.mode, input.query, agentMuxSearchScope(input), context.authority ?? 'sdk']))
const originalIssue = (error: unknown, source: AgentMuxSearchSource): AgentMuxSearchIssue => ({ source: source.source, hostId: source.hostId, agentSessionId: source.agentSessionId,
  code: error instanceof AgentMuxError ? error.code : 'SEARCH_SOURCE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error),
  recovery: 'Retry this exact original source with a fresh search. Existing Sessions and Runs are kept.' })

/** One read owner composes original catalogs and history readers. Leases contain
 * only frozen source references and metadata results, never conversation bodies. */
export function createAgentMuxSearchReader<C extends AgentMuxSearchReadContext = AgentMuxSearchReadContext>(owner: AgentMuxSearchOwner<C>) {
  const key = randomBytes(32), views = new Map<string, View>()
  const encode = (cursor: Cursor) => { const body = Buffer.from(JSON.stringify(cursor)).toString('base64url'); return body + '.' + createHmac('sha256', key).update(body).digest('base64url') }
  const decode = (value: string, scope: string): Cursor => {
    try {
      const [body, mac, extra] = value.split('.'); if (!body || !mac || extra) return changed()
      const expected = createHmac('sha256', key).update(body).digest(), actual = Buffer.from(mac, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return changed()
      const c = rpcRecord(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), ['version', 'viewId', 'scope', 'index', 'offset', 'completed', 'unavailable', 'sourceCursor'])
      if (c.version !== 1 || c.scope !== scope || typeof c.viewId !== 'string' || !['index', 'offset', 'completed', 'unavailable'].every(k => Number.isSafeInteger(c[k]) && (c[k] as number) >= 0) ||
        !(c.sourceCursor === null || typeof c.sourceCursor === 'string' && c.sourceCursor.length > 0 && c.sourceCursor.length <= 32768)) return changed()
      return c as Cursor
    } catch { return changed() }
  }
  const retain = (view: View) => {
    const now = Date.now()
    for (const [id, current] of views) if (now - current.touchedAt > 5 * 60_000) views.delete(id)
    views.delete(view.id); views.set(view.id, view)
    let total = [...views.values()].reduce((sum, current) => sum + current.bytes, 0)
    // Eviction ends only this reader lease. Keep one legitimate growing catalog;
    // it never limits the persistent Session population or their searchability.
    for (const [id, current] of views) {
      if (views.size <= 16 && total <= 64 * 1024 * 1024 || id === view.id) break
      views.delete(id); total -= current.bytes
    }
  }
  const read = async (raw: AgentMuxSearchInput, context: C): Promise<AgentMuxSearchPage> => {
    const input = parseAgentMuxSearchInput(raw), scope = scopeOf(input, context), maxBytes = input.maxBytes ?? 1024 * 1024
    context.signal?.throwIfAborted()
    let view: View, position: Position
    if (input.cursor) {
      const cursor = decode(input.cursor, scope), saved = views.get(cursor.viewId)
      if (!saved || saved.scope !== scope || Date.now() - saved.touchedAt > 5 * 60_000) return changed()
      view = saved; position = { index: cursor.index, offset: cursor.offset, completed: cursor.completed, unavailable: cursor.unavailable, sourceCursor: cursor.sourceCursor }
    } else {
      const streams: Stream[] = []
      if (input.mode === 'metadata') {
        const observation = await owner.metadata(input, context), result = searchAgentMuxMetadata(input.query, observation.facts), hits = new Map<string, AgentMuxSearchObjectHit>()
        if (result.issue) throw new AgentMuxError(result.issue, 'INVALID_AGENTMUX_SEARCH')
        const add = (hit: AgentMuxSearchObjectHit) => {
          if (input.hostId && hit.target.hostId !== input.hostId || input.agentSessionId && (hit.target.kind !== 'agent' || hit.target.agentSessionId !== input.agentSessionId)) return
          const key = agentMuxSearchTargetKey(hit.target), existing = hits.get(key)
          if (existing) { const seen = new Set(existing.locations.map(l => l.address)); for (const location of hit.locations) if (!seen.has(location.address)) { existing.locations.push(location); seen.add(location.address) } }
          else hits.set(key, { ...hit, locations: [...hit.locations] })
        }
        const sessionRows = new Map(observation.facts.sessions.map(row => [JSON.stringify([row.hostId, row.kind, row.agentSessionId]), row]))
        const projectRows = new Map(observation.facts.projects.map(row => [JSON.stringify([row.hostId, row.projectId]), row]))
        const regions = new Map(observation.facts.catalog.regions.map(region => [region.regionId, region]))
        const tabs = new Map(observation.facts.catalog.tabs.map(tab => [tab.tabId, tab]))
        const zones = new Map(observation.facts.catalog.zones.map(zone => [zone.zoneId, zone]))
        const spaces = new Map(observation.facts.catalog.spaces.map(space => [space.spaceId, space]))
        const agentLocations = new Map<string, AgentMuxSearchObjectHit['locations']>()
        for (const location of observation.facts.catalog.locations) {
          const region = regions.get(location.regionId)
          if (!region || region.tabId !== location.tabId || region.kind !== 'agent' || !region.agentSessionId || !region.execution) continue
          const key = JSON.stringify([region.execution.hostId, region.agentSessionId]), rows = agentLocations.get(key) ?? []
          const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
          rows.push({ reference, address: JSON.stringify(Object.values(reference)), kind: region.kind, name: tabs.get(region.tabId)?.name ?? region.regionId, sessionId: region.agentSessionId }); agentLocations.set(key, rows)
        }
        for (const session of result.sessions) {
          const original = sessionRows.get(JSON.stringify([session.hostId, session.kind, session.agentSessionId]))
          add({ kind: 'object', target: session.kind === 'agent' ? { kind: 'agent', hostId: session.hostId, agentSessionId: session.agentSessionId,
            ...(observation.sourceHostIds?.get(JSON.stringify([session.hostId, session.agentSessionId])) ? { sourceHostId: observation.sourceHostIds.get(JSON.stringify([session.hostId, session.agentSessionId]))! } : {}) } : { kind: 'terminal', hostId: session.hostId, terminalId: session.agentSessionId },
            name: original?.text.find(Boolean) ?? session.agentSessionId, locations: session.kind === 'agent' ? agentLocations.get(JSON.stringify([session.hostId, session.agentSessionId])) ?? [] : [] })
        }
        for (const project of result.projects) add({ kind: 'object', target: { kind: 'project', ...project }, name: projectRows.get(JSON.stringify([project.hostId, project.projectId]))?.name ?? project.projectId, locations: [] })
        for (const object of result.objects) add({ kind: 'object', target: object.target, name: object.name, locations: [...object.locations] })
        for (const location of result.locations) {
          const region = regions.get(location.reference.regionId), tab = region && tabs.get(region.tabId)
          const hostId = region?.execution?.hostId ?? (tab?.zoneId ? zones.get(tab.zoneId)?.hostId : null)
          add({ kind: 'object', target: { kind: 'region', regionId: location.reference.regionId, ...(hostId ? { hostId } : {}) }, name: location.name, locations: [location] })
        }
        for (const object of result.unplaced) {
          const tab = object.kind === 'tab' ? tabs.get(object.id) : object.kind === 'region' ? tabs.get(regions.get(object.id)?.tabId ?? '') : undefined
          const hostId = object.kind === 'space' ? spaces.get(object.id)?.hostId : object.kind === 'zone' ? zones.get(object.id)?.hostId : object.kind === 'region' ? regions.get(object.id)?.execution?.hostId ?? (tab?.zoneId ? zones.get(tab.zoneId)?.hostId : null) : tab?.zoneId ? zones.get(tab.zoneId)?.hostId : null
          const target = { kind: object.kind, [object.kind + 'Id']: object.id, ...(hostId ? { hostId } : {}) } as AgentMuxSearchObjectHit['target']
          add({ kind: 'object', target, name: object.name, locations: [] })
        }
        streams.push({ kind: 'metadata', hits: [...hits.values()], examined: observation.facts.sessions.length + observation.facts.sources.length + observation.facts.projects.length +
          observation.facts.catalog.spaces.length + observation.facts.catalog.zones.length + observation.facts.catalog.tabs.length + observation.facts.catalog.regions.length + (observation.facts.objects?.length ?? 0) })
        streams.push(...observation.issues.map(issue => ({ kind: 'unavailable' as const, issue })))
      } else {
        const discovery = await owner.sources(input, context), seen = new Set<string>()
        for (const source of discovery.sources) {
          if (input.hostId && source.hostId !== input.hostId || input.agentSessionId && source.agentSessionId !== input.agentSessionId || input.source && source.source !== input.source) continue
          const key = JSON.stringify([source.hostId, source.agentSessionId, source.source]); if (seen.has(key)) continue
          seen.add(key); streams.push({ kind: 'history', source })
        }
        streams.push(...discovery.issues.map(issue => ({ kind: 'unavailable' as const, issue })))
      }
      context.signal?.throwIfAborted()
      view = { id: randomUUID(), scope, streams, touchedAt: Date.now(), bytes: size(streams) }; retain(view)
      position = { index: 0, offset: 0, completed: 0, unavailable: 0, sourceCursor: null }
    }
    if (position.index > view.streams.length || position.completed + position.unavailable !== position.index) return changed()
    view.touchedAt = Date.now(); retain(view)
    const result: AgentMuxSearchPage = { mode: input.mode, query: input.query, scope: agentMuxSearchScope(input), hits: [], nextCursor: null, budgetBytes: maxBytes,
      coverage: { complete: false, examined: 0, totalSources: view.streams.length, completedSources: position.completed, remainingSources: view.streams.length - position.index, unavailableCount: position.unavailable, unavailable: [] } }
    const pageStart = { ...position }
    const cursor = () => encode({ version: 1, viewId: view.id, scope, ...position })
    const finish = () => {
      result.nextCursor = position.index < view.streams.length ? cursor() : null
      result.coverage = { ...result.coverage, complete: result.nextCursor === null && position.unavailable === 0, completedSources: position.completed,
        remainingSources: view.streams.length - position.index, unavailableCount: position.unavailable }
      if (size(result) > maxBytes) budget(size(result) + 16, pageStart)
      return parseAgentMuxSearchPage(result, input)
    }
    const budget = (requiredBytes: number, resume: Position = position): never => { throw new AgentMuxError('The original search result needs a larger read budget; continue the exact returned cursor. No record was truncated or Run operated.',
      'AGENTMUX_SEARCH_BUDGET', JSON.stringify({ phase: 'search-result', requiredBytes, maxBytes: AGENTMUX_SEARCH_MAX_BYTES, cursor: encode({ version: 1, viewId: view.id, scope, ...resume }) })) }
    for (let pages = 0; pages < 8 && position.index < view.streams.length && result.hits.length < (input.limit ?? 30); pages++) {
      context.signal?.throwIfAborted()
      const stream = view.streams[position.index]!
      if (stream.kind === 'unavailable') {
        if (size({ ...result, nextCursor: cursor(), coverage: { ...result.coverage, unavailable: [...result.coverage.unavailable, stream.issue] } }) + 4096 > maxBytes) {
          if (result.hits.length || result.coverage.unavailable.length) break
          budget(size(result) + size(stream.issue) + 8192)
        }
        result.coverage.unavailable.push(stream.issue); position.unavailable++; position.index++; continue
      }
      if (stream.kind === 'metadata') {
        if (position.offset === 0) result.coverage.examined += stream.examined
        while (position.offset < stream.hits.length && result.hits.length < (input.limit ?? 30)) {
          const hit = stream.hits[position.offset]!
          if (size({ ...result, hits: [...result.hits, hit], nextCursor: cursor() }) + 4096 > maxBytes) {
            if (result.hits.length) return finish()
            budget(size(result) + size(hit) + 8192)
          }
          result.hits.push(hit); position.offset++
        }
        if (position.offset === stream.hits.length) { position.index++; position.completed++; position.offset = 0 }
        continue
      }
      const remaining = (input.scanLimit ?? 1600) - result.coverage.examined
      if (remaining <= 0) break
      const available = maxBytes - size(result) - resultOverhead
      if (available < 4096) {
        if (result.hits.length || result.coverage.unavailable.length) break
        budget(size(result) + resultOverhead + 4096 + 1024)
      }
      const sourceBudget = Math.max(4096, Math.min(16 * 1024 * 1024, available)), source = stream.source
      try {
        const sourceInput: AgentSessionHistoryReadInput = { hostId: source.hostId, agentSessionId: source.agentSessionId, source: source.source, kind: 'text', query: input.query,
          limit: 1, scanLimit: Math.min(1000, remaining), maxBytes: sourceBudget, ...(position.sourceCursor ? { cursor: position.sourceCursor } : {}) }
        const page = parseAgentSessionHistoryReadPage(await owner.history(sourceInput, context), sourceInput)
        context.signal?.throwIfAborted()
        if (page.hostId !== source.hostId || page.agentSessionId !== source.agentSessionId || page.source !== source.source || page.kind !== 'text' || !page.scan ||
          source.source === 'native' && (!source.nativeSource || page.nativeSource?.providerId !== source.nativeSource.providerId || page.nativeSource.nativeSessionId !== source.nativeSource.nativeSessionId)) {
          throw new AgentMuxError('The history result names another original conversation and was not accepted; retry this source with a fresh search.', 'AGENTMUX_SEARCH_SOURCE_CHANGED')
        }
        if (page.nextCursor && page.nextCursor === position.sourceCursor) throw new AgentMuxError('The original history continuation did not advance.', 'CONTROL_PROTOCOL_ERROR')
        result.coverage.examined += page.scan.examined
        if (page.items.length) {
          const hit = { kind: 'history' as const, reference: { hostId: source.hostId, sourceHostId: source.sourceHostId, agentSessionId: source.agentSessionId, source: source.source }, page }
          if (size({ ...result, hits: [...result.hits, hit], nextCursor: cursor() }) > maxBytes) throw new AgentMuxError('The original source exceeded its negotiated search envelope.', 'CONTROL_PROTOCOL_ERROR')
          result.hits.push(hit)
        }
        if (page.nextCursor) position.sourceCursor = page.nextCursor
        else { position.index++; position.completed++; position.sourceCursor = null }
      } catch (error) {
        context.signal?.throwIfAborted()
        const recovery = sessionHistoryQueryBudgetRecovery(error, sourceBudget)
        if (recovery) {
          position.sourceCursor = recovery.cursor
          if (result.hits.length || result.coverage.unavailable.length) return finish()
          budget(recovery.maxBytes + size(result) + resultOverhead + 1024)
        }
        const issue = originalIssue(error, source)
        if (size({ ...result, nextCursor: cursor(), coverage: { ...result.coverage, unavailable: [...result.coverage.unavailable, issue] } }) + 4096 > maxBytes) {
          if (result.hits.length || result.coverage.unavailable.length) return finish()
          budget(size(result) + size(issue) + 8192)
        }
        result.coverage.unavailable.push(issue); position.index++; position.unavailable++; position.sourceCursor = null
      }
    }
    context.signal?.throwIfAborted()
    return finish()
  }
  return { read, dispose() { views.clear() } }
}
