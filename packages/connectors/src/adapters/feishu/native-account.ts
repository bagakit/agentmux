import type { ConnectionEnrollmentDiagnostic, ConnectionSetupAccount, ConnectionSetupChallenge } from '@agentmux/core/connections'
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5'
import { parse as parseScript, type Node, type Program } from 'acorn'
import { Cookie, CookieJar, type SerializedCookieJar } from 'tough-cookie'

export const FEISHU_BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
const FEISHU_QR_HEADERS = {
  'user-agent': FEISHU_BROWSER_USER_AGENT,
  'x-app-id': '12', 'x-api-version': '1.0.28', accept: 'application/json', 'content-type': 'application/json',
  'x-locale': 'zh-CN', 'x-terminal-type': '2',
  // Issuer web-client metadata is not the caller's trusted identity.
  'x-device-info': 'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false'
} as const
const INIT = 'https://accounts.feishu.cn/accounts/qrlogin/init'
const POLL = 'https://accounts.feishu.cn/accounts/qrlogin/polling'
const LANDING = 'https://ask.feishu.cn/'
const CONSOLE = 'https://open.feishu.cn/app'
const CONSOLE_HOSTS = ['open.feishu.cn', 'open.larkoffice.com']
const CROSS_LOGIN_HOSTS = ['accounts.feishu.cn', 'ask.feishu.cn']
type Phase = 'poll' | 'cross-login' | 'landing' | 'console' | 'account' | 'expired'
/** Private issuer facts only. The caller owns the intent, actor and any application binding. */
export type NativeAccountState = {
  version: 2; flowKey: string; token: string; cookieJar: SerializedCookieJar; phase: Phase; hops: number
  url?: string; account?: ConnectionSetupAccount; csrf?: string; consoleOrigin?: string
  referer?: string
}
export type NativeAccountInitialState = { version: 1; flowKey: string; token: string; setCookies: string[] }
type AuthenticationDiagnostic = Extract<ConnectionEnrollmentDiagnostic, { stage: 'authentication' }>
type NativeAccountUnknown = { kind: 'unknown'; diagnostic: AuthenticationDiagnostic }
type NativeAccountChallenge = { kind: 'challenge'; challenge: ConnectionSetupChallenge; state: NativeAccountInitialState } | NativeAccountUnknown
type NativeAccountProgress = { kind: 'progress'; stage: 'waiting' | 'scanned' | 'handoff' | 'account' | 'expired'; challenge: ConnectionSetupChallenge | null; account: ConnectionSetupAccount | null; state: NativeAccountState } | NativeAccountUnknown
const unconfirmed = (step: NonNullable<AuthenticationDiagnostic['step']>, failure: NonNullable<AuthenticationDiagnostic['failure']>, httpStatus?: number, nativeCode?: number, boundary?: AuthenticationDiagnostic['boundary']): NativeAccountUnknown => ({ kind: 'unknown', diagnostic: { stage: 'authentication', code: 'native-unconfirmed', step, failure, ...(httpStatus === undefined ? {} : { httpStatus }), ...(nativeCode === undefined ? {} : { nativeCode }), ...(boundary === undefined ? {} : { boundary }) } })
const uncached = (endpoint: string) => endpoint + `?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`
type Ast = Node & Record<string, unknown>
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\u0000-\u001f\u007f]/u.test(v)
const opaque = (v: unknown): v is string => text(v) && !/\s/u.test(v)
function url(value: string, hosts: readonly string[]): URL {
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !hosts.includes(u.hostname)) throw new Error('Unqualified issuer URL')
  return u
}
function consoleUrl(value: string): URL {
  const result = url(value, CONSOLE_HOSTS)
  if (result.pathname !== '/app' || result.search) throw new Error('Unqualified console bootstrap page')
  return result
}
function jar(): CookieJar { return new CookieJar(undefined, { rejectPublicSuffixes: true, prefixSecurity: 'strict', allowSpecialUseDomain: false, allowSecureOnLocal: false }) }
function serialize(cookies: CookieJar): SerializedCookieJar {
  const value = cookies.serializeSync()
  if (!value) throw new Error('Unconfirmed cookie snapshot')
  return value
}
/** Reads the original private protocol formats without accepting a business target or granting one. */
export function readNativeAccountState(snapshot: unknown): { state: NativeAccountState; cookies: CookieJar } {
  const p = record(snapshot)
  if (!p || !opaque(p.flowKey) || !opaque(p.token)) throw new Error('Unknown authentication snapshot')
  if (p.version === 1) {
    if (!Array.isArray(p.setCookies) || !p.setCookies.every(text)) throw new Error('Unknown original cookie snapshot')
    const cookies = jar()
    for (const cookie of p.setCookies) cookies.setCookieSync(cookie, INIT, { ignoreError: true })
    return { state: { version: 2, flowKey: p.flowKey, token: p.token, cookieJar: serialize(cookies), phase: 'poll', hops: 0 }, cookies }
  }
  if (p.version !== 2 || !['poll', 'cross-login', 'landing', 'console', 'account', 'expired'].includes(String(p.phase)) || !Number.isSafeInteger(p.hops) || Number(p.hops) < 0 || Number(p.hops) > 8) throw new Error('Unknown authentication snapshot')
  const original = p as unknown as NativeAccountState
  const state: NativeAccountState = {
    version: 2, flowKey: original.flowKey, token: original.token, cookieJar: original.cookieJar, phase: original.phase, hops: original.hops,
    ...(original.url !== undefined ? { url: original.url } : {}), ...(original.account !== undefined ? { account: original.account } : {}),
    ...(original.csrf !== undefined ? { csrf: original.csrf } : {}), ...(original.consoleOrigin !== undefined ? { consoleOrigin: original.consoleOrigin } : {}),
    ...(original.referer !== undefined ? { referer: url(original.referer, ['accounts.feishu.cn', 'ask.feishu.cn', ...CONSOLE_HOSTS]).href } : {})
  }
  const cookies = CookieJar.deserializeSync(state.cookieJar)
  // Reconstitute through the same strict policy rather than trusting serialized options.
  const strict = jar()
  for (const serialized of serialize(cookies).cookies) {
    const cookie = Cookie.fromJSON(serialized)
    if (!cookie?.domain || !cookie.path) throw new Error('Unknown stored cookie scope')
    strict.setCookieSync(cookie, `https://${cookie.domain.replace(/^\./u, '')}${cookie.path}`)
  }
  return { state, cookies: strict }
}

/** Authentication initialization only; it never creates or selects an application. */
export async function beginFeishuNativeAccount(signal?: AbortSignal): Promise<NativeAccountChallenge> {
  let failure: NonNullable<AuthenticationDiagnostic['failure']> = 'transport-unconfirmed', httpStatus: number | undefined
  let boundary: AuthenticationDiagnostic['boundary']
  try {
    // Bound this observation only; the durable caller keeps the original unknown intent.
    const bounded = AbortSignal.timeout(20_000)
    const response = await fetch(uncached(INIT), {
      method: 'POST', redirect: 'manual', signal: signal ? AbortSignal.any([signal, bounded]) : bounded, headers: FEISHU_QR_HEADERS,
      body: JSON.stringify({ biz_type: null, redirect_uri: LANDING })
    })
    httpStatus = response.status
    if (!response.ok || response.status >= 300) return unconfirmed('initialize', 'http-status', httpStatus)
    failure = 'invalid-response'
    boundary = 'json'
    const body = record(await response.json())
    boundary = 'envelope'
    const data = record(body?.data), step = record(data?.step_info)
    const flowKey = response.headers.get('x-flow-key')
    const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u0020\u007f]/u.test(value)
    if (Number.isSafeInteger(body?.code) && body!.code !== 0) return unconfirmed('initialize', 'platform-error', httpStatus, Number(body!.code))
    if (body?.code !== 0 || !token(step?.token) || !token(flowKey)) return unconfirmed('initialize', failure, httpStatus, undefined, boundary)
    const challenge = { qrPayload: JSON.stringify({ qrlogin: { token: step.token } }), expiresAt: null, nextPollAt: Date.now() + 1500 }
    return { kind: 'challenge', challenge, state: { version: 1, flowKey, token: step.token, setCookies: response.headers.getSetCookie() } }
  } catch { return unconfirmed('initialize', failure, httpStatus, undefined, boundary) }
}

function alias(p: Record<string, unknown>, names: readonly string[]): string {
  const values = names.filter(n => Object.hasOwn(p, n)).map(n => p[n])
  if (values.some(v => !text(v)) || new Set(values).size > 1 || values.length === 0) throw new Error('Unknown bootstrap identity')
  return values[0] as string
}
function label(values: unknown[]): string | undefined {
  return values.length && values.every(text) && new Set(values).size === 1 ? values[0] as string : undefined
}
function display(p: Record<string, unknown>, names: readonly string[]): unknown[] {
  return names.filter(name => Object.hasOwn(p, name)).map(name => p[name])
}
function account(value: unknown): ConnectionSetupAccount {
  const p = record(value); if (!p) throw new Error('Unknown bootstrap identity')
  const userId = alias(p, ['id', 'userId', 'user_id']), tenantId = alias(p, ['tenantId', 'tenant_id'])
  if (!opaque(userId) || !opaque(tenantId)) throw new Error('Unknown bootstrap identifiers')
  const userName = label([...display(p, ['name', 'userName', 'user_name']), ...display(record(p.displayName) ?? {}, ['value'])])
  const tenantName = label([...display(record(p.tenantDisplayName) ?? {}, ['value']), ...display(p, ['tenantName', 'tenant_name'])])
  return { userId, tenantId, ...(userName ? { userName } : {}), ...(tenantName ? { tenantName } : {}) }
}
function nodes(value: unknown): Ast[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  const p = record(value); if (!p || typeof p.type !== 'string') return []
  return [p as unknown as Ast, ...Object.values(p).flatMap(nodes)]
}
function isWindow(value: unknown): boolean { const p = record(value); return p?.type === 'Identifier' && p.name === 'window' }
/** Program bindings persist across scripts; declarations inside functions do not. */
function scriptBindings(program: Program): void {
  function hoisted(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hoisted)
    const n = record(value)
    if (!n || ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(String(n.type))) return false
    if (n.type === 'VariableDeclaration' && n.kind === 'var' && (n.declarations as Ast[]).some(d => nodes(d.id).some(isWindow))) return true
    return Object.values(n).some(hoisted)
  }
  for (const statement of program.body as unknown as Ast[]) {
    const expression = record(statement.expression)
    if (statement.type === 'VariableDeclaration' && (statement.declarations as Ast[]).some(d => nodes(d.id).some(isWindow)) || ['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type) && isWindow(statement.id)) throw new Error('Shadowed bootstrap binding')
    if (expression?.type === 'AssignmentExpression' && isWindow(expression.left)) throw new Error('Replaced bootstrap binding')
  }
  if (hoisted(program)) throw new Error('Shadowed bootstrap binding')
}
function bootstrap(html: string): { account: ConnectionSetupAccount; csrf: string } {
  const candidates: { key: 'user' | 'csrfToken'; value: unknown }[] = []
  function script(source: string): void {
    let ast: Program
    try { ast = parseScript(source, { ecmaVersion: 'latest', sourceType: 'script' }) } catch { throw new Error('Unknown console bootstrap syntax') }
    scriptBindings(ast)
    let statements = ast.body.filter(s => s.type !== 'EmptyStatement' && s.type !== 'FunctionDeclaration') as unknown as Ast[]
    const expression = statements.length === 1 ? record(statements[0]!.expression) : null
    const callee = record(expression?.callee)
    const initializer = expression?.type === 'CallExpression' && callee?.type === 'FunctionExpression'
    if (initializer && record(callee.body)?.type === 'BlockStatement') statements = record(callee.body)!.body as Ast[]
    const binding = (statement: Ast) => statement.type === 'VariableDeclaration' && (statement.declarations as Ast[]).some(d => nodes(d.id).some(isWindow))
    if (initializer && !statements.some(binding) && statements.some(s => record(s.expression)?.type === 'AssignmentExpression' && isWindow(record(s.expression)?.left))) throw new Error('Replaced bootstrap binding')
    const hasIdentity = statements.some(s => {
      const e = record(s.expression), left = record(e?.left), property = record(left?.property)
      return e?.type === 'AssignmentExpression' && left?.type === 'MemberExpression' && isWindow(left.object) && ['user', 'csrfToken'].includes(String(left.computed ? property?.value : property?.name))
    })
    if (!hasIdentity) return
    if (initializer) {
      // Only the sourced literal initializer supplies identity; no code is executed.
      if (callee.id || callee.async || callee.generator || !Array.isArray(callee.params) || callee.params.length || !Array.isArray(expression.arguments) || expression.arguments.length || record(callee.body)?.type !== 'BlockStatement') throw new Error('Unqualified console initializer')
    }
    const assigned = new Set<string>()
    for (const s of statements) {
      if (s.type === 'EmptyStatement' || s.type === 'FunctionDeclaration') continue
      const e = record(s.expression), left = record(e?.left), property = record(left?.property), key = String(property?.name)
      if (s.type !== 'ExpressionStatement' || e?.type !== 'AssignmentExpression' || e.operator !== '=' || left?.type !== 'MemberExpression' || !isWindow(left.object) || left.computed || !key || ['user', 'csrfToken'].includes(key) && assigned.has(key)) throw new Error('Unqualified console bootstrap program')
      const right = record(e.right); if (!right) throw new Error('Unknown console bootstrap literal')
      for (const node of (key === 'user' ? nodes(right) : []).filter(n => n.type === 'ObjectExpression')) {
        const keys = (node.properties as Ast[]).map(p => record(p.key)?.value)
        if (new Set(keys).size !== keys.length) throw new Error('Duplicate console bootstrap field')
      }
      const value: unknown = !initializer && key === 'csrfToken' && right.type === 'Literal' ? right.value : JSON.parse(source.slice(Number(right.start), Number(right.end)))
      if (key === 'user' && right.type !== 'ObjectExpression' || key === 'csrfToken' && (right.type !== 'Literal' || !opaque(value))) throw new Error('Unknown console bootstrap literal')
      assigned.add(key)
      if (key === 'user' || key === 'csrfToken') candidates.push({ key, value })
    }
    if (initializer && (!assigned.has('user') || !assigned.has('csrfToken'))) throw new Error('Incomplete console initializer')
  }
  function visit(node: DefaultTreeAdapterTypes.Node): void {
    if ('tagName' in node) {
      if (['template', 'noscript'].includes(node.tagName)) return
      if (node.tagName === 'script') {
        if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return
        const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value])), type = attrs.type?.trim().toLowerCase()
        if (Object.hasOwn(attrs, 'src') || Object.hasOwn(attrs, 'nomodule') || type && !['text/javascript', 'application/javascript'].includes(type)) return
        script(node.childNodes.filter(n => n.nodeName === '#text').map(n => (n as DefaultTreeAdapterTypes.TextNode).value).join(''))
        return
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child)
  }
  visit(parseHtml(html, { scriptingEnabled: true }))
  const users = candidates.filter(c => c.key === 'user').map(c => account(c.value)), tokens = candidates.filter(c => c.key === 'csrfToken').map(c => c.value)
  if (!users.length || !tokens.length || new Set(users.map(u => JSON.stringify([u.userId, u.tenantId]))).size !== 1 || new Set(tokens).size !== 1) throw new Error('Missing or conflicting console bootstrap')
  const userName = label(users.map(u => u.userName)), tenantName = label(users.map(u => u.tenantName))
  return { account: { userId: users[0]!.userId, tenantId: users[0]!.tenantId, ...(userName ? { userName } : {}), ...(tenantName ? { tenantName } : {}) }, csrf: tokens[0] as string }
}
export async function readNativeAccountResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error('Missing console document')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 2 * 1024 * 1024) throw new Error('Unconfirmed console document'); chunks.push(next.value) }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
/** One native request only. Its next URL and cookies are returned privately for the next durable action. */
export async function advanceFeishuNativeAccount(snapshot: unknown, signal?: AbortSignal): Promise<NativeAccountProgress> {
  let step: NonNullable<AuthenticationDiagnostic['step']> = 'account', failure: NonNullable<AuthenticationDiagnostic['failure']> = 'invalid-state', httpStatus: number | undefined
  let boundary: AuthenticationDiagnostic['boundary'] = 'saved-state'
  const failed = (reason = failure, nativeCode?: number) => unconfirmed(step, reason, httpStatus, nativeCode, boundary)
  try {
    const { state, cookies } = readNativeAccountState(snapshot)
    if (['account', 'expired'].includes(state.phase)) return failed()
    step = state.phase as typeof step
    failure = 'redirect-unconfirmed'; boundary = 'request-target'
    const hosts = state.phase === 'poll' ? ['accounts.feishu.cn'] : state.phase === 'cross-login' ? CROSS_LOGIN_HOSTS : state.phase === 'landing' ? ['ask.feishu.cn'] : CONSOLE_HOSTS
    const target = url(state.phase === 'poll' ? uncached(POLL) : state.url ?? '', hosts)
    if (state.phase === 'console') consoleUrl(target.href)
    const headers: Record<string, string> = state.phase === 'poll' ? { ...FEISHU_QR_HEADERS, 'x-flow-key': state.flowKey } : { accept: 'text/html', 'user-agent': FEISHU_BROWSER_USER_AGENT }
    if (state.referer) headers.referer = state.referer
    boundary = 'saved-state'
    const cookie = cookies.getCookieStringSync(target.href); if (cookie) headers.cookie = cookie
    const bounded = AbortSignal.timeout(20_000)
    failure = 'transport-unconfirmed'; boundary = undefined
    const response = await fetch(target.href, { method: state.phase === 'poll' ? 'POST' : 'GET', redirect: 'manual', headers, ...(state.phase === 'poll' ? { body: JSON.stringify({ biz_type: null }) } : {}), signal: signal ? AbortSignal.any([signal, bounded]) : bounded })
    httpStatus = response.status; failure = 'invalid-response'; boundary = 'response-target'
    if (response.url && new URL(response.url).href !== target.href) return failed()
    boundary = 'cookie-update'
    for (const value of response.headers.getSetCookie()) cookies.setCookieSync(value, target.href, { ignoreError: true })
    let stage: 'waiting' | 'scanned' | 'handoff' | 'account' | 'expired' = 'handoff'
    if (response.status >= 300 && response.status < 400) {
      failure = 'redirect-unconfirmed'; boundary = 'handoff'
      if (state.phase === 'poll' || ++state.hops > 8) return failed()
      const location = response.headers.get('location'); if (!location) return failed()
      state.url = url(new URL(location, target).href, hosts).href
      state.referer = target.href
      if (state.phase === 'console') consoleUrl(state.url)
    } else {
      boundary = undefined
      if (!response.ok) return failed('http-status')
      state.hops = 0
      if (state.phase === 'poll') {
        boundary = 'json'
        const body = record(await response.json())
        boundary = 'envelope'
        const data = record(body?.data), info = record(data?.step_info)
        if (Number.isSafeInteger(body?.code) && body!.code !== 0) return failed('platform-error', Number(body!.code))
        if (body?.code !== 0 || !data || data.step_info != null && !info) return failed()
        boundary = 'transition'
        const polling = data.next_step === null || data.next_step === 'qr_login_polling'
        if (polling && info?.status === 5) { state.phase = 'expired'; stage = 'expired' }
        else if (data.next_step === 'enter_app') {
          // Cross-login is optional; the fixed landing and console still prove the account.
          boundary = 'handoff'
          if (info?.cross_login_uri === undefined || info.cross_login_uri === null) {
            state.url = LANDING; state.phase = 'landing'; state.referer = target.href
          } else {
            if (!text(info.cross_login_uri)) return failed()
            failure = 'redirect-unconfirmed'
            state.url = url(info.cross_login_uri, CROSS_LOGIN_HOSTS).href; state.phase = 'cross-login'
          }
        } else if (polling && info && Number.isSafeInteger(info.status) && [1, 2].includes(Number(info.status))) stage = info.status === 2 ? 'scanned' : 'waiting'
        else return failed()
      } else if (state.phase === 'cross-login') {
        // Finish the cross-login chain before the original fixed landing, even on the same host.
        state.phase = 'landing'; state.url = LANDING; state.referer = target.href
      }
      else if (state.phase === 'landing') { state.phase = 'console'; state.url = CONSOLE; state.referer = target.href }
      else {
        boundary = 'bootstrap'
        if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') return failed()
        failure = 'bootstrap-unconfirmed'
        const identity = bootstrap(await readNativeAccountResponse(response)); state.account = identity.account; state.csrf = identity.csrf; state.consoleOrigin = target.origin; state.phase = 'account'; stage = 'account'
      }
    }
    failure = 'invalid-response'; boundary = 'snapshot'
    state.cookieJar = serialize(cookies)
    const challenge = state.phase === 'poll' ? { qrPayload: JSON.stringify({ qrlogin: { token: state.token } }), expiresAt: null, nextPollAt: Date.now() + 1500 } : null
    return { kind: 'progress', stage, challenge, account: stage === 'account' ? state.account! : null, state }
  } catch { return failed() }
}
