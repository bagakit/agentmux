import { AgentMuxError } from './errors.js'
import { parseMetricsObservation, type MetricsObservation } from './metrics.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES, AGENTMUX_CONTROL_SCHEMA_VERSION } from './control.js'
import { settingsResourceBudget, settingsResourceEnvelope, settingsResourceRecord } from './settings-resource-json.js'
import { parseToolkitResultDocument, type ToolkitResultDocument } from './toolkit-result-document.js'
export * from './toolkit-result-document.js'
export * from './toolkit-performance-failure.js'
import { parseToolkitPerformanceDiagnostics, type ToolkitPerformanceDiagnostics } from './toolkit-performance-failure.js'

export const TOOLKIT_STATES = ['idle', 'starting', 'observing', 'paused', 'stopping', 'failed', 'unknown'] as const
export type ToolkitState = typeof TOOLKIT_STATES[number]
export type ToolkitMetricsSnapshot = {
  schema: 'agentmux.toolkit.v1'; kind: 'metrics'; toolId: 'performance'; executionId: string | null
  run: { hostId: string; runId: string } | null; state: ToolkitState; reason: string | null
  startedAt: number | null; observedAt: number | null; observation: MetricsObservation | null; document: ToolkitResultDocument | null
  diagnostics: ToolkitPerformanceDiagnostics
  manual: boolean; consumerCount: number; sequence: number
  trend: { observedAt: number; appCpuPercent: number | null; appRssKib: number | null }[]
}
export const TOOLKIT_SCRIPT_MAX_BYTES = 32 * 1024
export const TOOLKIT_TEXT_MAX_BYTES = 32 * 1024
export const TOOLKIT_MAX_USER_TOOLS = 128
/** Shared budget for user tools and the existing bounded built-in catalog. */
export const TOOLKIT_MAX_LISTED_TOOLS = TOOLKIT_MAX_USER_TOOLS + 16
export const TOOLKIT_TOOL_FIELDS_MAX_BYTES = 39 * 1024
export const TOOLKIT_DEFINITION_MAX_BYTES = 40 * 1024
export const TOOLKIT_TEXT_MAX_JSON_BYTES = 48 * 1024
export const TOOLKIT_MAX_ACTIONS = 16
export type ToolkitDisplayProgram = { script: string; args: string[] }
export type ToolkitAction = { id: string; label: string; script: string; args: string[] }
export type ToolkitToolFields = {
  name: string; icon: string; enabled: boolean; statusBar: 'icon' | 'label'
  workspacePath: string; script: string; args: string[]; actions?: ToolkitAction[]; display?: ToolkitDisplayProgram | null
}
export type ToolkitToolInput = ToolkitToolFields & { id: string }
export type ToolkitPackageFields = {
  kind: 'package'; packagePath: string; enabled: boolean; statusBar: 'icon' | 'label'
  workspacePath: string; args: string[]
}
/** Only creation may omit cwd; the Host fills it before saving a configuration. */
export type ToolkitPackageCreateFields = Omit<ToolkitPackageFields, 'workspacePath'> & { workspacePath?: string }
export type ToolkitPackageConfiguration = ToolkitPackageFields & { id: string; revision: string }
export type ToolkitInlineToolConfiguration = ToolkitToolInput & { revision: string; package?: never }
export type ToolkitToolConfiguration = ToolkitInlineToolConfiguration | ToolkitPackageConfiguration
export type ToolkitConfigurationFields = ToolkitToolFields | ToolkitPackageFields
export type ToolkitConfigurationChanges = Partial<ToolkitToolFields> | Partial<ToolkitPackageFields>
export type ToolkitPackageManifest = {
  schema: 'agentmux.toolkit.package.v1'; name: string; icon: string; entry: string
  actions: { id: string; label: string; entry: string; args: string[] }[]
  display?: { entry: string; args: string[] }
}
export type ToolkitPackageSource = {
  path: string; configRevision: string; contentSHA256: string; entry: string
  actionEntries: { id: string; entry: string }[]; displayEntry?: string
}
/** Resolved public source facts; package bytes remain with the Host file owner. */
export type ToolkitToolDefinition = ToolkitToolInput & { revision: string; package?: ToolkitPackageSource }
export type ToolkitRunInput = {
  invocationId: string; expectedRevision: string; expectedLatestExecutionId: string | null
}
/** The baseline belongs to the independent display lane, never the action result. */
export type ToolkitEvaluateInput = ToolkitRunInput
export type ToolkitActionInput = {
  invocationId: string; expectedRevision: string; sourceExecutionId: string; expectedAdmissionExecutionId: string | null
}
export type ToolkitExecution = {
  executionId: string; invocationId: string; definition: ToolkitToolDefinition
  expectedLatestExecutionId: string | null; target: { workspacePath: string }
  run: { hostId: string; runId: string } | null; startedAt: number; text: string
  /** Absent for text-only results; null means the original machine document is unavailable. */
  document?: ToolkitResultDocument | null
  action?: { id: string; sourceExecutionId: string; expectedAdmissionExecutionId: string | null } | null
}
export type ToolkitAdmission = ToolkitExecution & {
  state: 'pending' | 'running' | 'stopping' | 'unknown'; reason: string | null
}
export type ToolkitConfirmedResult = ToolkitExecution & {
  state: 'succeeded' | 'failed' | 'stopped'; reason: string | null; endedAt: number; exitCode: number | null
}
export type ToolkitScriptState = ToolkitAdmission['state'] | ToolkitConfirmedResult['state'] | 'idle' | 'disabled'
export type ToolkitDisplaySnapshot = {
  state: ToolkitScriptState; reason: string | null; admission: ToolkitAdmission | null
  latestConfirmed: ToolkitConfirmedResult | null; sequence: number; lastSucceeded?: ToolkitConfirmedResult | null
}
export type ToolkitScriptSnapshot = {
  schema: 'agentmux.toolkit.v1'; kind: 'script'; toolId: string; definition: ToolkitToolDefinition
  state: ToolkitScriptState; reason: string | null; admission: ToolkitAdmission | null
  latestConfirmed: ToolkitConfirmedResult | null; consumerCount: number; sequence: number; display?: ToolkitDisplaySnapshot
}
export type ToolkitPackageUnavailableSnapshot = {
  schema: 'agentmux.toolkit.v1'; kind: 'package-unavailable'; toolId: string
  configuration: ToolkitPackageConfiguration; reason: string; retained: ToolkitScriptSnapshot | null
}
export type ToolkitSnapshot = ToolkitMetricsSnapshot | ToolkitScriptSnapshot | ToolkitPackageUnavailableSnapshot
export type ToolkitDescriptor =
  | { kind: 'metrics'; toolId: 'performance'; name: string; readonly: true }
  | { kind: 'script'; toolId: string; name: string; readonly: boolean; revision: string
      icon: string; enabled: boolean; statusBar: 'icon' | 'label'; display?: boolean }
  | { kind: 'package'; toolId: string; readonly: false; configRevision: string; path: string
      enabled: boolean; statusBar: 'icon' | 'label'; name: string | null; icon: string | null
      availability: 'available' | 'unavailable'; reason: string | null; display?: boolean }
export type ToolkitScript = { toolId: string; path: string | null; sha256: string; text: string }
export const TOOLKIT_OPERATIONS = ['toolkit.list', 'toolkit.get', 'toolkit.script', 'toolkit.run',
  'toolkit.stop', 'toolkit.watch', 'toolkit.add', 'toolkit.update', 'toolkit.remove', 'toolkit.action', 'toolkit.evaluate'] as const
export type ToolkitOperation = typeof TOOLKIT_OPERATIONS[number]
type Envelope = { schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string }
export type ToolkitRequest = Envelope & (
  | { operation: 'toolkit.list' }
  | { operation: 'toolkit.script'; toolId: string }
  | { operation: 'toolkit.get'; toolId: string; includeFailureEvidence?: true }
  | { operation: 'toolkit.watch'; toolId: string; captureFailure?: true; includeFailureEvidence?: true; evaluateOnDisplay?: boolean }
  | { operation: 'toolkit.run'; toolId: string; input?: ToolkitRunInput }
  | { operation: 'toolkit.evaluate'; toolId: string; input?: ToolkitEvaluateInput }
  | { operation: 'toolkit.action'; toolId: string; actionId: string; input: ToolkitActionInput }
  | { operation: 'toolkit.stop'; toolId: string; executionId?: string | null }
  | { operation: 'toolkit.add'; toolId: string; value: ToolkitToolFields | ToolkitPackageCreateFields }
  | { operation: 'toolkit.update'; toolId: string; changes: ToolkitConfigurationChanges; expected?: ToolkitConfigurationChanges }
  | { operation: 'toolkit.remove'; toolId: string; expected?: ToolkitConfigurationFields }
)
export type ToolkitResult =
  | { operation: 'toolkit.list'; tools: ToolkitDescriptor[] }
  | { operation: 'toolkit.script'; script: ToolkitScript }
  | { [O in 'toolkit.get' | 'toolkit.run' | 'toolkit.stop' | 'toolkit.action' | 'toolkit.evaluate']: { operation: O; snapshot: ToolkitSnapshot } }['toolkit.get' | 'toolkit.run' | 'toolkit.stop' | 'toolkit.action' | 'toolkit.evaluate']
  | { [O in 'toolkit.add' | 'toolkit.update']: { operation: O; definition: ToolkitToolConfiguration; changed: boolean } }['toolkit.add' | 'toolkit.update']
  | { operation: 'toolkit.remove'; toolId: string; removed: true }
  | { operation: 'toolkit.watch' }
export type ToolkitSubscribeOptions = { captureFailure?: true; includeFailureEvidence?: true; evaluateOnDisplay?: boolean }
export interface AgentMuxToolkitPort {
  execute(request: ToolkitRequest, signal: AbortSignal, context?: import('./display-label.js').AgentMuxNameContext): Promise<ToolkitResult>
  subscribe(toolId: string, onSnapshot: (value: ToolkitSnapshot) => void,
    onEnd: (error?: Error) => void, signal: AbortSignal, options?: ToolkitSubscribeOptions): Promise<{ dispose(): void }>
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
// Typed children have their own schema; wrapper nesting is not arbitrary Settings JSON.
function envelope(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const r = settingsResourceEnvelope(value, [...fields, ...optional], 'CONTROL_PROTOCOL_ERROR')
  if (fields.some(key => !Object.hasOwn(r, key))) invalid()
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
const TOOL_FIELDS = ['name', 'icon', 'enabled', 'statusBar', 'workspacePath', 'script', 'args', 'actions', 'display'] as const
function field(key: typeof TOOL_FIELDS[number], value: unknown, code: string) {
  if (key === 'display') {
    if (value === null) return
    const display = record(value, ['script', 'args'], [], code)
    field('script', display.script, code); field('args', display.args, code)
    return
  }
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
  const r = record(value, partial ? [] : TOOL_FIELDS.filter(key => key !== 'actions' && key !== 'display'), partial ? TOOL_FIELDS : ['actions', 'display'], code)
  if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_TOOL_FIELDS_MAX_BYTES) invalid(code)
  for (const key of Object.keys(r)) field(key as typeof TOOL_FIELDS[number], r[key], code)
  return r as ToolkitToolFields | Partial<ToolkitToolFields>
}
const PACKAGE_FIELDS = ['kind', 'packagePath', 'enabled', 'statusBar', 'workspacePath', 'args'] as const
export function parseToolkitPackageFields(value: unknown, partial = false, code = 'CONTROL_PROTOCOL_ERROR', allowMissingWorkspacePath = false): ToolkitPackageFields | Partial<ToolkitPackageFields> | ToolkitPackageCreateFields {
  const r = record(value, partial ? [] : PACKAGE_FIELDS.filter(key => !allowMissingWorkspacePath || key !== 'workspacePath'),
    partial ? PACKAGE_FIELDS : allowMissingWorkspacePath ? ['workspacePath'] : [], code)
  if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_TOOL_FIELDS_MAX_BYTES) invalid(code)
  for (const key of Object.keys(r)) {
    if (key === 'kind') { if (r.kind !== 'package') invalid(code) }
    else field(key === 'packagePath' ? 'workspacePath' : key as typeof TOOL_FIELDS[number], r[key], code)
  }
  return r as ToolkitPackageFields | Partial<ToolkitPackageFields> | ToolkitPackageCreateFields
}
/** Shared preference patches are valid for either arm; source fields cannot be mixed. */
export function parseToolkitConfigurationFields(value: unknown, partial = false, code = 'CONTROL_PROTOCOL_ERROR', allowMissingWorkspacePath = false): ToolkitConfigurationFields | ToolkitConfigurationChanges | ToolkitPackageCreateFields {
  const r = settingsResourceRecord(value, code)
  return Object.hasOwn(r, 'kind') || Object.hasOwn(r, 'packagePath')
    ? parseToolkitPackageFields(r, partial, code, allowMissingWorkspacePath)
    : parseToolkitToolFields(r, partial, code)
}
export function parseToolkitPackageConfiguration(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ToolkitPackageConfiguration {
  const r = record(value, [...PACKAGE_FIELDS, 'id', 'revision'], [], code)
  if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_DEFINITION_MAX_BYTES) invalid(code)
  const { id, revision, ...fields } = r
  identity(id, code); identity(revision, code)
  if (id === 'performance') invalid(code)
  return { ...parseToolkitPackageFields(fields, false, code), id, revision } as ToolkitPackageConfiguration
}
function relativeEntry(value: unknown, code: string) {
  text(value, 4096, code); encodedText(value, 4096, code)
  if (!(value as string).trim() || /[\\\x00-\x1f\x7f:]/u.test(value as string) ||
    (value as string).split('/').some(segment => !segment || segment === '.' || segment === '..')) invalid(code)
}
export function parseToolkitPackageManifest(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ToolkitPackageManifest {
  const r = record(value, ['schema', 'name', 'icon', 'entry'], ['actions', 'display'], code)
  if (r.schema !== 'agentmux.toolkit.package.v1' || Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_TOOL_FIELDS_MAX_BYTES) invalid(code)
  field('name', r.name, code); field('icon', r.icon, code); relativeEntry(r.entry, code)
  if (r.actions !== undefined && (!Array.isArray(r.actions) || r.actions.length > TOOLKIT_MAX_ACTIONS)) invalid(code)
  const ids = new Set<string>()
  const actions = ((r.actions ?? []) as unknown[]).map(value => {
    const action = record(value, ['id', 'label', 'entry'], ['args'], code)
    const id = identity(action.id, code)
    if (ids.has(id)) invalid(code)
    ids.add(id)
    text(action.label, 256, code); encodedText(action.label, 768, code)
    if (!(action.label as string).trim() || (action.label as string).includes('\0')) invalid(code)
    relativeEntry(action.entry, code); field('args', action.args ?? [], code)
    return { ...action, args: action.args ?? [] }
  })
  if (Object.hasOwn(r, 'display')) {
    const display = record(r.display, ['entry'], ['args'], code)
    relativeEntry(display.entry, code); field('args', display.args ?? [], code)
    r.display = { ...display, args: display.args ?? [] }
  }
  return { ...r, actions } as ToolkitPackageManifest
}
function packageSource(value: unknown, actions: ToolkitAction[] | undefined, display: ToolkitDisplayProgram | null | undefined, code: string): ToolkitPackageSource {
  const r = record(value, ['path', 'configRevision', 'contentSHA256', 'entry', 'actionEntries'], ['displayEntry'], code)
  field('workspacePath', r.path, code); identity(r.configRevision, code); relativeEntry(r.entry, code)
  if (typeof r.contentSHA256 !== 'string' || !/^[a-f0-9]{64}$/u.test(r.contentSHA256) ||
    !Array.isArray(r.actionEntries) || r.actionEntries.length !== (actions?.length ?? 0)) invalid(code)
  const ids = new Set<string>()
  for (const item of r.actionEntries as unknown[]) {
    const action = record(item, ['id', 'entry'], [], code), id = identity(action.id, code)
    if (ids.has(id) || !actions?.some(action => action.id === id)) invalid(code)
    ids.add(id); relativeEntry(action.entry, code)
  }
  if (Boolean(display) !== Object.hasOwn(r, 'displayEntry')) invalid(code)
  if (display) relativeEntry(r.displayEntry, code)
  return r as ToolkitPackageSource
}
export function parseToolkitToolDefinition(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ToolkitToolDefinition {
  const r = record(value, [...TOOL_FIELDS.filter(key => key !== 'actions' && key !== 'display'), 'id', 'revision'], ['actions', 'display', 'package'], code)
  if (Buffer.byteLength(JSON.stringify(r)) > TOOLKIT_DEFINITION_MAX_BYTES) invalid(code)
  const { id, revision, package: source, ...fields } = r
  identity(id, code); identity(revision, code)
  if (id === 'performance') invalid(code)
  const definition = { ...parseToolkitToolFields(fields, false, code), id, revision } as ToolkitToolDefinition
  if (Object.hasOwn(r, 'package')) definition.package = packageSource(source, definition.actions, definition.display, code)
  return definition
}
/** Durable records carry references or inline source, never resolved package source copies. */
export function parseToolkitToolConfiguration(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): ToolkitToolConfiguration {
  const r = settingsResourceRecord(value, code)
  if (r.kind === 'package') return parseToolkitPackageConfiguration(r, code)
  if (Object.hasOwn(r, 'package')) invalid(code)
  return parseToolkitToolDefinition(r, code) as ToolkitInlineToolConfiguration
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
  const r = envelope(value, [...EXECUTION_FIELDS, 'state', 'reason', ...(confirmed ? ['endedAt', 'exitCode'] : [])], ['action', 'document'])
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
  if (Object.hasOwn(r, 'document') && r.document !== null) parseToolkitResultDocument(r.document)
  if (r.document !== undefined && r.run === null) invalid()
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
  const source = settingsResourceEnvelope(value, ['schema', 'kind', 'toolId', 'configuration', 'reason', 'retained',
    'definition', 'state', 'admission', 'latestConfirmed', 'consumerCount', 'sequence', 'display',
    'executionId', 'run', 'startedAt', 'observedAt', 'observation', 'document', 'manual', 'trend', 'diagnostics'], 'CONTROL_PROTOCOL_ERROR')
  if (source.schema !== 'agentmux.toolkit.v1') invalid()
  if (source.kind === 'package-unavailable') {
    const r = record(source, ['schema', 'kind', 'toolId', 'configuration', 'reason', 'retained'])
    identity(r.toolId)
    const configuration = parseToolkitPackageConfiguration(r.configuration)
    text(r.reason); encodedText(r.reason, 4096)
    if (r.toolId !== configuration.id || !(r.reason as string).trim()) invalid()
    const retained = r.retained === null ? null : parseToolkitSnapshot(r.retained)
    if (retained && (retained.kind !== 'script' || retained.toolId !== r.toolId)) invalid()
    return { ...r, configuration, retained } as ToolkitPackageUnavailableSnapshot
  }
  if (source.kind === 'script') {
    const r = envelope(source, ['schema', 'kind', 'toolId', 'definition', 'state', 'reason', 'admission', 'latestConfirmed', 'consumerCount', 'sequence'], ['display'])
    identity(r.toolId); const definition = parseToolkitToolDefinition(r.definition)
    if (r.toolId !== definition.id || !['idle', 'disabled', 'pending', 'running', 'stopping', 'unknown', 'succeeded', 'failed', 'stopped'].includes(r.state as string)) invalid()
    const admission = r.admission === null ? null : execution(r.admission, false) as ToolkitAdmission
    const latestConfirmed = r.latestConfirmed === null ? null : execution(r.latestConfirmed, true) as ToolkitConfirmedResult
    for (const fact of [admission, latestConfirmed]) if (fact && fact.definition.id !== definition.id) invalid()
    if (admission && r.state !== admission.state) invalid()
    if (!admission && ['pending', 'running', 'stopping'].includes(r.state as string)) invalid()
    if (!admission && ['succeeded', 'failed', 'stopped'].includes(r.state as string) && r.state !== latestConfirmed?.state) invalid()
    count(r.consumerCount); count(r.sequence); nullable(r.reason, text); nullable(r.reason, value => encodedText(value, 4096))
    if (Object.hasOwn(r, 'display')) {
      const display = envelope(r.display, ['state', 'reason', 'admission', 'latestConfirmed', 'sequence'], ['lastSucceeded'])
      const displayAdmission = display.admission === null ? null : execution(display.admission, false) as ToolkitAdmission
      const displayConfirmed = display.latestConfirmed === null ? null : execution(display.latestConfirmed, true) as ToolkitConfirmedResult
      const lastSucceeded = display.lastSucceeded === undefined || display.lastSucceeded === null ? display.lastSucceeded
        : execution(display.lastSucceeded, true) as ToolkitConfirmedResult
      if (lastSucceeded && lastSucceeded.state !== 'succeeded') invalid()
      if (!definition.display && !displayAdmission && !displayConfirmed && !lastSucceeded) invalid()
      for (const fact of [displayAdmission, displayConfirmed, lastSucceeded]) {
        if (fact && (fact.definition.id !== definition.id || !fact.definition.display || fact.action)) invalid()
      }
      if (!['idle', 'disabled', 'pending', 'running', 'stopping', 'unknown', 'succeeded', 'failed', 'stopped'].includes(display.state as string)) invalid()
      if (displayAdmission && display.state !== displayAdmission.state) invalid()
      if (!displayAdmission && ['pending', 'running', 'stopping'].includes(display.state as string)) invalid()
      if (!displayAdmission && ['succeeded', 'failed', 'stopped'].includes(display.state as string) && display.state !== displayConfirmed?.state) invalid()
      count(display.sequence); nullable(display.reason, text); nullable(display.reason, value => encodedText(value, 4096))
      r.display = { ...display, admission: displayAdmission, latestConfirmed: displayConfirmed,
        ...(Object.hasOwn(display, 'lastSucceeded') ? { lastSucceeded } : {}) }
    }
    return { ...r, definition, admission, latestConfirmed } as ToolkitScriptSnapshot
  }
  const r = envelope(source, ['schema', 'kind', 'toolId', 'executionId', 'run', 'state', 'reason', 'startedAt', 'observedAt', 'observation', 'document', 'manual', 'consumerCount', 'sequence', 'trend', 'diagnostics'])
  if (r.kind !== 'metrics' || r.toolId !== 'performance' || !TOOLKIT_STATES.includes(r.state as ToolkitState) || typeof r.manual !== 'boolean') invalid()
  nullable(r.executionId, identity); nullable(r.reason, text); nullable(r.startedAt, time); nullable(r.observedAt, time)
  count(r.consumerCount); count(r.sequence); runRef(r.run)
  parseToolkitPerformanceDiagnostics(r.diagnostics)
  if (r.observation !== null) {
    const obs = parseMetricsObservation(r.observation)
    if (r.observedAt !== obs.observedAt) invalid()
  } else if (r.observedAt !== null) invalid()
  if (r.document !== null) parseToolkitResultDocument(r.document)
  // The small arbitrary trend subtree still uses the existing pure JSON guard.
  const trend = record({ trend: r.trend }, ['trend']).trend
  if (!Array.isArray(trend) || trend.length > 60) invalid()
  for (const point of trend) {
    const p = record(point, ['observedAt', 'appCpuPercent', 'appRssKib'])
    time(p.observedAt); nullable(p.appCpuPercent, time); nullable(p.appRssKib, time)
  }
  settingsResourceBudget(r, 'CONTROL_PROTOCOL_ERROR')
  return r as ToolkitMetricsSnapshot
}
export function parseToolkitResult(operation: ToolkitOperation, value: unknown): ToolkitResult {
  if (operation === 'toolkit.list') {
    const r = record(value, ['tools'])
    if (!Array.isArray(r.tools) || r.tools.length < 1 || r.tools.length > TOOLKIT_MAX_LISTED_TOOLS) invalid()
    const ids = new Set<string>(); let builtin = 0
    for (const value of r.tools) {
      const source = settingsResourceRecord(value, 'CONTROL_PROTOCOL_ERROR')
      const tool = source.kind === 'package'
        ? record(source, ['kind', 'toolId', 'name', 'readonly', 'icon', 'enabled', 'statusBar', 'configRevision', 'path', 'availability', 'reason'], ['display'])
        : record(source, ['kind', 'toolId', 'name', 'readonly'], ['revision', 'icon', 'enabled', 'statusBar', 'display'])
      identity(tool.toolId)
      if (Object.hasOwn(tool, 'display') && typeof tool.display !== 'boolean') invalid()
      if (tool.kind === 'package') nullable(tool.name, value => field('name', value, 'CONTROL_PROTOCOL_ERROR'))
      else field('name', tool.name, 'CONTROL_PROTOCOL_ERROR')
      if (ids.has(tool.toolId as string)) invalid(); ids.add(tool.toolId as string)
      if (tool.kind === 'metrics') {
        if (tool.toolId !== 'performance' || tool.readonly !== true || Object.keys(tool).length !== 4) invalid()
        builtin++
      } else if (tool.kind === 'script') {
        if (tool.toolId === 'performance' || typeof tool.readonly !== 'boolean' || Object.keys(tool).length !== 8 + (Object.hasOwn(tool, 'display') ? 1 : 0)) invalid()
        identity(tool.revision); field('icon', tool.icon, 'CONTROL_PROTOCOL_ERROR'); field('enabled', tool.enabled, 'CONTROL_PROTOCOL_ERROR'); field('statusBar', tool.statusBar, 'CONTROL_PROTOCOL_ERROR')
      } else if (tool.kind === 'package') {
        if (tool.toolId === 'performance' || tool.readonly !== false || !['available', 'unavailable'].includes(tool.availability as string)) invalid()
        identity(tool.configRevision); field('workspacePath', tool.path, 'CONTROL_PROTOCOL_ERROR')
        nullable(tool.icon, value => field('icon', value, 'CONTROL_PROTOCOL_ERROR'))
        field('enabled', tool.enabled, 'CONTROL_PROTOCOL_ERROR'); field('statusBar', tool.statusBar, 'CONTROL_PROTOCOL_ERROR')
        nullable(tool.reason, text); nullable(tool.reason, value => encodedText(value, 4096))
        if (tool.availability === 'available' && (tool.name === null || tool.icon === null) ||
          tool.availability === 'unavailable' && (typeof tool.reason !== 'string' || !tool.reason.trim())) invalid()
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
    return { operation, definition: parseToolkitToolConfiguration(r.definition), changed: r.changed }
  }
  if (operation === 'toolkit.remove') {
    const r = record(value, ['toolId', 'removed']); identity(r.toolId)
    if (r.toolId === 'performance' || r.removed !== true) invalid()
    return { operation, toolId: r.toolId as string, removed: true }
  }
  if (operation === 'toolkit.watch') { record(value, []); return { operation } }
  const r = envelope(value, ['snapshot'])
  const snapshot = parseToolkitSnapshot(r.snapshot)
  // The exact typed snapshot already validated its children; a generic wrapper walk
  // would reject retained package/display facts solely for their schema nesting.
  settingsResourceBudget(r, 'CONTROL_PROTOCOL_ERROR')
  return { operation, snapshot }
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
    case 'toolkit.add': record(source, [...base, 'value'], [], code); parseToolkitConfigurationFields(source.value, false, code, true); break
    case 'toolkit.update': {
      record(source, [...base, 'changes'], ['expected'], code)
      const changes = parseToolkitConfigurationFields(source.changes, true, code)
      if (!Object.keys(changes).length) invalid(code)
      if (Object.hasOwn(source, 'expected')) {
        const expected = parseToolkitConfigurationFields(source.expected, true, code)
        if (Object.keys(changes).some(key => !Object.hasOwn(expected, key))) invalid(code)
      }
      break
    }
    case 'toolkit.remove': record(source, base, ['expected'], code); if (Object.hasOwn(source, 'expected')) parseToolkitConfigurationFields(source.expected, false, code); break
    case 'toolkit.run': record(source, source.toolId === 'performance' ? base : [...base, 'input'], [], code); if (source.toolId !== 'performance') parseToolkitRunInput(source.input, code); break
    case 'toolkit.evaluate':
      if (source.toolId === 'performance') invalid(code)
      record(source, base, ['input'], code); if (source.input !== undefined) parseToolkitRunInput(source.input, code); break
    case 'toolkit.action': {
      if (source.toolId === 'performance') invalid(code)
      record(source, [...base, 'actionId', 'input'], [], code)
      identity(source.actionId, code); parseToolkitActionInput(source.input, code); break
    }
    case 'toolkit.stop': record(source, source.toolId === 'performance' ? base : [...base, 'executionId'], [], code); if (source.toolId !== 'performance' && source.executionId !== null) identity(source.executionId, code); break
    case 'toolkit.get':
    case 'toolkit.watch':
      record(source, base, source.operation === 'toolkit.watch' ? ['captureFailure', 'includeFailureEvidence', 'evaluateOnDisplay'] : ['includeFailureEvidence'], code)
      if (Object.hasOwn(source, 'evaluateOnDisplay') && typeof source.evaluateOnDisplay !== 'boolean') invalid(code)
      for (const key of ['captureFailure', 'includeFailureEvidence']) {
        if (Object.hasOwn(source, key) && (source.toolId !== 'performance' || source[key] !== true)) invalid(code)
      }
      break
    default: record(source, base, [], code)
  }
  return source as ToolkitRequest
}
