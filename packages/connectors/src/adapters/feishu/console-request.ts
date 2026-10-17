import type { ConnectionEnrollmentDiagnostic } from '@agentmux/core/connections'
import { FEISHU_BROWSER_USER_AGENT, isFeishuConsoleOrigin, readNativeAccountResponse, type NativeAccountState } from './native-account.js'
import type { CookieJar } from 'tough-cookie'

type Input = { state: NativeAccountState; cookies: CookieJar; path: string; referer?: string; body: Record<string, unknown> | FormData; assertCurrent?: () => void; developerPanel?: boolean }
export type ConsoleReply = ({ kind: 'response'; payload: Record<string, unknown>; httpStatus: number } | { kind: 'unknown'; diagnostic: ConnectionEnrollmentDiagnostic }) & { authentication?: NativeAccountState }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** One same-origin console request. Native results and Cookie continuation remain separate facts. */
export async function requestFeishuConsole(input: Input, signal?: AbortSignal): Promise<ConsoleReply> {
  const unknown = (diagnostic: ConnectionEnrollmentDiagnostic, authentication?: NativeAccountState): ConsoleReply => ({ kind: 'unknown', diagnostic, ...(authentication ? { authentication } : {}) })
  if (signal?.aborted) return unknown({ stage: 'request', code: 'cancelled' })
  const { state, cookies } = input, origin = state.consoleOrigin
  const invalidState = () => unknown({ stage: 'preparation', code: 'invalid-state' })
  if (!isFeishuConsoleOrigin(origin) || state.phase !== 'account' || !state.csrf || !state.account) return invalidState()
  let target: URL, referer: URL
  try {
    target = new URL(input.path, origin)
    const source = input.referer ?? state.url
    if (!source) return invalidState()
    referer = new URL(source, origin)
  } catch { return invalidState() }
  if (target.origin !== origin || target.username || target.password || referer.origin !== origin || referer.username || referer.password) return invalidState()
  target.hash = ''
  referer.hash = ''
  const multipart = input.body instanceof FormData
  const headers: Record<string, string> = { accept: 'application/json, text/plain, */*', 'user-agent': FEISHU_BROWSER_USER_AGENT, origin, referer: referer.href, 'x-csrf-token': state.csrf, 'X-Timezone-Offset': String(new Date().getTimezoneOffset()) }
  if (!multipart) headers['content-type'] = 'application/json'
  if (input.developerPanel) headers['X-AppPlatform-RequestFrom'] = 'develop_panel'
  const cookie = cookies.getCookieStringSync(target.href); if (cookie) headers.cookie = cookie
  const bounded = AbortSignal.timeout(20_000)
  input.assertCurrent?.()
  let response: Response
  try { response = await fetch(target.href, { method: 'POST', redirect: 'manual', headers, body: multipart ? input.body as FormData : JSON.stringify(input.body), signal: signal ? AbortSignal.any([signal, bounded]) : bounded }) }
  catch { return unknown({ stage: 'request', code: signal?.aborted ? 'cancelled' : 'transport-unconfirmed' }) }
  const invalid = (): ConsoleReply => unknown({ stage: 'response', code: 'invalid-response', httpStatus: response.status })
  try { if (response.redirected || response.url && new URL(response.url).href !== target.href) return invalid() } catch { return invalid() }
  let authentication: NativeAccountState | undefined
  // Cookie rejection is scoped to that Cookie; it does not revoke this response's business receipt.
  try {
    let changed = false
    for (const value of response.headers.getSetCookie()) if (cookies.setCookieSync(value, target.href, { ignoreError: true })) changed = true
    const cookieJar = changed ? cookies.serializeSync() : undefined
    if (cookieJar) authentication = { ...state, cookieJar }
  } catch { /* This response's platform result survives an unconfirmed local Cookie continuation. */ }
  const reject = (code: Extract<ConnectionEnrollmentDiagnostic, { stage: 'response' }>['code']): ConsoleReply => unknown({ stage: 'response', code, httpStatus: response.status }, authentication)
  if (!response.ok) return reject('http-status')
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return reject('invalid-response')
  let payload: Record<string, unknown> | null
  try { payload = record(JSON.parse(await readNativeAccountResponse(response))) } catch { return reject('invalid-json') }
  if (!payload || !Number.isSafeInteger(payload.code)) return reject('invalid-response')
  return payload.code === 0 ? { kind: 'response', payload, httpStatus: response.status, ...(authentication ? { authentication } : {}) } : reject('platform-error')
}
