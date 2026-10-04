import type { AgentMuxAgentForkSource } from '@agentmux/core'
import type { AgentMuxSpaceCatalog, AgentMuxSpaceControlRequest } from '@agentmux/core/control'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { SpatialRequestBinding } from '../../../shared/space-addresses'
import { OPEN_DESTINATIONS, type OpenDestination, type OpenHttpLinkOrigin } from './open-destination'

export type CurrentForkSession = Extract<SessionSnapshot, { kind: 'agent' }>
export type CurrentForkReview = {
  operationId: string
  hostId: string
  source: AgentMuxAgentForkSource
  origin: OpenHttpLinkOrigin & { tabId: string; regionId: string; tabGroupId: string }
}
export const CURRENT_FORK_DESTINATIONS = OPEN_DESTINATIONS.filter(destination => destination !== 'system')

/** Original admitted intent survives remounts, including the window before a child Run exists. */
export function retainedCurrentForkOperation(session: CurrentForkSession | null,
  requests: Readonly<Record<string, SpatialRequestBinding>>): string | null {
  const handle = session?.nativeHandle
  if (!session || handle?.kind !== 'provider') return null
  const admitted = Object.entries(requests).filter(([key, binding]) => {
    const source = binding.forkSource, expected = source?.expectedNativeHandle
    return key === binding.requestId && binding.operation === 'agent.open' && binding.createAgent &&
      binding.executionHostId === session.control.hostId && source?.agentSessionId === session.id &&
      source.expectedRun.runId === session.control.run.runId && expected?.providerId === handle.providerId &&
      expected.sessionId === handle.sessionId && expected.transcriptPath === handle.transcriptPath
  })
  // Original request order is a presentation choice; the receipt reader alone proves its outcome.
  return admitted.at(-1)?.[1].requestId ?? null
}

/** Eligibility describes only this action; it never changes terminal availability. */
export function currentForkUnavailableReason(session: CurrentForkSession | null, origin: OpenHttpLinkOrigin, readOnly: boolean): string | null {
  if (readOnly) return 'Fork is unavailable in this read-only view.'
  if (!session) return 'The source Agent Session has not been observed.'
  if (!session.capabilities.providerFork?.current) return 'This Provider does not support forking its current conversation.'
  if (session.nativeSourceObservation) return 'The current native conversation is unconfirmed. Check its source before forking.'
  if (session.nativeHandle?.kind !== 'provider') return 'The current native conversation identity has not been observed.'
  if (!origin.tabId || !origin.regionId || !origin.tabGroupId || origin.sessionId && origin.sessionId !== session.id) {
    return 'Fork requires the exact original Tab, Group and Region.'
  }
  return null
}

export function reviewCurrentFork(session: CurrentForkSession, origin: OpenHttpLinkOrigin, operationId: string): CurrentForkReview {
  const reason = currentForkUnavailableReason(session, origin, false)
  if (reason) throw new Error(reason)
  return { operationId, hostId: session.control.hostId,
    source: { agentSessionId: session.id, expectedRun: { ...session.control.run }, expectedNativeHandle: structuredClone(session.nativeHandle!) as AgentMuxAgentForkSource['expectedNativeHandle'] },
    origin: { ...origin, tabId: origin.tabId!, regionId: origin.regionId!, tabGroupId: origin.tabGroupId! } }
}

export function currentForkSourceMatches(review: CurrentForkReview, session: CurrentForkSession | null): boolean {
  const handle = session?.nativeHandle, expected = review.source.expectedNativeHandle
  return Boolean(session && session.id === review.source.agentSessionId && session.control.hostId === review.hostId &&
    session.control.run.runId === review.source.expectedRun.runId && !session.nativeSourceObservation &&
    session.capabilities.providerFork?.current && handle?.kind === 'provider' && handle.providerId === expected.providerId &&
    handle.sessionId === expected.sessionId && handle.transcriptPath === expected.transcriptPath)
}

/** Both new Tabs and splits retain the exact original display occurrence and resource Zone. */
export function currentForkRequest(review: CurrentForkReview, session: CurrentForkSession | null,
  catalog: AgentMuxSpaceCatalog, destination: OpenDestination, focus: boolean): Extract<AgentMuxSpaceControlRequest, { operation: 'agent.open' }> {
  if (!currentForkSourceMatches(review, session)) throw new Error('The reviewed source conversation changed. Review its current identity before this fork.')
  if (destination === 'system') throw new Error('Fork requires a new Tab or a split destination.')
  const origin = review.origin
  const region = catalog.regions.find(value => value.regionId === origin.regionId && value.tabId === origin.tabId)
  if (!region || region.kind !== 'agent' || region.agentSessionId !== review.source.agentSessionId || region.runId !== review.source.expectedRun.runId) {
    throw new Error('The original Region no longer contains the reviewed Agent Session and Run.')
  }
  const locations = catalog.locations.filter(value => value.regionId === origin.regionId && value.tabId === origin.tabId &&
    value.displayWorkspaceId === origin.workspaceId && value.groupId === origin.tabGroupId)
  const location = locations[0]
  if (!location?.zoneId || new Set(locations.map(value => JSON.stringify(value))).size !== 1) {
    throw new Error('The original display location or resource Zone is unknown. Inspect the original Region before forking.')
  }
  return { schemaVersion: 5, requestId: review.operationId, operation: 'agent.open',
    content: { kind: 'fork-agent', source: structuredClone(review.source) },
    destination: { ...(location.spaceId ? { spaceId: location.spaceId } : {}), zoneId: location.zoneId,
      displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId,
      ...(destination === 'tab' ? { newTab: true } : { tabId: origin.tabId, regionId: origin.regionId,
        split: destination === 'up' ? 'above' : destination === 'down' ? 'below' : destination }) }, focus }
}
