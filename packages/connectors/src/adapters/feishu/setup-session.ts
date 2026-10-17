import type { ConnectionSetupReadSubject, ConnectionSetupReadSummary } from '@agentmux/core/connections'
import type { SetupAdapterInput, SetupChallengeReceipt, SetupAuthenticationReceipt, SetupInspectionReceipt, SetupReadReceipt, SetupConfigurationReceipt, SetupPublicationReceipt } from '../../connection-setup-adapter.js'
import { beginFeishuNativeAccount, advanceFeishuNativeAccount, readNativeAccountState, type NativeAccountInitialState, type NativeAccountState } from './native-account.js'
import { supportedScopeId } from './setup-permissions.js'
import { enrollmentAccountSession } from './enrollment.js'
import { feishuMessageReceptionIntent } from './setup-message-reception.js'
import { feishuVersionStatus, feishuSubmissionResponse } from './setup-publication.js'
import { requestFeishuConsole } from './console-request.js'
import { FEISHU_MESSAGE_EVENT } from './message.js'

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
export async function continueFeishuEnrollment(input: SetupAdapterInput & { privateState: string; account: import('@agentmux/core/connections').ConnectionSetupAccount }): Promise<SetupAuthenticationReceipt> {
  const native = enrollmentAccountSession(input.privateState, input.application)
  if (!native || !native.account || native.account.userId !== input.account.userId || native.account.tenantId !== input.account.tenantId) return { kind: 'unknown' }
  return { kind: 'progress', stage: 'account', challenge: null, account: native.account, privateState: serializeSnapshot(input, native) }
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
async function applicationEnvelope(input: SetupAdapterInput & { privateState: string; assertCurrent?: () => void }, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ApplicationReply> {
  return applicationRequest(input, path + encodeURIComponent(input.application.appId), body, signal, path === '/developers/v1/scope/update/')
}
type ApplicationReply = { payload: Record<string, unknown> | null; authentication?: string }
async function applicationRequest(input: SetupAdapterInput & { privateState: string; assertCurrent?: () => void }, path: string, body: Record<string, unknown>, signal?: AbortSignal, developerPanel = false): Promise<ApplicationReply> {
  if (input.application.domain !== 'open.feishu.cn') return { payload: null }
  let native: ReturnType<typeof readNativeAccountState>
  try { native = readNativeAccountState(snapshot(input)) } catch { return { payload: null } }
  const receipt = await requestFeishuConsole({ state: native.state, cookies: native.cookies, path, body, referer: '/app/' + encodeURIComponent(input.application.appId), developerPanel, ...(input.assertCurrent ? { assertCurrent: input.assertCurrent } : {}) }, signal)
  return { payload: receipt.kind === 'response' ? receipt.payload : null, ...(receipt.authentication ? { authentication: serializeSnapshot(input, receipt.authentication) } : {}) }
}

async function applicationData(input: SetupAdapterInput & { privateState: string }, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: Record<string, unknown> | null; authentication?: string }> {
  const { payload, ...authentication } = await applicationEnvelope(input, path, body, signal)
  return { data: record(payload?.data), ...authentication }
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
  const { payload: envelope, ...authentication } = await applicationEnvelope(input, '/developers/v1/robot/switch/', { clientId: input.application.appId, enable: true }, signal)
  return envelope ? { kind: 'accepted', privateState: JSON.stringify(envelope), ...authentication } : { kind: 'unknown', ...authentication }
}

/** Only known native modes can qualify a scalar transition; missing or future modes stay unknown. */
export async function feishuEventTransportCapability(originalReadState: string): Promise<'enabled' | 'disabled' | 'unknown'> {
  try {
    const data = record(JSON.parse(originalReadState))
    return data?.eventMode === 4 ? 'enabled' : [1, 2, 3].includes(data?.eventMode as number) ? 'disabled' : 'unknown'
  } catch { return 'unknown' }
}

export async function useFeishuPersistentConnection(input: SetupAdapterInput & { privateState: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt> {
  const { payload: envelope, ...authentication } = await applicationEnvelope(input, '/developers/v1/event/switch/', { clientId: input.application.appId, eventMode: 4 }, signal)
  return envelope ? { kind: 'accepted', privateState: JSON.stringify(envelope), ...authentication } : { kind: 'unknown', ...authentication }
}

export async function feishuCallbackTransportCapability(originalReadState: string): Promise<'enabled' | 'disabled' | 'unknown'> {
  try {
    const data = record(JSON.parse(originalReadState))
    return data?.callbackMode === 4 ? 'enabled' : [0, 1, 2, 3].includes(data?.callbackMode as number) ? 'disabled' : 'unknown'
  } catch { return 'unknown' }
}
export async function useFeishuPersistentCallback(input: SetupAdapterInput & { privateState: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt> {
  const { payload: envelope, ...authentication } = await applicationEnvelope(input, '/developers/v1/callback/switch/', { clientId: input.application.appId, callbackMode: 4 }, signal)
  return envelope ? { kind: 'accepted', privateState: JSON.stringify(envelope), ...authentication } : { kind: 'unknown', ...authentication }
}
export async function feishuCardActionsCapability(originalReadState: string): Promise<'enabled' | 'disabled' | 'unknown'> {
  try {
    const data = record(JSON.parse(originalReadState))
    if (data?.callbackMode !== 4 || !Array.isArray(data.callbacks)) return 'unknown'
    const callbacks = data.callbacks.map(value => typeof value === 'string' ? value : record(value)?.id)
    if (!callbacks.every(opaque) || new Set(callbacks).size !== callbacks.length) return 'unknown'
    return callbacks.includes('card.action.trigger') ? 'enabled' : 'disabled'
  } catch { return 'unknown' }
}
export async function addFeishuCardActions(input: SetupAdapterInput & { privateState: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt> {
  const { payload: envelope, ...authentication } = await applicationEnvelope(input, '/developers/v1/callback/update/', { clientId: input.application.appId, operation: 'add', callbacks: ['card.action.trigger'], callbackMode: 4 }, signal)
  return envelope ? { kind: 'accepted', privateState: JSON.stringify(envelope), ...authentication } : { kind: 'unknown', ...authentication }
}

/** One exact console permission read, not an app-data read or a configuration grant. */
export async function inspectFeishuApplication(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupInspectionReceipt> {
  const { data, ...authentication } = await applicationData(input, '/developers/v1/app_role/permission/', {}, signal)
  const permissions = record(data?.permission)
  if (!data || !Number.isSafeInteger(data.roleType) || !permissions || !Object.hasOwn(permissions, String(data.roleType))) return { kind: 'unknown', ...authentication }
  const role = record(permissions[String(data.roleType)]), read = record(role?.readResource), write = record(role?.writeResource)
  if (!read || !write) return { kind: 'unknown', ...authentication }
  return { kind: 'observed', applicationInfoReadPermission: Object.hasOwn(read, 'app.info') || Object.hasOwn(write, 'app.info') ? 'confirmed' : 'unknown', privateState: JSON.stringify(data), ...authentication }
}

/** A current read is one native subject; catalogs and UI-defaulted objects are excluded. */
export async function readFeishuApplication(input: SetupAdapterInput & { privateState: string; subject: ConnectionSetupReadSubject; versionId?: string }, signal?: AbortSignal): Promise<SetupReadReceipt> {
  const paths = { 'application-details': '/developers/v1/app/', 'event-settings': '/developers/v1/event/', 'callback-settings': '/developers/v1/callback/', 'bot-settings': '/developers/v1/robot/', 'permission-catalog': '/developers/v1/scope/all/', 'application-permissions': '/developers/v1/scope/applied/', 'event-catalog': '/developers/v1/event/all/', 'publication-pending': '/developers/v1/app_version/change/', 'publication-versions': '/developers/v1/app_version/list/', 'publication-visibility': '/developers/v1/visible/online/', 'publication-sharing': '/developers/v1/b2c_share/' } as const
  if (input.subject === 'publication-version') {
    if (!opaque(input.versionId)) return { kind: 'unknown' }
    const { payload, ...authentication } = await applicationRequest(input, '/developers/v1/app_version/detail/' + encodeURIComponent(input.application.appId) + '/' + encodeURIComponent(input.versionId), {}, signal)
    const data = record(payload?.data)
    return data && (data.versionId === undefined || data.versionId === input.versionId) ? { kind: 'observed', readResult: { subject: input.subject, versionId: input.versionId, status: feishuVersionStatus(data.versionStatus) }, privateState: JSON.stringify(data), ...authentication } : { kind: 'unknown', ...authentication }
  }
  const reply = input.subject === 'publication-features' ? await applicationRequest(input, '/developers/v1/developer_panel/config', { clientId: input.application.appId }, signal) : Object.hasOwn(paths, input.subject) ? await applicationEnvelope(input, paths[input.subject as keyof typeof paths], input.subject === 'event-settings' ? { needEventDetail: true } : {}, signal) : { payload: null }
  const { payload, ...authentication } = reply, data = record(payload?.data)
  if (!data) return { kind: 'unknown', ...authentication }
  const display = (v: unknown, max: number): string | null => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v) ? v : null
  const readResult: ConnectionSetupReadSummary = input.subject === 'application-details'
    ? { subject: input.subject, name: display(data.name, 512), description: display(data.desc, 4096) }
    : input.subject === 'event-settings'
      ? { subject: input.subject, transport: data.eventMode === 4 ? 'persistent-connection' : data.eventMode === 1 ? 'webhook' : data.eventMode === 2 || data.eventMode === 3 ? 'function' : 'unknown' }
      : { subject: input.subject }
  return { kind: 'observed', readResult, privateState: JSON.stringify(data), ...authentication }
}

/** Preserve the exact original primitive IDs. An empty difference is never a platform ACK. */
export async function addFeishuApplicationPermissions(input: SetupAdapterInput & { privateState: string; appScopeIDs: Array<string | number>; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt> {
  if (!input.appScopeIDs.length || !input.appScopeIDs.every(supportedScopeId) || new Set(input.appScopeIDs).size !== input.appScopeIDs.length) return { kind: 'unknown' }
  const { payload: envelope, ...authentication } = await applicationEnvelope(input, '/developers/v1/scope/update/', { clientId: input.application.appId, appScopeIDs: input.appScopeIDs, userScopeIDs: [], scopeIds: [], operation: 'add', isDeveloperPanel: true }, signal)
  if (!envelope) return { kind: 'unknown', ...authentication }
  const data = record(envelope.data)
  return { kind: 'accepted', privateState: JSON.stringify(envelope), requiresDataRangeConfiguration: typeof data?.needConfigurePrivilege === 'boolean' ? data.needConfigurePrivilege : null, ...authentication }
}

/** Add only the receiver's exact App event, explicitly carrying the checked native mode. */
export async function addFeishuMessageReception(input: SetupAdapterInput & { privateState: string; privateIntent: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupConfigurationReceipt> {
  if (input.privateIntent !== feishuMessageReceptionIntent()) return { kind: 'unknown' }
  const { payload: envelope, ...authentication } = await applicationEnvelope(input, '/developers/v1/event/update/', { clientId: input.application.appId, events: [], appEvents: [FEISHU_MESSAGE_EVENT], userEvents: [], operation: 'add', eventMode: 4 }, signal)
  return envelope ? { kind: 'accepted', privateState: JSON.stringify(envelope), ...authentication } : { kind: 'unknown', ...authentication }
}

/** Original native create/commit requests. No list lookup or implied publication. */
export async function createFeishuVersion(input: SetupAdapterInput & { privateState: string; privateIntent: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupPublicationReceipt> {
  let body: Record<string, unknown> | null
  try {
    const intent = record(JSON.parse(input.privateIntent)); body = record(intent?.body)
    if (!body || (intent?.kind === 'create-initial-version' ? Object.hasOwn(body, 'autoPublish') : intent?.kind !== 'create-version' || body.autoPublish !== false)) return { kind: 'unknown' }
  } catch { return { kind: 'unknown' } }
  const { payload: envelope, ...authentication } = await applicationEnvelope(input, '/developers/v1/app_version/create/', body, signal), data = record(envelope?.data)
  return envelope && opaque(data?.versionId) ? { kind: 'accepted', privateState: JSON.stringify(envelope), versionId: data.versionId, submission: null, ...authentication } : { kind: 'unknown', ...authentication }
}
export async function submitFeishuVersion(input: SetupAdapterInput & { privateState: string; privateIntent: string; assertCurrent: () => void }, signal?: AbortSignal): Promise<SetupPublicationReceipt> {
  let body: Record<string, unknown> | null, versionId: string
  try {
    const intent = record(JSON.parse(input.privateIntent))
    if (!opaque(intent?.versionId)) return { kind: 'unknown' }
    if (intent.kind === 'submit-initial-version') body = { clientId: input.application.appId }
    else {
      body = record(intent.body)
      if (intent.kind !== 'submit-version' || !body || typeof body.is_full_release !== 'boolean' || Object.keys(body).length !== 1) return { kind: 'unknown' }
    }
    versionId = intent.versionId
  } catch { return { kind: 'unknown' } }
  const { payload: envelope, ...authentication } = await applicationRequest(input, '/developers/v1/publish/commit/' + encodeURIComponent(input.application.appId) + '/' + encodeURIComponent(versionId), body, signal, true)
  return envelope ? { kind: 'accepted', privateState: JSON.stringify(envelope), versionId, submission: feishuSubmissionResponse(record(envelope.data)), ...authentication } : { kind: 'unknown', ...authentication }
}
