import { isAbsolute, win32 } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

type ObjectValue = Record<string, unknown>
type RequestId = string | number
type ClaudeExecutionIntent = {
  kind: 'read' | 'write' | 'process' | 'control'
  paths: { path: string; access: 'read' | 'write' }[]
  initialize?: true
  processId?: string
}
type ClaudeExecutionMessage =
  | { kind: 'request'; requestId: RequestId; method: string; params: ObjectValue | null; payload: ObjectValue; intent: ClaudeExecutionIntent }
  | { kind: 'notification'; method: string; payload: ObjectValue; cancels?: RequestId }
  | { kind: 'response'; requestId: RequestId; payload: ObjectValue }
  | { kind: 'rejected'; requestId?: RequestId; code: number; reason: string; payload: unknown }

/** Resource tools qualified from the native `claude mcp serve` tool catalog. */
export const CLAUDE_EXECUTION_TOOL_NAMES = ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'TaskStop'] as const
/** Address namespace only. The resource binding's actual child map grants task control. */
export const CLAUDE_EXECUTION_SHELL_TASK_PREFIX = 'amux-shell-'
export const isClaudeExecutionShellTaskId = (value: unknown): value is string => typeof value === 'string' && value.startsWith(CLAUDE_EXECUTION_SHELL_TASK_PREFIX)
const tools = new Set<string>(CLAUDE_EXECUTION_TOOL_NAMES)
type Request = Extract<ClaudeExecutionMessage, { kind: 'request' }>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const id = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)
const absolute = (value: unknown): value is string => text(value) && (isAbsolute(value) || win32.isAbsolute(value))

/** Native MCP facts only. Host-user authorization remains with the resource Core. */
export function parseClaudeExecutionMessage(payload: unknown): ClaudeExecutionMessage {
  const requestId = object(payload) && id(payload.id) ? payload.id : undefined
  const reject = (code: number, reason: string): ClaudeExecutionMessage => ({ kind: 'rejected', ...(requestId === undefined ? {} : { requestId }), code, reason, payload })
  if (!object(payload) || payload.jsonrpc !== '2.0') return reject(-32600, 'Expected a native MCP JSON-RPC 2.0 object')
  if (!Object.hasOwn(payload, 'method')) {
    if (requestId === undefined || Object.hasOwn(payload, 'result') === Object.hasOwn(payload, 'error')) return reject(-32600, 'Invalid native MCP response')
    if (Object.hasOwn(payload, 'error') && (!object(payload.error) || !Number.isSafeInteger(payload.error.code) || typeof payload.error.message !== 'string')) return reject(-32600, 'Invalid native MCP error')
    return { kind: 'response', requestId, payload }
  }
  if (!text(payload.method) || Object.hasOwn(payload, 'result') || Object.hasOwn(payload, 'error')) return reject(-32600, 'Invalid native MCP request')
  const p = payload.params === undefined ? {} : payload.params
  if (!object(p)) return reject(-32602, 'Native MCP parameters must be an object')
  if (!Object.hasOwn(payload, 'id')) {
    if (payload.method === 'notifications/initialized') return { kind: 'notification', method: payload.method, payload }
    if (payload.method === 'notifications/cancelled' && id(p.requestId))
      return { kind: 'notification', method: payload.method, payload, cancels: p.requestId }
    return reject(-32601, 'Unsupported native MCP notification')
  }
  if (requestId === undefined) return reject(-32600, 'Invalid native MCP request identity')
  const intent: ClaudeExecutionIntent = { kind: 'control', paths: [] }
  switch (payload.method) {
    case 'initialize':
      if (!text(p.protocolVersion) || !object(p.capabilities) || !object(p.clientInfo) || !text(p.clientInfo.name) || !text(p.clientInfo.version)) return reject(-32602, 'Invalid native MCP initialization')
      intent.initialize = true
      break
    case 'ping':
      break
    case 'tools/list':
      if (p.cursor !== undefined && !text(p.cursor)) return reject(-32602, 'Invalid native MCP tool cursor')
      break
    case 'tools/call': {
      if (!text(p.name) || !tools.has(p.name)) return reject(-32601, 'This native tool is not part of the resource execution binding')
      if (!object(p.arguments)) return reject(-32602, 'Native tool arguments must be an object')
      const args = p.arguments
      if (p.name === 'Bash') {
        if (!text(args.command)) return reject(-32602, 'A native shell command is required')
        intent.kind = 'process'
        // Preserve command bytes in payload. Shell source is not an argv or a
        // claim about which paths the command can access.
      } else if (p.name === 'TaskStop') {
        if (!text(args.task_id) && !text(args.shell_id)) return reject(-32602, 'The original native background task is required')
        intent.kind = 'process'; intent.processId = String(args.task_id ?? args.shell_id)
      } else {
        const path = p.name === 'NotebookEdit' ? args.notebook_path : args.file_path
        if (!absolute(path)) return reject(-32602, 'An absolute resource-Host file path is required')
        intent.kind = p.name === 'Read' ? 'read' : 'write'
        intent.paths.push({ path, access: intent.kind })
      }
      break
    }
    default:
      return reject(-32601, 'Unsupported native MCP method')
  }
  return { kind: 'request', requestId, method: payload.method, params: payload.params === undefined ? null : p, payload, intent }
}

/** The selected native server advertises tools only; it does not require client-side roots or sampling. */
export function parseClaudeExecutionServerMessage(payload: unknown): ClaudeExecutionMessage {
  if (object(payload) && !Object.hasOwn(payload, 'method')) return parseClaudeExecutionMessage(payload)
  if (object(payload) && payload.jsonrpc === '2.0' && !Object.hasOwn(payload, 'id') && !Object.hasOwn(payload, 'result') && !Object.hasOwn(payload, 'error') &&
      ['notifications/progress', 'notifications/message', 'notifications/tools/list_changed'].includes(String(payload.method)) && (payload.params === undefined || object(payload.params))) {
    return { kind: 'notification', method: payload.method as string, payload }
  }
  return { kind: 'rejected', code: -32600, reason: 'Unsupported native MCP server message', payload }
}

/** The resource server has no session handles in MCP initialization. A new
 * stdio connection may stand behind the same client only with the same contract. */
export function restoreClaudeExecutionConnection(request: unknown, response: unknown) {
  const initial = parseClaudeExecutionMessage(request)
  const reply = parseClaudeExecutionServerMessage(response)
  if (initial.kind !== 'request' || !initial.intent.initialize || reply.kind !== 'response' ||
      reply.requestId !== initial.requestId || !object(reply.payload.result)) return
  const result = reply.payload.result
  if (!text(result.protocolVersion) || !object(result.capabilities) || !object(result.serverInfo) ||
      !text(result.serverInfo.name) || !text(result.serverInfo.version)) return
  return {
    requestId: initial.requestId,
    request: initial.payload,
    initialized: { jsonrpc: '2.0', method: 'notifications/initialized' },
    accepts(candidate: unknown) {
      const next = parseClaudeExecutionServerMessage(candidate)
      return next.kind === 'response' && next.requestId === initial.requestId && isDeepStrictEqual(next.payload.result, result)
    },
  }
}

/** Listing is presentation, while parse() independently enforces the same exact tool surface. */
export function projectClaudeExecutionResponse(request: Request, response: ObjectValue): ObjectValue {
  if (request.method !== 'tools/list' || !Object.hasOwn(response, 'result')) return response
  if (!object(response.result) || !Array.isArray(response.result.tools) || response.result.tools.some(tool => !object(tool) || !text(tool.name))) throw new Error('The original native resource tool catalog is unconfirmed')
  return { ...response, result: { ...response.result, tools: response.result.tools.filter(tool => tools.has((tool as ObjectValue).name as string)) } }
}

export function buildClaudeNativeExecutorLaunchSpec(options: { executable: string; cwd: string }): { program: string; args: string[]; cwd: string; transport: 'stdio' } {
  if (!absolute(options.executable) || !absolute(options.cwd)) throw new TypeError('The exact native Claude executable and resource directory must be absolute')
  return { program: options.executable, args: ['mcp', 'serve'], cwd: options.cwd, transport: 'stdio' }
}
