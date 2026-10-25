import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcCount, rpcRecord, rpcString } from './rpc-business-codec.js'
import { currentAgentSemanticStatus, isAgentActivityStatusSource, type AgentObservation } from './agent-status-freshness.js'
import type { AgentMuxClient, AgentMuxAgentRuntimeStatus } from './client.js'
import type { AgentMuxAgentSession, AgentSessionHistoryDescriptor, AgentStatus } from './types.js'

export type AgentDiscoveryFilters = {
  agentSessionId?: string; executorId?: string; providerId?: string
  /** Original process state. Semantic activity is selected independently. */
  status?: string; semantic?: AgentObservation['semantic']; readiness?: AgentObservation['readiness']
  /** Original metadata update, not activity. */
  since?: number
  activitySince?: number; cursor?: string; limit?: number
}
export type AgentDiscoveryActivity = Pick<AgentStatus, 'state' | 'source' | 'observedAt' | 'nativeTurnId'> & {
  run: AgentMuxAgentSession['run']
}
export type AgentDiscoveryObservation = AgentMuxAgentRuntimeStatus & { routeHostId: string; lastActivity: AgentDiscoveryActivity | null }
export type AgentDiscoveryPage = {
  sessions: AgentDiscoveryObservation[]
  unavailableSessions: Array<{ routeHostId: string; session: AgentMuxAgentSession; code: string; message: string; lastActivity: AgentDiscoveryActivity | null }>
  retired: Array<AgentSessionHistoryDescriptor & { routeHostId: string }>
  errors: Array<{ agentSessionId: string | null; hostId: string; code: string; message: string }>
  nextCursor: string | null
}
type Owner = Pick<AgentMuxClient, 'readAgentSession' | 'readAgentSessions' | 'sessionHistorySources' | 'statusAgent' | 'readAgentMessageQueuePath'> & { forwardRpc?: unknown }
type Scope = { hostId: string; client: Owner }
type Candidate = { key: string; scope: Scope } & ({ session: AgentMuxAgentSession; retired?: never } | { retired: AgentSessionHistoryDescriptor; session?: never })

/** A historical typed event, never current work, polling time or metadata edit time. */
export function agentDiscoveryActivity(session: AgentMuxAgentSession): AgentDiscoveryActivity | null {
  const retained = session.semanticStatus
  if (!retained || !isAgentActivityStatusSource(retained.source)) return null
  const projected = currentAgentSemanticStatus(retained)
  const activity = projected?.state === 'running' ? retained : projected
  if (!activity || !['working', 'waiting', 'blocked', 'done', 'error'].includes(activity.state)) return null
  return { state: activity.state, source: activity.source, observedAt: activity.observedAt, run: { ...session.run },
    ...(activity.nativeTurnId === undefined || activity !== retained && retained.aggregateActivityAt !== undefined
      ? {} : { nativeTurnId: activity.nativeTurnId }) }
}

export function parseAgentDiscoveryFilters(value: unknown): AgentDiscoveryFilters {
  const p = rpcRecord(value, ['agentSessionId', 'executorId', 'providerId', 'status', 'semantic', 'readiness', 'since', 'activitySince', 'cursor', 'limit'])
  const result: AgentDiscoveryFilters = {}
  for (const name of ['agentSessionId', 'executorId', 'providerId', 'status', 'cursor'] as const)
    if (p[name] !== undefined) result[name] = rpcString(p[name], name)
  if (p.semantic !== undefined) {
    if (!['active', 'idle', 'awaiting-input', 'unknown', 'unsupported'].includes(String(p.semantic))) throw new AgentMuxError('Unknown semantic filter.', 'INVALID_CONTROL_REQUEST')
    result.semantic = p.semantic as AgentObservation['semantic']
  }
  if (p.readiness !== undefined) {
    if (!['ready', 'pending', 'unknown'].includes(String(p.readiness))) throw new AgentMuxError('Unknown readiness filter.', 'INVALID_CONTROL_REQUEST')
    result.readiness = p.readiness as AgentObservation['readiness']
  }
  for (const name of ['since', 'activitySince'] as const) if (p[name] !== undefined) result[name] = rpcCount(p[name], 0)
  result.limit = p.limit === undefined ? 100 : rpcCount(p.limit, 100, 1000)
  if (result.limit < 1) throw new AgentMuxError('A discovery page must inspect at least one candidate.', 'INVALID_CONTROL_REQUEST')
  return result
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const issue = (error: unknown) => ({ code: error instanceof AgentMuxError ? error.code : 'AGENT_DISCOVERY_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) })
const invalidCursor = (): never => { throw new AgentMuxError('Discovery cursor belongs to another route, participant filter or position. Read a fresh first page.', 'AGENT_DISCOVERY_CURSOR_INVALID') }

/** First narrow metadata; only this page's candidates incur a Runtime status read. */
export async function readAgentDiscovery(scopes: readonly Scope[], filters: AgentDiscoveryFilters): Promise<AgentDiscoveryPage> {
  const { cursor, limit = 100, ...selection } = filters
  const namespaces = await Promise.allSettled(scopes.map(async scope => await scope.client.readAgentMessageQueuePath()))
  // Unknown namespaces stay explicit in the cursor. Recovery or owner replacement
  // requires a fresh first page rather than silently omitting a newly available source.
  const binding = hash({ selection, owners: scopes.map((scope, index) => {
    const namespace = namespaces[index]!
    return [scope.hostId, namespace.status === 'fulfilled' ? namespace.value : null]
  }).sort() })
  let after = ''
  if (cursor !== undefined) {
    try {
      const p = rpcRecord(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), ['binding', 'after'])
      if (p.binding !== binding || typeof p.after !== 'string' || !p.after) invalidCursor()
      after = p.after as string
    } catch { invalidCursor() }
  }
  const page: AgentDiscoveryPage = { sessions: [], unavailableSessions: [], retired: [], errors: [], nextCursor: null }
  const candidates: Candidate[] = []
  await Promise.all(scopes.map(async (scope, index) => {
    const namespace = namespaces[index]!
    if (namespace.status === 'rejected') {
      page.errors.push({ hostId: scope.hostId, agentSessionId: filters.agentSessionId ?? null, ...issue(namespace.reason) })
      return
    }
    const sourceHost = scope.client.forwardRpc ? 'local' : scope.hostId
    const [active, history] = await Promise.allSettled([
      filters.agentSessionId ? scope.client.readAgentSession(filters.agentSessionId).then(value => value ? [value] : []) : scope.client.readAgentSessions(),
      scope.client.sessionHistorySources(filters.agentSessionId ? { agentSessionId: filters.agentSessionId } : {})
    ])
    const sessions = active.status === 'fulfilled' ? active.value.filter(session => session.hostId === sourceHost) : []
    const activeIds = new Set(sessions.map(session => session.agentSessionId))
    if (active.status === 'rejected') page.errors.push({ hostId: scope.hostId, agentSessionId: filters.agentSessionId ?? null, ...issue(active.reason) })
    if (history.status === 'rejected') page.errors.push({ hostId: scope.hostId, agentSessionId: filters.agentSessionId ?? null, ...issue(history.reason) })
    for (const session of sessions) {
      if (filters.agentSessionId && session.agentSessionId !== filters.agentSessionId || filters.executorId && session.executorId !== filters.executorId ||
          filters.providerId && session.providerId !== filters.providerId || filters.since !== undefined && session.updatedAt < filters.since) continue
      const activity = agentDiscoveryActivity(session)
      if (filters.activitySince !== undefined && (!activity || activity.observedAt < filters.activitySince)) continue
      candidates.push({ key: JSON.stringify([scope.hostId, session.agentSessionId]), scope, session })
    }
    if (history.status === 'fulfilled' && !filters.status && !filters.semantic && !filters.readiness && filters.since === undefined && filters.activitySince === undefined)
      for (const retired of history.value) {
        if (retired.hostId !== sourceHost || retired.state !== 'retired' || activeIds.has(retired.agentSessionId) ||
            filters.agentSessionId && retired.agentSessionId !== filters.agentSessionId || filters.executorId && retired.history?.executorId !== filters.executorId ||
            filters.providerId && retired.history?.providerId !== filters.providerId) continue
        candidates.push({ key: JSON.stringify([scope.hostId, retired.agentSessionId]), scope, retired })
      }
  }))
  candidates.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const relevant = candidates.filter(item => item.key > after), selected = relevant.slice(0, limit)
  if (relevant.length > limit) page.nextCursor = Buffer.from(JSON.stringify({ binding, after: selected.at(-1)!.key })).toString('base64url')
  await Promise.all(selected.map(async candidate => {
    const { scope } = candidate
    if (candidate.retired) { page.retired.push({ ...candidate.retired, routeHostId: scope.hostId }); return }
    const session = candidate.session, lastActivity = agentDiscoveryActivity(session)
    try {
      const observed = await scope.client.statusAgent(session.agentSessionId)
      if (observed.session.agentSessionId !== session.agentSessionId || observed.session.run.runId !== session.run.runId)
        throw new AgentMuxError('Original Session changed during discovery. Read this exact identity again.', 'STALE_AGENT_SESSION')
      if (filters.status && observed.observation.process !== filters.status || filters.semantic && observed.observation.semantic !== filters.semantic ||
          filters.readiness && observed.observation.readiness !== filters.readiness) return
      if (filters.executorId && observed.session.executorId !== filters.executorId || filters.providerId && observed.session.providerId !== filters.providerId ||
          filters.since !== undefined && observed.session.updatedAt < filters.since || filters.activitySince !== undefined &&
          (agentDiscoveryActivity(observed.session)?.observedAt ?? -Infinity) < filters.activitySince) return
      page.sessions.push({ ...observed, routeHostId: scope.hostId, lastActivity: agentDiscoveryActivity(observed.session) })
    } catch (error) {
      const failure = issue(error)
      page.unavailableSessions.push({ routeHostId: scope.hostId, session, lastActivity, ...failure })
      page.errors.push({ hostId: scope.hostId, agentSessionId: session.agentSessionId, ...failure })
    }
  }))
  for (const entries of [page.sessions, page.unavailableSessions]) entries.sort((a, b) => a.routeHostId.localeCompare(b.routeHostId) || a.session.agentSessionId.localeCompare(b.session.agentSessionId))
  page.retired.sort((a, b) => a.routeHostId.localeCompare(b.routeHostId) || a.agentSessionId.localeCompare(b.agentSessionId))
  return page
}
