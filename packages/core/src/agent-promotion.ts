import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMoteDefaultConversation, type MoteDefaultConversation } from './mote-preferences.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import { spatialCatalog, type AgentMuxSpatialGraph } from './spatial-graph.js'
import { addTabOrThrow, createWorkbenchViewLayout, createWorkspaceLayout } from './spatial-layout.js'

export type AgentPromotionTarget = { hostId: string; agentSessionId: string }
export type AgentPromotionApply = {
  target: AgentPromotionTarget; source: MoteDefaultConversation; operationId: string; title: string
}
export type AgentPromotionInspection = { target: AgentPromotionTarget; operationId?: string }
export type AgentPromotionReceipt = AgentPromotionApply & {
  topicId: string; moteSpaceId: string; zoneId: string; directoryPath: string
  conversation: MoteDefaultConversation
  state: 'complete' | 'partial'; stage: 'files' | 'spatial' | 'main' | 'complete'
  diskDurability: 'confirmed' | 'unconfirmed'
  unavailable: Array<{ code: string; message: string; recovery: string }>
}
export const AGENT_PROMOTION_METHODS = { 'agent.promote.inspect': 'short', 'agent.promote.apply': 'long' } as const
export type AgentPromotionMethod = keyof typeof AGENT_PROMOTION_METHODS
export type AgentPromotionParamsMap = {
  'agent.promote.inspect': AgentPromotionInspection
  'agent.promote.apply': AgentPromotionApply
}
export type AgentPromotionResultMap = {
  'agent.promote.inspect': { promotion: AgentPromotionReceipt | null }
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
export function parseAgentPromotionParams<M extends AgentPromotionMethod>(method: M, value: unknown): AgentPromotionParamsMap[M] {
  const p = rpcRecord(value, method === 'agent.promote.inspect' ? ['target', 'operationId'] : ['target', 'source', 'operationId', 'title'])
  const original = target(p.target, 'INVALID_CONTROL_REQUEST')
  if (method === 'agent.promote.inspect') return { target: original, ...(p.operationId === undefined ? {} : { operationId: text(p.operationId, 'INVALID_CONTROL_REQUEST', 512) }) } as AgentPromotionParamsMap[M]
  const source = parseMoteDefaultConversation(p.source)
  if (source.hostId !== original.hostId || source.sessionId !== original.agentSessionId) fail('The original promotion source belongs to another Agent.')
  return { target: original, source, operationId: text(p.operationId, 'INVALID_CONTROL_REQUEST', 512), title: text(p.title, 'INVALID_CONTROL_REQUEST', 120) } as AgentPromotionParamsMap[M]
}
export function parseAgentPromotionResult<M extends AgentPromotionMethod>(method: M, value: unknown, input: AgentPromotionParamsMap[M]): AgentPromotionResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR', result = rpcRecord(value, ['promotion'], code)
  if (result.promotion === null && method === 'agent.promote.inspect') return { promotion: null } as AgentPromotionResultMap[M]
  const p = rpcRecord(result.promotion, ['operationId', 'target', 'source', 'title', 'topicId', 'moteSpaceId', 'zoneId', 'directoryPath', 'conversation', 'state', 'stage', 'diskDurability', 'unavailable'], code)
  const original = target(p.target, code), source = parseMoteDefaultConversation(p.source, code), conversation = parseMoteDefaultConversation(p.conversation, code)
  const operationId = text(p.operationId, code, 512), title = text(p.title, code, 120)
  if (!sameTarget(original, input.target) || input.operationId !== undefined && input.operationId !== operationId ||
    source.hostId !== original.hostId || source.sessionId !== original.agentSessionId || conversation.hostId !== original.hostId || conversation.sessionId !== original.agentSessionId ||
    method === 'agent.promote.apply' && (!sameConversation(source, (input as AgentPromotionApply).source) || title !== (input as AgentPromotionApply).title))
    fail('The promotion receipt belongs to another original operation or Agent.', code)
  for (const key of ['topicId', 'moteSpaceId', 'zoneId', 'directoryPath']) text(p[key], code)
  if (p.state !== 'complete' && p.state !== 'partial' || !['files', 'spatial', 'main', 'complete'].includes(String(p.stage)) ||
    p.diskDurability !== 'confirmed' && p.diskDurability !== 'unconfirmed' || !Array.isArray(p.unavailable)) fail('Promotion completion is unconfirmed.', code)
  const unavailable = (p.unavailable as unknown[]).map(value => {
    const issue = rpcRecord(value, ['code', 'message', 'recovery'], code)
    return { code: text(issue.code, code), message: text(issue.message, code), recovery: text(issue.recovery, code) }
  })
  if (p.state === 'complete' && (p.stage !== 'complete' || p.diskDurability !== 'confirmed' || unavailable.length)) fail('Promotion completion lacks the original confirmed facts.', code)
  return { promotion: { ...p, target: original, source, conversation, operationId, title, unavailable } as AgentPromotionReceipt } as AgentPromotionResultMap[M]
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
