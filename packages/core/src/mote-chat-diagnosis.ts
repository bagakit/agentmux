import { sha256 } from '@noble/hashes/sha2.js'
import type { AgentInputSubmissionReceipt } from './agent-input-wait.js'
import { agentPromptInputId } from './agent-prompt-condition.js'
import { connectionDiagnosisIntakeCodes, connectionDiagnosisSourceCodes, type ConnectionDiagnosisIntake } from './connection-diagnosis-contract.js'
import { parseConnectionDiagnosisWaiting } from './connection-diagnosis-codec.js'
import { readAgentPromptPreparationWait, type AgentPromptPreparationWaitReason } from './prompt-preparation.js'
import { parseConnectionObservation } from './connection-record-codec.js'
import type { ConnectionObservation } from './connections-contract.js'
import { AgentMuxError } from './errors.js'
import type { MoteChatTarget } from './mote-chat-contract.js'
import type { ConnectionIngressRuntimeObservation } from './ingress-contract.js'
import { parseMoteConnectionValues, parseMotePreferencesTarget, type MoteConnectionRef } from './mote-preferences.js'
import { rpcRecord } from './rpc-data.js'

export const moteChatDiagnosisWindowLimit = 5 as const
/** Original typed causes only; exception messages and arbitrary codes never cross this boundary. */
export const moteChatDiagnosisCodes = [...connectionDiagnosisIntakeCodes, ...connectionDiagnosisSourceCodes,
  'MOTE_CHAT_TARGET_CHANGED', 'MOTE_CHAT_CONNECTION_UNAVAILABLE', 'MOTE_CHAT_SOURCE_MISMATCH',
  'MOTE_CHAT_ADMISSION_CONFLICT', 'MOTE_CHAT_ROUTE_CHANGED', 'MOTE_CHAT_QUOTA_EXHAUSTED',
  'MOTE_CHAT_AUTHORITY_UNCONFIRMED', 'MOTE_CHAT_ROUTE_DISABLED', 'MOTE_CHAT_PREPARE_MISMATCH',
  'MOTE_CHAT_CREATE_MISMATCH', 'MOTE_CHAT_SOURCE_UNCONFIRMED', 'MOTE_CHAT_HOST_UNAVAILABLE',
  'MOTE_CHAT_EXECUTOR_REQUIRED', 'MOTE_CHAT_EXECUTOR_UNAVAILABLE', 'MOTE_CHAT_EXECUTOR_UNCONFIRMED',
  'MOTE_CHAT_TARGET_UNCONFIRMED', 'MOTE_CHAT_AGENT_RETIRED', 'MOTE_CHAT_CONTEXT_UNCONFIRMED',
  'MOTE_CHAT_STORAGE_UNCONFIRMED', 'CONTROL_UNAVAILABLE',
  'CONNECTION_SERVICE_DISABLED', 'CONNECTION_SERVICE_UNCONFIRMED', 'INGRESS_PREPARATION_UNAVAILABLE'
] as const
export type MoteChatDiagnosisCode = typeof moteChatDiagnosisCodes[number]
export const moteChatDiagnosisCode = (value: unknown): MoteChatDiagnosisCode | null => moteChatDiagnosisCodes.find(code => code === value) ?? null
/** Original preclaim leaves only; this is not a general error-log or Provider error catalog. */
export const moteChatInputFailureCodes = [
  'UNKNOWN_AGENT_SESSION', 'AGENT_SESSION_STORE_READ_UNCONFIRMED', 'STALE_AGENT_SESSION',
  'AGENT_SESSION_IDENTITY_CONFLICT', 'AGENT_SESSION_RUN_MISMATCH', 'STALE_AGENT_SESSION_BINDING',
  'AGENT_RUN_NOT_RUNNING', 'CTXMUX_INPUT_CURSOR_MISSING', 'CTXMUX_DISCONNECTED',
  'AGENT_INTERACTION_PENDING', 'AGENT_PROMPT_SUBMISSION_BUSY', 'AGENT_PROMPT_INPUT_UNCONFIRMED',
  'AGENT_PROMPT_OPERATION_CONFLICT', 'AGENT_PROMPT_SOURCE_CHANGED', 'INVALID_AGENT_PROMPT',
  'INVALID_SESSION_ID', 'INVALID_AGENT_PROVIDER', 'UNKNOWN_PROVIDER', 'AGENT_PROMPT_CANCELLED',
  'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED', 'INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED',
  'INGRESS_ACTOR_NOT_AUTHORIZED', 'INGRESS_AUTHORITY_REVISED', 'INGRESS_BINDING_UNAVAILABLE',
  'INGRESS_CONNECTION_UNAVAILABLE', 'INGRESS_INPUT_MISMATCH', 'INGRESS_TARGET_UNCONFIRMED'
] as const
export type MoteChatInputFailureCode = typeof moteChatInputFailureCodes[number]
export type MoteChatDiagnosisInput = { target: MoteChatTarget }
export type MoteChatDiagnosisIntake = {
  key: string
  state: 'received' | 'refused' | 'claimed'
  code: MoteChatDiagnosisCode | null
  codeRecorded: boolean
  preparation: 'not-admitted' | 'reserved' | 'prepared' | 'creation-dispatched' | 'ready' | 'other-route'
  input: { status: AgentInputSubmissionReceipt['status'] | null; observation: 'not-started' | 'observed' | 'unavailable'
    controlState: AgentInputSubmissionReceipt['control']['state'] | null
    receiptObservation: AgentInputSubmissionReceipt['observation'] | null
    /** Last retained reason, not proof of an active await or permission to retry. */
    waiting: ConnectionDiagnosisIntake['waiting']
    preparationReason: AgentPromptPreparationWaitReason | null
    failureCode: MoteChatInputFailureCode | null
    runtime: ConnectionIngressRuntimeObservation | null }
}
function originalInputFailure(receipt: AgentInputSubmissionReceipt) {
  const waiting = receipt.control.waiting
  return waiting?.phase === 'native-environment' ? waiting.observation?.failure : waiting?.failure
}
/** Read only the original retained typed cause; never infer one from text or nested error details. */
export function moteChatInputFailureCode(receipt: AgentInputSubmissionReceipt): MoteChatInputFailureCode | null {
  const failure = originalInputFailure(receipt)
  return moteChatInputFailureCodes.find(code => code === failure?.code) ?? null
}
/** Read a typed original preparation observation, then discard every private identity and retry fence. */
export function moteChatPreparationReason(receipt: AgentInputSubmissionReceipt): AgentPromptPreparationWaitReason | null {
  const observed = readAgentPromptPreparationWait(originalInputFailure(receipt))
  return observed && observed.agentSessionId === receipt.key.agentSessionId && observed.runId === receipt.key.expectedRun.runId &&
    observed.operationId === agentPromptInputId(receipt.key) ? observed.reason : null
}
export const moteChatDiagnosisIssues = ['configuration-unavailable', 'target-changed', 'service-unavailable', 'connection-unavailable', 'intake-unavailable'] as const
export type MoteChatDiagnosis = {
  /** Diagnostic equality, never a selector, capability or a private path. */
  targetKey: string
  limit: typeof moteChatDiagnosisWindowLimit
  configuration: { revision: number; enabled: boolean; connection: MoteConnectionRef | null } | null
  readiness: { state: 'ready' | 'unavailable' | 'not-configured'; code: MoteChatDiagnosisCode | null }
  service: { enabled: boolean; revision: number } | null
  adapterService: { enabled: boolean; revision: number } | null
  connection: ({ enabled: boolean; revision: number } & ConnectionObservation) | null
  incoming: { rows: MoteChatDiagnosisIntake[]; more: boolean } | null
  issues: Array<typeof moteChatDiagnosisIssues[number]>
}
/** Hash only the exact parsed input. Neither fingerprint grants history, retry or management authority. */
export function moteChatDiagnosisKey(target: MoteChatTarget, ingressId?: string): string {
  const original = parseMotePreferencesTarget(target)
  if (ingressId !== undefined && (typeof ingressId !== 'string' || !ingressId.trim() || /[\u0000-\u001f\u007f]/u.test(ingressId)))
    throw new AgentMuxError('A diagnostic intake key requires its original identity.', 'INVALID_CONTROL_REQUEST')
  const encoded = JSON.stringify(['mote-chat-diagnosis-v1', ingressId === undefined ? ['target', original] : ['intake', original, ingressId]],
    (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
  return Array.from(sha256(new TextEncoder().encode(encoded)), byte => byte.toString(16).padStart(2, '0')).join('')
}

const fail = (): never => { throw new AgentMuxError('The redacted Mote chat diagnosis is malformed or belongs to another original target.', 'CONTROL_PROTOCOL_ERROR') }
function fields(value: unknown, names: string[]): Record<string, unknown> {
  const p = rpcRecord(value, names, 'CONTROL_PROTOCOL_ERROR')
  if (names.some(name => !Object.hasOwn(p, name))) fail()
  return p
}
function member<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) fail(); return value as T }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value as boolean }
function count(value: unknown, min: number): number { if (!Number.isSafeInteger(value) || Number(value) < min) fail(); return value as number }
function key(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(); return value as string }
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value) }
function array<T>(value: unknown, parse: (value: unknown) => T, limit: number): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) fail()
  return Array.from({ length: (value as unknown[]).length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index))
    if (!entry?.enumerable || !('value' in entry)) fail()
    return parse(entry!.value)
  })
}
export function parseMoteChatDiagnosis(value: unknown, input?: MoteChatDiagnosisInput): MoteChatDiagnosis {
  const p = fields(value, ['targetKey', 'limit', 'configuration', 'readiness', 'service', 'adapterService', 'connection', 'incoming', 'issues'])
  const targetKey = key(p.targetKey)
  if (p.limit !== moteChatDiagnosisWindowLimit || input && targetKey !== moteChatDiagnosisKey(input.target)) fail()
  const configuration = nullable(p.configuration, value => {
    const c = fields(value, ['revision', 'enabled', 'connection'])
    const connection = parseMoteConnectionValues({ connection: c.connection }, 'CONTROL_PROTOCOL_ERROR').connection
    if (c.enabled === true && connection === null) fail()
    return { revision: count(c.revision, 1), enabled: bool(c.enabled), connection }
  })
  const r = fields(p.readiness, ['state', 'code']), readiness = {
    state: member(r.state, ['ready', 'unavailable', 'not-configured'] as const),
    code: nullable(r.code, value => member(value, moteChatDiagnosisCodes))
  }
  if (readiness.state !== 'unavailable' && readiness.code !== null) fail()
  const service = (value: unknown) => { const s = fields(value, ['enabled', 'revision']); return { enabled: bool(s.enabled), revision: count(s.revision, 0) } }
  const connection = nullable(p.connection, value => {
    const c = fields(value, ['enabled', 'revision', 'authentication', 'transport', 'intake', 'delivery'])
    let observation: ConnectionObservation
    try { observation = parseConnectionObservation({ authentication: c.authentication, transport: c.transport, intake: c.intake, delivery: c.delivery }) } catch { return fail() }
    return { enabled: bool(c.enabled), revision: count(c.revision, 1), ...observation }
  })
  const incoming = nullable(p.incoming, value => {
    const page = fields(value, ['rows', 'more'])
    const rows = array(page.rows, value => {
      const row = fields(value, ['key', 'state', 'code', 'codeRecorded', 'preparation', 'input']), i = fields(row.input, ['status', 'observation', 'controlState', 'receiptObservation', 'waiting', 'preparationReason', 'failureCode', 'runtime'])
      const code = nullable(row.code, value => member(value, moteChatDiagnosisCodes)), codeRecorded = bool(row.codeRecorded)
      const preparation = member(row.preparation, ['not-admitted', 'reserved', 'prepared', 'creation-dispatched', 'ready', 'other-route'] as const)
      const observation = member(i.observation, ['not-started', 'observed', 'unavailable'] as const)
      const status = nullable(i.status, value => member(value, ['waiting', 'stopped', 'terminal-confirmed', 'admitted', 'not-applied', 'unknown'] as const))
      const controlState = nullable(i.controlState, value => member(value, ['enabled', 'stopped-before-dispatch', 'dispatch-authorized'] as const))
      const receiptObservation = nullable(i.receiptObservation, value => member(value, ['owned', 'rejoin-needed', 'closed'] as const))
      const preparationReason = nullable(i.preparationReason, value => member(value, ['context-compaction', 'native-busy'] as const))
      const failureCode = nullable(i.failureCode, value => member(value, moteChatInputFailureCodes))
      const runtime = nullable(i.runtime, value => {
        const r = fields(value, ['target', 'state', 'exitCode'])
        const target = member(r.target, ['original', 'changed', 'missing', 'unavailable'] as const)
        const state = member(r.state, ['running', 'exited', 'interrupted', 'unavailable'] as const)
        if (r.exitCode !== null && (!Number.isSafeInteger(r.exitCode) || state !== 'exited')) fail()
        return { target, state, exitCode: r.exitCode as number | null }
      })
      if (runtime !== null && status !== 'waiting') fail()
      let waiting: ConnectionDiagnosisIntake['waiting']
      try { waiting = parseConnectionDiagnosisWaiting(i.waiting) } catch { return fail() }
      if (code !== null && !codeRecorded || status !== null && (observation !== 'observed' || preparation === 'other-route')) fail()
      if (status === null ? controlState !== null || receiptObservation !== null || waiting !== null || preparationReason !== null || failureCode !== null
        : controlState === null || receiptObservation === null) fail()
      if (status === 'waiting' && (controlState !== 'enabled' || receiptObservation === 'closed') ||
          status === 'stopped' && controlState !== 'stopped-before-dispatch' ||
          (status === 'admitted' || status === 'not-applied' || status === 'terminal-confirmed') && controlState !== 'dispatch-authorized' ||
          status !== null && status !== 'waiting' && receiptObservation !== 'closed') fail()
      if ((preparationReason !== null || failureCode !== null) && waiting === null) fail()
      if (preparationReason !== null && failureCode !== null) fail()
      return { key: key(row.key), state: member(row.state, ['received', 'refused', 'claimed'] as const), code, codeRecorded,
        preparation, input: { status, observation, controlState, receiptObservation, waiting, preparationReason, failureCode, runtime } }
    }, moteChatDiagnosisWindowLimit)
    if (new Set(rows.map(row => row.key)).size !== rows.length) fail()
    return { rows, more: bool(page.more) }
  })
  const issues = array(p.issues, value => member(value, moteChatDiagnosisIssues), moteChatDiagnosisIssues.length)
  if (new Set(issues).size !== issues.length) fail()
  return { targetKey, limit: moteChatDiagnosisWindowLimit, configuration, readiness,
    service: nullable(p.service, service), adapterService: nullable(p.adapterService, service), connection, incoming, issues }
}
