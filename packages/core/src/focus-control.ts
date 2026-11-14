import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from './public-rpc-frame.js'

/** Presentation references are not canonical Agent Session identities. */
export type AgentMuxFocusContextReference = { hostId: string; contextId: string }
export type AgentMuxFocusScope =
  | { kind: 'project'; hostId: string; projectSpaceId: string }
  | { kind: 'collection'; hostId: string; categorySpaceIds: readonly string[] }
export type AgentMuxFocusSelection = { kind: 'all' } |
  { kind: 'members'; references: readonly AgentMuxFocusContextReference[] }
export type AgentMuxFocusTaskReference = { scope: AgentMuxFocusScope; selection: AgentMuxFocusSelection }
export type AgentMuxFocusListParams = { limit?: number; cursor?: string }
export type AgentMuxFocusReadParams = AgentMuxFocusTaskReference & AgentMuxFocusListParams
export type AgentMuxFocusSource = { clientId: string; rendererId: string; documentGeneration: number }
export type AgentMuxFocusGroup = { scope: AgentMuxFocusScope; name: string; identityStatus: 'confirmed' | 'unconfirmed'; memberCount: number }
export type AgentMuxFocusMember = {
  reference: AgentMuxFocusContextReference; availability: 'observed' | 'changed' | 'unconfirmed'
  name: string | null; kind: string | null
  state: { process: string | null; semantic: string | null; label: string | null; unobserved: boolean } | null
  agent: { hostId: string; agentSessionId: string; run: { runId: string } } | null
  excerpt: { text: string; truncated: boolean } | null
  locations: { status: 'confirmed' | 'unconfirmed'; occurrences: readonly {
    hostId: string; workspaceId: string; groupId: string; tabId: string; regionId: string
  }[] }
}
export type AgentMuxFocusPage<Item> = {
  schemaVersion: 1; source: AgentMuxFocusSource; readAt: number
  status: 'observed' | 'changed' | 'unconfirmed' | 'unavailable'
  items: readonly Item[]; nextCursor: string | null
  coverage: { complete: boolean; total: number; selected: number; returned: number
    sourceStatuses: readonly { source: string; status: 'observed' | 'unconfirmed' | 'unavailable' }[] }
  issues: readonly { code: string; message: string }[]
}
export type AgentMuxFocusGroupDirectoryPage = AgentMuxFocusPage<AgentMuxFocusGroup>
export type AgentMuxFocusGroupPage = AgentMuxFocusPage<AgentMuxFocusMember> & AgentMuxFocusTaskReference
export const FOCUS_METHODS = { 'focus.ls': 'short', 'focus.read': 'short' } as const
export type FocusMethod = keyof typeof FOCUS_METHODS
export type FocusParams = { 'focus.ls': AgentMuxFocusListParams; 'focus.read': AgentMuxFocusReadParams }
export type FocusResults = { 'focus.ls': AgentMuxFocusGroupDirectoryPage; 'focus.read': AgentMuxFocusGroupPage }
export const FOCUS_READ_MAX_REFERENCES = 256
export const FOCUS_PAGE_DEFAULT = 50
export const FOCUS_PAGE_MAX = 100
export const FOCUS_EXCERPT_MAX = 600

function fail(code: string, message = 'The original Focus read is invalid. Keep its exact scope and existing work.'): never {
  throw new AgentMuxError(message, code)
}
function text(value: unknown, code: string, identity = false): string {
  if (typeof value !== 'string' || value.includes('\0') || identity && !value.trim()) fail(code)
  return value
}
function count(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code)
  return value as number
}
function oneOf<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (!values.includes(value as T)) fail(code)
  return value as T
}
function list(value: unknown, code: string): unknown[] { if (!Array.isArray(value)) fail(code); return value }
function boolean(value: unknown, code: string): boolean { if (typeof value !== 'boolean') fail(code); return value }
function nullable(value: unknown, code: string): string | null { return value === null ? null : text(value, code) }
function budget(value: unknown, code: string): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > AGENTMUX_RPC_MAX_MESSAGE_BYTES) {
    fail(code, 'This Focus request exceeds the original transport budget. Keep the complete task and read its exact member batches separately; no Agent was changed.')
  }
}
export function parseFocusScope(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxFocusScope {
  const p = rpcRecord(value, ['kind', 'hostId', 'projectSpaceId', 'categorySpaceIds'], code)
  const hostId = text(p.hostId, code, true)
  if (p.kind === 'project' && p.categorySpaceIds === undefined) return { kind: 'project', hostId, projectSpaceId: text(p.projectSpaceId, code, true) }
  if (p.kind === 'collection' && p.projectSpaceId === undefined) return { kind: 'collection', hostId,
    categorySpaceIds: [...new Set(list(p.categorySpaceIds, code).map(id => text(id, code, true)))].sort() }
  return fail(code)
}
function reference(value: unknown, code: string): AgentMuxFocusContextReference {
  const p = rpcRecord(value, ['hostId', 'contextId'], code)
  return { hostId: text(p.hostId, code, true), contextId: text(p.contextId, code, true) }
}
export const focusContextReferenceKey = (ref: AgentMuxFocusContextReference): string => JSON.stringify([ref.hostId, ref.contextId])
export function parseFocusTaskReference(value: unknown, code = 'INVALID_CONTROL_REQUEST'): AgentMuxFocusTaskReference {
  const p = rpcRecord(value, ['scope', 'selection'], code), s = rpcRecord(p.selection, ['kind', 'references'], code)
  const scope = parseFocusScope(p.scope, code)
  if (s.kind === 'all' && s.references === undefined) return { scope, selection: { kind: 'all' } }
  if (s.kind !== 'members') return fail(code)
  const refs = list(s.references, code).map(item => reference(item, code))
  const references = [...new Map(refs.map(ref => [focusContextReferenceKey(ref), ref])).entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ref]) => ref)
  const result: AgentMuxFocusTaskReference = { scope, selection: { kind: 'members', references } }
  budget(result, code)
  return result
}
export function parseFocusSource(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): AgentMuxFocusSource {
  const p = rpcRecord(value, ['clientId', 'rendererId', 'documentGeneration'], code)
  return { clientId: text(p.clientId, code, true), rendererId: text(p.rendererId, code, true), documentGeneration: count(p.documentGeneration, code) }
}
export function parseFocusParams<M extends FocusMethod>(method: M, value: unknown, code = 'INVALID_CONTROL_REQUEST'): FocusParams[M] {
  const p = rpcRecord(value, method === 'focus.ls' ? ['limit', 'cursor'] : ['scope', 'selection', 'limit', 'cursor'], code)
  const limit = p.limit === undefined ? undefined : count(p.limit, code)
  if (limit !== undefined && (limit < 1 || limit > FOCUS_PAGE_MAX)) fail(code)
  const page = { ...(limit === undefined ? {} : { limit }), ...(p.cursor === undefined ? {} : { cursor: text(p.cursor, code, true) }) }
  let result: FocusParams[FocusMethod] = page
  if (method === 'focus.read') {
    const task = parseFocusTaskReference({ scope: p.scope, selection: p.selection }, code)
    if (task.selection.kind === 'members' && task.selection.references.length > FOCUS_READ_MAX_REFERENCES) {
      fail('FOCUS_SELECTION_LIMIT', 'One Focus read accepts at most 256 exact references. Keep the complete selection and read its exact batches; do not truncate or change it to all.')
    }
    result = { ...task, ...page }
  }
  budget(result, code)
  return result as FocusParams[M]
}
function group(value: unknown, code: string): AgentMuxFocusGroup {
  const p = rpcRecord(value, ['scope', 'name', 'identityStatus', 'memberCount'], code)
  const scope = parseFocusScope(p.scope, code), identityStatus = oneOf(p.identityStatus, ['confirmed', 'unconfirmed'], code)
  if (scope.kind === 'collection' && scope.categorySpaceIds.length === 0 && identityStatus === 'confirmed') fail(code)
  return { scope, name: text(p.name, code), identityStatus, memberCount: count(p.memberCount, code) }
}
function member(value: unknown, code: string): AgentMuxFocusMember {
  const p = rpcRecord(value, ['reference', 'availability', 'name', 'kind', 'state', 'agent', 'excerpt', 'locations'], code)
  const state = p.state === null ? null : rpcRecord(p.state, ['process', 'semantic', 'label', 'unobserved'], code)
  const agent = p.agent === null ? null : rpcRecord(p.agent, ['hostId', 'agentSessionId', 'run'], code)
  const excerpt = p.excerpt === null ? null : rpcRecord(p.excerpt, ['text', 'truncated'], code)
  const locations = rpcRecord(p.locations, ['status', 'occurrences'], code)
  const result: AgentMuxFocusMember = { reference: reference(p.reference, code), availability: oneOf(p.availability, ['observed', 'changed', 'unconfirmed'], code),
    name: nullable(p.name, code), kind: nullable(p.kind, code),
    state: state ? { process: nullable(state.process, code), semantic: nullable(state.semantic, code), label: nullable(state.label, code), unobserved: boolean(state.unobserved, code) } : null,
    agent: agent ? { hostId: text(agent.hostId, code, true), agentSessionId: text(agent.agentSessionId, code, true), run: { runId: text(rpcRecord(agent.run, ['runId'], code).runId, code, true) } } : null,
    excerpt: excerpt ? { text: text(excerpt.text, code), truncated: boolean(excerpt.truncated, code) } : null,
    locations: { status: oneOf(locations.status, ['confirmed', 'unconfirmed'], code), occurrences: list(locations.occurrences, code).map(item => {
      const at = rpcRecord(item, ['hostId', 'workspaceId', 'groupId', 'tabId', 'regionId'], code)
      return { hostId: text(at.hostId, code, true), workspaceId: text(at.workspaceId, code, true), groupId: text(at.groupId, code, true), tabId: text(at.tabId, code, true), regionId: text(at.regionId, code, true) }
    }) } }
  if (result.excerpt && result.excerpt.text.length > FOCUS_EXCERPT_MAX) fail(code)
  if (result.availability !== 'observed' && result.agent !== null) fail(code)
  return result
}
/** Strict public and IPC reply validation; presentation strings grant no control authority. */
export function parseFocusResult<M extends FocusMethod>(method: M, value: unknown, input?: FocusParams[M]): FocusResults[M] {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['schemaVersion', 'source', 'readAt', 'status', 'items', 'nextCursor', 'coverage', 'issues', ...(method === 'focus.read' ? ['scope', 'selection'] : [])], code)
  if (p.schemaVersion !== 1 || typeof p.readAt !== 'number' || !Number.isFinite(p.readAt) || p.readAt < 0) fail(code)
  const coverage = rpcRecord(p.coverage, ['complete', 'total', 'selected', 'returned', 'sourceStatuses'], code)
  const items = list(p.items, code).map(item => method === 'focus.ls' ? group(item, code) : member(item, code))
  const complete = boolean(coverage.complete, code), nextCursor = p.nextCursor === null ? null : text(p.nextCursor, code, true)
  const total = count(coverage.total, code), selected = count(coverage.selected, code), returned = count(coverage.returned, code)
  if (items.length > (input ? input.limit ?? FOCUS_PAGE_DEFAULT : FOCUS_PAGE_MAX) || items.length !== returned || returned > selected || complete && nextCursor !== null) fail(code)
  const status = oneOf(p.status, ['observed', 'changed', 'unconfirmed', 'unavailable'], code)
  const result = { schemaVersion: 1 as const, source: parseFocusSource(p.source), readAt: p.readAt, status, items, nextCursor,
    coverage: { complete, total, selected, returned, sourceStatuses: list(coverage.sourceStatuses, code).map(value => {
      const entry = rpcRecord(value, ['source', 'status'], code)
      return { source: text(entry.source, code, true), status: oneOf(entry.status, ['observed', 'unconfirmed', 'unavailable'], code) }
    }) }, issues: list(p.issues, code).map(value => {
      const issue = rpcRecord(value, ['code', 'message'], code)
      return { code: text(issue.code, code, true), message: text(issue.message, code) }
    }) }
  if (method === 'focus.ls') return result as unknown as FocusResults[M]
  const task = parseFocusTaskReference({ scope: p.scope, selection: p.selection }, code)
  if (input && JSON.stringify(task) !== JSON.stringify(parseFocusTaskReference({ scope: (input as AgentMuxFocusReadParams).scope, selection: (input as AgentMuxFocusReadParams).selection }, code))) fail(code)
  const readItems = items as AgentMuxFocusMember[]
  if (new Set(readItems.map(item => focusContextReferenceKey(item.reference))).size !== readItems.length) fail(code)
  if (task.selection.kind === 'members') {
    const keys = new Set(task.selection.references.map(focusContextReferenceKey))
    if (readItems.some(item => !keys.has(focusContextReferenceKey(item.reference)))) fail(code)
  }
  return { ...result, ...task } as FocusResults[M]
}
