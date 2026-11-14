import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMoteDefaultConversation, parseMotePreferencesTarget, sameMotePreferencesTarget,
  type MoteDefaultConversation, type MotePreferencesTarget } from './mote/preferences.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import { spatialCatalog, type AgentMuxSpatialGraph } from './spatial-graph.js'
import { addTabOrThrow, createWorkbenchViewLayout, createWorkspaceLayout } from './spatial-layout.js'

export type AgentPromotionTarget = { hostId: string; agentSessionId: string }
export type AgentPromotionDestination = { kind: 'existing-club'; target: MotePreferencesTarget } | { kind: 'new-club' }
export type AgentPromotionApply = {
  target: AgentPromotionTarget; source: MoteDefaultConversation; operationId: string; title: string
  destination: AgentPromotionDestination
}
export type AgentPromotionInspection = { target: AgentPromotionTarget; operationId?: string; cursor?: string }
export type AgentPromotionReceipt = AgentPromotionApply & {
  topicId: string; moteSpaceId: string; zoneId: string; directoryPath: string
  conversation: MoteDefaultConversation
  state: 'complete' | 'partial'; stage: 'files' | 'spatial' | 'main' | 'complete'
  diskDurability: 'confirmed' | 'unconfirmed'
  unavailable: Array<{ code: string; message: string; recovery: string }>
}
export type AgentPromotionClub = { title: string; directoryPath: string; target: MotePreferencesTarget }
export type AgentPromotionMembership = AgentPromotionClub & { main: boolean | null }
export type AgentPromotionDiscovery = {
  pending: AgentPromotionReceipt[]
  clubs: AgentPromotionClub[]
  memberships: AgentPromotionMembership[]
  /** Original operation scan only; it does not identify the latest action or current membership. */
  nextCursor: string | null
  issue: string | null
}
export type AgentPromotionInspectResult = { promotion: AgentPromotionReceipt | null; discovery: AgentPromotionDiscovery | null }
export const AGENT_PROMOTION_METHODS = { 'agent.promote.inspect': 'short', 'agent.promote.apply': 'long' } as const
export type AgentPromotionMethod = keyof typeof AGENT_PROMOTION_METHODS
export type AgentPromotionParamsMap = {
  'agent.promote.inspect': AgentPromotionInspection
  'agent.promote.apply': AgentPromotionApply
}
export type AgentPromotionResultMap = {
  'agent.promote.inspect': AgentPromotionInspectResult
  'agent.promote.apply': { promotion: AgentPromotionReceipt }
}
export type AgentPromotionParams<M extends AgentPromotionMethod> = AgentPromotionParamsMap[M]
export type AgentPromotionResult<M extends AgentPromotionMethod> = AgentPromotionResultMap[M]
export interface AgentPromotionPort {
  call<M extends AgentPromotionMethod>(method: M, params: AgentPromotionParamsMap[M], context?: AgentMuxRpcCallContext): Promise<AgentPromotionResultMap[M]>
}
export function isAgentPromotionMethod(value: unknown): value is AgentPromotionMethod {
  return typeof value === 'string' && Object.hasOwn(AGENT_PROMOTION_METHODS, value)
}
function fail(message: string, code = 'INVALID_CONTROL_REQUEST'): never { throw new AgentMuxError(message, code) }
function text(value: unknown, code: string, max = 16384): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/u.test(value)) fail('An exact original promotion identity or text is required.', code)
  return value as string
}
function diagnostic(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('An original operation diagnostic is required.', code)
  return value
}
function target(value: unknown, code: string): AgentPromotionTarget {
  const p = rpcRecord(value, ['hostId', 'agentSessionId'], code)
  return { hostId: text(p.hostId, code, 512), agentSessionId: text(p.agentSessionId, code, 512) }
}
function sameTarget(a: AgentPromotionTarget, b: AgentPromotionTarget): boolean {
  return a.hostId === b.hostId && a.agentSessionId === b.agentSessionId
}
function sameConversation(a: MoteDefaultConversation, b: MoteDefaultConversation): boolean {
  return (['hostId', 'sessionId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'] as const).every(key => a[key] === b[key])
}
function destination(value: unknown, code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR'): AgentPromotionDestination {
  const p = rpcRecord(value, ['kind', 'target'], code)
  if (p.kind === 'new-club') { rpcRecord(value, ['kind'], code); return { kind: 'new-club' } }
  if (p.kind !== 'existing-club') return fail('Choose an exact existing Club or explicitly establish a new Club.', code)
  return { kind: 'existing-club', target: parseMotePreferencesTarget(p.target, code) }
}
function sameDestination(a: AgentPromotionDestination, b: AgentPromotionDestination): boolean {
  return a.kind === b.kind && (a.kind === 'new-club' || b.kind === 'existing-club' && sameMotePreferencesTarget(a.target, b.target))
}
export function parseAgentPromotionParams<M extends AgentPromotionMethod>(method: M, value: unknown): AgentPromotionParamsMap[M] {
  const p = rpcRecord(value, method === 'agent.promote.inspect' ? ['target', 'operationId', 'cursor'] : ['target', 'source', 'operationId', 'title', 'destination'])
  const original = target(p.target, 'INVALID_CONTROL_REQUEST')
  if (method === 'agent.promote.inspect') {
    if (p.operationId !== undefined && p.cursor !== undefined) fail('An exact operation and an operation discovery cursor are separate reads.')
    return { target: original, ...(p.operationId === undefined ? {} : { operationId: text(p.operationId, 'INVALID_CONTROL_REQUEST', 512) }),
      ...(p.cursor === undefined ? {} : { cursor: text(p.cursor, 'INVALID_CONTROL_REQUEST', 2048) }) } as AgentPromotionParamsMap[M]
  }
  const source = parseMoteDefaultConversation(p.source)
  if (source.hostId !== original.hostId || source.sessionId !== original.agentSessionId) fail('The original promotion source belongs to another Agent.')
  return { target: original, source, operationId: text(p.operationId, 'INVALID_CONTROL_REQUEST', 512), title: text(p.title, 'INVALID_CONTROL_REQUEST', 120),
    destination: destination(p.destination, 'INVALID_CONTROL_REQUEST') } as AgentPromotionParamsMap[M]
}
function promotion(value: unknown, input: AgentPromotionInspection, apply?: AgentPromotionApply): AgentPromotionReceipt {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['operationId', 'target', 'source', 'title', 'destination', 'topicId', 'moteSpaceId', 'zoneId', 'directoryPath', 'conversation', 'state', 'stage', 'diskDurability', 'unavailable'], code)
  const original = target(p.target, code), source = parseMoteDefaultConversation(p.source, code), conversation = parseMoteDefaultConversation(p.conversation, code)
  const operationId = text(p.operationId, code, 512), title = text(p.title, code, 120), selected = destination(p.destination, code)
  if (!sameTarget(original, input.target) || input.operationId !== undefined && input.operationId !== operationId ||
    source.hostId !== original.hostId || source.sessionId !== original.agentSessionId || conversation.hostId !== original.hostId || conversation.sessionId !== original.agentSessionId ||
    apply && (!sameConversation(source, apply.source) || title !== apply.title || !sameDestination(selected, apply.destination)))
    fail('The promotion receipt belongs to another original operation, destination or Agent.', code)
  for (const key of ['topicId', 'moteSpaceId', 'zoneId', 'directoryPath']) text(p[key], code)
  if (selected.kind === 'existing-club' && (p.moteSpaceId !== selected.target.spaceId || p.zoneId !== selected.target.zoneId || !['spatial', 'complete'].includes(String(p.stage))))
    fail('The existing Club receipt changed its destination or claims an unrelated content/Main stage.', code)
  if (p.state !== 'complete' && p.state !== 'partial' || !['files', 'spatial', 'main', 'complete'].includes(String(p.stage)) ||
    p.diskDurability !== 'confirmed' && p.diskDurability !== 'unconfirmed' || !Array.isArray(p.unavailable)) fail('Promotion completion is unconfirmed.', code)
  const unavailable = (p.unavailable as unknown[]).map(value => {
    const issue = rpcRecord(value, ['code', 'message', 'recovery'], code)
    return { code: text(issue.code, code), message: diagnostic(issue.message, code), recovery: diagnostic(issue.recovery, code) }
  })
  if (p.state === 'complete' && (p.stage !== 'complete' || p.diskDurability !== 'confirmed' || unavailable.length)) fail('Promotion completion lacks the original confirmed facts.', code)
  return { ...p, target: original, source, conversation, operationId, title, destination: selected, unavailable } as AgentPromotionReceipt
}
function club(value: unknown): AgentPromotionClub {
  const p = rpcRecord(value, ['title', 'directoryPath', 'target'], 'CONTROL_PROTOCOL_ERROR')
  if (typeof p.title !== 'string') fail('A Club title must be a string.', 'CONTROL_PROTOCOL_ERROR')
  return { title: p.title, directoryPath: text(p.directoryPath, 'CONTROL_PROTOCOL_ERROR'), target: parseMotePreferencesTarget(p.target, 'CONTROL_PROTOCOL_ERROR') }
}
function discovery(value: unknown, input: AgentPromotionInspection): AgentPromotionDiscovery {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['pending', 'clubs', 'memberships', 'nextCursor', 'issue'], code)
  if (!Array.isArray(p.pending) || !Array.isArray(p.clubs) || !Array.isArray(p.memberships)) fail('Original promotion discovery is unconfirmed.', code)
  const pending = p.pending.map(value => promotion(value, { target: input.target }))
  if (pending.some(value => value.state !== 'partial') || new Set(pending.map(value => value.operationId)).size !== pending.length) fail('Discovery must retain distinct original unfinished operations.', code)
  const clubs = p.clubs.map(club), memberships = p.memberships.map(value => {
    const item = rpcRecord(value, ['title', 'directoryPath', 'target', 'main'], code)
    if (item.main !== null && typeof item.main !== 'boolean') fail('The original Main role observation is unconfirmed.', code)
    return { ...club({ title: item.title, directoryPath: item.directoryPath, target: item.target }), main: item.main as boolean | null }
  })
  for (const values of [clubs, memberships]) if (new Set(values.map(value => JSON.stringify(value.target))).size !== values.length) fail('Club discovery contains duplicate original targets.', code)
  return { pending, clubs, memberships, nextCursor: p.nextCursor === null ? null : text(p.nextCursor, code, 2048),
    issue: p.issue === null ? null : diagnostic(p.issue, code) }
}
export function parseAgentPromotionResult<M extends AgentPromotionMethod>(method: M, value: unknown, input: AgentPromotionParamsMap[M]): AgentPromotionResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR'
  if (method === 'agent.promote.apply') {
    const result = rpcRecord(value, ['promotion'], code)
    return { promotion: promotion(result.promotion, input, input as AgentPromotionApply) } as AgentPromotionResultMap[M]
  }
  const result = rpcRecord(value, ['promotion', 'discovery'], code), query = input as AgentPromotionInspection
  if (query.operationId !== undefined) {
    if (result.discovery !== null) fail('An exact original operation read cannot substitute discovery.', code)
    return { promotion: result.promotion === null ? null : promotion(result.promotion, query), discovery: null } as AgentPromotionResultMap[M]
  }
  if (result.promotion !== null) fail('Operation discovery cannot appoint a historical receipt as a new action result.', code)
  return { promotion: null, discovery: discovery(result.discovery, query) } as AgentPromotionResultMap[M]
}

export type PromotedAgentAssociation = {
  source: MoteDefaultConversation; conversation: MoteDefaultConversation
  spaceId: string; zoneId: string; workspaceId: string; hostId: string; directoryPath: string; title: string; topicId: string
  session: { agentSessionId: string; runId: string | null; hostId: string; runtimeId: string; cwd: string }
}
/** Associate one original Session with a Mote home. No Runtime call, move, or broad Zone membership. */
export function associatePromotedAgent(graph: AgentMuxSpatialGraph, input: PromotedAgentAssociation): AgentMuxSpatialGraph {
  const { source, conversation, session } = input
  text(session.runtimeId, 'AGENT_PROMOTION_SOURCE_UNCONFIRMED', 512)
  if (source.hostId !== session.hostId || source.sessionId !== session.agentSessionId || conversation.hostId !== session.hostId || conversation.sessionId !== session.agentSessionId)
    fail('The requested association belongs to another original Session.', 'AGENT_PROMOTION_TARGET_CHANGED')
  const space = graph.spaces.find(value => value.spaceId === input.spaceId), zone = graph.zones.find(value => value.zoneId === input.zoneId)
  if (!space || space.kind !== 'mote' || space.topicId !== input.topicId || space.hostId !== input.hostId || space.directoryPath !== input.directoryPath ||
    !zone || zone.workspaceId !== input.workspaceId || zone.kind !== 'home' || zone.hostId !== input.hostId || zone.directoryPath !== input.directoryPath ||
    !graph.bindings.some(value => value.spaceId === input.spaceId && value.zoneId === input.zoneId))
    fail('The exact original Mote home is unconfirmed. All workfaces are retained.', 'AGENT_PROMOTION_HOME_UNCONFIRMED')
  const current = graph.regions.find(value => value.regionId === conversation.regionId), tab = graph.tabs.find(value => value.tabId === conversation.tabId)
  if (current || tab) {
    if (!current || !tab || current.tabId !== conversation.tabId || !tab.regionIds.includes(conversation.regionId) || tab.zoneId !== input.zoneId ||
      current.kind !== 'agent' || current.agentSessionId !== session.agentSessionId || current.execution?.hostId !== session.hostId || current.execution.cwd !== session.cwd || current.execution.runtimeId !== session.runtimeId ||
      !spatialCatalog(graph).locations.some(value => value.spaceId === input.spaceId && value.displayWorkspaceId === conversation.displayWorkspaceId &&
        value.groupId === conversation.groupId && value.tabId === conversation.tabId && value.regionId === conversation.regionId))
      fail('The retained Mote occurrence changed. Inspect the original promotion; existing work is retained.', 'AGENT_PROMOTION_TARGET_CHANGED')
    return structuredClone(graph)
  }
  const original = graph.regions.find(value => value.tabId === source.tabId && value.regionId === source.regionId)
  const sourceTab = graph.tabs.find(value => value.tabId === source.tabId)
  if (!original || !sourceTab || !sourceTab.regionIds.includes(source.regionId) || original.kind !== 'agent' || original.agentSessionId !== session.agentSessionId ||
    original.execution?.hostId !== session.hostId || original.execution.cwd !== session.cwd ||
    (original.execution.runtimeId !== undefined || session.hostId !== 'local') && original.execution.runtimeId !== session.runtimeId ||
    !spatialCatalog(graph).locations.some(value => value.displayWorkspaceId === source.displayWorkspaceId && value.groupId === source.groupId && value.tabId === source.tabId && value.regionId === source.regionId))
    fail('The original Agent occurrence is unconfirmed. Its Session and workface are retained.', 'AGENT_PROMOTION_SOURCE_UNCONFIRMED')
  const memberTabs = new Set(graph.regions.filter(value => value.agentSessionId === session.agentSessionId && value.execution?.hostId === session.hostId &&
    (value.execution.runtimeId === session.runtimeId || session.hostId === 'local' && value.execution.runtimeId === undefined)).map(value => value.tabId))
  const memberZones = new Set(graph.tabs.filter(value => memberTabs.has(value.tabId)).map(value => value.zoneId))
  const ownerSpaces = new Set(graph.bindings.filter(value => memberZones.has(value.zoneId)).map(value => value.spaceId))
  if (graph.spaces.some(value => ownerSpaces.has(value.spaceId) && (value.kind === 'topic' || value.kind === 'mote')) ||
    [...memberZones].some(zoneId => { const value = graph.resources['zone:' + zoneId]; return value && typeof value === 'object' && !Array.isArray(value) && (value.contentKind === 'topic' || value.contentKind === 'mote') }))
    fail('This Agent already belongs to a Topic or Mote. Use its original organization; no membership was changed.', 'AGENT_PROMOTION_ORGANIZED_SOURCE')
  const next = structuredClone(graph)
  next.tabs.push({ tabId: conversation.tabId, workspaceId: input.workspaceId, zoneId: input.zoneId, name: null, regionIds: [conversation.regionId] })
  next.regions.push({ tabId: conversation.tabId, regionId: conversation.regionId, kind: 'agent', agentSessionId: session.agentSessionId,
    runId: session.runId, execution: { hostId: session.hostId, cwd: session.cwd, runtimeId: session.runtimeId } })
  next.tabLayouts[conversation.tabId] = createWorkbenchViewLayout(conversation.regionId)
  const layout = next.layouts[conversation.displayWorkspaceId]
  if (layout && !layout.groups.some(value => value.id === conversation.groupId))
    fail('The original Mote display Group changed. Existing work is retained.', 'AGENT_PROMOTION_TARGET_CHANGED')
  const placed = layout ? addTabOrThrow(layout, conversation.groupId, conversation.tabId) : createWorkspaceLayout(conversation.groupId, [conversation.tabId])
  next.layouts[conversation.displayWorkspaceId] = layout ? { ...placed, activeGroupId: layout.activeGroupId,
    groups: placed.groups.map(group => { const before = layout.groups.find(value => value.id === group.id)
      return before?.activeTabId ? { ...group, activeTabId: before.activeTabId, recentTabIds: before.recentTabIds } : group }) } : placed
  next.resources['tab:' + conversation.tabId] = { titleRegionId: conversation.regionId }
  const originalResource = graph.resources['region:' + source.regionId]
  const presentation = originalResource && typeof originalResource === 'object' && !Array.isArray(originalResource) ? originalResource.agentPresentation : undefined
  // Keep only the original display locator, never another copy of input or business state.
  next.resources['region:' + conversation.regionId] = { workspaceId: input.workspaceId, phase: 'attached',
    agentPresentation: presentation && typeof presentation === 'object' && !Array.isArray(presentation) && typeof presentation.sessionId === 'string' &&
      presentation.agentSessionId === session.agentSessionId && presentation.hostId === session.hostId
      ? { sessionId: presentation.sessionId, agentSessionId: session.agentSessionId, hostId: session.hostId }
      : { sessionId: session.agentSessionId, agentSessionId: session.agentSessionId, hostId: session.hostId } }
  return next
}
