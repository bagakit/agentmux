import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

/** Host content identities; category membership and conversations remain Core spatial facts. */
export type TopicCategory = {
  categoryId: string; hostId: string; spaceId: string; directoryPath: string;
  title: string; revision: string | null; readError?: string
}
export type KnowledgeTopic = {
  topicId: string; hostId: string; zoneId: string; directoryPath: string;
  title: string; summary: string; categorySpaceIds: string[]; chatIds: string[];
  spatialRevision: number; readError?: string
}
export type TopicUnavailable = { code: string; message: string; recovery: string; source?: string }
export type TopicMigrationPreview = {
  spatialRevision: number;
  topics: Array<{ topicId: string; sourceSpaceId: string; zoneId: string; categorySpaceId: string }>;
  category: TopicCategory; required: boolean; unavailable: TopicUnavailable[]
}
export type TopicMigrationReceipt = {
  spatialRevision: number; backupPath: string | null; migratedTopicIds: string[]; diskDurability: 'confirmed'
}
export type TopicKnowledgeSource =
  | { kind: 'topic'; topicId: string; chatId?: string; threadId?: string }
  | { kind: 'file'; hostId: string; path: string; projectId?: string; revision?: string }
  | { kind: 'note'; noteId: string; blockId?: string }
  | { kind: 'survey'; zoneId: string; tabId?: string; regionId?: string }
  | { kind: 'space'; zoneId: string; tabId?: string; regionId?: string }
  | { kind: 'url'; url: string }
export type TopicKnowledge = {
  topicId: string; entryId: string; title: string; content: string;
  form: 'reference' | 'derived'; certainty: 'fact' | 'inference' | 'proposal' | 'decision';
  sources: TopicKnowledgeSource[]; scope?: string; revision: string; updatedAt: number
}
export type TopicKnowledgeItem = TopicKnowledge | { topicId: string; entryId: string; readError: string }
export type TopicKnowledgeWrite = Omit<TopicKnowledge, 'revision' | 'updatedAt'> & { expectedRevision: string | null }
export type TopicParameterMap = {
  'topic.category.ls': Record<string, never>
  'topic.category.create': { categoryId: string; title: string }
  'topic.category.rename': { categoryId: string; title: string; expectedRevision: string }
  'topic.ls': { categoryId?: string; topicId?: string }
  'topic.inspect': { topicId: string }
  'topic.create': { topicId: string; title: string; categoryId?: string }
  'topic.move': { topicId: string; categoryId: string; expectedRevision: number }
  'topic.migrate.preview': Record<string, never>
  'topic.migrate.apply': { expectedRevision: number }
  'topic.knowledge.ls': { topicId: string; limit?: number }
  'topic.knowledge.search': { topicId?: string; query: string; limit?: number }
  'topic.knowledge.read': { topicId: string; entryId: string }
  'topic.knowledge.write': TopicKnowledgeWrite
}
export type TopicResultMap = {
  'topic.category.ls': { categories: TopicCategory[]; unavailable: TopicUnavailable[] }
  'topic.category.create': { category: TopicCategory; diskDurability: 'confirmed' }
  'topic.category.rename': { category: TopicCategory; diskDurability: 'confirmed' }
  'topic.ls': { topics: KnowledgeTopic[]; unavailable: TopicUnavailable[] }
  'topic.inspect': { topic: KnowledgeTopic | null; unavailable: TopicUnavailable[] }
  'topic.create': { topic: KnowledgeTopic; diskDurability: 'confirmed' }
  'topic.move': { topic: KnowledgeTopic; previousCategorySpaceIds: string[]; spatialRevision: number; diskDurability: 'confirmed' }
  'topic.migrate.preview': TopicMigrationPreview
  'topic.migrate.apply': TopicMigrationReceipt
  'topic.knowledge.ls': { entries: TopicKnowledgeItem[]; unavailable: TopicUnavailable[] }
  'topic.knowledge.search': { entries: TopicKnowledgeItem[]; unavailable: TopicUnavailable[] }
  'topic.knowledge.read': { entry: TopicKnowledge | null }
  'topic.knowledge.write': { entry: TopicKnowledge; diskDurability: 'confirmed' }
}
export type TopicMethod = keyof TopicParameterMap
export type TopicParams<M extends TopicMethod> = TopicParameterMap[M]
export type TopicResult<M extends TopicMethod> = TopicResultMap[M]
export interface AgentMuxRpcTopicsOwner {
  call<M extends TopicMethod>(method: M, params: TopicParams<M>, context?: AgentMuxRpcCallContext): Promise<TopicResult<M>>
}
export const AGENTMUX_RPC_TOPIC_METHODS = {
  'topic.category.ls': 'short', 'topic.category.create': 'long', 'topic.category.rename': 'long',
  'topic.ls': 'long', 'topic.inspect': 'short', 'topic.create': 'long', 'topic.move': 'long',
  'topic.migrate.preview': 'long', 'topic.migrate.apply': 'long',
  'topic.knowledge.ls': 'long', 'topic.knowledge.search': 'long', 'topic.knowledge.read': 'short', 'topic.knowledge.write': 'long'
} as const satisfies Record<TopicMethod, 'short' | 'long'>
export function isTopicMethod(value: unknown): value is TopicMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_TOPIC_METHODS, value)
}
function invalid(message: string, code = 'INVALID_CONTROL_REQUEST'): never { throw new AgentMuxError(message, code) }
function string(value: unknown, code: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\0\r\n]/u.test(value)) invalid('Topic identity or text is invalid.', code)
}
function categoryId(value: unknown, code: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) invalid('An exact Topic Category UUID is required.', code)
}
function topicId(value: unknown, code: string): void {
  if (typeof value !== 'string' || !/^(launcher|session|view):[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) invalid('An exact Topic identity is required.', code)
}
function count(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('Topic spatial revision is invalid.', code)
}
function title(value: unknown, code: string): void {
  string(value, code, 120)
  if (!value.trim()) invalid('Topic title cannot be empty.', code)
}
function revision(value: unknown, code: string, nullable = false): void {
  if (nullable && value === null) return
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) invalid('An exact content revision is required.', code)
}
function stringArray(value: unknown, code: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 10000) invalid('Topic identifiers must be a bounded array.', code)
  value.forEach(item => string(item, code))
  if (new Set(value).size !== value.length) invalid('Topic identifiers cannot repeat.', code)
}
export function parseTopicCategory(value: unknown): TopicCategory {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['categoryId','hostId','spaceId','directoryPath','title','revision','readError'], code)
  categoryId(p.categoryId, code); string(p.hostId, code); string(p.spaceId, code); string(p.directoryPath, code); title(p.title, code); revision(p.revision, code, true)
  if (p.readError !== undefined) string(p.readError, code)
  return p as TopicCategory
}
function parseTopic(value: unknown): KnowledgeTopic {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['topicId','hostId','zoneId','directoryPath','title','summary','categorySpaceIds','chatIds','spatialRevision','readError'], code)
  topicId(p.topicId, code); string(p.hostId, code); string(p.zoneId, code); string(p.directoryPath, code); string(p.title, code)
  if (typeof p.summary !== 'string') invalid('Topic summary is invalid.', code)
  stringArray(p.categorySpaceIds, code); stringArray(p.chatIds, code); count(p.spatialRevision, code)
  if (p.readError !== undefined) string(p.readError, code)
  return p as KnowledgeTopic
}
function unavailable(value: unknown): void {
  const code = 'CONTROL_PROTOCOL_ERROR'
  if (!Array.isArray(value)) invalid('Topic unavailable facts must be an array.', code)
  for (const item of value) {
    const p = rpcRecord(item, ['code','message','recovery','source'], code)
    for (const key of ['code','message','recovery']) string(p[key], code)
    if (p.source !== undefined) string(p.source, code)
  }
}
const knowledgeFields = ['topicId','entryId','title','content','form','certainty','sources','scope'] as const
function knowledgePayload(p: Record<string, unknown>, code: string): void {
  topicId(p.topicId, code); categoryId(p.entryId, code); title(p.title, code)
  if (typeof p.content !== 'string' || p.content.includes('\0') || new TextEncoder().encode(p.content).byteLength > 128 * 1024)
    invalid('Knowledge content must be bounded UTF-8 text.', code)
  if (p.form !== 'reference' && p.form !== 'derived' || !['fact','inference','proposal','decision'].includes(String(p.certainty))) invalid('Knowledge form or certainty is invalid.', code)
  if (!Array.isArray(p.sources) || p.sources.length > 16 || p.form === 'reference' && p.sources.length === 0) invalid('Knowledge references require bounded original sources.', code)
  for (const value of p.sources as unknown[]) {
    const source = rpcRecord(value, undefined, code)
    const fields = source.kind === 'topic' ? ['kind','topicId','chatId','threadId'] : source.kind === 'file' ? ['kind','hostId','path','projectId','revision']
      : source.kind === 'note' ? ['kind','noteId','blockId'] : source.kind === 'survey' || source.kind === 'space' ? ['kind','zoneId','tabId','regionId'] : source.kind === 'url' ? ['kind','url'] : null
    if (!fields) invalid('Choose an original typed knowledge source.', code)
    rpcRecord(source, fields, code)
    const required = source.kind === 'topic' ? ['topicId'] : source.kind === 'file' ? ['hostId','path'] : source.kind === 'note' ? ['noteId'] : source.kind === 'survey' || source.kind === 'space' ? ['zoneId'] : ['url']
    for (const key of required) string(source[key], code)
    for (const key of fields) if (key !== 'kind' && source[key] !== undefined) string(source[key], code)
    if (source.kind === 'topic') topicId(source.topicId, code)
    if (source.kind === 'url') { try { new URL(source.url as string) } catch { invalid('The original source URL is invalid.', code) } }
  }
  if (p.scope !== undefined) string(p.scope, code, 4096)
}
export function parseTopicKnowledge(value: unknown): TopicKnowledge {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, [...knowledgeFields,'revision','updatedAt'], code)
  knowledgePayload(p, code); revision(p.revision, code); count(p.updatedAt, code)
  return p as TopicKnowledge
}
function knowledgeItem(value: unknown): TopicKnowledgeItem {
  const p = rpcRecord(value, undefined, 'CONTROL_PROTOCOL_ERROR')
  if (Object.hasOwn(p, 'readError')) {
    rpcRecord(p, ['topicId','entryId','readError'], 'CONTROL_PROTOCOL_ERROR')
    topicId(p.topicId, 'CONTROL_PROTOCOL_ERROR'); categoryId(p.entryId, 'CONTROL_PROTOCOL_ERROR'); string(p.readError, 'CONTROL_PROTOCOL_ERROR')
    return p as { topicId: string; entryId: string; readError: string }
  }
  return parseTopicKnowledge(p)
}
const PARAM_FIELDS: Record<TopicMethod, readonly string[]> = {
  'topic.category.ls': [], 'topic.category.create': ['categoryId','title'],
  'topic.category.rename': ['categoryId','title','expectedRevision'], 'topic.ls': ['categoryId','topicId'],
  'topic.inspect': ['topicId'], 'topic.create': ['topicId','title','categoryId'],
  'topic.move': ['topicId','categoryId','expectedRevision'], 'topic.migrate.preview': [], 'topic.migrate.apply': ['expectedRevision'],
  'topic.knowledge.ls': ['topicId','limit'], 'topic.knowledge.search': ['topicId','query','limit'],
  'topic.knowledge.read': ['topicId','entryId'], 'topic.knowledge.write': [...knowledgeFields,'expectedRevision']
}
export function parseTopicParams<M extends TopicMethod>(method: M, value: unknown): TopicParams<M> {
  const p = rpcRecord(value, PARAM_FIELDS[method]), code = 'INVALID_CONTROL_REQUEST'
  if (method !== 'topic.ls' && method !== 'topic.knowledge.search' && PARAM_FIELDS[method].includes('topicId')) topicId(p.topicId, code)
  if ((method === 'topic.ls' || method === 'topic.knowledge.search') && p.topicId !== undefined) topicId(p.topicId, code)
  if (p.categoryId !== undefined || method === 'topic.category.create' || method === 'topic.category.rename' || method === 'topic.move') categoryId(p.categoryId, code)
  if (PARAM_FIELDS[method].includes('title')) title(p.title, code)
  if (method === 'topic.category.rename') revision(p.expectedRevision, code)
  if (method === 'topic.move' || method === 'topic.migrate.apply') count(p.expectedRevision, code)
  if (method === 'topic.knowledge.write') { knowledgePayload(p, code); revision(p.expectedRevision, code, true) }
  if (method === 'topic.knowledge.read') categoryId(p.entryId, code)
  if (method === 'topic.knowledge.search') { string(p.query, code, 4096); if (!(p.query as string).trim()) invalid('Choose a nonempty knowledge query.', code) }
  if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 100)) invalid('Knowledge limit must be between 1 and 100.', code)
  return p as TopicParams<M>
}
export function parseTopicResult<M extends TopicMethod>(method: M, value: unknown, params: TopicParams<M>): TopicResult<M> {
  const code = 'CONTROL_PROTOCOL_ERROR', input = params as Record<string, unknown>
  const fields = method === 'topic.category.ls' ? ['categories','unavailable']
    : method === 'topic.category.create' || method === 'topic.category.rename' ? ['category','diskDurability']
    : method === 'topic.ls' ? ['topics','unavailable'] : method === 'topic.inspect' ? ['topic','unavailable']
    : method === 'topic.create' ? ['topic','diskDurability']
    : method === 'topic.move' ? ['topic','previousCategorySpaceIds','spatialRevision','diskDurability']
    : method === 'topic.migrate.preview' ? ['spatialRevision','topics','category','required','unavailable']
    : method === 'topic.knowledge.ls' || method === 'topic.knowledge.search' ? ['entries','unavailable']
    : method === 'topic.knowledge.read' ? ['entry'] : method === 'topic.knowledge.write' ? ['entry','diskDurability']
    : ['spatialRevision','backupPath','migratedTopicIds','diskDurability']
  const p = rpcRecord(value, fields, code)
  if (p.diskDurability !== undefined && p.diskDurability !== 'confirmed') invalid('Topic save is not confirmed.', code)
  if (fields.includes('diskDurability') && p.diskDurability !== 'confirmed') invalid('Topic save receipt is missing.', code)
  if (fields.includes('unavailable')) unavailable(p.unavailable)
  if (method === 'topic.category.ls') {
    if (!Array.isArray(p.categories)) invalid('Topic categories must be an array.', code)
    p.categories.forEach(parseTopicCategory)
  } else if (method === 'topic.category.create' || method === 'topic.category.rename') {
    if (parseTopicCategory(p.category).categoryId !== input.categoryId) invalid('Another Topic Category was returned.', code)
  } else if (method === 'topic.ls') {
    if (!Array.isArray(p.topics)) invalid('Topics must be an array.', code)
    p.topics.forEach(item => { if (input.topicId !== undefined && parseTopic(item).topicId !== input.topicId) invalid('Another Topic was returned.', code); parseTopic(item) })
  } else if (method === 'topic.inspect' || method === 'topic.create' || method === 'topic.move') {
    if (p.topic !== null || method !== 'topic.inspect') {
      if (parseTopic(p.topic).topicId !== input.topicId) invalid('Another Topic was returned.', code)
    }
    if (method === 'topic.move') { stringArray(p.previousCategorySpaceIds, code); count(p.spatialRevision, code) }
  } else if (method === 'topic.migrate.preview') {
    count(p.spatialRevision, code); parseTopicCategory(p.category)
    if (typeof p.required !== 'boolean' || !Array.isArray(p.topics)) invalid('Topic migration preview is invalid.', code)
    for (const item of p.topics) {
      const t = rpcRecord(item, ['topicId','sourceSpaceId','zoneId','categorySpaceId'], code)
      topicId(t.topicId, code); for (const key of ['sourceSpaceId','zoneId','categorySpaceId']) string(t[key], code)
    }
  } else if (method === 'topic.knowledge.ls' || method === 'topic.knowledge.search') {
    if (!Array.isArray(p.entries) || p.entries.length > (input.limit as number ?? 32)) invalid('Knowledge list is invalid or exceeds its requested scope.', code)
    for (const value of p.entries) { const entry = knowledgeItem(value); if (input.topicId !== undefined && entry.topicId !== input.topicId) invalid('Another Topic knowledge scope was returned.', code) }
  } else if (method === 'topic.knowledge.read' || method === 'topic.knowledge.write') {
    if (p.entry !== null || method === 'topic.knowledge.write') { const entry = parseTopicKnowledge(p.entry); if (entry.topicId !== input.topicId || entry.entryId !== input.entryId) invalid('Another knowledge entry was returned.', code) }
  } else {
    count(p.spatialRevision, code); if (p.backupPath !== null) string(p.backupPath, code)
    stringArray(p.migratedTopicIds, code); p.migratedTopicIds.forEach(item => topicId(item, code))
  }
  return p as TopicResult<M>
}
