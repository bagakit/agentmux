import { parseFileReadParams, parseFileReadResult, parseFileWriteParams, parseFileCreateParams,
  type FileReadResource, type FileReadResult, type FileWriteParams, type FileCreateParams } from '@agentmux/core/files'
import { isLocalNetworkHost } from '@agentmux/relay/offer'

export const moteFileSources = [
  { path: 'MOTE.md', label: 'MOTE.md' }, { path: 'BEHAVIOR.md', label: '合作方式 · BEHAVIOR.md' },
  { path: 'SOUL.md', label: '自我设定 · SOUL.md' }, { path: 'topic.md', label: '原摘要 · topic.md' }
] as const
export type MoteFilePath = typeof moteFileSources[number]['path']
/** Device text and original requests only. File bytes/revisions remain with the original Files owner. */
export type MoteFileDraftScope = {
  origin: string; runtimeId: string; deviceHostId: string | null
  spaceId: string; path: MoteFilePath; resource: FileReadResource
}
export type MoteFileBaseline = { status: 'read'; content: string; revision: string } | { status: 'deleted' }
type Attempt = { attemptId: string; ownerInstanceId: string; phase: 'sending' | 'unknown' | 'failed'; issue: string | null }
export type MoteFileAttempt = Attempt & (
  { kind: 'write'; input: FileWriteParams } | { kind: 'create'; input: FileCreateParams }
)
export type MoteFileDraft = {
  scope: MoteFileDraftScope; body: string; baseline: MoteFileBaseline | null
  attempts: MoteFileAttempt[]; blockedAttemptId: string | null
}
export type MoteFileDraftCommit = { recordId: string | null; applied: boolean; draft: MoteFileDraft | null; conflict: MoteFileDraft | null }
export class MoteFileDraftInvalidError extends Error {}
/** This owner refused the complete update before any durable write. */
export class MoteFileDraftCapacityError extends MoteFileDraftInvalidError {}
function invalid(): never { throw new MoteFileDraftInvalidError('原 Mote 文件草稿或完整保存请求无法核实；原字节与当前正文保留。') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
  return value as Record<string, unknown>
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value)
// Hosted opaque Runtime identities are nonempty strings, not spatial IDs.
const runtimeIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0
export function isMoteFilePath(value: unknown): value is MoteFilePath { return moteFileSources.some(source => source.path === value) }
export function moteFileReadParams(scope: MoteFileDraftScope) {
  const r = scope.resource
  return { spaceId: scope.spaceId, zoneId: r.zoneId, path: scope.path,
    expectedResource: { hostId: r.hostId, workspaceId: r.workspaceId, workspacePath: r.workspacePath } }
}
export function sameMoteFileResource(a: FileReadResource, b: FileReadResource): boolean {
  return (['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const).every(key => a[key] === b[key])
}
export function parseMoteFileDraftScope(value: unknown): MoteFileDraftScope {
  const v = object(value, ['origin', 'runtimeId', 'deviceHostId', 'spaceId', 'path', 'resource'])
  if (typeof v.origin !== 'string' || !runtimeIdentity(v.runtimeId) || !(v.deviceHostId === null || id(v.deviceHostId)) || !isMoteFilePath(v.path)) invalid()
  try {
    const url = new URL(v.origin)
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && isLocalNetworkHost(url.hostname))
      || url.origin !== v.origin || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid()
    const scope = v as unknown as MoteFileDraftScope, params = parseFileReadParams(moteFileReadParams(scope))
    const result = parseFileReadResult({ resource: v.resource, result: { status: 'directory' } }, params)
    if (!result.resource) invalid()
  } catch { invalid() }
  return structuredClone(value) as MoteFileDraftScope
}
export function moteFileDraftKey(scope: MoteFileDraftScope): string {
  const r = scope.resource
  return JSON.stringify([scope.origin, scope.runtimeId, scope.deviceHostId, scope.spaceId, scope.path,
    r.hostId, r.workspaceId, r.workspacePath, r.zoneId, r.zonePath, r.path, r.logicalDirectory ?? null])
}
export function sameMoteFileScope(a: MoteFileDraftScope, b: MoteFileDraftScope): boolean { return moteFileDraftKey(a) === moteFileDraftKey(b) }
export function moteFileBaseline(read: FileReadResult): MoteFileBaseline | null {
  return read.result.status === 'read' ? { status: 'read', content: read.result.document.content, revision: read.result.document.revision }
    : read.result.status === 'deleted' ? { status: 'deleted' } : null
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
}
export function freezeMoteFileWrite(value: unknown): FileWriteParams { const input = structuredClone(parseFileWriteParams(value)); freeze(input); return input }
export function freezeMoteFileCreate(value: unknown): FileCreateParams { const input = structuredClone(parseFileCreateParams(value)); freeze(input); return input }
export function parseMoteFileDraft(value: unknown): MoteFileDraft {
  const v = object(value, ['scope', 'body', 'baseline', 'attempts', 'blockedAttemptId']), scope = parseMoteFileDraftScope(v.scope)
  if (typeof v.body !== 'string' || !Array.isArray(v.attempts)) invalid()
  if (v.baseline !== null) {
    const b = v.baseline as MoteFileBaseline
    object(b, b.status === 'read' ? ['status', 'content', 'revision'] : ['status'])
    try {
      parseFileReadResult({ resource: scope.resource, result: b.status === 'read'
        ? { status: 'read', document: { path: scope.resource.path, content: b.content, revision: b.revision } }
        : b.status === 'deleted' ? { status: 'deleted' } : invalid() }, moteFileReadParams(scope))
    } catch { invalid() }
  }
  const ids = new Set<string>()
  for (const value of v.attempts) {
    const a = object(value, ['attemptId', 'ownerInstanceId', 'kind', 'input', 'phase', 'issue'])
    if (!id(a.attemptId) || ids.has(a.attemptId) || !runtimeIdentity(a.ownerInstanceId)
      || !['sending', 'unknown', 'failed'].includes(String(a.phase)) || !(a.issue === null || typeof a.issue === 'string')) invalid()
    try {
      const input = a.kind === 'write' ? parseFileWriteParams(a.input) : a.kind === 'create' ? parseFileCreateParams(a.input) : invalid()
      if (input.spaceId !== scope.spaceId || input.zoneId !== scope.resource.zoneId || input.path !== scope.path
        || !sameMoteFileResource(input.expectedResource, scope.resource)) invalid()
    } catch { invalid() }
    ids.add(a.attemptId)
  }
  if (!(v.blockedAttemptId === null || id(v.blockedAttemptId) && ids.has(v.blockedAttemptId))) invalid()
  return structuredClone(value) as MoteFileDraft
}
export function parseMoteFileDrafts(value: unknown): MoteFileDraft[] {
  if (!Array.isArray(value)) invalid()
  const values = value.map(parseMoteFileDraft), keys = new Set<string>()
  for (const draft of values) { const key = moteFileDraftKey(draft.scope); if (keys.has(key)) invalid(); keys.add(key) }
  return values
}
export function parseMoteFileDraftConflicts(value: unknown): MoteFileDraft[] {
  if (!Array.isArray(value)) invalid()
  const values = value.map(parseMoteFileDraft), keys = new Set<string>()
  for (const draft of values) { const key = JSON.stringify(draft); if (keys.has(key)) invalid(); keys.add(key) }
  return values
}
