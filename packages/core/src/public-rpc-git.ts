import type {
  GitBranchComparisonSnapshot, GitCommitDetailsInput, GitCommitDetailsResult, GitCommitSnapshot,
  GitDiffDescriptor, GitDiffSide, GitFileDiff, GitHistoryInput, GitHistoryResult, GitHistorySnapshot
} from '@agentmux/git/types'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

/** The original configured resource, discovered from app.snapshot; never a display or cwd guess. */
export type GitExpectedResource = { hostId: string; workspacePath: string }
export type GitTarget = { workspaceId: string; expectedResource: GitExpectedResource }
export type GitParameterMap = {
  'git.history': GitTarget & GitHistoryInput
  'git.commit': GitTarget & GitCommitDetailsInput
  'git.diff': GitTarget & { input: GitDiffDescriptor }
}
export type GitResultMap = {
  'git.history': GitHistoryResult
  'git.commit': GitCommitDetailsResult
  'git.diff': GitFileDiff
}
export type GitMethod = keyof GitParameterMap
export type GitOpenParams = GitTarget & GitCommitDetailsInput
export type GitOpenResult = {
  workspaceId: string
  read: { kind: 'ready'; snapshot: GitCommitSnapshot }
  presentation: { tabId: string; regionId: string }
}
export interface AgentMuxRpcGitOwner {
  call<M extends GitMethod>(method: M, params: GitParameterMap[M], context?: AgentMuxRpcCallContext): Promise<GitResultMap[M]>
}
export const AGENTMUX_RPC_GIT_METHODS = {
  'git.history': 'long', 'git.commit': 'long', 'git.diff': 'long'
} as const satisfies Record<GitMethod, 'short' | 'long'>
export function isGitMethod(value: unknown): value is GitMethod {
  return typeof value === 'string' && Object.hasOwn(AGENTMUX_RPC_GIT_METHODS, value)
}
function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function identity(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value || value === 'self' || /[\0\r\n]/u.test(value)) invalid('An exact original Git identity is required.', code)
}
function text(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) invalid('Git text must be complete text data.', code)
}
function absolutePath(value: unknown, code: string): asserts value is string {
  text(value, code)
  if (!value.startsWith('/')) invalid('The original absolute Git resource path is required.', code)
}
function filePath(value: unknown, code: string): asserts value is string {
  text(value, code)
  if (!value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) invalid('A repository-relative Git file path is required.', code)
}
function oid(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) invalid('A complete immutable Git commit OID is required.', code)
}
function count(value: unknown, code: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid('Git count or cursor is invalid.', code)
}
function array(value: unknown, code: string, consume: (item: unknown) => void): asserts value is unknown[] {
  if (!Array.isArray(value)) invalid('Git collection is invalid.', code)
  for (const item of value) consume(item)
}
function parseTarget(value: Record<string, unknown>, code: string): void {
  identity(value.workspaceId, code)
  const resource = rpcRecord(value.expectedResource, ['hostId', 'workspacePath'], code)
  identity(resource.hostId, code); absolutePath(resource.workspacePath, code)
}
export function parseGitCommitSnapshot(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): GitCommitSnapshot {
  const p = rpcRecord(value, ['hostId', 'repoPath', 'commitOid', 'parentOid'], code)
  identity(p.hostId, code); absolutePath(p.repoPath, code); oid(p.commitOid, code)
  if (p.parentOid !== null) oid(p.parentOid, code)
  return p as GitCommitSnapshot
}
function historySnapshot(value: unknown, code: string): GitHistorySnapshot {
  const p = rpcRecord(value, ['hostId', 'repoPath', 'selectedRef', 'roots', 'refs', 'checkedAt'], code)
  identity(p.hostId, code); absolutePath(p.repoPath, code)
  if (p.selectedRef !== null) identity(p.selectedRef, code)
  array(p.roots, code, item => oid(item, code))
  array(p.refs, code, item => {
    const ref = rpcRecord(item, ['name', 'kind', 'oid'], code)
    identity(ref.name, code); oid(ref.oid, code)
    if (!['head', 'local', 'remote', 'tag'].includes(String(ref.kind))) invalid('Git reference kind is invalid.', code)
  })
  if (typeof p.checkedAt !== 'number' || !Number.isFinite(p.checkedAt)) invalid('Git observation time is invalid.', code)
  return p as GitHistorySnapshot
}
function historyCursor(value: unknown, code: string) {
  const p = rpcRecord(value, ['snapshot', 'offset'], code)
  historySnapshot(p.snapshot, code); count(p.offset, code)
  return p as unknown as NonNullable<GitHistoryInput['cursor']>
}
function branchSnapshot(value: unknown, code: string): GitBranchComparisonSnapshot {
  const p = rpcRecord(value, ['hostId', 'repoPath', 'mode', 'baseBranch', 'targetBranch', 'baseOid', 'targetOid', 'comparisonBaseOid'], code)
  identity(p.hostId, code); absolutePath(p.repoPath, code)
  identity(p.baseBranch, code); identity(p.targetBranch, code)
  if (p.mode !== 'merge-base' && p.mode !== 'two-point') invalid('Git comparison mode is invalid.', code)
  for (const key of ['baseOid', 'targetOid', 'comparisonBaseOid']) oid(p[key], code)
  return p as GitBranchComparisonSnapshot
}
function diffDescriptor(value: unknown, code: string): GitDiffDescriptor {
  const p = rpcRecord(value, ['kind', 'snapshot', 'file'], code)
  if (p.kind === 'commit') parseGitCommitSnapshot(p.snapshot, code)
  else if (p.kind === undefined) branchSnapshot(p.snapshot, code)
  else invalid('Git diff must use the original bound descriptor.', code)
  const file = rpcRecord(p.file, ['path', 'origPath'], code)
  filePath(file.path, code)
  if (file.origPath !== null) filePath(file.origPath, code)
  return p as GitDiffDescriptor
}
export function parseGitParams<M extends GitMethod>(method: M, value: unknown, code = 'INVALID_CONTROL_REQUEST'): GitParameterMap[M] {
  const p = rpcRecord(value, ['workspaceId', 'expectedResource',
    ...(method === 'git.history' ? ['ref', 'limit', 'cursor'] : method === 'git.commit' ? ['oid', 'parentOid'] : ['input'])], code)
  parseTarget(p, code)
  if (method === 'git.commit') {
    oid(p.oid, code); if (p.parentOid !== undefined) oid(p.parentOid, code)
  } else if (method === 'git.history') {
    if (p.ref !== undefined && p.ref !== null) identity(p.ref, code)
    if (p.limit !== undefined) { count(p.limit, code); if (p.limit === 0) invalid('Git page size must be positive.', code) }
    if (p.cursor !== undefined) {
      const cursor = historyCursor(p.cursor, code)
      if (cursor.snapshot.hostId !== (p.expectedResource as GitExpectedResource).hostId ||
          p.ref !== undefined && p.ref !== cursor.snapshot.selectedRef) invalid('Git cursor belongs to another Host or reference.', code)
    }
  } else {
    const input = diffDescriptor(p.input, code)
    if (input.snapshot.hostId !== (p.expectedResource as GitExpectedResource).hostId) invalid('Git diff belongs to another Host.', code)
  }
  return p as GitParameterMap[M]
}
export function parseGitOpenParams(value: unknown, code = 'INVALID_CONTROL_REQUEST'): GitOpenParams {
  return parseGitParams('git.commit', value, code)
}
function commit(value: unknown, code: string, details = false): Record<string, unknown> {
  const p = rpcRecord(value, ['oid', 'parents', 'subject', 'author', 'authoredAt', 'refs',
    ...(details ? ['message', 'committer', 'committedAt'] : [])], code)
  oid(p.oid, code); array(p.parents, code, item => oid(item, code))
  for (const key of ['subject', 'author', ...(details ? ['message', 'committer'] : [])]) text(p[key], code)
  for (const key of ['authoredAt', ...(details ? ['committedAt'] : [])]) {
    if (p[key] !== null && (typeof p[key] !== 'number' || !Number.isFinite(p[key]))) invalid('Git commit time is invalid.', code)
  }
  array(p.refs, code, item => {
    const ref = rpcRecord(item, ['name', 'kind', 'oid'], code)
    identity(ref.name, code); oid(ref.oid, code)
    if (!['head', 'local', 'remote', 'tag'].includes(String(ref.kind))) invalid('Git reference kind is invalid.', code)
  })
  return p
}
function side(value: unknown, code: string): GitDiffSide {
  const p = rpcRecord(value, undefined, code)
  if (p.present === false) rpcRecord(p, ['present'], code)
  else if (p.present === true && p.binary === true) rpcRecord(p, ['present', 'binary'], code)
  else if (p.present === true && p.binary === false) { rpcRecord(p, ['present', 'binary', 'text'], code); text(p.text, code) }
  else invalid('Git diff side is invalid.', code)
  return p as GitDiffSide
}
export function parseGitResult<M extends GitMethod>(method: M, value: unknown, params: GitParameterMap[M]): GitResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, undefined, code)
  if (method === 'git.diff') {
    rpcRecord(p, ['path', 'old', 'new', 'binary', 'change'], code)
    filePath(p.path, code); const old = side(p.old, code), current = side(p.new, code)
    if (p.path !== (params as GitParameterMap['git.diff']).input.file.path ||
        p.binary !== (old.present && old.binary || current.present && current.binary) ||
        !['added', 'deleted', 'modified', 'unchanged'].includes(String(p.change))) invalid('Git diff belongs to another file or has invalid sides.', code)
  } else if (p.kind === 'not-a-git-repository') {
    rpcRecord(p, ['kind', 'hostId', 'workspacePath'], code)
    if (p.hostId !== params.expectedResource.hostId || p.workspacePath !== params.expectedResource.workspacePath) invalid('Git result belongs to another original resource.', code)
  } else if (p.kind === 'ready' && method === 'git.history') {
    rpcRecord(p, ['kind', 'snapshot', 'commits', 'nextCursor'], code)
    const snapshot = historySnapshot(p.snapshot, code), input = params as GitParameterMap['git.history']
    if (snapshot.hostId !== input.expectedResource.hostId ||
        input.ref !== undefined && snapshot.selectedRef !== input.ref ||
        input.cursor && !isDeepStrictEqual(snapshot, input.cursor.snapshot)) invalid('Git history belongs to another fixed scope.', code)
    array(p.commits, code, item => commit(item, code))
    const commits = p.commits as Array<{ oid: string }>
    if (new Set(commits.map(item => item.oid)).size !== commits.length ||
        input.limit !== undefined && commits.length > input.limit) invalid('Git history page is inconsistent.', code)
    if (p.nextCursor !== null) {
      const next = historyCursor(p.nextCursor, code)
      if (!isDeepStrictEqual(next.snapshot, snapshot) || next.offset !== (input.cursor?.offset ?? 0) + commits.length || !commits.length) invalid('Git history continuation changed its fixed scope.', code)
    }
  } else if (p.kind === 'ready' && method === 'git.commit') {
    rpcRecord(p, ['kind', 'snapshot', 'commit', 'entries', 'warnings'], code)
    const snapshot = parseGitCommitSnapshot(p.snapshot), input = params as GitParameterMap['git.commit'], data = commit(p.commit, code, true)
    const parents = data.parents as string[]
    if (snapshot.hostId !== input.expectedResource.hostId || snapshot.commitOid !== input.oid || data.oid !== input.oid ||
        snapshot.parentOid !== (input.parentOid ?? parents[0] ?? null) ||
        snapshot.parentOid !== null && !parents.includes(snapshot.parentOid)) invalid('Git commit belongs to another comparison.', code)
    array(p.entries, code, item => {
      const entry = rpcRecord(item, ['path', 'origPath', 'change'], code)
      filePath(entry.path, code); if (entry.origPath !== null) filePath(entry.origPath, code)
      if (!['added', 'deleted', 'modified', 'renamed', 'type-changed'].includes(String(entry.change))) invalid('Git file change is invalid.', code)
    })
    array(p.warnings, code, item => text(item, code))
  } else invalid('Git result is invalid.', code)
  return p as GitResultMap[M]
}
export function parseGitOpenResult(value: unknown, params?: GitOpenParams): GitOpenResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['workspaceId', 'read', 'presentation'], code)
  identity(p.workspaceId, code)
  const read = rpcRecord(p.read, ['kind', 'snapshot'], code)
  if (read.kind !== 'ready') invalid('The fixed Git commit read was not confirmed.', code)
  const snapshot = parseGitCommitSnapshot(read.snapshot)
  const presentation = rpcRecord(p.presentation, ['tabId', 'regionId'], code)
  identity(presentation.tabId, code); identity(presentation.regionId, code)
  if (params && (p.workspaceId !== params.workspaceId || snapshot.hostId !== params.expectedResource.hostId ||
      snapshot.commitOid !== params.oid || params.parentOid !== undefined && snapshot.parentOid !== params.parentOid)) invalid('Git presentation belongs to another requested commit.', code)
  return p as GitOpenResult
}
