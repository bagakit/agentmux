import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseFileReadParams, parseFileReadResource, parseFileReadResult,
  type FileReadParams, type FileReadResource, type FileWriteContext } from './public-rpc-files.js'

/** An observation of one original directory entry, never an authorization token. */
export type FileEntryWitness = { device: string; inode: string; size: string; ctimeNs: string; mtimeNs: string; birthtimeNs: string | null }
export type FilePathScopeWitness = { root: FileEntryWitness; parent: FileEntryWitness }
export type FileStatParams = Omit<FileReadParams, 'maxBytes'>
export type FilePathObservation = FilePathScopeWitness & {
  parentPath: string
  entry: { kind: 'absent' } | { kind: 'file' | 'directory' | 'symlink' | 'other'; witness: FileEntryWitness }
  implementation: { platform: 'darwin' | 'linux'; stat: 'native'; mkdir: 'native-no-replace' | 'generation-unavailable' }
}
export type FileStatResult = { resource: FileReadResource | null; result:
  | { status: 'observed'; observation: FilePathObservation }
  | { status: 'unknown' | 'unsupported'; code: string; message: string } }
export type FileMkdirParams = Omit<FileStatParams, 'expectedResource'> & {
  operationId: string; expectedResource: FileReadResource; expectedAbsent: true; expected: FilePathScopeWitness
}
export type FileMutationInspectParams = Omit<FileStatParams, 'expectedResource'> & { operationId: string; expectedResource: FileReadResource }
/** Original transport provenance is supplied by the Host, never by a JSON request. */
export type FilePathMutationContext = FileWriteContext & { callerHostId?: string }
export type FilePathMutationReceipt = {
  action: 'mkdir'; phase: 'prepared' | 'published' | 'settled'
  filesystem: 'created' | 'not-applied' | 'unknown'; durability: 'confirmed' | 'unconfirmed'
  createdWitness?: FileEntryWitness; code?: string; message?: string
}
export type FileMkdirResult = { operationId: string; resource: FileReadResource | null; result: FilePathMutationReceipt }
export type FileMutationInspectResult = { operationId: string; resource: FileReadResource | null; result:
  | (FilePathMutationReceipt & { original: FileMkdirParams })
  | { action: 'mkdir'; phase: 'absent' | 'unavailable'; filesystem: 'unknown'; durability: 'unconfirmed'; code: string; message: string } }

export interface AgentMuxRpcFilePathsOwner {
  stat(params: FileStatParams): Promise<FileStatResult>
  mkdir(params: FileMkdirParams, context?: FilePathMutationContext): Promise<FileMkdirResult>
  inspectMutation(params: FileMutationInspectParams, context?: FilePathMutationContext): Promise<FileMutationInspectResult>
}
const keys = ['device', 'inode', 'size', 'ctimeNs', 'mtimeNs', 'birthtimeNs'] as const
const wellFormed = (value: string): boolean => !/[\uD800-\uDFFF]/u.test(value)
const invalid = (message: string, code: string): never => { throw new AgentMuxError(message, code) }
function text(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 16384 || /[\0\r\n]/u.test(value)) invalid('The exact original Files identity is required.', code)
}
function pathText(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 16384 || /\0/u.test(value) || !wellFormed(value)) invalid('The exact original path data is required.', code)
}
function message(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string') invalid('The original Files diagnostic must remain text.', code)
}
export function parseFileEntryWitness(value: unknown, code = 'INVALID_CONTROL_REQUEST'): FileEntryWitness {
  const p = rpcRecord(value, [...keys], code)
  for (const key of keys) if (!(key === 'birthtimeNs' && p[key] === null) && (typeof p[key] !== 'string' || !(key.endsWith('Ns') ? /^-?\d{1,30}$/u : /^\d{1,30}$/u).test(p[key]))) invalid('An original native entry witness is required.', code)
  return p as FileEntryWitness
}
export function parseFilePathScopeWitness(value: unknown, code = 'INVALID_CONTROL_REQUEST'): FilePathScopeWitness {
  const p = rpcRecord(value, ['root', 'parent'], code)
  return { root: parseFileEntryWitness(p.root, code), parent: parseFileEntryWitness(p.parent, code) }
}
export function parseFileStatParams(value: unknown): FileStatParams {
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource'])
  const parsed = parseFileReadParams(p)
  if (!wellFormed(parsed.path)) invalid('The original path must be well-formed Unicode; its bytes are not rewritten.', 'INVALID_CONTROL_REQUEST')
  return parsed
}
function mutationParams(value: unknown, mkdir: boolean): FileMkdirParams | FileMutationInspectParams {
  const code = 'INVALID_CONTROL_REQUEST'
  const p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource', 'operationId', ...(mkdir ? ['expectedAbsent', 'expected'] : [])], code)
  const original = parseFileReadResource(p.expectedResource, code)
  if (typeof p.path !== 'string' || !wellFormed(p.path) || Object.values(original).some(value => typeof value === 'string' && !wellFormed(value))) invalid('The exact original path descriptor must be well-formed Unicode.', code)
  parseFileReadParams({ zoneId: p.zoneId, ...(p.spaceId === undefined ? {} : { spaceId: p.spaceId }), path: p.path,
    expectedResource: { hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath } })
  // The original public mapper owns Zone-relative to Workspace-relative paths.
  try { parseFileReadResult({ resource: original, result: { status: 'directory' } }, p as unknown as FileReadParams) }
  catch { invalid('The complete original Files resource does not match its exact Zone-relative target.', code) }
  text(p.operationId, code)
  if ((p.operationId as string).length > 512) invalid('Keep one bounded original Files operation ID.', code)
  if (mkdir) {
    if (original.path === '.' || original.path === '') invalid('The original Workspace root cannot be created or replaced.', code)
    if (p.expectedAbsent !== true) invalid('Directory creation requires an explicitly observed absent entry.', code)
    parseFilePathScopeWitness(p.expected, code)
  }
  return p as FileMkdirParams | FileMutationInspectParams
}
export const parseFileMkdirParams = (value: unknown): FileMkdirParams => mutationParams(value, true) as FileMkdirParams
export const parseFileMutationInspectParams = (value: unknown): FileMutationInspectParams => mutationParams(value, false) as FileMutationInspectParams

function resultResource(value: unknown, params: FileStatParams, code: string): FileReadResource | null {
  if (value === null) return null
  parseFileReadResult({ resource: value, result: { status: 'directory' } }, params)
  return parseFileReadResource(value, code)
}
export function parseFileStatResult(value: unknown, params: FileStatParams): FileStatResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'result'], code)
  const resource = resultResource(p.resource, params, code), r = rpcRecord(p.result, undefined, code)
  if (r.status === 'observed') {
    rpcRecord(r, ['status', 'observation'], code)
    if (!resource) invalid('A native entry observation requires its original resource.', code)
    const o = rpcRecord(r.observation, ['root', 'parent', 'parentPath', 'entry', 'implementation'], code)
    parseFilePathScopeWitness({ root: o.root, parent: o.parent }, code); pathText(o.parentPath, code)
    const e = rpcRecord(o.entry, undefined, code)
    rpcRecord(e, e.kind === 'absent' ? ['kind'] : ['kind', 'witness'], code)
    if (!['absent', 'file', 'directory', 'symlink', 'other'].includes(e.kind as string)) invalid('The original entry kind is unconfirmed.', code)
    if (e.kind !== 'absent') parseFileEntryWitness(e.witness, code)
    const implementation = rpcRecord(o.implementation, ['platform', 'stat', 'mkdir'], code)
    if (!['darwin', 'linux'].includes(implementation.platform as string) || implementation.stat !== 'native' || !['native-no-replace', 'generation-unavailable'].includes(implementation.mkdir as string)) invalid('The Files helper implementation is unconfirmed.', code)
  } else {
    rpcRecord(r, ['status', 'code', 'message'], code)
    if (!['unknown', 'unsupported'].includes(r.status as string)) invalid('The original File stat status is invalid.', code)
    text(r.code, code); message(r.message, code)
  }
  return p as FileStatResult
}
export function parseFilePathMutationReceipt(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): FilePathMutationReceipt {
  const r = rpcRecord(value, ['action', 'phase', 'filesystem', 'durability', 'createdWitness', 'code', 'message'], code)
  if (r.action !== 'mkdir' || !['prepared', 'published', 'settled'].includes(r.phase as string) ||
      !['created', 'not-applied', 'unknown'].includes(r.filesystem as string) || !['confirmed', 'unconfirmed'].includes(r.durability as string)) invalid('The original directory creation receipt is invalid.', code)
  if (r.filesystem === 'created') parseFileEntryWitness(r.createdWitness, code)
  else if (r.createdWitness !== undefined) invalid('An unconfirmed entry cannot claim a created object.', code)
  if (r.code !== undefined) text(r.code, code)
  if (r.message !== undefined) message(r.message, code)
  if (r.filesystem === 'unknown' && (r.durability !== 'unconfirmed' || !r.code || !r.message)) invalid('An unknown directory effect requires its original recovery reason.', code)
  return r as FilePathMutationReceipt
}
export function parseFileMkdirResult(value: unknown, params: FileMkdirParams): FileMkdirResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'result'], code)
  if (p.operationId !== params.operationId) invalid('Another Files operation was returned.', code)
  const resource = resultResource(p.resource, params, code), result = parseFilePathMutationReceipt(p.result, code)
  if (resource && ['hostId','workspaceId','workspacePath','zoneId','zonePath','path','logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) invalid('Another original mutation resource was returned.', code)
  if (result.filesystem !== 'unknown' && !resource) invalid('A directory effect requires its original resource.', code)
  return { operationId: params.operationId, resource, result }
}
export function parseFileMutationInspectResult(value: unknown, params: FileMutationInspectParams): FileMutationInspectResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['operationId', 'resource', 'result'], code)
  if (p.operationId !== params.operationId) invalid('Another original Files operation was returned.', code)
  const resource = resultResource(p.resource, params, code), r = rpcRecord(p.result, undefined, code)
  if (resource && ['hostId','workspaceId','workspacePath','zoneId','zonePath','path','logicalDirectory'].some(key => resource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) invalid('Another original mutation resource was returned.', code)
  if (r.phase === 'absent' || r.phase === 'unavailable') {
    rpcRecord(r, ['action', 'phase', 'filesystem', 'durability', 'code', 'message'], code)
    if (r.action !== 'mkdir' || r.filesystem !== 'unknown' || r.durability !== 'unconfirmed') invalid('An absent operation cannot claim an original effect.', code)
    text(r.code, code); message(r.message, code)
  } else {
    const { original, ...receipt } = r
    parseFilePathMutationReceipt(receipt, code)
    const input = parseFileMkdirParams(original)
    if (input.operationId !== params.operationId || params.spaceId !== undefined && input.spaceId !== params.spaceId || input.zoneId !== params.zoneId || input.path !== params.path ||
        ['hostId','workspaceId','workspacePath','zoneId','zonePath','path','logicalDirectory'].some(key => input.expectedResource[key as keyof FileReadResource] !== params.expectedResource[key as keyof FileReadResource])) invalid('The retained Files intent belongs to another target.', code)
  }
  return { operationId: params.operationId, resource, result: r as FileMutationInspectResult['result'] }
}
