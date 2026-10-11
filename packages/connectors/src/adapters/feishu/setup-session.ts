import type { ConnectionSetupReadSubject, ConnectionSetupReadSummary } from '@agentmux/core/connections'
import type { SetupAdapterInput, SetupChallengeReceipt, SetupAuthenticationReceipt, SetupInspectionReceipt, SetupReadReceipt, SetupConfigurationReceipt } from '../../connection-setup-adapter.js'
import { beginFeishuNativeAccount, advanceFeishuNativeAccount, readNativeAccountState, readNativeAccountResponse, type NativeAccountInitialState, type NativeAccountState } from './native-account.js'

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const opaque = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\u0000-\u001f\u007f\s]/u.test(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Validate the original saved-application binding before interpreting any native account state. */
function snapshot(input: SetupAdapterInput & { privateState: string }): Record<string, unknown> {
  const p = record(JSON.parse(input.privateState))
  if (!p || p.operationId !== input.operationId || p.connectionId !== input.connectionId || p.attemptId !== input.attemptId || !same(p.application, input.application)) throw new Error('Foreign authentication snapshot')
  return p
}
function serializeSnapshot(input: SetupAdapterInput, state: NativeAccountInitialState | NativeAccountState): string {
  const { version, ...native } = state
  return JSON.stringify({ version, operationId: input.operationId, connectionId: input.connectionId, attemptId: input.attemptId, application: input.application, ...native })
}
export async function beginFeishuSession(input: SetupAdapterInput, signal?: AbortSignal): Promise<SetupChallengeReceipt> {
  if (input.application.domain !== 'open.feishu.cn') return { kind: 'unknown' }
  const receipt = await beginFeishuNativeAccount(signal)
  return receipt.kind === 'challenge' ? { kind: 'challenge', challenge: receipt.challenge, privateState: serializeSnapshot(input, receipt.state) } : receipt
}
/** Setup retains its original scope; native authentication receives no fabricated application. */
export async function advanceFeishuSession(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupAuthenticationReceipt> {
  if (input.application.domain !== 'open.feishu.cn') return { kind: 'unknown' }
  try {
    const receipt = await advanceFeishuNativeAccount(snapshot(input), signal)
    return receipt.kind === 'progress' ? { kind: 'progress', stage: receipt.stage, challenge: receipt.challenge, account: receipt.account, privateState: serializeSnapshot(input, receipt.state) } : receipt
  } catch { return { kind: 'unknown' } }
}

/** The exact sourced console origin is qualified separately from authentication aliases. */
async function applicationEnvelope(input: SetupAdapterInput & { privateState: string; assertCurrent?: () => void }, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  if (input.application.domain !== 'open.feishu.cn') return null
  try {
    const { state, cookies } = readNativeAccountState(snapshot(input))
    if (state.phase !== 'account' || !state.account || !opaque(state.csrf) || state.consoleOrigin !== 'https://open.feishu.cn') return null
    const target = new URL(path + encodeURIComponent(input.application.appId), state.consoleOrigin)
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': state.csrf, 'X-Timezone-Offset': String(new Date().getTimezoneOffset()) }
    const cookie = cookies.getCookieStringSync(target.href); if (cookie) headers.cookie = cookie
    const bounded = AbortSignal.timeout(20_000)
    input.assertCurrent?.()
    const response = await fetch(target.href, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, bounded]) : bounded })
    if (!response.ok || response.redirected || response.url && new URL(response.url).href !== target.href || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null
    const payload = record(JSON.parse(await readNativeAccountResponse(response)))
    return payload?.code === 0 ? payload : null
  } catch { return null }
}

async function applicationData(input: SetupAdapterInput & { privateState: string }, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  return record((await applicationEnvelope(input, path, body, signal))?.data)
}

/** Local raw-field interpretation only; a missing field is never the UI's false default. */
export async function feishuMessagingCapability(originalReadState: string): Promise<'enabled' | 'disabled' | 'unknown'> {
  try {
    const data = record(JSON.parse(originalReadState))
    return data && Object.hasOwn(data, 'enable') && typeof data.enable === 'boolean' ? data.enable ? 'enabled' : 'disabled' : 'unknown'
  } catch { return 'unknown' }
}

/** One exact scalar command. Acceptance is neither enabled readback nor online readiness. */
export async function enableFeishuMessaging(input: SetupAdapterInput & { privateState: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt> {
  const envelope = await applicationEnvelope(input, '/developers/v1/robot/switch/', { enable: true }, signal)
  return envelope ? { kind: 'accepted', privateState: JSON.stringify(envelope) } : { kind: 'unknown' }
}

/** One exact console permission read, not an app-data read or a configuration grant. */
export async function inspectFeishuApplication(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupInspectionReceipt> {
  const data = await applicationData(input, '/developers/v1/app_role/permission/', {}, signal)
  const permissions = record(data?.permission)
  if (!data || !Number.isSafeInteger(data.roleType) || !permissions || !Object.hasOwn(permissions, String(data.roleType))) return { kind: 'unknown' }
  const role = record(permissions[String(data.roleType)]), read = record(role?.readResource), write = record(role?.writeResource)
  if (!read || !write) return { kind: 'unknown' }
  return { kind: 'observed', applicationInfoReadPermission: Object.hasOwn(read, 'app.info') || Object.hasOwn(write, 'app.info') ? 'confirmed' : 'unknown', privateState: JSON.stringify(data) }
}

/** A current read is one native subject; catalogs and UI-defaulted objects are excluded. */
export async function readFeishuApplication(input: SetupAdapterInput & { privateState: string; subject: ConnectionSetupReadSubject }, signal?: AbortSignal): Promise<SetupReadReceipt> {
  const paths = { 'application-details': '/developers/v1/app/', 'event-settings': '/developers/v1/event/', 'callback-settings': '/developers/v1/callback/', 'bot-settings': '/developers/v1/robot/' } as const
  if (!Object.hasOwn(paths, input.subject)) return { kind: 'unknown' }
  const data = await applicationData(input, paths[input.subject], input.subject === 'event-settings' ? { needEventDetail: true } : {}, signal)
  if (!data) return { kind: 'unknown' }
  const display = (v: unknown, max: number): string | null => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v) ? v : null
  const readResult: ConnectionSetupReadSummary = input.subject === 'application-details'
    ? { subject: input.subject, name: display(data.name, 512), description: display(data.desc, 4096) }
    : input.subject === 'event-settings'
      ? { subject: input.subject, transport: data.eventMode === 4 ? 'persistent-connection' : data.eventMode === 1 ? 'webhook' : data.eventMode === 2 || data.eventMode === 3 ? 'function' : 'unknown' }
      : { subject: input.subject }
  return { kind: 'observed', readResult, privateState: JSON.stringify(data) }
}
