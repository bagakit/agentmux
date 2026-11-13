import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** One bounded observation of existing captured JSON bodies, never a reclaim estimate. */
export type AgentSessionUsageInput = { hostId: string; agentSessionId: string; cursor?: string; limit?: number }
export type AgentSessionUsagePage = {
  hostId: string
  agentSessionId: string
  observedAt: number
  lifecycle: { state: 'active' | 'retired'; retiredAt?: number; pendingReopen?: true }
  captured: { status: 'not-measured'; reason: string } | {
    status: 'measured'
    epoch: string
    throughSequence: number
    afterSequence: number
    lastSequence: number
    records: number
    logicalBytes: number
    complete: boolean
    nextCursor: string | null
  }
  /** These owners and representations are outside this read's measured scope. */
  unmeasured: readonly ['other-core-records', 'provider-native', 'ctxmux-runtime', 'shared-database-physical']
}
export const SESSION_USAGE_UNMEASURED = ['other-core-records', 'provider-native', 'ctxmux-runtime', 'shared-database-physical'] as const
const fail = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code) }
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

export function parseAgentSessionUsageInput(value: unknown): AgentSessionUsageInput {
  const input = rpcRecord(value, ['hostId', 'agentSessionId', 'cursor', 'limit'])
  for (const key of ['hostId', 'agentSessionId'] as const) if (typeof input[key] !== 'string' || !input[key]) fail(`Usage requires the original ${key}.`)
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 4096)) fail('Usage cursor is invalid.')
  if (input.limit !== undefined && (!natural(input.limit) || input.limit < 1 || input.limit > 256)) fail('Usage limit must be 1–256 records.')
  return input as AgentSessionUsageInput
}

type UsageCursor = { agentSessionId: string; epoch: string; throughSequence: number; afterSequence: number }
export function sessionUsageWindow(id: string, epoch: string, sequence: number, cursor?: string): UsageCursor {
  if (!cursor) return { agentSessionId: id, epoch, throughSequence: sequence, afterSequence: 0 }
  try {
    const value = rpcRecord(JSON.parse(cursor), ['agentSessionId', 'epoch', 'throughSequence', 'afterSequence'])
    if (value.agentSessionId !== id || value.epoch !== epoch || !natural(value.throughSequence) ||
      !natural(value.afterSequence) || value.afterSequence > value.throughSequence || value.throughSequence > sequence) throw new Error('scope')
    return value as UsageCursor
  } catch { return fail('Usage cursor does not match this original captured stream. Read the first page again.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') }
}
export function sessionUsageMeasurement(window: UsageCursor, rows: readonly { sequence: number; logicalBytes: number }[], limit: number): Extract<AgentSessionUsagePage['captured'], { status: 'measured' }> {
  const page = rows.slice(0, limit)
  const lastSequence = page.at(-1)?.sequence ?? window.afterSequence
  const complete = rows.length <= limit
  return { status: 'measured', epoch: window.epoch, throughSequence: window.throughSequence,
    afterSequence: window.afterSequence, lastSequence, records: page.length,
    logicalBytes: page.reduce((sum, row) => sum + row.logicalBytes, 0), complete,
    nextCursor: complete ? null : JSON.stringify({ ...window, afterSequence: lastSequence }) }
}

export function parseAgentSessionUsagePage(value: unknown, expected: Pick<AgentSessionUsageInput, 'hostId' | 'agentSessionId'>): AgentSessionUsagePage {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const page = rpcRecord(value, ['hostId', 'agentSessionId', 'observedAt', 'lifecycle', 'captured', 'unmeasured'], code)
  if (page.hostId !== expected.hostId || page.agentSessionId !== expected.agentSessionId || !natural(page.observedAt)) fail('Usage response belongs to another original target.', code)
  const lifecycle = rpcRecord(page.lifecycle, ['state', 'retiredAt', 'pendingReopen'], code)
  if (!['active', 'retired'].includes(String(lifecycle.state)) || lifecycle.retiredAt !== undefined && !natural(lifecycle.retiredAt) ||
    lifecycle.pendingReopen !== undefined && lifecycle.pendingReopen !== true) fail('Usage lifecycle observation is invalid.', code)
  const captured = rpcRecord(page.captured, undefined, code)
  if (captured.status === 'not-measured') {
    rpcRecord(captured, ['status', 'reason'], code)
    if (typeof captured.reason !== 'string' || !captured.reason) fail('Unmeasured usage requires its reason.', code)
  } else {
    rpcRecord(captured, ['status', 'epoch', 'throughSequence', 'afterSequence', 'lastSequence', 'records', 'logicalBytes', 'complete', 'nextCursor'], code)
    if (captured.status !== 'measured' || typeof captured.epoch !== 'string' || !captured.epoch ||
      !['throughSequence', 'afterSequence', 'lastSequence', 'records', 'logicalBytes'].every(key => natural(captured[key])) ||
      Number(captured.afterSequence) > Number(captured.lastSequence) || Number(captured.lastSequence) > Number(captured.throughSequence) ||
      Number(captured.records) > 256 || typeof captured.complete !== 'boolean' ||
      (captured.complete ? captured.nextCursor !== null : typeof captured.nextCursor !== 'string' || !captured.nextCursor)) fail('Captured usage observation is invalid.', code)
  }
  if (JSON.stringify(page.unmeasured) !== JSON.stringify(SESSION_USAGE_UNMEASURED)) fail('Usage must retain its unmeasured owners and scope.', code)
  return page as AgentSessionUsagePage
}
