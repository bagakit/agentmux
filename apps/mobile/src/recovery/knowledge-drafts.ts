import { parseTopicParams, type TopicKnowledge, type TopicKnowledgeSource, type TopicKnowledgeWrite } from '@agentmux/core/control'
import { isLocalNetworkHost } from '@agentmux/relay/offer'

/** Device text and original requests; Knowledge facts remain with the Host. */
export type MobileKnowledgeDraftScope = { origin: string; runtimeId: string; deviceHostId: string | null }
export type MobileKnowledgeAttempt = {
  attemptId: string; ownerInstanceId: string; input: TopicKnowledgeWrite; phase: 'sending' | 'unknown'; issue: string | null
}
export type MobileKnowledgeDraft = {
  topicId: string; entryId: string; scope: MobileKnowledgeDraftScope
  title: string; content: string; form: TopicKnowledge['form']; certainty: TopicKnowledge['certainty']
  sources: TopicKnowledgeSource[]; authoringScope: string; expectedRevision: string | null
  attempts: MobileKnowledgeAttempt[]; blockedAttemptId: string | null
}
export type MobileKnowledgeDraftCommit = {
  recordId: string | null; applied: boolean; draft: MobileKnowledgeDraft | null; conflict: MobileKnowledgeDraft | null
}
export class MobileKnowledgeDraftInvalidError extends Error {}
const MAX_ENTRIES = 256
function invalid(): never { throw new MobileKnowledgeDraftInvalidError('原知识草稿或完整写入请求无法核实；原字节与本页正文保留。') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
  return value as Record<string, unknown>
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const text = (value: unknown): value is string => typeof value === 'string' && new TextEncoder().encode(value).byteLength <= 65536
export function parseMobileKnowledgeDraftScope(value: unknown): MobileKnowledgeDraftScope {
  const v = object(value, ['origin', 'runtimeId', 'deviceHostId'])
  if (typeof v.origin !== 'string' || v.origin.length > 2048 || !id(v.runtimeId) || !(v.deviceHostId === null || id(v.deviceHostId))) invalid()
  try {
    const url = new URL(v.origin)
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && isLocalNetworkHost(url.hostname))
      || url.origin !== v.origin || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid()
  } catch { invalid() }
  return structuredClone(value) as MobileKnowledgeDraftScope
}
export function sameMobileKnowledgeDraftScope(a: MobileKnowledgeDraftScope, b: MobileKnowledgeDraftScope): boolean {
  return a.origin === b.origin && a.runtimeId === b.runtimeId && a.deviceHostId === b.deviceHostId
}
export function mobileKnowledgeDraftKey(topicId: string, entryId: string, scope: MobileKnowledgeDraftScope): string {
  return JSON.stringify([scope.origin, scope.runtimeId, scope.deviceHostId, topicId, entryId])
}
/** An opaque reference to one saved draft, not inferred Runtime health. */
export function parseMobileKnowledgeDraftKey(value: unknown): { topicId: string; entryId: string; scope: MobileKnowledgeDraftScope } {
  if (typeof value !== 'string' || value.length > 4096) invalid()
  try {
    const parts: unknown = JSON.parse(value)
    if (!Array.isArray(parts) || parts.length !== 5) invalid()
    const scope = parseMobileKnowledgeDraftScope({ origin: parts[0], runtimeId: parts[1], deviceHostId: parts[2] })
    const target = parseTopicParams('topic.knowledge.read', { topicId: parts[3], entryId: parts[4] })
    if (mobileKnowledgeDraftKey(target.topicId, target.entryId, scope) !== value) invalid()
    return { ...target, scope }
  } catch { invalid() }
}
function parseInput(value: unknown): TopicKnowledgeWrite {
  try { return structuredClone(parseTopicParams('topic.knowledge.write', value)) } catch { invalid() }
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
}
export function freezeMobileKnowledgeInput(value: unknown): TopicKnowledgeWrite {
  const input = parseInput(value)
  freeze(input)
  return input
}
/** Preserve unfinished authoring too; only the explicit Save needs a valid title/reference form. */
export function parseMobileKnowledgeDraft(value: unknown): MobileKnowledgeDraft {
  const v = object(value, ['topicId', 'entryId', 'scope', 'title', 'content', 'form', 'certainty', 'sources',
    'authoringScope', 'expectedRevision', 'attempts', 'blockedAttemptId'])
  parseMobileKnowledgeDraftScope(v.scope)
  if (typeof v.title !== 'string' || v.title.length > 120 || typeof v.authoringScope !== 'string' || v.authoringScope.length > 4096
    || !['derived', 'reference'].includes(String(v.form))) invalid()
  // The public parser owns sources, certainty, body, IDs and revision. A blank
  // title or reference without a source is a retainable draft, not a sent input.
  parseInput({ topicId: v.topicId, entryId: v.entryId, title: v.title.trim() || '未命名草稿', content: v.content,
    form: 'derived', certainty: v.certainty, sources: v.sources, expectedRevision: v.expectedRevision,
    ...(v.authoringScope ? { scope: v.authoringScope } : {}) })
  if (!Array.isArray(v.attempts) || v.attempts.length > MAX_ENTRIES) invalid()
  const ids = new Set<string>()
  for (const value of v.attempts) {
    const a = object(value, ['attemptId', 'ownerInstanceId', 'input', 'phase', 'issue']), input = parseInput(a.input)
    if (!id(a.attemptId) || ids.has(a.attemptId) || !id(a.ownerInstanceId)
      || input.topicId !== v.topicId || input.entryId !== v.entryId
      || !['sending', 'unknown'].includes(String(a.phase)) || !(a.issue === null || text(a.issue))) invalid()
    ids.add(a.attemptId)
  }
  if (!(v.blockedAttemptId === null || id(v.blockedAttemptId) && ids.has(v.blockedAttemptId))) invalid()
  return structuredClone(value) as MobileKnowledgeDraft
}
export function parseMobileKnowledgeDrafts(value: unknown): MobileKnowledgeDraft[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) invalid()
  const values = value.map(parseMobileKnowledgeDraft), keys = new Set<string>()
  for (const draft of values) {
    const key = mobileKnowledgeDraftKey(draft.topicId, draft.entryId, draft.scope)
    if (keys.has(key)) invalid()
    keys.add(key)
  }
  return values
}
export function parseMobileKnowledgeDraftConflicts(value: unknown): MobileKnowledgeDraft[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) invalid()
  const values = value.map(parseMobileKnowledgeDraft), keys = new Set<string>()
  for (const draft of values) { const key = JSON.stringify(draft); if (keys.has(key)) invalid(); keys.add(key) }
  return values
}
