import type { AgentMuxMotePresentation, AgentMuxSpaceAddress, TopicKnowledgeSource } from '@agentmux/core/control'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'
import type { MobilePrimaryWorkface } from '../navigation/home-preference'
import type { MobileTopicsContext } from '../topics/MobileTopicsSurface'
import type { MobileSurveyContext } from '../survey/MobileSurveySurface'
import type { MobileSpatialContext } from '../navigation/MobileSpatialNavigation'
import { parseMobileKnowledgeDraftKey } from './knowledge-drafts'
import { parseMobileTopicSourceContentReference, type MobileTopicSourceContentReference } from '../topics/source-reference'

/** Display references only: original content, appearance and Runtime facts stay with their owners. */
export type MobileObjectReference = { name: string; project: string; context?: AgentMuxSpaceAddress;
  mote?: { spaceId: string; name?: string; conversationName?: string; contentReference?: AgentMuxMotePresentation['content'] } }
export type MobilePresentationRoute = {
  primary: MobilePrimaryWorkface | 'survey'; showSession: boolean; showGoalWork: boolean
  identity: MobileObjectReference | null
  profile: { identity: MobileObjectReference; sourcePath: string | null } | null
  topics?: MobileTopicsRoute
  survey?: MobileSurveyContext
  spatial?: MobileSpatialContext
  goals?: MobileGoalsContext
}
export type MobileGoalsContext = { goalId: string | null; mode: 'detail' | 'edit';
  discussion: { goalId: string; tabId: string; agentSessionId: string | null } | null }
export type MobileTopicSourceReference = Exclude<TopicKnowledgeSource, { kind: 'url' }>
export type MobileKnowledgeReference = { topicId: string | null; entryId: string | null;
  view: 'list' | 'read' | 'edit'; query?: string; draftKey?: string }
export type MobileTopicsRoute = { context: MobileTopicsContext;
  knowledge?: MobileKnowledgeReference;
  sources: Array<{ source: MobileTopicSourceReference; origin: MobileTopicsContext; originKnowledge?: MobileKnowledgeReference;
    content?: MobileTopicSourceContentReference }> }
const sourcePaths = ['MOTE.md', 'BEHAVIOR.md', 'SOUL.md', 'topic.md']
function invalid(): never { throw new Error('设备原工作面引用无法完整核实；原记录保留。') }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const v = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) return invalid()
  return v
}
function text(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function parseTopicsContext(value: unknown): void {
  const v = object(value, ['categoryId', 'topicId', 'mode'])
  for (const key of ['categoryId', 'topicId']) if (v[key] !== null && !text(v[key], 256)) invalid()
  if (v.mode !== 'discussion' && v.mode !== 'knowledge') invalid()
}
function parseKnowledgeReference(value: unknown): void {
  const v = object(value, ['topicId', 'entryId', 'view'], ['query', 'draftKey'])
  if (!(v.topicId === null || text(v.topicId, 256)) || !(v.entryId === null || text(v.entryId, 256))
    || !['list', 'read', 'edit'].includes(String(v.view))
    || v.view === 'list' && v.entryId !== null || v.view !== 'list' && (v.topicId === null || v.entryId === null)) invalid()
  if (v.query !== undefined && (typeof v.query !== 'string' || v.query.length > 4096)) invalid()
  if (v.draftKey !== undefined) {
    const key = parseMobileKnowledgeDraftKey(v.draftKey)
    if (key.topicId !== v.topicId || key.entryId !== v.entryId) invalid()
  }
}
function parseContentContext(value: unknown, parent: 'spaceId' | 'zoneId'): void {
  const v = object(value, [parent, 'tabId', 'regionId'])
  for (const key of [parent, 'tabId', 'regionId']) {
    const id = v[key]
    if (id !== null && (typeof id !== 'string' || !id.trim() || id === 'self' || /[\0\r\n]/u.test(id)
      || new TextEncoder().encode(id).byteLength > 16 * 1024)) invalid()
  }
  if (v.tabId !== null && v[parent] === null || v.regionId !== null && v.tabId === null) invalid()
}
function parseTopicSource(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const kind = (value as Record<string, unknown>).kind
  const fields = kind === 'topic' ? [['topicId'], ['chatId', 'threadId']]
    : kind === 'file' ? [['hostId', 'path'], ['projectId', 'revision']]
    : kind === 'note' ? [['noteId'], ['blockId']]
    : kind === 'notebook' ? [['notebookId'], []]
    : kind === 'space' || kind === 'survey' ? [['zoneId'], ['tabId', 'regionId']] : null
  if (!fields) invalid()
  const v = object(value, ['kind', ...fields[0]!], fields[1]!)
  for (const key of fields[0]!) if (!text(v[key], key === 'path' ? 4096 : 256)) invalid()
  for (const key of fields[1]!) if (v[key] !== undefined && !text(v[key], key === 'revision' ? 4096 : 256)) invalid()
}
function parseIdentity(value: unknown): MobileObjectReference {
  const v = object(value, ['name', 'project'], ['context', 'mote'])
  if (!text(v.name) || typeof v.project !== 'string' || v.project.length > 4096) invalid()
  if (v.context !== undefined) {
    const c = object(v.context, ['spaceId', 'zoneId', 'workspaceId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'])
    for (const key of ['spaceId', 'zoneId']) if (c[key] !== null && !text(c[key], 256)) invalid()
    for (const key of ['workspaceId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId']) if (!text(c[key], 256)) invalid()
  }
  if (v.mote !== undefined) {
    const m = object(v.mote, ['spaceId'], ['name', 'conversationName', 'contentReference'])
    if (!text(m.spaceId, 256)) invalid()
    for (const key of ['name', 'conversationName']) if (m[key] !== undefined && !text(m[key])) invalid()
    if (m.contentReference !== undefined && m.contentReference !== null) {
      const c = object(m.contentReference, ['zoneId', 'hostId', 'workspaceId', 'workspacePath'])
      for (const key of ['zoneId', 'hostId', 'workspaceId']) if (!text(c[key], 256)) invalid()
      if (!text(c.workspacePath)) invalid()
    }
  }
  return structuredClone(value) as MobileObjectReference
}
export function retainObjectReference(identity: MobileObjectIdentity | null): MobileObjectReference | null {
  if (!identity) return null
  const m = identity.mote
  const content = m?.contentReference ?? m?.facts?.content
  const c = identity.context
  return { name: identity.name, project: identity.project,
    ...(c ? { context: { spaceId: c.spaceId, zoneId: c.zoneId, workspaceId: c.workspaceId, displayWorkspaceId: c.displayWorkspaceId,
      groupId: c.groupId, tabId: c.tabId, regionId: c.regionId } } : {}),
    ...(m ? { mote: { spaceId: m.spaceId, ...(m.name ? { name: m.name } : {}),
      ...(m.conversationName ? { conversationName: m.conversationName } : {}),
      ...(content ? { contentReference: content } : {}) } } : {}) }
}
export function parsePresentationRoute(value: unknown): MobilePresentationRoute {
  const v = object(value, ['primary', 'showSession', 'showGoalWork', 'identity', 'profile'], ['topics', 'survey', 'spatial', 'goals'])
  if (!['goals', 'topics', 'mote', 'focus', 'space', 'survey'].includes(String(v.primary)) ||
    typeof v.showSession !== 'boolean' || typeof v.showGoalWork !== 'boolean' || v.showGoalWork && !v.showSession) invalid()
  if (v.identity !== null) parseIdentity(v.identity)
  if (v.profile !== null) {
    const p = object(v.profile, ['identity', 'sourcePath'])
    parseIdentity(p.identity)
    if (p.sourcePath !== null && !sourcePaths.includes(String(p.sourcePath))) invalid()
  }
  if (v.topics !== undefined) {
    const topics = object(v.topics, ['context', 'sources'], ['knowledge'])
    parseTopicsContext(topics.context)
    if (topics.knowledge !== undefined) parseKnowledgeReference(topics.knowledge)
    if (!Array.isArray(topics.sources) || topics.sources.length > 128) invalid()
    for (const value of topics.sources) {
      const frame = object(value, ['source', 'origin'], ['originKnowledge', 'content'])
      parseTopicSource(frame.source); parseTopicsContext(frame.origin)
      if (frame.originKnowledge !== undefined) parseKnowledgeReference(frame.originKnowledge)
      if (frame.content !== undefined) parseMobileTopicSourceContentReference(frame.content, frame.source as TopicKnowledgeSource)
    }
  }
  if (v.survey !== undefined) parseContentContext(v.survey, 'zoneId')
  if (v.spatial !== undefined) parseContentContext(v.spatial, 'spaceId')
  if (v.goals !== undefined) {
    const goals = object(v.goals, ['goalId', 'mode', 'discussion'])
    if (!(goals.goalId === null || text(goals.goalId, 256)) || !['detail', 'edit'].includes(String(goals.mode))
      || goals.goalId === null && (goals.mode !== 'detail' || goals.discussion !== null)) invalid()
    if (goals.discussion !== null) {
      const discussion = object(goals.discussion, ['goalId', 'tabId', 'agentSessionId'])
      if (discussion.goalId !== goals.goalId || !text(discussion.tabId, 256)
        || !(discussion.agentSessionId === null || text(discussion.agentSessionId, 256))) invalid()
    }
  }
  return structuredClone(value) as MobilePresentationRoute
}
