import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** The original Files owner and resource, independent of display occurrences. */
export type FileResource = { hostId: string; workspaceId: string; workspacePath: string }
export type FileReadResource = FileResource & { zoneId: string; zonePath: string; path: string }
export type FileDocument = { path: string; content: string; revision: string }
export type FileDocumentReadResult =
  | { status: 'read'; document: FileDocument }
  | { status: 'binary'; path: string; revision: string; byteLength: number }
  | { status: 'deleted' }
  | { status: 'directory' }
  | { status: 'error'; code: string; message: string }
/** Public observation failure; this is not a new state invented for WorkspaceFiles. */
export type FileReadUnknown = { status: 'unknown'; code: string; message: string }
export type FileReadParams = { zoneId: string; spaceId?: string; path: string; expectedResource: FileResource }
export type FileReadResult = { resource: FileReadResource | null; result: FileDocumentReadResult | FileReadUnknown }
export type FileParameterMap = { 'file.read': FileReadParams }
export type FileResultMap = { 'file.read': FileReadResult }
export type FileMethod = keyof FileParameterMap
export interface AgentMuxRpcFilesOwner { read(params: FileReadParams): Promise<FileReadResult> }
export const AGENTMUX_RPC_FILE_METHODS = { 'file.read': 'short' } as const
export function isFileMethod(value: unknown): value is FileMethod { return value === 'file.read' }

function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function string(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 16384 || /[\0\r\n]/u.test(value)) invalid('An exact File identity or path is required.', code)
}
function revision(value: unknown, code: string): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) invalid('The complete original File revision is required.', code)
}
function resource(value: unknown, code: string, read = false): FileResource | FileReadResource {
  const p = rpcRecord(value, ['hostId', 'workspaceId', 'workspacePath', ...(read ? ['zoneId', 'zonePath', 'path'] : [])], code)
  for (const key of ['hostId', 'workspaceId', 'workspacePath', ...(read ? ['zoneId', 'zonePath', 'path'] : [])]) string(p[key], code)
  return p as FileResource | FileReadResource
}
export function parseFileReadParams(value: unknown): FileReadParams {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, ['zoneId', 'spaceId', 'path', 'expectedResource'], code)
  string(p.zoneId, code); string(p.path, code)
  if (p.spaceId !== undefined) string(p.spaceId, code)
  if ((p.path as string).startsWith('/') || /^[A-Za-z]:/u.test(p.path as string) || (p.path as string).includes('\\') ||
      (p.path as string).split('/').some(segment => segment === '..')) invalid('Choose a relative file path inside the original Zone.', code)
  resource(p.expectedResource, code)
  return p as FileReadParams
}
export function parseFileReadResult(value: unknown, params: FileReadParams): FileReadResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['resource', 'result'], code)
  const r = rpcRecord(p.result, undefined, code)
  const fields = r.status === 'read' ? ['status', 'document'] : r.status === 'binary' ? ['status', 'path', 'revision', 'byteLength']
    : r.status === 'deleted' || r.status === 'directory' ? ['status'] : r.status === 'error' || r.status === 'unknown' ? ['status', 'code', 'message'] : null
  if (!fields) invalid('The original File read status is invalid.', code)
  rpcRecord(r, fields, code)
  if (p.resource === null) { if (r.status !== 'unknown') invalid('File data requires a confirmed original resource.', code) }
  else {
    const original = resource(p.resource, code, true) as FileReadResource
    if (original.zoneId !== params.zoneId || original.hostId !== params.expectedResource.hostId ||
        original.workspaceId !== params.expectedResource.workspaceId || original.workspacePath !== params.expectedResource.workspacePath) invalid('Another File resource was returned.', code)
    const root = original.workspacePath.replace(/\/+$/u, '') || '/', zone = original.zonePath.replace(/\/+$/u, '') || '/'
    const prefix = root === '/' ? '/' : root + '/'
    if (zone !== root && !zone.startsWith(prefix)) invalid('The File Zone is outside its original Workspace.', code)
    const directory = zone === root ? '' : zone.slice(prefix.length), relative = params.path.split('/').filter(part => part && part !== '.').join('/')
    if (directory.split('/').some(part => part === '.' || part === '..' || part.includes('\\'))) invalid('The returned File Zone is invalid.', code)
    const mapped = directory && relative ? directory + '/' + relative : directory || relative || '.'
    if (original.path !== mapped) invalid('Another File path was returned.', code)
  }
  if (r.status === 'read') {
    const d = rpcRecord(r.document, ['path', 'content', 'revision'], code)
    string(d.path, code); revision(d.revision, code)
    if (typeof d.content !== 'string') invalid('File content must be text.', code)
    if ((p.resource as FileReadResource | null)?.path !== d.path) invalid('Another File document was returned.', code)
  } else if (r.status === 'binary') {
    string(r.path, code); revision(r.revision, code)
    if (!Number.isSafeInteger(r.byteLength) || (r.byteLength as number) < 0 || (p.resource as FileReadResource | null)?.path !== r.path) invalid('The original binary File evidence is invalid.', code)
  } else if (r.status === 'error' || r.status === 'unknown') { string(r.code, code); string(r.message, code) }
  return p as FileReadResult
}
