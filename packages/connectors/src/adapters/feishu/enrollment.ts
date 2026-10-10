import { gzipSync } from 'node:zlib'
import type { ConnectionEnrollmentDiagnostic } from '@agentmux/core/connections'
import type { ConnectionEnrollmentAdapter, EnrollmentAdapterInput, EnrollmentChallengeReceipt, EnrollmentPollReceipt, EnrollmentUnknownReceipt } from '../../connection-enrollment-adapter.js'

const issuers = {
  'open.feishu.cn': { accounts: 'accounts.feishu.cn', brand: 'feishu', label: 'Feishu' },
  'open.larksuite.com': { accounts: 'accounts.larksuite.com', brand: 'lark', label: 'Lark' }
} as const
type Domain = keyof typeof issuers
type State = {
  version: 1
  operationId: string
  connectionId: string
  domain: Domain
  label: string
  deviceCode: string
  verificationUrl: string
  userCode?: string
  deadline: number | null
  interval: number
}

// The original confirmation page may ignore addons outside its rollout. This is a
// requested bot-only profile, never evidence of actual grants or WS readiness.
const addons = gzipSync(JSON.stringify({
  preset: false,
  scopes: { tenant: ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:write_only', 'im:chat.members:read'] },
  events: { items: { tenant: ['im.message.receive_v1'] } }
})).toString('base64url')

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
}
function domain(value: string): value is Domain { return Object.hasOwn(issuers, value) }
function milliseconds(value: unknown, zero = false): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0)) return null
  const result = value * 1_000
  return Number.isSafeInteger(result) ? result : null
}
function verification(value: unknown, scope: Domain, deviceCode: string): URL | null {
  if (!text(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      url.hostname !== scope && url.hostname !== issuers[scope].accounts || url.searchParams.has('device_code') ||
      value.includes(deviceCode) || decodeURIComponent(value).includes(deviceCode) || [...url.searchParams.values()].some(part => part.includes(deviceCode))) return null
    return url
  } catch { return null }
}
function receipt(state: State): EnrollmentChallengeReceipt {
  return {
    kind: 'pending', verificationUrl: state.verificationUrl,
    ...(state.userCode === undefined ? {} : { userCode: state.userCode }),
    expiresInMs: state.deadline === null ? null : Math.max(0, state.deadline - Date.now()),
    pollIntervalMs: state.interval, privateState: JSON.stringify(state)
  }
}
function readState(input: EnrollmentAdapterInput & { privateState: string }): State | null {
  let value: Record<string, unknown> | null
  try { value = object(JSON.parse(input.privateState)) } catch { return null }
  if (!value || value.version !== 1 || !domain(input.domain) || value.domain !== input.domain ||
    value.operationId !== input.operationId || value.connectionId !== input.connectionId || value.label !== input.label ||
    !text(value.deviceCode) || !verification(value.verificationUrl, input.domain, value.deviceCode) ||
    (value.userCode !== undefined && (!text(value.userCode) || value.userCode.includes(value.deviceCode))) ||
    (value.deadline !== null && (typeof value.deadline !== 'number' || !Number.isSafeInteger(value.deadline) || value.deadline < 0)) ||
    typeof value.interval !== 'number' || !Number.isSafeInteger(value.interval) || value.interval <= 0) return null
  return value as State
}
function unknown(diagnostic: ConnectionEnrollmentDiagnostic): EnrollmentUnknownReceipt { return { kind: 'unknown', diagnostic } }
type RegistrationResponse = { kind: 'received'; value: Record<string, unknown>; httpStatus: number } | EnrollmentUnknownReceipt
async function request(scope: Domain, fields: Record<string, string>, signal?: AbortSignal): Promise<RegistrationResponse> {
  if (signal?.aborted) return unknown({ stage: 'request', code: 'cancelled' })
  let response: Response
  try {
    response = await fetch(`https://${issuers[scope].accounts}/oauth/v1/app/registration`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(), redirect: 'error', ...(signal ? { signal } : {})
    })
  } catch { return unknown({ stage: 'request', code: signal?.aborted ? 'cancelled' : 'transport-unconfirmed' }) }
  const httpStatus = response.status
  // A received HTTP failure does not prove that this registration was unapplied.
  if (!response.ok && httpStatus !== 400) return unknown({ stage: 'response', code: 'http-status', httpStatus })
  let decoded: unknown
  try { decoded = await response.json() } catch { return unknown({ stage: 'response', code: 'invalid-json', httpStatus }) }
  const value = object(decoded)
  if (!value || !response.ok && (typeof value.error !== 'string' || value.client_id !== undefined || value.client_secret !== undefined)) return unknown({ stage: 'response', code: 'invalid-response', httpStatus })
  return { kind: 'received', value, httpStatus }
}

/** Finite public SDK wire protocol. The original Host owns every claim and secret. */
export function createFeishuEnrollment(): ConnectionEnrollmentAdapter {
  return {
    domains: Object.entries(issuers).map(([scope, issuer]) => ({ domain: scope, label: issuer.label })),
    async begin(input, signal) {
      if (!domain(input.domain) || !text(input.operationId) || !text(input.connectionId) || !text(input.label)) return { kind: 'unknown' }
      const response = await request(input.domain, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' }, signal)
      if (response.kind === 'unknown') return response
      const { value: result, httpStatus } = response
      if (result.error !== undefined) return unknown({ stage: 'response', code: text(result.error) ? 'platform-error' : 'invalid-response', httpStatus })
      if (!text(result.device_code)) return unknown({ stage: 'response', code: 'invalid-response', httpStatus })
      const received = Date.now()
      let url: URL | null
      if (result.verification_uri_complete === undefined) {
        // The official CLI builds this exact issuer-owned page from the public
        // user code. A supplied unsafe URI cannot be hidden by its missing peer.
        if (result.verification_uri !== undefined && !verification(result.verification_uri, input.domain, result.device_code)) return unknown({ stage: 'challenge', code: 'unsafe-verification' })
        if (!text(result.user_code) || result.user_code.includes(result.device_code)) return unknown({ stage: 'challenge', code: 'missing-verification' })
        url = new URL(`https://${input.domain}/page/cli`)
        url.searchParams.set('user_code', result.user_code)
      } else url = verification(result.verification_uri_complete, input.domain, result.device_code)
      const interval = result.interval === undefined ? 5_000 : milliseconds(result.interval)
      if (!url) return unknown({ stage: 'challenge', code: 'unsafe-verification' })
      if (interval === null || (result.user_code !== undefined && (!text(result.user_code) || result.user_code.includes(result.device_code)))) return unknown({ stage: 'challenge', code: 'invalid-challenge' })
      // Both spellings exist in the original SDK/installer. Missing is unknown;
      // their local default timeout is not an authoritative platform expiry.
      if (result.expires_in !== undefined && result.expire_in !== undefined && result.expires_in !== result.expire_in) return unknown({ stage: 'challenge', code: 'invalid-challenge' })
      const expiry = result.expires_in !== undefined ? result.expires_in : result.expire_in
      const lifetime = expiry === undefined ? null : milliseconds(expiry, true)
      if (expiry !== undefined && lifetime === null || lifetime !== null && !Number.isSafeInteger(received + lifetime)) return unknown({ stage: 'challenge', code: 'invalid-challenge' })
      url.searchParams.set('from', 'sdk')
      url.searchParams.set('source', 'node-sdk/agentmux')
      url.searchParams.set('tp', 'sdk')
      url.searchParams.set('createOnly', 'true')
      url.searchParams.delete('clientID')
      url.searchParams.set('name', input.preset?.name ?? input.label)
      url.searchParams.set('desc', input.preset?.description ?? (input.preset ? '' : 'Connect this bot to AgentMux'))
      url.searchParams.set('addons', addons)
      if (!verification(url.toString(), input.domain, result.device_code)) return unknown({ stage: 'challenge', code: 'unsafe-verification' })
      return receipt({ version: 1, operationId: input.operationId, connectionId: input.connectionId, domain: input.domain, label: input.label,
        deviceCode: result.device_code, verificationUrl: url.toString(), ...(typeof result.user_code === 'string' ? { userCode: result.user_code } : {}),
        deadline: lifetime === null ? null : received + lifetime, interval })
    },
    async poll(input, signal): Promise<EnrollmentPollReceipt> {
      const state = readState(input)
      if (!state || state.deadline !== null && state.deadline <= Date.now()) return { kind: 'unknown' }
      const response = await request(state.domain, { action: 'poll', device_code: state.deviceCode }, signal)
      if (response.kind === 'unknown') return response
      const { value: result, httpStatus } = response
      const user = result.user_info === undefined ? null : object(result.user_info)
      // The SDK's implicit Lark switch sends another HTTP request. A finite
      // preclaimed poll must never change the frozen issuer or perform that hop.
      if (result.user_info !== undefined && !user || user?.tenant_brand !== undefined && user.tenant_brand !== issuers[state.domain].brand) return unknown({ stage: 'response', code: 'invalid-response', httpStatus })
      if (result.client_id !== undefined || result.client_secret !== undefined) {
        // Match the original ConnectionApplication identifier contract before
        // exposing an authorized identity to the Host's secure handoff.
        if (result.error !== undefined || !text(result.client_id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result.client_id) ||
          typeof result.client_secret !== 'string' || result.client_secret.length === 0) return unknown({ stage: 'response', code: 'invalid-response', httpStatus })
        // Preserve a validated late response for this original attempt: aborting
        // the observer does not revoke a remotely created app or its secret.
        return { kind: 'authorized', application: { domain: state.domain, appId: result.client_id }, secret: result.client_secret }
      }
      switch (result.error) {
        case 'authorization_pending': return receipt(state)
        case 'slow_down': {
          const interval = state.interval + 5_000
          return Number.isSafeInteger(interval) ? receipt({ ...state, interval }) : { kind: 'unknown' }
        }
        case 'access_denied': return { kind: 'denied' }
        case 'expired_token': return { kind: 'expired' }
        default: return unknown({ stage: 'response', code: text(result.error) ? 'platform-error' : 'invalid-response', httpStatus })
      }
    }
  }
}
