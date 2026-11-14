import type { TopicKnowledgeSource } from '@agentmux/core/control'
import type { MobileKnowledgeReference, MobileTopicsRoute, MobileTopicSourceReference } from '../recovery/presentation-route'
import type { MobileTopicSourceContentReference } from './source-reference'

/** Presentation only. A search scope is distinct from the Topic of its selected entry. */
export type MobileTopicsContext = { categoryId: string | null; topicId: string | null; mode: 'discussion' | 'knowledge' }
export type KnowledgeTarget = { topicId: string; entryId: string }
export type KnowledgeEditorReference = KnowledgeTarget & { token: number; mountKey: string; draftKey?: string; isNew?: boolean }
export type KnowledgePosition = { view: 'list' | 'read' | 'edit'; reading: KnowledgeTarget | null;
  editor: KnowledgeEditorReference | null; query: string; search: string }
export type TopicsSourceFrame = { token: number; value: MobileTopicsRoute['sources'][number] }
export type TopicsNavigationState = { context: MobileTopicsContext; positions: ReadonlyMap<string | null, KnowledgePosition>;
  knowledgeScope: string | null | undefined; sources: readonly TopicsSourceFrame[]; directoryQuery: string; nextToken: number }
export type KnowledgeNavigationIntent =
  | { type: 'knowledge-query'; scope: string | null; query: string }
  | { type: 'knowledge-search'; scope: string | null }
  | { type: 'knowledge-read'; scope: string | null; target: KnowledgeTarget }
  | { type: 'knowledge-edit'; scope: string | null; target: KnowledgeTarget; mountKey: string; isNew?: boolean }
  | { type: 'knowledge-back'; scope: string | null; to: 'list' | 'read' }
  | { type: 'knowledge-saved'; scope: string | null; editorToken: number; keepEditing: boolean }
export type TopicsNavigationIntent = KnowledgeNavigationIntent
  | { type: 'category'; categoryId: string | null }
  | { type: 'directory-query'; query: string }
  | { type: 'topic'; topicId: string; categoryId?: string | null }
  | { type: 'mode'; scope: string | null; mode: MobileTopicsContext['mode'] }
  | { type: 'topic-back' }
  | { type: 'source-open'; source: Exclude<TopicKnowledgeSource, { kind: 'url' }> }
  | { type: 'source-leave' }
export type TopicsNavigationObservation =
  | { type: 'draft-key'; scope: string | null; editorToken: number; target: KnowledgeTarget; draftKey: string }
  | { type: 'source-content'; frameToken: number; source: MobileTopicSourceReference; content: MobileTopicSourceContentReference }
export type TopicsNavigationController = { state: TopicsNavigationState; route: MobileTopicsRoute;
  send(intent: TopicsNavigationIntent): void; observe(observation: TopicsNavigationObservation): void }

export const emptyKnowledgePosition = (): KnowledgePosition => ({ view: 'list', reading: null, editor: null, query: '', search: '' })
export const knowledgePosition = (state: TopicsNavigationState, scope: string | null): KnowledgePosition => state.positions.get(scope) ?? emptyKnowledgePosition()
const sameTarget = (a: KnowledgeTarget | null, b: KnowledgeTarget) => a?.topicId === b.topicId && a.entryId === b.entryId
export function knowledgeReference(scope: string | null, position: KnowledgePosition): MobileKnowledgeReference {
  const target = position.view === 'edit' ? position.editor : position.view === 'read' ? position.reading : null
  const draftKey = target && position.editor && sameTarget(position.editor, target) ? position.editor.draftKey : undefined
  return { topicId: target?.topicId ?? scope, entryId: target?.entryId ?? null, view: target ? position.view : 'list',
    ...(draftKey ? { draftKey } : {}), ...(position.query ? { query: position.query } : {}) }
}
function restorePosition(reference: MobileKnowledgeReference, previous: KnowledgePosition | undefined, token: number): KnowledgePosition {
  const target = reference.topicId && reference.entryId ? { topicId: reference.topicId, entryId: reference.entryId } : null
  const editor = target && (reference.view === 'edit' || reference.draftKey)
    ? previous?.editor && sameTarget(previous.editor, target) && (!reference.draftKey || previous.editor.draftKey === reference.draftKey) ? previous.editor
      : { ...target, token, mountKey: reference.draftKey ?? `${target.topicId}:${target.entryId}`, ...(reference.draftKey ? { draftKey: reference.draftKey } : {}) }
    : previous?.editor ?? null
  return { view: reference.view, reading: target, editor, query: reference.query ?? '', search: reference.query ?? '' }
}
export function createTopicsNavigation(route: MobileTopicsRoute = { context: { categoryId: null, topicId: null, mode: 'discussion' }, sources: [] }): TopicsNavigationState {
  const positions = new Map<string | null, KnowledgePosition>()
  let nextToken = 1
  const sources = route.sources.map(value => {
    if (value.originKnowledge) positions.set(value.origin.topicId, restorePosition(value.originKnowledge, positions.get(value.origin.topicId), nextToken++))
    return { token: nextToken++, value }
  })
  // Existing persisted routes can retain a knowledge reference underneath a Topic source or another discussion.
  const originFrame = route.knowledge ? [...route.sources].reverse().find(frame => frame.originKnowledge && JSON.stringify(frame.originKnowledge) === JSON.stringify(route.knowledge)) : undefined
  const knowledgeScope = route.knowledge ? route.context.topicId === null || route.knowledge.topicId === route.context.topicId ? route.context.topicId
    : originFrame ? originFrame.origin.topicId : route.knowledge.topicId : undefined
  if (route.knowledge && knowledgeScope !== undefined) positions.set(knowledgeScope, restorePosition(route.knowledge, positions.get(knowledgeScope), nextToken++))
  if (!positions.has(route.context.topicId)) positions.set(route.context.topicId, emptyKnowledgePosition())
  return { context: route.context, positions, knowledgeScope, sources, directoryQuery: '', nextToken }
}
export function projectTopicsRoute(state: TopicsNavigationState): MobileTopicsRoute {
  return { context: state.context, sources: state.sources.map(frame => frame.value),
    ...(state.knowledgeScope !== undefined ? { knowledge: knowledgeReference(state.knowledgeScope, knowledgePosition(state, state.knowledgeScope)) } : {}) }
}
function withPosition(state: TopicsNavigationState, scope: string | null, position: KnowledgePosition): TopicsNavigationState {
  return { ...state, positions: new Map(state.positions).set(scope, position) }
}
function visit(state: TopicsNavigationState, topicId: string | null): TopicsNavigationState {
  return state.positions.has(topicId) ? state : { ...state, positions: new Map(state.positions).set(topicId, emptyKnowledgePosition()) }
}
/** Internal navigation in this exact Topic source keeps its original return frame. */
function sourcesForTarget(state: TopicsNavigationState, scope: string | null): readonly TopicsSourceFrame[] {
  const source = state.sources.at(-1)?.value.source
  return source?.kind === 'topic' && source.topicId === scope ? state.sources : []
}
function leaveSource(state: TopicsNavigationState): TopicsNavigationState {
  const frame = state.sources.at(-1)
  if (!frame) return state
  let next: TopicsNavigationState = { ...state, context: frame.value.origin, sources: state.sources.slice(0, -1), knowledgeScope: frame.value.originKnowledge ? frame.value.origin.topicId : undefined }
  if (frame.value.originKnowledge) next = withPosition(next, frame.value.origin.topicId,
    restorePosition(frame.value.originKnowledge, next.positions.get(frame.value.origin.topicId), next.nextToken++))
  return next
}
export function reduceTopicsNavigation(state: TopicsNavigationState, intent: TopicsNavigationIntent): TopicsNavigationState {
  switch (intent.type) {
    case 'directory-query': return { ...state, directoryQuery: intent.query }
    case 'category': return { ...state, context: { ...state.context, categoryId: intent.categoryId }, directoryQuery: intent.categoryId === null ? '' : state.directoryQuery }
    case 'topic': return visit({ ...state, sources: sourcesForTarget(state, intent.topicId), context: { categoryId: intent.categoryId === undefined ? state.context.categoryId : intent.categoryId, topicId: intent.topicId, mode: 'discussion' } }, intent.topicId)
    case 'mode': return visit({ ...state, sources: sourcesForTarget(state, intent.scope), context: { ...state.context, topicId: intent.scope, mode: intent.mode },
      ...(intent.mode === 'knowledge' ? { knowledgeScope: intent.scope } : {}) }, intent.scope)
    case 'topic-back': return state.sources.at(-1)?.value.source.kind === 'topic' ? leaveSource(state)
      : { ...state, sources: [], context: { ...state.context, topicId: null, mode: 'discussion' } }
    case 'source-open': {
      const route = projectTopicsRoute(state), source = intent.source
      const frame = { token: state.nextToken, value: { source, origin: state.context, ...(route.knowledge ? { originKnowledge: route.knowledge } : {}) } }
      return visit({ ...state, sources: [...state.sources, frame], nextToken: state.nextToken + 1,
        context: source.kind === 'topic' ? { ...state.context, topicId: source.topicId, mode: 'discussion' } : state.context }, source.kind === 'topic' ? source.topicId : state.context.topicId)
    }
    case 'source-leave': return leaveSource(state)
    default: {
      const position = knowledgePosition(state, intent.scope)
      if (intent.type === 'knowledge-query') return withPosition({ ...state, knowledgeScope: intent.scope }, intent.scope, { ...position, query: intent.query })
      if (intent.type === 'knowledge-search') return withPosition(state, intent.scope, { ...position, search: position.query.trim() })
      if (intent.type === 'knowledge-saved') {
        if (position.editor?.token !== intent.editorToken || position.view !== 'edit') return state
        return withPosition(state, intent.scope, { ...position, reading: { topicId: position.editor.topicId, entryId: position.editor.entryId }, view: intent.keepEditing ? 'edit' : 'read' })
      }
      const active = visit({ ...state, sources: sourcesForTarget(state, intent.scope), context: { ...state.context, topicId: intent.scope, mode: 'knowledge' }, knowledgeScope: intent.scope }, intent.scope)
      if (intent.type === 'knowledge-read') return withPosition(active, intent.scope, { ...position, reading: intent.target, view: 'read' })
      if (intent.type === 'knowledge-back') return withPosition(active, intent.scope, { ...position, view: intent.to === 'read' && position.reading ? 'read' : 'list', ...(intent.to === 'list' ? { reading: null } : {}) })
      const editor = position.editor && sameTarget(position.editor, intent.target) ? position.editor
        : { ...intent.target, token: state.nextToken, mountKey: intent.mountKey, ...(intent.isNew ? { isNew: true } : {}) }
      return withPosition({ ...active, nextToken: state.nextToken + 1 }, intent.scope, { ...position, view: 'edit', editor })
    }
  }
}
export function observeTopicsNavigation(state: TopicsNavigationState, observation: TopicsNavigationObservation): TopicsNavigationState {
  if (observation.type === 'source-content') {
    const frame = state.sources.at(-1)
    // Only this original frame's metadata is updated; it never opens or leaves a source.
    if (!frame || frame.token !== observation.frameToken || JSON.stringify(frame.value.source) !== JSON.stringify(observation.source)
      || JSON.stringify(frame.value.content) === JSON.stringify(observation.content)) return state
    return { ...state, sources: [...state.sources.slice(0, -1), { ...frame, value: { ...frame.value, content: observation.content } }] }
  }
  const position = state.positions.get(observation.scope), editor = position?.editor
  // A late editor observation cannot choose a new object or overwrite another retained editor.
  if (!position || !editor || editor.token !== observation.editorToken || !sameTarget(editor, observation.target) || editor.draftKey === observation.draftKey) return state
  return withPosition(state, observation.scope, { ...position, editor: { ...editor, draftKey: observation.draftKey } })
}
