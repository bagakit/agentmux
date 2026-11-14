import type { AgentMuxClientEvent, AgentMuxAgentSession } from './types.js'

/** Ephemeral dispatch indexes only. The original Core still owns every Session and Run. */
export class HostedSessionReaders<R> {
  private readonly full = new Set<R>()
  private readonly connections = new Set<R>()
  private readonly sessions = new Map<string, Set<R>>()
  private readonly runs = new Map<string, Set<R>>()
  private readonly scopes = new Map<R, { ids: ReadonlySet<string>; runs: Map<string, string> }>()

  add(reader: R, ids: readonly string[] | undefined): void {
    if (ids === undefined) { this.full.add(reader); return }
    this.scopes.set(reader, { ids: new Set(ids), runs: new Map() }); this.connections.add(reader)
    for (const id of ids) this.include(this.sessions, id, reader)
  }
  observe(reader: R, session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'run'>): void {
    const scope = this.scopes.get(reader)
    if (!scope?.ids.has(session.agentSessionId)) return
    const previous = scope.runs.get(session.agentSessionId)
    if (previous === session.run.runId) return
    if (previous) this.exclude(this.runs, previous, reader)
    scope.runs.set(session.agentSessionId, session.run.runId); this.include(this.runs, session.run.runId, reader)
  }
  remove(reader: R): void {
    this.full.delete(reader); this.connections.delete(reader)
    const scope = this.scopes.get(reader)
    if (!scope) return
    for (const id of scope.ids) this.exclude(this.sessions, id, reader)
    for (const run of scope.runs.values()) this.exclude(this.runs, run, reader)
    this.scopes.delete(reader)
  }
  recipients(event: AgentMuxClientEvent): Set<R> {
    const found = new Set(this.full)
    if (event.type === 'connection-state' || event.type === 'control-endpoint-state') {
      for (const reader of this.connections) found.add(reader)
      return found
    }
    const id = event.type === 'agent-session' ? event.session.agentSessionId
      : event.type === 'interaction' ? event.request.agentSessionId
      : event.type === 'agent-input' ? event.receipt.key.agentSessionId
      : 'agentSessionId' in event ? event.agentSessionId : undefined
    const run = 'run' in event ? event.run.runId : 'evidence' in event ? event.evidence.run?.runId : undefined
    for (const reader of id ? this.sessions.get(id) ?? [] : run ? this.runs.get(run) ?? [] : []) found.add(reader)
    if (event.type === 'agent-session') for (const reader of this.sessions.get(event.session.agentSessionId) ?? []) this.observe(reader, event.session)
    return found
  }
  private include(index: Map<string, Set<R>>, id: string, reader: R): void {
    const group = index.get(id) ?? new Set<R>(); group.add(reader); index.set(id, group)
  }
  private exclude(index: Map<string, Set<R>>, id: string, reader: R): void {
    const group = index.get(id); group?.delete(reader); if (!group?.size) index.delete(id)
  }
}
