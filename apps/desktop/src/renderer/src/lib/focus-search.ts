import { searchAgentMuxMetadata, agentMuxSearchSessionKey, type AgentMuxSearchSession, type AgentMuxSearchLocation } from '@agentmux/core/search'
import type { AgentMuxSpaceCatalog, AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { AgentFocusHistoryEntry } from './agent-focus'
import type { FocusContext } from './focus-context'
import { focusProjectKey, type FocusProjectLane, type FocusRetainedProject } from './focus-project-lanes'

export const focusSearchContextKey = agentMuxSearchSessionKey
export type FocusSearchLocation = AgentMuxSearchLocation

/** Adapt already observed client facts; Core owns every matching and identity rule. */
export function searchFocus(query: string, input: {
 rows: readonly FocusContext[]; lanes: readonly FocusProjectLane[]; catalog: AgentMuxSpaceCatalog
 sources: readonly AgentSessionHistoryDescriptor[]; history: readonly AgentFocusHistoryEntry[]; retained: readonly FocusRetainedProject[]
}) {
 const sessions: AgentMuxSearchSession[] = input.rows.map(row => ({ agentSessionId: row.id, hostId: row.hostId, kind: row.kind,
  workspaceId: row.workspaceId, topicId: row.topicId, identities: [row.runId, row.nativeSessionId, ...row.retainedRunIds ?? []].filter((id): id is string => Boolean(id)),
  text: [row.name, row.detail, row.recap?.text ?? '', row.stateLabel, row.workspacePath, row.workspaceName, row.providerId ?? ''] }))
 const kinds = new Map<string, Set<FocusContext['kind']>>()
 for (const row of input.rows) { const key = JSON.stringify([row.hostId, row.id]), values = kinds.get(key) ?? new Set<FocusContext['kind']>(); values.add(row.kind); kinds.set(key, values) }
 for (const lane of input.lanes) for (const id of lane.contextIds) {
  for (const kind of kinds.get(JSON.stringify([lane.hostId, id])) ?? []) sessions.push({ agentSessionId: id, hostId: lane.hostId, kind, identities: [lane.workspaceId, lane.projectWorkspaceId, lane.topicId].filter((id): id is string => Boolean(id)), text: [lane.name] })
 }
 for (const entry of input.history) if (entry.identity) {
  const saved = entry.identity
  sessions.push({ agentSessionId: entry.sessionId, hostId: saved.hostId, kind: saved.kind,
   identities: [saved.project?.id, saved.topicId].filter((id): id is string => Boolean(id)),
   text: [saved.name, saved.workspacePath, saved.project?.name ?? '', saved.branch ?? '', saved.topicId ?? ''] })
 }
 const members = new Map<string, string[]>()
 for (const entry of input.history) if (entry.identity?.project) {
  const key = focusProjectKey(entry.identity.hostId, entry.identity.project.id), ids = members.get(key) ?? []
  ids.push(entry.sessionId); members.set(key, ids)
 }
 const result = searchAgentMuxMetadata(query, { sessions, catalog: input.catalog, sources: input.sources,
  projects: input.retained.map(project => ({ hostId: project.hostId, projectId: project.projectId, name: project.name, sessionIds: members.get(project.key) ?? [] })) })
 const contextKeys = new Set(result.sessions.map(session => agentMuxSearchSessionKey(session.hostId, session.agentSessionId, session.kind)))
 const rowKeys = new Set(input.rows.map(row => agentMuxSearchSessionKey(row.hostId, row.id, row.kind)))
 return { contextKeys, projectKeys: new Set(result.projects.map(project => focusProjectKey(project.hostId, project.projectId))),
  locations: result.locations, unplaced: result.unplaced, issue: result.issue,
  sources: query.trim() ? input.sources.filter(source => contextKeys.has(agentMuxSearchSessionKey(source.hostId, source.agentSessionId)) && !rowKeys.has(agentMuxSearchSessionKey(source.hostId, source.agentSessionId))) : [] }
}
