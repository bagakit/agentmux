import { AgentMuxError } from './errors.js'
import { parseMetricsObservation, type MetricsObservation } from './metrics.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION } from './control.js'
import { settingsResourceRecord } from './settings-resource-json.js'

export const TOOLKIT_STATES = ['idle', 'starting', 'observing', 'paused', 'stopping', 'failed', 'unknown'] as const
export type ToolkitState = typeof TOOLKIT_STATES[number]
export type ToolkitMetricsSnapshot = {
  schema: 'agentmux.toolkit.v1'; kind: 'metrics'; toolId: 'performance'; executionId: string | null
  run: { hostId: string; runId: string } | null; state: ToolkitState; reason: string | null
  startedAt: number | null; observedAt: number | null; observation: MetricsObservation | null
  manual: boolean; consumerCount: number; sequence: number
  trend: { observedAt: number; appCpuPercent: number | null; appRssKib: number | null }[]
}
export const TOOLKIT_SCRIPT_MAX_BYTES = 32 * 1024
export const TOOLKIT_TEXT_MAX_BYTES = 32 * 1024
export const TOOLKIT_MAX_USER_TOOLS = 128
export const TOOLKIT_TOOL_FIELDS_MAX_BYTES = 39 * 1024
export const TOOLKIT_DEFINITION_MAX_BYTES = 40 * 1024
export const TOOLKIT_TEXT_MAX_JSON_BYTES = 48 * 1024
export const TOOLKIT_MAX_ACTIONS = 16
export type ToolkitAction = { id: string; label: string; script: string; args: string[] }
export type ToolkitToolFields = {
  name: string; icon: string; enabled: boolean; statusBar: 'icon' | 'label'
  workspacePath: string; script: string; args: string[]; actions?: ToolkitAction[]
}
export type ToolkitToolInput = ToolkitToolFields & { id: string }
export type ToolkitToolDefinition = ToolkitToolInput & { revision: string }
export type ToolkitRunInput = {
  invocationId: string; expectedRevision: string; expectedLatestExecutionId: string | null
}
export type ToolkitActionInput = {
  invocationId: string; expectedRevision: string; sourceExecutionId: string; expectedAdmissionExecutionId: string | null
}
export type ToolkitExecution = {
  executionId: string; invocationId: string; definition: ToolkitToolDefinition
  expectedLatestExecutionId: string | null; target: { workspacePath: string }
  run: { hostId: string; runId: string } | null; startedAt: number; text: string
  action?: { id: string; sourceExecutionId: string; expectedAdmissionExecutionId: string | null } | null
}
export type ToolkitAdmission = ToolkitExecution & {
  state: 'pending' | 'running' | 'stopping' | 'unknown'; reason: string | null
}
export type ToolkitConfirmedResult = ToolkitExecution & {
  state: 'succeeded' | 'failed' | 'stopped'; reason: string | null; endedAt: number; exitCode: number | null
}
export type ToolkitScriptState = ToolkitAdmission['state'] | ToolkitConfirmedResult['state'] | 'idle' | 'disabled'
export type ToolkitScriptSnapshot = {
  schema: 'agentmux.toolkit.v1'; kind: 'script'; toolId: string; definition: ToolkitToolDefinition
  state: ToolkitScriptState; reason: string | null; admission: ToolkitAdmission | null
  latestConfirmed: ToolkitConfirmedResult | null; consumerCount: number; sequence: number
}
export type ToolkitSnapshot = ToolkitMetricsSnapshot | ToolkitScriptSnapshot
export type ToolkitDescriptor =
  | { kind: 'metrics'; toolId: 'performance'; name: string; readonly: true }
  | { kind: 'script'; toolId: string; name: string; readonly: false; revision: string
      icon: string; enabled: boolean; statusBar: 'icon' | 'label' }
export type ToolkitScript = { toolId: string; path: string | null; sha256: string; text: string }
export const TOOLKIT_OPERATIONS = ['toolkit.list', 'toolkit.get', 'toolkit.script', 'toolkit.run',
  'toolkit.stop', 'toolkit.watch', 'toolkit.add', 'toolkit.update', 'toolkit.remove', 'toolkit.action'] as const
export type ToolkitOperation = typeof TOOLKIT_OPERATIONS[number]
type Envelope = { schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string }
export type ToolkitRequest = Envelope & (
  | { operation: 'toolkit.list' }
  | { operation: 'toolkit.get' | 'toolkit.script' | 'toolkit.watch'; toolId: string }
  | { operation: 'toolkit.run'; toolId: string; input?: ToolkitRunInput }
  | { operation: 'toolkit.action'; toolId: string; actionId: string; input: ToolkitActionInput }
  | { operation: 'toolkit.stop'; toolId: string; executionId?: string | null }
  | { operation: 'toolkit.add'; toolId: string; value: ToolkitToolFields }
  | { operation: 'toolkit.update'; toolId: string; changes: Partial<ToolkitToolFields>; expected?: Partial<ToolkitToolFields> }
  | { operation: 'toolkit.remove'; toolId: string; expected?: ToolkitToolFields }
)
export type ToolkitResult =
  | { operation: 'toolkit.list'; tools: ToolkitDescriptor[] }
  | { operation: 'toolkit.script'; script: ToolkitScript }
  | { [O in 'toolkit.get' | 'toolkit.run' | 'toolkit.stop' | 'toolkit.action']: { operation: O; snapshot: ToolkitSnapshot } }['toolkit.get' | 'toolkit.run' | 'toolkit.stop' | 'toolkit.action']
  | { [O in 'toolkit.add' | 'toolkit.update']: { operation: O; definition: ToolkitToolDefinition; changed: boolean } }['toolkit.add' | 'toolkit.update']
  | { operation: 'toolkit.remove'; toolId: string; removed: true }
  | { operation: 'toolkit.watch' }
export interface AgentMuxToolkitPort {
  execute(request: ToolkitRequest, signal: AbortSignal): Promise<ToolkitResult>
  subscribe(toolId: string, onSnapshot: (value: ToolkitSnapshot) => void,
    onEnd: (error?: Error) => void, signal: AbortSignal): Promise<{ dispose(): void }>
}
export function isToolkitOperation(value: unknown): value is ToolkitOperation {
  return typeof value === 'string' && (TOOLKIT_OPERATIONS as readonly string[]).includes(value)
}
/** Narrow a decoded request as a whole; field guards alone cannot exclude its union arm. */
export function isToolkitRequest<R extends { operation: string }>(request: R): request is Extract<R, { operation: ToolkitOperation }> {
  return isToolkitOperation(request.operation)
}
function invalid(code = 'CONTROL_PROTOCOL_ERROR'): never { throw new AgentMuxError('Toolkit data is invalid or exceeds its budget.', code) }
function record(value: unknown, fields: readonly string[], optional: readonly string[] = [], code = 'CONTROL_PROTOCOL_ERROR'): Record<string, unknown> {
  const r = settingsResourceRecord(value, code)
  if (fields.some(key => !Object.hasOwn(r, key)) || Object.keys(r).some(key => !fields.includes(key) && !optional.includes(key))) invalid(code)
  return r
}
function count(v: unknown) { if (!Number.isSafeInteger(v) || (v as number) < 0) invalid() }
function time(v: unknown) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) invalid() }
function text(v: unknown, max = 4096, code = 'CONTROL_PROTOCOL_ERROR') {
  if (typeof v !== 'string' || Buffer.byteLength(v) > max) invalid(code)
}
function encodedText(v: unknown, max: number, code = 'CONTROL_PROTOCOL_ERROR') {
  if (typeof v !== 'string' || Buffer.byteLength(JSON.stringify(v)) > max) invalid(code)
}
function identity(v: unknown, code = 'CONTROL_PROTOCOL_ERROR'): string {
  text(v, 128, code)
  if (!(v as string).trim() || /[\x00-\x1f\x7f]/u.test(v as string)) invalid(code)
  return v as string
}
function nullable(v: unknown, check: (v: unknown) => void) { if (v !== null) check(v) }
function runRef(v: unknown) {
  if (v !== null) { const r = record(v, ['hostId', 'runId']); identity(r.hostId); identity(r.runId) }
}
const TOOL_FIELDS = ['name', 'icon', 'enabled', 'statusBar', 'workspacePath', 'script', 'args', 'actions'] as const
function field(key: typeof TOOL_FIELDS[number], value: unknown, code: string) {
  if (key === 'actions') {
    if (!Array.isArray(value) || value.length > TOOLKIT_MAX_ACTIONS) invalid(code)
    const ids = new Set<string>()
    for (const item of value) {
      const action = record(item, ['id', 'label', 'script', 'args'], [], code)
      const id = identity(action.id, code)
      if (ids.has(id)) invalid(code)
      ids.add(id)
      text(action.label, 256, code); encodedText(action.label, 768, code)
      if (!(action.label as string).trim() || (action.label as string).includes('\0')) invalid(code)
      field('script', action.script, code); field('args', action.args, code)
    }
    return
  }
  if (key === 'enabled') { if (typeof value !== 'boolean') invalid(code); return }
  if (key === 'statusBar') { if (value !== 'icon' && value !== 'label') invalid(code); return }
  if (key === 'args') {
    if (!Array.isArray(value) || value.length > 32) invalid(code)
    for (const arg of value) { text(arg, 4096, code); if ((arg as string).includes('\0')) invalid(code) }
    return
  }
  const max = key === 'script' ? TOOLKIT_SCRIPT_MAX_BYTES : key === 'workspacePath' ? 4096 : key === 'name' ? 256 : 64
  text(value, max, code)
  // A complete maximum-size descriptor list must fit the unchanged Control envelope.
  if (key === 'name') encodedText(value, 768, code)
  if (key === 'icon') encodedText(value, 192, code)
  if (key === 'workspacePath') encodedText(value, 4096, code)
  if (key !== 'script' && (!(value as string).trim() || (value as string).includes('\0'))) invalid(code)
  if (key === 'script' && (!(value as string).trim() || (value as string).includes('\0'))) invalid(code)
}
/** Pure data validation; the host owns paths, icon choices, persistence and revision issuance. */
export function parseToolkitToolFields(value: unknown, partial = false, code = 'CONTROL_PROTOCOL_ERROR'): ToolkitToolFields | Partial<ToolkitToolFields> {
  const r = record(value, partial ? [] : TOOL_FIELDS.filter(key => key !== 'actions'), partial ? TOOL_FIELDS : ['actions'], code)
  if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_TOOL_FIELDS_MAX_BYTES) invalid(code)
  for (const key of Object.keys(r)) field(key as typeof TOOL_FIELDS[number], r[key], code)
  return r as ToolkitToolFields | Partial<ToolkitToolFields>
}
export function parseToolkitToolDefinition(value: unknown): ToolkitToolDefinition {
  const r = record(value, [...TOOL_FIELDS.filter(key => key !== 'actions'), 'id', 'revision'], ['actions'])
  if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_DEFINITION_MAX_BYTES) invalid()
  const { id, revision, ...fields } = r
  identity(id); identity(revision)
  if (id === 'performance') invalid()
  return { ...parseToolkitToolFields(fields), id, revision } as ToolkitToolDefinition
}
export function parseToolkitRunInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): ToolkitRunInput {
  const r = record(value, ['invocationId', 'expectedRevision', 'expectedLatestExecutionId'], [], code)
  identity(r.invocationId, code); identity(r.expectedRevision, code)
  if (r.expectedLatestExecutionId !== null) identity(r.expectedLatestExecutionId, code)
  return r as ToolkitRunInput
}
export function parseToolkitActionInput(value: unknown, code = 'INVALID_CONTROL_REQUEST'): ToolkitActionInput {
  const r = record(value, ['invocationId', 'expectedRevision', 'sourceExecutionId', 'expectedAdmissionExecutionId'], [], code)
  identity(r.invocationId, code); identity(r.expectedRevision, code); identity(r.sourceExecutionId, code)
  if (r.expectedAdmissionExecutionId !== null) identity(r.expectedAdmissionExecutionId, code)
  return r as ToolkitActionInput
}
const EXECUTION_FIELDS = ['executionId', 'invocationId', 'definition', 'expectedLatestExecutionId', 'target', 'run', 'startedAt', 'text'] as const
function execution(value: unknown, confirmed: boolean): ToolkitAdmission | ToolkitConfirmedResult {
  const r = record(value, [...EXECUTION_FIELDS, 'state', 'reason', ...(confirmed ? ['endedAt', 'exitCode'] : [])], ['action'])
  identity(r.executionId); identity(r.invocationId); nullable(r.expectedLatestExecutionId, identity)
  const definition = parseToolkitToolDefinition(r.definition)
  if (r.action !== undefined && r.action !== null) {
    const action = record(r.action, ['id', 'sourceExecutionId', 'expectedAdmissionExecutionId'])
    identity(action.id); identity(action.sourceExecutionId); nullable(action.expectedAdmissionExecutionId, identity)
    if (!definition.actions?.some(item => item.id === action.id) || action.sourceExecutionId !== r.expectedLatestExecutionId) invalid()
  }
  const target = record(r.target, ['workspacePath']); text(target.workspacePath); encodedText(target.workspacePath, 4096)
  if (target.workspacePath !== definition.workspacePath) invalid()
  runRef(r.run); time(r.startedAt); nullable(r.reason, text); nullable(r.reason, value => encodedText(value, 4096)); text(r.text, TOOLKIT_TEXT_MAX_BYTES); encodedText(r.text, TOOLKIT_TEXT_MAX_JSON_BYTES)
  if (confirmed) {
    if (!['succeeded', 'failed', 'stopped'].includes(r.state as string)) invalid()
    time(r.endedAt)
    if ((r.endedAt as number) < (r.startedAt as number)) invalid()
    if (r.exitCode !== null && !Number.isSafeInteger(r.exitCode)) invalid()
    if (r.state === 'succeeded' && (r.exitCode !== 0 || r.run === null)) invalid()
  } else if (!['pending', 'running', 'stopping', 'unknown'].includes(r.state as string)) invalid()
  return { ...r, definition } as ToolkitAdmission | ToolkitConfirmedResult
}
export function parseToolkitSnapshot(value: unknown): ToolkitSnapshot {
  const source = settingsResourceRecord(value, 'CONTROL_PROTOCOL_ERROR')
  if (source.schema !== 'agentmux.toolkit.v1') invalid()
  if (source.kind === 'script') {
    const r = record(source, ['schema', 'kind', 'toolId', 'definition', 'state', 'reason', 'admission', 'latestConfirmed', 'consumerCount', 'sequence'])
    identity(r.toolId); const definition = parseToolkitToolDefinition(r.definition)
    if (r.toolId !== definition.id || !['idle', 'disabled', 'pending', 'running', 'stopping', 'unknown', 'succeeded', 'failed', 'stopped'].includes(r.state as string)) invalid()
    const admission = r.admission === null ? null : execution(r.admission, false) as ToolkitAdmission
    const latestConfirmed = r.latestConfirmed === null ? null : execution(r.latestConfirmed, true) as ToolkitConfirmedResult
    for (const fact of [admission, latestConfirmed]) if (fact && fact.definition.id !== definition.id) invalid()
    if (admission && r.state !== admission.state) invalid()
    if (!admission && ['pending', 'running', 'stopping'].includes(r.state as string)) invalid()
    if (!admission && ['succeeded', 'failed', 'stopped'].includes(r.state as string) && r.state !== latestConfirmed?.state) invalid()
    count(r.consumerCount); count(r.sequence); nullable(r.reason, text); nullable(r.reason, value => encodedText(value, 4096))
    return { ...r, definition, admission, latestConfirmed } as ToolkitScriptSnapshot
  }
  const r = record(source, ['schema', 'kind', 'toolId', 'executionId', 'run', 'state', 'reason', 'startedAt', 'observedAt', 'observation', 'manual', 'consumerCount', 'sequence', 'trend'])
  if (r.kind !== 'metrics' || r.toolId !== 'performance' || !TOOLKIT_STATES.includes(r.state as ToolkitState) || typeof r.manual !== 'boolean') invalid()
  nullable(r.executionId, identity); nullable(r.reason, text); nullable(r.startedAt, time); nullable(r.observedAt, time)
  count(r.consumerCount); count(r.sequence); runRef(r.run)
  if (r.observation !== null) {
    const obs = parseMetricsObservation(r.observation)
    if (r.observedAt !== obs.observedAt) invalid()
  } else if (r.observedAt !== null) invalid()
  if (!Array.isArray(r.trend) || r.trend.length > 60) invalid()
  for (const point of r.trend) {
    const p = record(point, ['observedAt', 'appCpuPercent', 'appRssKib'])
    time(p.observedAt); nullable(p.appCpuPercent, time); nullable(p.appRssKib, time)
  }
  return r as ToolkitMetricsSnapshot
}
export function parseToolkitResult(operation: ToolkitOperation, value: unknown): ToolkitResult {
  if (operation === 'toolkit.list') {
    const r = record(value, ['tools'])
    if (!Array.isArray(r.tools) || r.tools.length < 1 || r.tools.length > TOOLKIT_MAX_USER_TOOLS + 1) invalid()
    const ids = new Set<string>(); let builtin = 0
    for (const value of r.tools) {
      const tool = record(value, ['kind', 'toolId', 'name', 'readonly'], ['revision', 'icon', 'enabled', 'statusBar'])
      identity(tool.toolId); field('name', tool.name, 'CONTROL_PROTOCOL_ERROR')
      if (ids.has(tool.toolId as string)) invalid(); ids.add(tool.toolId as string)
      if (tool.kind === 'metrics') {
        if (tool.toolId !== 'performance' || tool.readonly !== true || Object.keys(tool).length !== 4) invalid()
        builtin++
      } else if (tool.kind === 'script') {
        if (tool.toolId === 'performance' || tool.readonly !== false || Object.keys(tool).length !== 8) invalid()
        identity(tool.revision); field('icon', tool.icon, 'CONTROL_PROTOCOL_ERROR'); field('enabled', tool.enabled, 'CONTROL_PROTOCOL_ERROR'); field('statusBar', tool.statusBar, 'CONTROL_PROTOCOL_ERROR')
      } else invalid()
    }
    if (builtin !== 1) invalid()
    return { operation, tools: r.tools as ToolkitDescriptor[] }
  }
  if (operation === 'toolkit.script') {
    const r = record(value, ['script']), s = record(r.script, ['toolId', 'path', 'sha256', 'text'])
    identity(s.toolId); nullable(s.path, text)
    if (typeof s.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(s.sha256)) invalid()
    text(s.text, s.toolId === 'performance' ? AGENTMUX_CONTROL_MAX_MESSAGE_BYTES - 4096 : TOOLKIT_SCRIPT_MAX_BYTES)
    if (s.toolId === 'performance' && s.path === null) invalid()
    return { operation, script: s as ToolkitScript }
  }
  if (operation === 'toolkit.add' || operation === 'toolkit.update') {
    const r = record(value, ['definition', 'changed']); if (typeof r.changed !== 'boolean') invalid()
    return { operation, definition: parseToolkitToolDefinition(r.definition), changed: r.changed }
  }
  if (operation === 'toolkit.remove') {
    const r = record(value, ['toolId', 'removed']); identity(r.toolId)
    if (r.toolId === 'performance' || r.removed !== true) invalid()
    return { operation, toolId: r.toolId as string, removed: true }
  }
  if (operation === 'toolkit.watch') { record(value, []); return { operation } }
  const r = record(value, ['snapshot'])
  return { operation, snapshot: parseToolkitSnapshot(r.snapshot) }
}
/** A valid result must still belong to the tool the caller actually requested. */
export function assertToolkitResultTarget(request: { operation: string; toolId?: string }, result: ToolkitResult): void {
  if (request.operation !== result.operation) throw new AgentMuxError('Toolkit operation mismatch.', 'CONTROL_PROTOCOL_ERROR')
  let toolId: string
  switch (result.operation) {
    case 'toolkit.list': case 'toolkit.watch': return
    case 'toolkit.script': toolId = result.script.toolId; break
    case 'toolkit.add': case 'toolkit.update': toolId = result.definition.id; break
    case 'toolkit.remove': toolId = result.toolId; break
    default: toolId = result.snapshot.toolId
  }
  if (toolId !== request.toolId) throw new AgentMuxError('Toolkit result belongs to another tool.', 'CONTROL_PROTOCOL_ERROR')
}
export function parseToolkitRequest(value: unknown): ToolkitRequest {
  const code = 'INVALID_CONTROL_REQUEST', source = settingsResourceRecord(value, code)
  if (source.schemaVersion !== AGENTMUX_CONTROL_SCHEMA_VERSION || !isToolkitOperation(source.operation)) invalid(code)
  identity(source.requestId, code)
  const base = ['schemaVersion', 'requestId', 'operation']
  if (source.operation === 'toolkit.list') return record(source, base, [], code) as ToolkitRequest
  identity(source.toolId, code); base.push('toolId')
  switch (source.operation) {
    case 'toolkit.add': record(source, [...base, 'value'], [], code); parseToolkitToolFields(source.value, false, code); break
    case 'toolkit.update': {
      record(source, [...base, 'changes'], ['expected'], code)
      const changes = parseToolkitToolFields(source.changes, true, code)
      if (!Object.keys(changes).length) invalid(code)
      if (Object.hasOwn(source, 'expected')) {
        const expected = parseToolkitToolFields(source.expected, true, code)
        if (Object.keys(changes).some(key => !Object.hasOwn(expected, key))) invalid(code)
      }
      break
    }
    case 'toolkit.remove': record(source, base, ['expected'], code); if (Object.hasOwn(source, 'expected')) parseToolkitToolFields(source.expected, false, code); break
    case 'toolkit.run': record(source, source.toolId === 'performance' ? base : [...base, 'input'], [], code); if (source.toolId !== 'performance') parseToolkitRunInput(source.input, code); break
    case 'toolkit.action': {
      if (source.toolId === 'performance') invalid(code)
      record(source, [...base, 'actionId', 'input'], [], code)
      identity(source.actionId, code); parseToolkitActionInput(source.input, code); break
    }
    case 'toolkit.stop': record(source, source.toolId === 'performance' ? base : [...base, 'executionId'], [], code); if (source.toolId !== 'performance' && source.executionId !== null) identity(source.executionId, code); break
    default: record(source, base, [], code)
  }
  return source as ToolkitRequest
}
