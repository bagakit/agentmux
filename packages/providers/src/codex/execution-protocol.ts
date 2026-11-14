/** Native exec-server request IDs are scoped to a connection, never operation keys. */
export type CodexExecutionRequestId = string | number
type ObjectValue = Record<string, unknown>

export interface CodexExecutionPathAccess {
  /** Native file URI, preserved byte for byte. Resolve aliases only on its owner Host. */
  path: string
  access: 'read' | 'write'
  sandbox?: unknown
}

/** Describes requested effects, not permission to perform them. */
export interface CodexExecutionIntent {
  kind: 'read' | 'write' | 'process' | 'control'
  paths: CodexExecutionPathAccess[]
  argv?: string[]
  cwd?: string
  processId?: string
  handleId?: string
  resumeSessionId?: string | null
  initialize?: true
  handle?: { kind: 'file' | 'process'; id: string; action: 'create' | 'use' | 'close' }
  /** Native filesystem/process sandbox intent; absence and null remain distinct. */
  sandbox?: unknown
  /** Config reads also inspect executor home/system layers outside cwd. */
  environmentConfig?: true
}

export type CodexExecutionMessage =
  | { kind: 'request'; requestId: CodexExecutionRequestId; method: string; params: ObjectValue | null; payload: ObjectValue; intent: CodexExecutionIntent }
  | { kind: 'notification'; method: string; payload: ObjectValue }
  | { kind: 'response'; requestId: CodexExecutionRequestId; payload: ObjectValue }
  | { kind: 'rejected'; requestId?: CodexExecutionRequestId; code: -32600 | -32601 | -32602; reason: string; payload: unknown }

const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value: ObjectValue, key: string): boolean => Object.hasOwn(value, key)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const id = (value: unknown): value is CodexExecutionRequestId => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
const uint = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optionalUint = (value: unknown): boolean => value == null || uint(value)
const optionalBoolean = (value: unknown): boolean => value == null || typeof value === 'boolean'
const base64 = (value: unknown): boolean => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
const keyPaths = (value: unknown): boolean => Array.isArray(value) && value.every(path => Array.isArray(path) && path.every(key => typeof key === 'string'))

function pathUri(value: unknown): value is string {
  if (!text(value) || !value.startsWith('file:')) return false
  try { return new URL(value).protocol === 'file:' } catch { return false }
}

/**
 * Interpret an already decoded native client message. The transport owns JSON
 * framing/limits and must forward this same payload, not reparse a different copy.
 * No handshake, process registry or replay state lives here. Handles and resume
 * IDs must be checked against the broker's binding, never trusted as authority.
 * Responses are envelopes only; their direction/correlation belongs to the owner.
 */
export function parseCodexExecutionMessage(payload: unknown): CodexExecutionMessage {
  const requestId = object(payload) && id(payload.id) ? payload.id : undefined
  const reject = (code: -32600 | -32601 | -32602, reason: string): CodexExecutionMessage => ({
    kind: 'rejected', ...(requestId === undefined ? {} : { requestId }), code, reason, payload,
  })
  if (!object(payload)) return reject(-32600, 'Expected a native JSON-RPC object')
  if (own(payload, 'jsonrpc') && payload.jsonrpc !== '2.0') return reject(-32600, 'Invalid JSON-RPC version')
  if (own(payload, 'method')) {
    if (!text(payload.method) || own(payload, 'result') || own(payload, 'error')) return reject(-32600, 'Invalid request envelope')
    if (!own(payload, 'id')) {
      if (payload.method !== 'initialized') return reject(-32601, 'Unsupported client notification')
      if (payload.params != null && !object(payload.params)) return reject(-32602, 'Invalid initialized parameters')
      return { kind: 'notification', method: 'initialized', payload }
    }
    if (requestId === undefined) return reject(-32600, 'Invalid native request ID')
  } else {
    if (requestId === undefined || own(payload, 'result') === own(payload, 'error')) return reject(-32600, 'Invalid response envelope')
    if (own(payload, 'error') && (!object(payload.error) || !Number.isSafeInteger(payload.error.code) || typeof payload.error.message !== 'string')) return reject(-32600, 'Invalid error response')
    return { kind: 'response', requestId, payload }
  }

  const method = payload.method as string
  const p = payload.params == null ? {} : payload.params
  if (!object(p)) return reject(-32602, 'Expected named native parameters')
  const intent: CodexExecutionIntent = { kind: 'control', paths: [] }
  const invalid = (): CodexExecutionMessage => reject(-32602, `Invalid parameters for ${method}`)
  const path = (value: string, access: 'read' | 'write'): void => {
    intent.paths.push({ path: value, access, ...(own(p, 'sandbox') ? { sandbox: p.sandbox } : {}) })
  }
  // Native fs methods and process/start carry sandbox; handle operations inherit
  // executor-owned handle state. Preserve the constraint, do not reinterpret it.
  if (own(p, 'sandbox')) {
    if (p.sandbox !== null && !object(p.sandbox)) return invalid()
    intent.sandbox = p.sandbox
  }
  switch (method) {
    case 'initialize':
      if (!text(p.clientName) || (p.resumeSessionId != null && !text(p.resumeSessionId))) return invalid()
      intent.initialize = true
      if (own(p, 'resumeSessionId')) intent.resumeSessionId = p.resumeSessionId as string | null
      break
    case 'environment/info':
    case 'environment/status':
      if (payload.params != null) return invalid()
      break
    case 'environmentConfig/read':
      if (!pathUri(p.cwd) || !keyPaths(p.configPaths) || !keyPaths(p.requirementsPaths)) return invalid()
      intent.kind = 'read'; intent.cwd = p.cwd; intent.environmentConfig = true; path(p.cwd, 'read')
      break
    case 'capabilityRoots/discoverV1':
      if (!Array.isArray(p.roots)) return invalid()
      intent.kind = 'read'
      for (const root of p.roots) {
        if (!object(root) || !text(root.id) || !pathUri(root.path) || (root.sandbox != null && !object(root.sandbox))) return invalid()
        intent.paths.push({ path: root.path, access: 'read', ...(own(root, 'sandbox') ? { sandbox: root.sandbox } : {}) })
      }
      break
    case 'process/start':
      if (!text(p.processId) || !Array.isArray(p.argv) || p.argv.length === 0 || !p.argv.every(arg => typeof arg === 'string' && !arg.includes('\0')) || !pathUri(p.cwd) || !object(p.env) || !Object.values(p.env).every(value => typeof value === 'string' && !value.includes('\0')) || typeof p.tty !== 'boolean' || !optionalBoolean(p.pipeStdin) || !optionalBoolean(p.enforceManagedNetwork)) return invalid()
      intent.kind = 'process'; intent.argv = p.argv as string[]; intent.cwd = p.cwd; intent.processId = p.processId
      intent.handle = { kind: 'process', id: p.processId, action: 'create' }
      // cwd is a location, not an assertion that argv only reads this directory.
      break
    case 'process/read':
    case 'process/write':
    case 'process/signal':
    case 'process/terminate':
      if (!text(p.processId)) return invalid()
      if (method === 'process/read' && ![p.afterSeq, p.maxBytes, p.waitMs].every(optionalUint)) return invalid()
      if (method === 'process/write' && (!text(p.writeId) || !base64(p.chunk))) return invalid()
      if (method === 'process/signal' && p.signal !== 'interrupt') return invalid()
      intent.kind = method === 'process/read' ? 'read' : 'process'; intent.processId = p.processId
      // terminate stops the process; its buffered output remains readable.
      intent.handle = { kind: 'process', id: p.processId, action: 'use' }
      break
    case 'fs/readFile':
    case 'fs/getMetadata':
    case 'fs/canonicalize':
    case 'fs/readDirectory':
    case 'fs/walk':
    case 'fs/open':
      if (!pathUri(p.path) || !optionalBoolean(p.followSymlinks)) return invalid()
      if (method === 'fs/walk' && !object(p.options)) return invalid()
      if (method === 'fs/open') {
        if (!text(p.handleId)) return invalid()
        intent.handleId = p.handleId
        intent.handle = { kind: 'file', id: p.handleId, action: 'create' }
      }
      intent.kind = 'read'; path(p.path, 'read')
      break
    case 'fs/readBlock':
    case 'fs/close':
      if (!text(p.handleId)) return invalid()
      if (method === 'fs/readBlock' && (!uint(p.offset) || !uint(p.len))) return invalid()
      intent.kind = method === 'fs/readBlock' ? 'read' : 'control'; intent.handleId = p.handleId
      intent.handle = { kind: 'file', id: p.handleId, action: method === 'fs/close' ? 'close' : 'use' }
      break
    case 'fs/writeFile':
    case 'fs/createDirectory':
    case 'fs/remove':
      if (!pathUri(p.path) || !optionalBoolean(p.followSymlinks)) return invalid()
      if (method === 'fs/writeFile' && !base64(p.dataBase64)) return invalid()
      if (method !== 'fs/writeFile' && !optionalBoolean(p.recursive)) return invalid()
      if (method === 'fs/remove' && !optionalBoolean(p.force)) return invalid()
      intent.kind = 'write'; path(p.path, 'write')
      break
    case 'fs/copy':
      if (!pathUri(p.sourcePath) || !pathUri(p.destinationPath) || typeof p.recursive !== 'boolean') return invalid()
      intent.kind = 'write'; path(p.sourcePath, 'read'); path(p.destinationPath, 'write')
      break
    default:
      // HTTP and future native methods need an explicit capability contract.
      return reject(-32601, `Unsupported native execution method: ${method}`)
  }
  return { kind: 'request', requestId: requestId!, method, params: payload.params == null ? null : p, payload, intent }
}

export interface CodexNativeExecutorLaunchSpec {
  program: string
  args: string[]
  cwd: string
  transport: 'stdio'
}

/** Executor-origin events are never accepted on the client request boundary. */
export function parseCodexExecutionServerMessage(payload: unknown): CodexExecutionMessage {
  if (object(payload) && !own(payload, 'method')) return parseCodexExecutionMessage(payload)
  const reject = (reason: string): CodexExecutionMessage => ({ kind: 'rejected', code: -32600, reason, payload })
  if (!object(payload) || own(payload, 'id') || own(payload, 'result') || own(payload, 'error') || !object(payload.params)) return reject('Invalid native executor notification')
  const p = payload.params
  if (!text(p.processId) || !uint(p.seq)) return reject('Invalid native process notification identity')
  switch (payload.method) {
    case 'process/output':
      if (!['stdout', 'stderr', 'pty'].includes(p.stream as string) || !base64(p.chunk)) return reject('Invalid native output notification')
      break
    case 'process/exited':
      if (typeof p.exitCode !== 'number' || !Number.isInteger(p.exitCode) || p.exitCode < -2147483648 || p.exitCode > 2147483647 || !optionalBoolean(p.sandboxDenied)) return reject('Invalid native exit notification')
      break
    case 'process/closed':
      break
    default:
      return reject('Unsupported native executor notification')
  }
  return { kind: 'notification', method: payload.method, payload }
}

/** The durable wrapper owns stdin/stdout for the whole Run, across WAN detach. */
export function buildCodexNativeExecutorLaunchSpec(options: { executable: string; cwd: string; concurrentRequests: number }): CodexNativeExecutorLaunchSpec {
  if (!text(options.executable) || !text(options.cwd) || !Number.isSafeInteger(options.concurrentRequests) || options.concurrentRequests < 1) throw new TypeError('Invalid native executor launch options')
  return {
    program: options.executable,
    args: ['exec-server', '--listen', 'stdio://', '--concurrent-requests', String(options.concurrentRequests)],
    cwd: options.cwd,
    transport: 'stdio',
  }
}
