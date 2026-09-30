import { AgentMuxError } from './errors.js'
import { parseMetricsObservation, type MetricsObservation } from './metrics.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest } from './control.js'

export const TOOLKIT_STATES = ['idle', 'starting', 'observing', 'paused', 'stopping', 'failed', 'unknown'] as const
export type ToolkitState = typeof TOOLKIT_STATES[number]
export type ToolkitSnapshot = {
  schema: 'agentmux.toolkit.v1'; toolId: 'performance'; executionId: string | null
  run: { hostId: string; runId: string } | null; state: ToolkitState; reason: string | null
  startedAt: number | null; observedAt: number | null; observation: MetricsObservation | null
  manual: boolean; consumerCount: number; sequence: number
  trend: { observedAt: number; appCpuPercent: number | null; appRssKib: number | null }[]
}
export type ToolkitScript = { toolId: 'performance'; path: string; sha256: string; text: string }
export type ToolkitOperation = 'toolkit.list' | 'toolkit.get' | 'toolkit.script' | 'toolkit.run' | 'toolkit.stop' | 'toolkit.watch'
export type ToolkitRequest = { [O in ToolkitOperation]: {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string; operation: O; toolId: 'performance'
} }[ToolkitOperation]
export type ToolkitResult =
  | { operation: 'toolkit.list'; tools: { toolId: 'performance'; name: string; readonly: true }[] }
  | { operation: 'toolkit.script'; script: ToolkitScript }
  | { operation: 'toolkit.get' | 'toolkit.run' | 'toolkit.stop'; snapshot: ToolkitSnapshot }
  | { operation: 'toolkit.watch' }
export interface AgentMuxToolkitPort {
  execute(request: ToolkitRequest, signal: AbortSignal): Promise<ToolkitResult>
  subscribe(toolId: 'performance', onSnapshot: (value: ToolkitSnapshot) => void,
    onEnd: (error?: Error) => void, signal: AbortSignal): Promise<{ dispose(): void }>
}
export function isToolkitOperation(value: unknown): value is ToolkitOperation {
  return typeof value === 'string' && ['toolkit.list','toolkit.get','toolkit.script','toolkit.run','toolkit.stop','toolkit.watch'].includes(value)
}
function invalid(): never { throw new AgentMuxError('Toolkit result is invalid.', 'CONTROL_PROTOCOL_ERROR') }
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== fields.length || fields.some(key => !Object.hasOwn(r, key))) invalid()
  return r
}
function count(v: unknown) { if (!Number.isSafeInteger(v) || (v as number) < 0) invalid() }
function time(v: unknown) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) invalid() }
function nullable(v: unknown, check: (v: unknown) => void) { if (v !== null) check(v) }
function text(v: unknown) { if (typeof v !== 'string' || v.length > 4096) invalid() }
export function parseToolkitSnapshot(value: unknown): ToolkitSnapshot {
  const r = record(value, ['schema','toolId','executionId','run','state','reason','startedAt','observedAt','observation','manual','consumerCount','sequence','trend'])
  if (r.schema !== 'agentmux.toolkit.v1' || r.toolId !== 'performance' || !TOOLKIT_STATES.includes(r.state as ToolkitState) || typeof r.manual !== 'boolean') invalid()
  nullable(r.executionId, text); nullable(r.reason, text); nullable(r.startedAt, time); nullable(r.observedAt, time)
  count(r.consumerCount); count(r.sequence)
  if (r.run !== null) { const run = record(r.run, ['hostId','runId']); text(run.hostId); text(run.runId) }
  if (r.observation !== null) {
    const obs = parseMetricsObservation(r.observation)
    if (r.observedAt !== obs.observedAt) invalid()
  } else if (r.observedAt !== null) invalid()
  if (!Array.isArray(r.trend) || r.trend.length > 60) invalid()
  for (const point of r.trend) {
    const p = record(point, ['observedAt','appCpuPercent','appRssKib'])
    time(p.observedAt); nullable(p.appCpuPercent, time); nullable(p.appRssKib, time)
  }
  if (Buffer.byteLength(JSON.stringify(r)) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) invalid()
  return r as ToolkitSnapshot
}
export function parseToolkitResult(operation: ToolkitOperation, value: unknown): ToolkitResult {
  if (operation === 'toolkit.list') {
    const r = record(value, ['tools'])
    if (!Array.isArray(r.tools) || r.tools.length !== 1) invalid()
    const tool = record(r.tools[0], ['toolId','name','readonly'])
    if (tool.toolId !== 'performance' || tool.readonly !== true) invalid()
    text(tool.name)
    return { operation, tools: r.tools as Extract<ToolkitResult,{operation:'toolkit.list'}>['tools'] }
  }
  if (operation === 'toolkit.script') {
    const r = record(value, ['script']), s = record(r.script, ['toolId','path','sha256','text'])
    if (s.toolId !== 'performance' || typeof s.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(s.sha256) || typeof s.text !== 'string' || Buffer.byteLength(s.text) > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 4096) invalid()
    text(s.path)
    return { operation, script: s as ToolkitScript }
  }
  if (operation === 'toolkit.watch') { record(value, []); return { operation } }
  const r = record(value, ['snapshot'])
  return { operation, snapshot: parseToolkitSnapshot(r.snapshot) }
}
export function toolkitRequest(value: AgentMuxControlRequest): ToolkitRequest {
  if (!isToolkitOperation(value.operation)) throw new AgentMuxError('Toolkit operation is invalid.', 'INVALID_CONTROL_REQUEST')
  const r = value as unknown as Record<string, unknown>
  if (r.toolId !== 'performance') throw new AgentMuxError('Toolkit tool is unknown.', 'INVALID_CONTROL_REQUEST')
  return value as ToolkitRequest
}
