import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { CONNECTION_SETUP_READ_ACTIONS, type ConnectionSetupReadSubject, type ConnectionSetupConfigurationEffect, type ConnectionSetupRequestDiagnostic } from './connection-setup-contract.js'

/** A local journal projection. It is not a network log or permission to replay a step. */
export type ConnectionRequestTraceSelector = { cursor?: string; limit?: number }
export type ConnectionRequestTraceEntry = {
  sequence: number
  stepId: string
  kind: 'enrollment-request' | 'setup-initialize' | 'setup-authentication' | 'application-inspection' | 'application-configuration'
  action: 'initialize' | 'enrollment-handoff' | 'authentication' | 'upload' | 'create' | 'credential' | 'continue' | 'confirm-account' | 'renew' | 'inspect-application' | 'read-application' | 'configure-application'
  subject: ConnectionSetupReadSubject | null
  effect: ConnectionSetupConfigurationEffect | null
  /** claimed/settled are original Enrollment journal facts; settled does not mean success. */
  request: 'not-dispatched' | 'claimed' | 'settled' | 'dispatching' | 'confirmed' | 'unknown' | 'refused'
  secureStorage: 'not-started' | 'storing' | 'stored' | 'unknown' | null
  /** A full HTTP request record was not captured; original finite diagnostic facts may be present separately. */
  network: null
  diagnostic?: ConnectionSetupRequestDiagnostic
}
export type ConnectionRequestTrace = { operationId: string; entries: ConnectionRequestTraceEntry[]; next: string | null }
const fail = (): never => { throw new AgentMuxError('The original request trace scope or receipt is unconfirmed.', 'INVALID_CONNECTION_REQUEST_TRACE') }
const object = (value: unknown, keys: string[]) => rpcRecord(value, keys, 'INVALID_CONNECTION_REQUEST_TRACE')
const integer = (v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number => { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail(); return v as number }
const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v)) fail(); return v as string }
const choice = <T extends string>(v: unknown, values: readonly T[]): T => { if (!values.includes(v as T)) fail(); return v as T }
function cursor(value: unknown): string {
  if (typeof value !== 'string' || !/^request-trace:[a-f0-9]{64}:[1-9][0-9]*$/u.test(value)) fail()
  integer(Number((value as string).split(':')[2]))
  return value as string
}
export function parseConnectionSetupRequestDiagnostic(value: unknown): ConnectionSetupRequestDiagnostic {
  const d = object(value, ['code', 'httpStatus', 'nativeCode'])
  const result: ConnectionSetupRequestDiagnostic = { ...(d.code === undefined ? {} : { code: choice(d.code, ['transport-unconfirmed', 'cancelled', 'http-status', 'platform-error', 'invalid-json', 'invalid-response']) }), ...(d.httpStatus === undefined ? {} : { httpStatus: integer(d.httpStatus, 100, 599) }), ...(d.nativeCode === undefined ? {} : { nativeCode: integer(d.nativeCode, -Number.MAX_SAFE_INTEGER) }) }
  if (!Object.keys(result).length) fail()
  return result
}
export function parseConnectionRequestTraceSelector(value: unknown): ConnectionRequestTraceSelector {
  const p = object(value, ['cursor', 'limit'])
  return { ...(p.cursor === undefined ? {} : { cursor: cursor(p.cursor) }), ...(p.limit === undefined ? {} : { limit: integer(p.limit, 1, 100) }) }
}
export function parseConnectionRequestTrace(value: unknown, operationId: string, selector: ConnectionRequestTraceSelector = {}): ConnectionRequestTrace {
  const p = object(value, ['operationId', 'entries', 'next'])
  if (id(p.operationId) !== operationId || !Array.isArray(p.entries) || p.entries.length > (selector.limit ?? 25)) fail()
  const entries = (p.entries as unknown[]).map(value => {
    const e = object(value, ['sequence', 'stepId', 'kind', 'action', 'subject', 'effect', 'request', 'secureStorage', 'network', 'diagnostic'])
    if (e.network !== null) fail()
    const entry: ConnectionRequestTraceEntry = {
      sequence: integer(e.sequence), stepId: id(e.stepId),
      kind: choice(e.kind, ['enrollment-request', 'setup-initialize', 'setup-authentication', 'application-inspection', 'application-configuration']),
      action: choice(e.action, ['initialize', 'enrollment-handoff', 'authentication', 'upload', 'create', 'credential', 'continue', 'confirm-account', 'renew', 'inspect-application', 'read-application', 'configure-application']),
      subject: e.subject === null ? null : choice(e.subject, [...Object.keys(CONNECTION_SETUP_READ_ACTIONS), 'publication-version'] as ConnectionSetupReadSubject[]),
      effect: e.effect === null ? null : choice(e.effect, ['enable-messaging', 'use-persistent-connection', 'use-persistent-callback', 'add-card-actions', 'add-application-permissions', 'add-message-reception', 'create-application-version', 'submit-application-version', 'upload-profile-avatar', 'update-application-profile'] as const),
      request: choice(e.request, ['not-dispatched', 'claimed', 'settled', 'dispatching', 'confirmed', 'unknown', 'refused']),
      secureStorage: e.secureStorage === null ? null : choice(e.secureStorage, ['not-started', 'storing', 'stored', 'unknown'] as const), network: null
    }
    if (e.diagnostic !== undefined) {
      if (entry.kind !== 'application-configuration') fail()
      entry.diagnostic = parseConnectionSetupRequestDiagnostic(e.diagnostic)
    }
    if ((entry.kind === 'application-configuration') !== (entry.effect !== null) || entry.subject !== null && entry.kind !== 'application-inspection') fail()
    const nativeStep = entry.kind === 'setup-authentication' || entry.kind === 'application-inspection' || entry.kind === 'application-configuration'
    if (nativeStep && (!['dispatching', 'confirmed', 'unknown'].includes(entry.request) || entry.secureStorage === null)) fail()
    if (entry.kind === 'enrollment-request' && (!['initialize', 'authentication', 'upload', 'create', 'credential'].includes(entry.action) || !['claimed', 'settled'].includes(entry.request) || entry.secureStorage !== null)) fail()
    if (entry.kind === 'setup-initialize' && (!['initialize', 'enrollment-handoff'].includes(entry.action) || entry.secureStorage === null || !['not-dispatched', 'dispatching', 'confirmed', 'unknown', 'refused'].includes(entry.request))) fail()
    if (entry.kind === 'setup-authentication' && !['continue', 'confirm-account', 'renew'].includes(entry.action)) fail()
    if (entry.kind === 'application-inspection' && entry.action !== (entry.subject === null ? 'inspect-application' : 'read-application')) fail()
    if (entry.kind === 'application-configuration' && entry.action !== 'configure-application') fail()

    return entry
  })
  const after = selector.cursor === undefined ? 0 : Number(selector.cursor.split(':')[2])
  if (new Set(entries.map(e => e.stepId)).size !== entries.length || entries.some((entry, index) => entry.sequence <= (index === 0 ? after : entries[index - 1]!.sequence))) fail()
  const next = p.next === null ? null : cursor(p.next)
  if (next !== null && (!entries.length || Number(next.split(':')[2]) !== entries.at(-1)!.sequence || selector.cursor !== undefined && next.split(':')[1] !== selector.cursor.split(':')[1])) fail()
  return { operationId, entries, next }
}
