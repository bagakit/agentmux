import type { SpaceAuthorityRef, SpaceAuthoritySource } from './space-authority.js'
import type { AgentMuxHostedAgentSessionSummary } from './hosted-session-summary.js'
import type { AgentMuxClientEvent } from './types.js'

/** All aliases belong to the answering Space Core. Runtime/SID are semantic identity;
 * a null Host or Runtime stays unknown and never means the observing client. */
/** Source-owned presentation only. Access to this Space is a separate route;
 * an adopted execution chain is never reconstructed from current Host choices. */
export type SpaceSessionOccurrence = {
  regionId: string
  creationOperationId?: string
  projectRuntimeId: string | null
  agentRuntimeId: string | null
  executionRoute: { kind: 'same' } | { kind: 'adopted'; route: import('./host-route.js').AdoptedHostRoute } | { kind: 'unconfirmed' }
}
export type SpaceSessionMember = { hostId: string | null; runtimeId: string | null; agentSessionId: string }
export const spaceSessionMemberKey = (member: SpaceSessionMember) => JSON.stringify([member.runtimeId, member.hostId, member.agentSessionId])
export type SpaceSessionState =
  | { status: 'pending' }
  | { status: 'unknown' | 'unavailable'; issue: { code: string; message: string } }
  | { status: 'missing'; authority: SpaceAuthoritySource }
  | { status: 'observed'; authority: SpaceAuthoritySource; session: AgentMuxHostedAgentSessionSummary }
export type SpaceSessionsOpening = { reference: SpaceAuthorityRef; source: SpaceAuthoritySource; revision: number }
/** Membership revision belongs to B; authority belongs to the original Session Core.
 * Observed metadata is not a claim that its Native Run is currently connected. */
export type SpaceSessionsObservation = SpaceSessionsOpening & (
  | { type: 'member'; member: SpaceSessionMember; occurrences?: SpaceSessionOccurrence[]; state: SpaceSessionState }
  | { type: 'removed'; member: SpaceSessionMember }
  | { type: 'membership-complete' }
  | { type: 'runtime'; hostId: string; runtimeId: string; authority: SpaceAuthoritySource; event: AgentMuxClientEvent }
)
export const SPACE_SESSION_METHODS = { 'space.sessions.watch': 'long' } as const
export type SpaceSessionsParams = { 'space.sessions.watch': { reference: SpaceAuthorityRef } }
export type SpaceSessionsResults = { 'space.sessions.watch': SpaceSessionsOpening }
