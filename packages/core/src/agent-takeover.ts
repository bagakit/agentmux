import { parseAgentNativeResumeSource } from './agent-native-sessions.js'
import type { AgentNativeResumeSource } from './types.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parseSpaceAuthorityRef, type SpaceAuthorityRef, type SpaceAuthoritySource } from './space-reference.js'
import type { AgentMuxRunRef } from './types.js'
import type { AgentMuxSpaceAddress } from './space-control.js'

/** The selected source is a locator. The original Core verifies membership and freezes its facts. */
export type AgentTakeoverSource = { hostId: string; expectedRuntimeId?: string; agentSessionId?: string; expectedRun?: AgentMuxRunRef; nativeSource?: AgentNativeResumeSource; executorId?: string; organization: SpaceAuthorityRef | null }
export type AgentTakeoverOrganization = { reference: SpaceAuthorityRef; kind: 'project' | 'mote'; organizationId: string; title: string }
export type AgentTakeoverNature = 'takeover' | 'promotion' | 'handson' | 'transfer'
export type AgentTakeoverProvenance = {
  source: { hostId: string; runtimeId: string; agentSessionId: string | null; run: AgentMuxRunRef | null; organization: AgentTakeoverOrganization | null; organizationIssue?: string; nativeSource?: AgentNativeResumeSource; executorId?: string }
  destination: { owner: { runtimeId: string }; address: AgentMuxSpaceAddress; organization: AgentTakeoverOrganization | null }
  nature: AgentTakeoverNature | null
}
/** Source/destination qualification before the original spatial owner allocates the actual address. */
export type AgentTakeoverPreparation = Omit<AgentTakeoverProvenance, 'destination'> & {
  destination: Omit<AgentTakeoverProvenance['destination'], 'address'>
}
export type AgentTakeoverQuery = { expectedRuntimeId: string; direction: 'incoming' | 'outgoing'; subject: { runtimeId: string; agentSessionId: string }; cursor?: string; limit?: number }
export type AgentTakeoverRecord = {
  requestId: string
  agent: { hostId: string; runtimeId: string | null; agentSessionId: string; run: AgentMuxRunRef | null }
  takeover: AgentTakeoverProvenance
  phase: 'prepared' | 'active' | 'retired' | 'unconfirmed'
  issue: string | null
}
export type AgentTakeoverPage = {
  owner: SpaceAuthoritySource; direction: AgentTakeoverQuery['direction']; subject: AgentTakeoverQuery['subject']; records: AgentTakeoverRecord[]; nextCursor: string | null
  coverage: { scope: 'selected-owner'; history: 'recorded-takeovers' }
}
export const AGENT_TAKEOVER_METHODS = { 'agent.takeover.ls': 'short' } as const
const invalid = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code) }
const run = (value: unknown): AgentMuxRunRef => { const p = rpcRecord(value, ['runId']); return { runId: rpcString(p.runId, 'Original Takeover Run') } }
export function parseAgentTakeoverSource(value: unknown): AgentTakeoverSource {
  const p = rpcRecord(value, ['hostId', 'expectedRuntimeId', 'agentSessionId', 'expectedRun', 'organization', 'nativeSource', 'executorId'])
  if (p.agentSessionId === undefined && (!p.nativeSource || !p.executorId || p.organization !== null || p.expectedRun !== undefined)) invalid('A native-only Takeover retains its exact native locator and Executor, without a fabricated Agent or organization.')
  return { ...(p.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Original Takeover source Runtime') }), hostId: rpcString(p.hostId, 'Original Takeover Host'), ...(p.agentSessionId === undefined ? {} : { agentSessionId: rpcString(p.agentSessionId, 'Original Takeover Session') }),
    ...(p.nativeSource === undefined ? {} : { nativeSource: parseAgentNativeResumeSource(p.nativeSource) }), ...(p.executorId === undefined ? {} : { executorId: rpcString(p.executorId, 'Original history Executor') }),
    organization: p.organization === null ? null : parseSpaceAuthorityRef(p.organization), ...(p.expectedRun === undefined ? {} : { expectedRun: run(p.expectedRun) }) }
}
export function agentTakeoverNature(source: AgentTakeoverOrganization | null, target: AgentTakeoverOrganization | null): AgentTakeoverNature | null {
  if (!source || !target) return null
  if (source.kind === 'project' && target.kind === 'mote') return 'promotion'
  if (source.kind === 'mote' && target.kind === 'project') return 'handson'
  return source.reference.runtimeId === target.reference.runtimeId && source.kind === target.kind && source.organizationId === target.organizationId ? 'takeover' : 'transfer'
}
export function parseAgentTakeoverProvenance(value: unknown): AgentTakeoverProvenance {
  const p = rpcRecord(value, ['source', 'destination', 'nature']), source = rpcRecord(p.source, ['hostId', 'runtimeId', 'agentSessionId', 'run', 'organization', 'organizationIssue', 'nativeSource', 'executorId'])
  const destination = rpcRecord(p.destination, ['owner', 'address', 'organization'])
  const organization = (value: unknown): AgentTakeoverOrganization | null => {
    if (value === null) return null
    const q = rpcRecord(value, ['reference', 'kind', 'organizationId', 'title'])
    if (q.kind !== 'project' && q.kind !== 'mote' || typeof q.title !== 'string') invalid('The original Takeover organization is unconfirmed.')
    return { reference: parseSpaceAuthorityRef(q.reference), kind: q.kind as 'project' | 'mote', organizationId: rpcString(q.organizationId, 'Original organization identity'), title: q.title as string }
  }
  const origin = organization(source.organization), target = organization(destination.organization), ownerRecord = rpcRecord(destination.owner, ['runtimeId']), owner = { runtimeId: rpcString(ownerRecord.runtimeId, 'Original Takeover admission Runtime') }
  const address = rpcRecord(destination.address, ['spaceId', 'zoneId', 'workspaceId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'])
  const location = Object.fromEntries(['spaceId', 'zoneId', 'workspaceId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'].map(key => [key, (key === 'spaceId' || key === 'zoneId') && address[key] === null ? null : rpcString(address[key], 'Original Takeover address')])) as AgentMuxSpaceAddress
  if (target && (target.reference.runtimeId !== owner.runtimeId) || p.nature !== agentTakeoverNature(origin, target)) invalid('Takeover nature or destination disagrees with its original organization facts.')
  if (source.agentSessionId === null && (!source.nativeSource || !source.executorId || source.run !== null || origin !== null)) invalid('The native-only source cannot claim a Session, Run or organization.')
  if (source.organizationIssue !== undefined && (typeof source.organizationIssue !== 'string' || !source.organizationIssue || origin !== null)) invalid('An original organization observation issue must keep its organization unknown.')
  return { source: { ...(source.organizationIssue === undefined ? {} : { organizationIssue: source.organizationIssue as string }), ...(source.nativeSource === undefined ? {} : { nativeSource: parseAgentNativeResumeSource(source.nativeSource) }), ...(source.executorId === undefined ? {} : { executorId: rpcString(source.executorId, 'Original history Executor') }), hostId: rpcString(source.hostId, 'Original Takeover Host'), runtimeId: rpcString(source.runtimeId, 'Original Takeover Runtime'),
    agentSessionId: source.agentSessionId === null ? null : rpcString(source.agentSessionId, 'Original Takeover Session'), run: source.run === null ? null : run(source.run), organization: origin },
    destination: { owner, address: location, organization: target }, nature: p.nature as AgentTakeoverNature | null }
}
export function parseAgentTakeoverQuery(value: unknown): AgentTakeoverQuery {
  const p = rpcRecord(value, ['expectedRuntimeId', 'direction', 'subject', 'cursor', 'limit']), source = rpcRecord(p.subject, ['runtimeId', 'agentSessionId'])
  if (p.direction !== 'incoming' && p.direction !== 'outgoing') invalid('Takeover query requires its exact incoming or outgoing relation.')
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100)) invalid('Takeover query limit must be between one and one hundred.')
  return { expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Original Takeover admission Runtime'), direction: p.direction as 'incoming' | 'outgoing', subject: { runtimeId: rpcString(source.runtimeId, 'Original Takeover source Runtime'), agentSessionId: rpcString(source.agentSessionId, 'Original Takeover source Session') },
    ...(p.cursor === undefined ? {} : { cursor: rpcString(p.cursor, 'Original Takeover cursor') }), ...(p.limit === undefined ? {} : { limit: Number(p.limit) }) }
}

/** Organization identities are original Core facts; directory and presentation names never choose them. */
export function takeoverOrganization(space: import('./space-control.js').AgentMuxSpaceFact | null | undefined, runtimeId: string): AgentTakeoverOrganization | null {
  if (!space || space.issue) return null
  if (space.kind === 'mote' && space.topicId) return { reference: { runtimeId, spaceId: space.spaceId }, kind: 'mote', organizationId: space.topicId, title: space.name }
  if (space.kind === 'folder' && space.projectId) return { reference: { runtimeId, spaceId: space.spaceId }, kind: 'project', organizationId: space.projectId, title: space.name }
  return null
}
export function parseAgentTakeoverPage(value: unknown, input: AgentTakeoverQuery): AgentTakeoverPage {
  const p = rpcRecord(value, ['owner', 'direction', 'subject', 'records', 'nextCursor', 'coverage'], 'CONTROL_PROTOCOL_ERROR')
  const owner = rpcRecord(p.owner, ['runtimeId', 'ownerInstanceId']), source = rpcRecord(p.subject, ['runtimeId', 'agentSessionId']), coverage = rpcRecord(p.coverage, ['scope', 'history'])
  if (owner.runtimeId !== input.expectedRuntimeId || p.direction !== input.direction || source.runtimeId !== input.subject.runtimeId || source.agentSessionId !== input.subject.agentSessionId ||
    coverage.scope !== 'selected-owner' || coverage.history !== 'recorded-takeovers' || !Array.isArray(p.records) || p.records.length > (input.limit ?? 50)) invalid('The Takeover page belongs to another original owner or source.', 'CONTROL_PROTOCOL_ERROR')
  let previous = ''
  const records = (p.records as unknown[]).map(value => {
    const row = rpcRecord(value, ['requestId', 'agent', 'takeover', 'phase', 'issue']), agent = rpcRecord(row.agent, ['hostId', 'runtimeId', 'agentSessionId', 'run'])
    const requestId = rpcString(row.requestId, 'Original Takeover operation'), takeover = parseAgentTakeoverProvenance(row.takeover)
    if (requestId <= previous || !['prepared', 'active', 'retired', 'unconfirmed'].includes(String(row.phase)) || row.issue !== null && typeof row.issue !== 'string' ||
      (input.direction === 'outgoing' ? takeover.source.runtimeId !== input.subject.runtimeId || takeover.source.agentSessionId !== input.subject.agentSessionId : agent.runtimeId !== input.subject.runtimeId || agent.agentSessionId !== input.subject.agentSessionId) || takeover.destination.owner.runtimeId !== input.expectedRuntimeId) invalid('The Takeover record changed its original source or order.', 'CONTROL_PROTOCOL_ERROR')
    previous = requestId
    return { requestId, agent: { hostId: rpcString(agent.hostId, 'Created Takeover Host'), runtimeId: agent.runtimeId === null ? null : rpcString(agent.runtimeId, 'Created Takeover Runtime'), agentSessionId: rpcString(agent.agentSessionId, 'Created Takeover Session'), run: agent.run === null ? null : run(agent.run) },
      takeover, phase: row.phase as AgentTakeoverRecord['phase'], issue: row.issue as string | null }
  })
  return { owner: { runtimeId: input.expectedRuntimeId, ownerInstanceId: rpcString(owner.ownerInstanceId, 'Original Takeover owner instance') }, direction: input.direction, subject: input.subject,
    records, nextCursor: p.nextCursor === null ? null : rpcString(p.nextCursor, 'Original Takeover cursor'), coverage: { scope: 'selected-owner', history: 'recorded-takeovers' } }
}

/** Verify the selected original organization against exact execution identity, never Host aliases or cwd. */
export function qualifyTakeoverOrganization(graph: Pick<import('./spatial-graph.js').AgentMuxSpatialGraph, 'spaces' | 'bindings' | 'tabs' | 'regions'>, reference: SpaceAuthorityRef,
  source: { runtimeId: string; agentSessionId: string | null }): AgentTakeoverOrganization | null {
  const zones = new Set(graph.bindings.filter(value => value.spaceId === reference.spaceId).map(value => value.zoneId))
  const tabs = new Set(graph.tabs.filter(value => value.zoneId && zones.has(value.zoneId)).map(value => value.tabId))
  if (!source.agentSessionId || !graph.regions.some(value => tabs.has(value.tabId) && value.kind === 'agent' && value.agentSessionId === source.agentSessionId &&
    (value.execution?.runtimeId === source.runtimeId || source.runtimeId === reference.runtimeId && value.execution?.hostId === 'local' && value.execution.runtimeId === undefined))) invalid('The selected source organization does not contain that exact original Agent.', 'AGENT_TAKEOVER_SOURCE_CHANGED')
  return takeoverOrganization(graph.spaces.find(value => value.spaceId === reference.spaceId), reference.runtimeId)
}
export const sameTakeoverOrganization = (a: AgentTakeoverOrganization | null, b: AgentTakeoverOrganization | null): boolean =>
  a === null || b === null ? a === b : a.reference.runtimeId === b.reference.runtimeId && a.reference.spaceId === b.reference.spaceId && a.kind === b.kind && a.organizationId === b.organizationId

/** A presentation container may share the original Zone with a Club. Every binding remains membership. */
export function takeoverDestinationOrganizations(graph: Pick<import('./spatial-graph.js').AgentMuxSpatialGraph, 'spaces' | 'bindings'>, address: Pick<AgentMuxSpaceAddress, 'spaceId' | 'zoneId'>, runtimeId: string): AgentTakeoverOrganization[] {
  const spaces = new Set(address.zoneId ? graph.bindings.filter(value => value.zoneId === address.zoneId).map(value => value.spaceId) : address.spaceId ? [address.spaceId] : [])
  return graph.spaces.filter(value => spaces.has(value.spaceId)).flatMap(value => { const organization = takeoverOrganization(value, runtimeId); return organization ? [organization] : [] })
}
export function takeoverDestinationOrganization(graph: Pick<import('./spatial-graph.js').AgentMuxSpatialGraph, 'spaces' | 'bindings'>, address: Pick<AgentMuxSpaceAddress, 'spaceId' | 'zoneId'>, runtimeId: string): AgentTakeoverOrganization | null {
  const organizations = takeoverDestinationOrganizations(graph, address, runtimeId)
  return organizations.length === 1 ? organizations[0]! : null
}
export function takeoverRequiresPromotion(graph: Pick<import('./spatial-graph.js').AgentMuxSpatialGraph, 'spaces' | 'bindings'>, address: Pick<AgentMuxSpaceAddress, 'spaceId' | 'zoneId'>, source: AgentTakeoverProvenance['source']): boolean {
  return source.organization?.kind !== 'mote' && graph.bindings.some(binding => binding.zoneId === address.zoneId && graph.spaces.some(space => space.spaceId === binding.spaceId && space.kind === 'mote'))
}
