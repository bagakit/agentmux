import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Fresh values only. Child identities/cursors and approvals are supplied by the original owner. */
export type BrowserTaskCallInput = {
  parameters: Record<string, string>
  items: { id: string; parameters: Record<string, string>; calls?: BrowserTaskInvocationCalls }[]
}
export type BrowserTaskInvocationCalls = Record<string, BrowserTaskCallInput>
export type BrowserTaskInvocation = { parameters: Record<string, string>; calls?: BrowserTaskInvocationCalls }
export const BROWSER_TASK_SUBFLOW_MAX_DEPTH = 4
export const BROWSER_TASK_SUBFLOW_MAX_ITEMS = 16
export const BROWSER_TASK_SUBFLOW_MAX_CHILDREN = 32

/** This carrier bounds data; only the Browser Client resolves immutable definitions and permissions. */
export function parseBrowserTaskInvocation(value: unknown): BrowserTaskInvocation {
  const root = rpcRecord(value, ['parameters', 'calls'], 'INVALID_CONTROL_REQUEST')
  let bytes = 0, children = 0
  const invalid = (): never => { throw new AgentMuxError('Task invocation needs bounded fresh parameters and explicit finite call items.', 'INVALID_CONTROL_REQUEST') }
  const identity = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u0020\u007f]/.test(value)) invalid()
    return value as string
  }
  const parameters = (value: unknown): Record<string, string> => {
    const row = rpcRecord(value, undefined, 'INVALID_CONTROL_REQUEST'), entries = Object.entries(row)
    if (entries.length > 32) invalid()
    return Object.fromEntries(entries.map(([key, value]) => {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 16_384) invalid()
      bytes += Buffer.byteLength(key) + Buffer.byteLength(value as string)
      if (bytes > 65_536) invalid()
      return [key, value as string]
    }))
  }
  const calls = (value: unknown, depth: number): BrowserTaskInvocationCalls => {
    const row = rpcRecord(value, undefined, 'INVALID_CONTROL_REQUEST')
    if (depth >= BROWSER_TASK_SUBFLOW_MAX_DEPTH || Object.keys(row).length > 32) invalid()
    return Object.fromEntries(Object.entries(row).map(([stepId, value]) => {
      identity(stepId)
      const call = rpcRecord(value, ['parameters', 'items'], 'INVALID_CONTROL_REQUEST')
      if (!Array.isArray(call.items) || call.items.length < 1 || call.items.length > BROWSER_TASK_SUBFLOW_MAX_ITEMS) invalid()
      const shared = parameters(call.parameters)
      const items = (call.items as unknown[]).map(value => {
        if (++children > BROWSER_TASK_SUBFLOW_MAX_CHILDREN) invalid()
        const item = rpcRecord(value, ['id', 'parameters', 'calls'], 'INVALID_CONTROL_REQUEST')
        return { id: identity(item.id), parameters: parameters(item.parameters),
          ...(item.calls === undefined ? {} : { calls: calls(item.calls, depth + 1) }) }
      })
      if (new Set(items.map(item => item.id)).size !== items.length) invalid()
      return [stepId, { parameters: shared, items }]
    }))
  }
  const result = { parameters: parameters(root.parameters), ...(root.calls === undefined ? {} : { calls: calls(root.calls, 1) }) }
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536) invalid()
  return result
}
