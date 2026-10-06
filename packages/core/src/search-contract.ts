import type { AmuxObjectLinkTarget } from './sharing.js'
import type { AgentSessionHistoryReadPage } from './session-history-read-codec.js'
import type { AgentMuxSearchLocation, AgentMuxSearchMetadata } from './search-metadata.js'

export type AgentMuxSearchInput = {
  mode: 'metadata' | 'history'; query: string
  /** Host is the exact endpoint route; a Session selector also requires that Host. */
  hostId?: string; agentSessionId?: string; source?: 'captured' | 'native'
  limit?: number; scanLimit?: number; maxBytes?: number; cursor?: string
}
export type AgentMuxSearchTarget =
  | (AmuxObjectLinkTarget & { hostId?: string; sourceHostId?: string })
  | { kind: 'terminal'; hostId: string; terminalId: string }
  | { kind: 'project'; hostId: string; projectId: string }
  | { kind: 'workspace'; hostId: string; workspaceId: string }
  | { kind: 'topic' | 'mote'; hostId: string; topicId: string }
export const agentMuxSearchTargetKey = (target: AgentMuxSearchTarget) => JSON.stringify([target.kind, target.hostId ?? null,
  target.kind === 'agent' ? target.agentSessionId : target.kind === 'terminal' ? target.terminalId : target.kind === 'project' ? target.projectId : target.kind === 'workspace' ? target.workspaceId : target.kind === 'topic' || target.kind === 'mote' ? target.topicId : target.kind === 'space' ? target.spaceId : target.kind === 'zone' ? target.zoneId : target.kind === 'tab' ? target.tabId : target.kind === 'region' ? target.regionId : target.topicId])
export type AgentMuxSearchObjectHit = { kind: 'object'; target: AgentMuxSearchTarget; name: string; locations: AgentMuxSearchLocation[] }
export type AgentMuxSearchHistoryReference = { hostId: string; sourceHostId: string; agentSessionId: string; source: 'captured' | 'native' }
export type AgentMuxSearchHistoryHit = { kind: 'history'; reference: AgentMuxSearchHistoryReference; page: AgentSessionHistoryReadPage }
export type AgentMuxSearchHit = AgentMuxSearchObjectHit | AgentMuxSearchHistoryHit
export type AgentMuxSearchIssue = { source: string; hostId?: string; agentSessionId?: string; code: string; message: string; recovery: string }
export type AgentMuxSearchPage = {
  mode: AgentMuxSearchInput['mode']; query: string
  scope: Pick<AgentMuxSearchInput, 'hostId' | 'agentSessionId' | 'source'>
  hits: AgentMuxSearchHit[]; nextCursor: string | null; budgetBytes: number
  coverage: {
    complete: boolean; examined: number; totalSources: number; completedSources: number; remainingSources: number
    /** Cumulative failed sources; details below belong to this page and must be retained on continuation. */
    unavailableCount: number; unavailable: AgentMuxSearchIssue[]
  }
}
/** Original observations supplement the same pure metadata matcher, never an index or a second owner. */
export type AgentMuxSearchMetadataObservation = {
  facts: AgentMuxSearchMetadata
  issues: AgentMuxSearchIssue[]
  sourceHostIds?: ReadonlyMap<string, string>
}
