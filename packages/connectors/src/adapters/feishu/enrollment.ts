import type { ConnectionEnrollmentDiagnostic } from '@agentmux/core/connections'
import type { ConnectionEnrollmentAdapter, EnrollmentAdapterInput, EnrollmentUnknownReceipt } from '../../connection-enrollment-adapter.js'
import { beginFeishuNativeAccount, advanceFeishuNativeAccount, isFeishuConsoleOrigin, readNativeAccountState } from './native-account.js'
import { requestFeishuConsole } from './console-request.js'
import { FEISHU_ENROLLMENT_PROTOCOL } from './enrollment-protocol.js'
export { FEISHU_ENROLLMENT_PROTOCOL } from './enrollment-protocol.js'

const DOMAIN = 'open.feishu.cn'
type State = { version: 1; authentication: unknown; avatar?: { url: string; width: number; height: number }; appId?: string }
type Session = { value: State; native: ReturnType<typeof readNativeAccountState>['state']; cookies: ReturnType<typeof readNativeAccountState>['cookies'] }
type Reply = { kind: 'response'; payload: Record<string, unknown>; httpStatus: number } | EnrollmentUnknownReceipt
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
const opaque = (value: unknown): value is string => text(value) && !/\s/u.test(value)
const applicationId = (value: unknown): value is string => typeof value === 'string' && /^cli_[A-Za-z0-9._:-]+$/u.test(value)
const unknown = (diagnostic: ConnectionEnrollmentDiagnostic): EnrollmentUnknownReceipt => ({ kind: 'unknown', diagnostic })
const preparation = (code: 'invalid-state' | 'invalid-image' | 'unsupported-domain' | 'invalid-application') => unknown({ stage: 'preparation', code })
const invalidResponse = (httpStatus: number) => unknown({ stage: 'response', code: 'invalid-response', httpStatus })

function imageUrl(value: unknown): value is string {
  if (!text(value)) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash } catch { return false }
}
function snapshot(value: string): Session | null {
  try {
    const p = record(JSON.parse(value)), avatar = p?.avatar === undefined ? null : record(p.avatar)
    if (!p || p.version !== 1 || Object.keys(p).some(key => !['version', 'authentication', 'avatar', 'appId'].includes(key)) ||
      p.appId !== undefined && !applicationId(p.appId) || p.avatar !== undefined && (!avatar || !imageUrl(avatar.url) || !Number.isSafeInteger(avatar.width) || Number(avatar.width) <= 0 || !Number.isSafeInteger(avatar.height) || Number(avatar.height) <= 0)) return null
    const native = readNativeAccountState(p.authentication)
    return { native: native.state, cookies: native.cookies, value: { version: 1, authentication: native.state,
      ...(avatar ? { avatar: { url: avatar.url as string, width: avatar.width as number, height: avatar.height as number } } : {}), ...(p.appId === undefined ? {} : { appId: p.appId as string }) } }
  } catch { return null }
}
function authenticated(input: EnrollmentAdapterInput & { privateState: string }): Session | EnrollmentUnknownReceipt {
  if (input.domain !== DOMAIN) return preparation('unsupported-domain')
  const saved = snapshot(input.privateState), native = saved?.native
  if (!saved || !native || native.phase !== 'account' || !native.account || !opaque(native.account.userId) || !opaque(native.account.tenantId) || !opaque(native.csrf) || !isFeishuConsoleOrigin(native.consoleOrigin)) return preparation('invalid-state')
  return saved
}
/** Only this owner interprets its Enrollment wrapper; no foreign Setup binding is stripped. */
export function enrollmentAccountSession(privateState: string, application: { domain: string; appId: string }): Session['native'] | null {
  const saved = snapshot(privateState), native = saved?.native
  return application.domain === DOMAIN && saved?.value.appId === application.appId && native?.phase === 'account' && native.account && opaque(native.account.userId) && opaque(native.account.tenantId) && opaque(native.csrf) && isFeishuConsoleOrigin(native.consoleOrigin) ? native : null
}
function png(value: string): { bytes: Buffer; width: number; height: number } | null {
  // Reuse the original profile PNG boundary; scale follows the actual IHDR, not a fixed icon size.
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value) || (value.length - 22) % 4 || value.length > Math.ceil(512 * 1024 / 3) * 4 + 22) return null
  const encoded = value.slice(22), bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded || bytes.length < 33 || bytes.length > 512 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  return width && height ? { bytes, width, height } : null
}

/** One original console request. The Host owns consent, durable claims and original result recovery. */
async function request(input: EnrollmentAdapterInput, saved: Session, path: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<Reply> {
  const { authentication, ...response } = await requestFeishuConsole({ state: saved.native, cookies: saved.cookies, path, body, assertCurrent: input.assertCurrent }, signal)
  if (authentication) saved.value.authentication = authentication
  return response
}

/** The current console template route is frozen by the original Host; old intents retain their original route. */
export function createFeishuEnrollment(): ConnectionEnrollmentAdapter {
  return {
    protocolId: FEISHU_ENROLLMENT_PROTOCOL,
    domains: [{ domain: DOMAIN, label: 'Feishu' }],
    async begin(input, signal) {
      if (input.domain !== DOMAIN) return preparation('unsupported-domain')
      if (signal?.aborted) return unknown({ stage: 'request', code: 'cancelled' })
      input.assertCurrent()
      const result = await beginFeishuNativeAccount(signal)
      return result.kind === 'challenge' ? { kind: 'authentication', stage: 'waiting', challenge: result.challenge, account: null, privateState: JSON.stringify({ version: 1, authentication: result.state } satisfies State) } : result
    },
    async advance(input, signal) {
      if (input.domain !== DOMAIN) return preparation('unsupported-domain')
      const saved = snapshot(input.privateState); if (!saved || saved.value.avatar || saved.value.appId) return preparation('invalid-state')
      if (signal?.aborted) return unknown({ stage: 'request', code: 'cancelled' })
      input.assertCurrent()
      const result = await advanceFeishuNativeAccount(saved.value.authentication, signal)
      return result.kind === 'progress' ? { kind: 'authentication', stage: result.stage, challenge: result.challenge, account: result.account, privateState: JSON.stringify({ ...saved.value, authentication: result.state }) } : result
    },
    async upload(input, signal) {
      const saved = authenticated(input); if ('kind' in saved) return saved
      if (saved.value.avatar || saved.value.appId) return preparation('invalid-state')
      const image = png(input.pngDataUrl); if (!image) return preparation('invalid-image')
      const body = new FormData()
      body.append('file', new Blob([new Uint8Array(image.bytes)], { type: 'image/png' }), 'icon.png')
      body.append('uploadType', '4'); body.append('isIsv', 'false'); body.append('scale', JSON.stringify({ width: image.width, height: image.height }))
      const response = await request(input, saved, '/developers/v1/app/upload/image', body, signal)
      if (response.kind === 'unknown') return response
      const data = record(response.payload.data); if (!data || !imageUrl(data.url)) return invalidResponse(response.httpStatus)
      return { kind: 'uploaded', privateState: JSON.stringify({ ...saved.value, avatar: { url: data.url, width: image.width, height: image.height } }) }
    },
    async create(input, signal) {
      const saved = authenticated(input); if ('kind' in saved) return saved
      if (!saved.value.avatar || saved.value.appId || !text(input.preset.name) || input.preset.description !== undefined && (typeof input.preset.description !== 'string' || input.preset.description.includes('\0'))) return preparation('invalid-state')
      if (input.protocolId !== undefined && input.protocolId !== FEISHU_ENROLLMENT_PROTOCOL) return preparation('invalid-state')
      const name = input.preset.name, description = input.preset.description ?? ''
      const template = input.protocolId === FEISHU_ENROLLMENT_PROTOCOL
      const body = template
        ? { appManifestTemplateID: 'developer_console', createAppUserCustomField: { i18n: { zh_cn: { name, description } }, avatar: saved.value.avatar.url, primaryLang: 'zh_cn' }, cid: input.attemptId, HTTPHead: {} }
        : { appSceneType: 0, name, desc: description, avatar: saved.value.avatar.url, i18n: { zh_cn: { name, description } }, primaryLang: 'zh_cn' }
      const response = await request(input, saved, template ? '/developers/v1/manifest/upsert_by_template' : '/developers/v1/app/create', body, signal)
      if (response.kind === 'unknown') return response
      const data = record(response.payload.data)
      const values = template ? [data, response.payload].flatMap(p => p ? ['ClientID', 'clientID', 'clientId', 'appId'].filter(key => Object.hasOwn(p, key)).map(key => p[key]) : []) : [data?.ClientID]
      if (!values.length || values.some(value => !applicationId(value)) || new Set(values).size !== 1) return invalidResponse(response.httpStatus)
      const appId = values[0] as string
      return { kind: 'created', application: { domain: DOMAIN, appId }, privateState: JSON.stringify({ ...saved.value, appId }) }
    },
    async credential(input, signal) {
      const saved = authenticated(input); if ('kind' in saved) return saved
      // A known creation receipt can precede its private snapshot ACK. The original Host owns that exact application.
      if (input.application.domain !== DOMAIN || !applicationId(input.application.appId) || saved.value.appId !== undefined && input.application.appId !== saved.value.appId) return preparation('invalid-application')
      const response = await request(input, saved, '/developers/v1/secret/' + encodeURIComponent(input.application.appId), {}, signal)
      if (response.kind === 'unknown') return response
      const data = response.payload.data === undefined || response.payload.data === null ? null : record(response.payload.data)
      if (response.payload.data !== undefined && response.payload.data !== null && !data) return invalidResponse(response.httpStatus)
      const values = [data, response.payload].filter(p => p && Object.hasOwn(p, 'secret')).map(p => p!.secret)
      if (!values.length || values.some(value => !text(value)) || new Set(values).size !== 1) return invalidResponse(response.httpStatus)
      return { kind: 'credential', secret: values[0] as string, privateState: JSON.stringify({ ...saved.value, appId: input.application.appId }) }
    }
  }
}
