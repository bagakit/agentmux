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
const CONSOLE_FLOW_HOSTS = [...CROSS_LOGIN_HOSTS, ...CONSOLE_HOSTS, 'accounts.larkoffice.com', 'login.feishu.cn']
export function isFeishuConsoleOrigin(value: unknown): value is string {
  return typeof value === 'string' && CONSOLE_HOSTS.some(host => value === `https://${host}`)
}
// Match Fetch's finite redirect observation budget; this is not a platform login limit.
const redirectLimit = (phase: unknown) => phase === 'console' ? 20 : 8
type Phase = 'poll' | 'cross-login' | 'landing' | 'console' | 'account' | 'expired'
/** Private issuer facts only. The caller owns the intent, actor and any application binding. */
export type NativeAccountState = {
  version: 2; flowKey: string; token: string; cookieJar: SerializedCookieJar; phase: Phase; hops: number
  url?: string; account?: ConnectionSetupAccount; csrf?: string; consoleOrigin?: string
  referer?: string
}
export type NativeAccountInitialState = { version: 1; flowKey: string; token: string; setCookies: string[] }
type AuthenticationDiagnostic = Extract<ConnectionEnrollmentDiagnostic, { stage: 'authentication' }>
type RedirectReason = NonNullable<AuthenticationDiagnostic['redirectReason']>
type NativeAccountUnknown = { kind: 'unknown'; diagnostic: AuthenticationDiagnostic }
type NativeAccountChallenge = { kind: 'challenge'; challenge: ConnectionSetupChallenge; state: NativeAccountInitialState } | NativeAccountUnknown
type NativeAccountProgress = { kind: 'progress'; stage: 'waiting' | 'scanned' | 'handoff' | 'account' | 'expired'; challenge: ConnectionSetupChallenge | null; account: ConnectionSetupAccount | null; state: NativeAccountState } | NativeAccountUnknown
const unconfirmed = (step: NonNullable<AuthenticationDiagnostic['step']>, failure: NonNullable<AuthenticationDiagnostic['failure']>, httpStatus?: number, nativeCode?: number, boundary?: AuthenticationDiagnostic['boundary'], redirectReason?: RedirectReason): NativeAccountUnknown => ({ kind: 'unknown', diagnostic: { stage: 'authentication', code: 'native-unconfirmed', step, failure, ...(httpStatus === undefined ? {} : { httpStatus }), ...(nativeCode === undefined ? {} : { nativeCode }), ...(boundary === undefined ? {} : { boundary }), ...(redirectReason === undefined || failure !== 'redirect-unconfirmed' ? {} : { redirectReason }) } })
const uncached = (endpoint: string) => endpoint + `?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`
type Ast = Node & Record<string, unknown>
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\u0000-\u001f\u007f]/u.test(v)
const opaque = (v: unknown): v is string => text(v) && !/\s/u.test(v)
class NativeRedirectError extends Error {
  constructor(readonly reason: RedirectReason) { super('Unqualified issuer redirect') }
}
function url(value: string, hosts: readonly string[], normalizeFragment = false, base?: URL): URL {
  let u: URL
  try { u = new URL(value, base) } catch { throw new NativeRedirectError('invalid-url') }
  if (u.protocol !== 'https:') throw new NativeRedirectError('unsupported-scheme')
  if (u.username || u.password) throw new NativeRedirectError('url-credentials')
  if (u.port) throw new NativeRedirectError('unexpected-port')
  if (normalizeFragment) u.hash = ''
  else if (u.hash) throw new NativeRedirectError('unexpected-fragment')
  if (!hosts.includes(u.hostname)) throw new NativeRedirectError('unexpected-host')
  return u
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
  if (p.version !== 2 || !['poll', 'cross-login', 'landing', 'console', 'account', 'expired'].includes(String(p.phase)) || !Number.isSafeInteger(p.hops) || Number(p.hops) < 0 || Number(p.hops) > redirectLimit(p.phase)) throw new Error('Unknown authentication snapshot')
  const original = p as unknown as NativeAccountState
  const state: NativeAccountState = {
    version: 2, flowKey: original.flowKey, token: original.token, cookieJar: original.cookieJar, phase: original.phase, hops: original.hops,
    ...(original.url !== undefined ? { url: original.url } : {}), ...(original.account !== undefined ? { account: original.account } : {}),
    ...(original.csrf !== undefined ? { csrf: original.csrf } : {}), ...(original.consoleOrigin !== undefined ? { consoleOrigin: original.consoleOrigin } : {}),
    ...(original.referer !== undefined ? { referer: url(original.referer, original.phase === 'console' || original.phase === 'account' ? CONSOLE_FLOW_HOSTS : [...CROSS_LOGIN_HOSTS, ...CONSOLE_HOSTS]).href } : {})
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
function nodes(value: unknown, includeLocalScopes = true): Ast[] {
  if (Array.isArray(value)) return value.flatMap(item => nodes(item, includeLocalScopes))
  const p = record(value); if (!p || typeof p.type !== 'string') return []
  if (!includeLocalScopes) {
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(p.type)) return []
    if (p.type === 'BlockStatement' && (p.body as Ast[]).some(statement => windowBinding(statement) && statement.kind !== 'var')) return []
    if (p.type === 'CallExpression' && ['FunctionExpression', 'ArrowFunctionExpression'].includes(String(record(p.callee)?.type))) {
      const callee = record(p.callee)!, body = record(callee.body), local = body?.type === 'BlockStatement' ? body.body as Ast[] : []
      const parameterShadowed = isWindow(callee.id) || (callee.params as unknown[]).some(bindsWindow)
      const bodyShadowed = parameterShadowed || local.some(windowBinding) || hoistedWindow(local)
      return [p as Ast, ...nodes(p.arguments, false), ...(parameterShadowed ? [] : nodes(callee.params, false)), ...(bodyShadowed ? [] : nodes(callee.body, false))]
    }
    if (p.type === 'ClassDeclaration' || p.type === 'ClassExpression') {
      const members = record(p.body)?.body as Ast[]
      const active = isWindow(p.id) ? [] : members.flatMap(member => {
        if (member.type === 'StaticBlock') return (member.body as Ast[]).some(windowBinding) || hoistedWindow(member.body) ? [] : nodes(member.body, false)
        const key = member.computed ? nodes(member.key, false) : []
        return member.static ? [...key, ...nodes(member.value, false)] : key
      })
      return [p as Ast, ...nodes(p.superClass, false), ...active]
    }
  }
  return [p as Ast, ...Object.values(p).flatMap(item => nodes(item, includeLocalScopes))]
}
function isWindow(value: unknown): boolean { const p = record(value); return p?.type === 'Identifier' && p.name === 'window' }
function bindsWindow(value: unknown): boolean {
  const pattern = record(value); if (!pattern) return false
  if (pattern.type === 'Identifier') return isWindow(pattern)
  if (pattern.type === 'ObjectPattern') return (pattern.properties as Ast[]).some(property => bindsWindow(property.type === 'RestElement' ? property.argument : property.value))
  if (pattern.type === 'ArrayPattern') return (pattern.elements as unknown[]).some(bindsWindow)
  return pattern.type === 'AssignmentPattern' ? bindsWindow(pattern.left) : pattern.type === 'RestElement' && bindsWindow(pattern.argument)
}
function windowBinding(statement: Ast): boolean {
  return statement.type === 'VariableDeclaration' && (statement.declarations as Ast[]).some(d => bindsWindow(d.id)) || ['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type) && isWindow(statement.id)
}
function hoistedWindow(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hoistedWindow)
  const n = record(value)
  if (!n || ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(String(n.type))) return false
  if (n.type === 'VariableDeclaration' && n.kind === 'var' && windowBinding(n as Ast)) return true
  return Object.values(n).some(hoistedWindow)
}
/** Program bindings persist across scripts; declarations inside functions do not. */
function scriptBindings(program: Program): void {
  for (const statement of program.body as unknown as Ast[]) {
    if (windowBinding(statement)) throw new Error('Shadowed bootstrap binding')
    if (nodes(statement, false).some(node => node.type === 'AssignmentExpression' && isWindow(node.left))) throw new Error('Replaced bootstrap binding')
  }
  if (hoistedWindow(program)) throw new Error('Shadowed bootstrap binding')
}
function identityField(value: unknown): 'user' | 'csrfToken' | null {
  const member = record(value); if (member?.type !== 'MemberExpression') return null
  const property = record(member.property), key = member.computed ? property?.value : property?.name
  if (isWindow(member.object)) return key === 'user' || key === 'csrfToken' ? key : null
  const parent = record(member.object)
  if (parent?.type === 'MemberExpression' && isWindow(parent.object)) {
    const root = record(parent.property), field = parent.computed ? root?.value : root?.name
    if (field === 'user') return typeof key !== 'string' || ['id', 'userId', 'user_id', 'tenantId', 'tenant_id'].includes(key) ? 'user' : null
  }
  const ancestor = identityField(member.object)
  return ancestor === 'user' ? 'user' : null
}
function bootstrap(html: string): { account: ConnectionSetupAccount; csrf: string } {
  const candidates: { key: 'user' | 'csrfToken'; value: unknown }[] = []
  function script(source: string): void {
    let ast: Program
    try { ast = parseScript(source, { ecmaVersion: 'latest', sourceType: 'script' }) } catch { return }
    scriptBindings(ast)
    const meaningful = (statement: Ast) => statement.type !== 'EmptyStatement' && !(statement.type === 'ExpressionStatement' && typeof statement.directive === 'string')
    const identityWrites = (statement: Ast) => nodes(statement, false).filter(node => node.type === 'AssignmentExpression' && identityField(node.left) || (node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete') && identityField(node.argument))
    function fields(body: Ast[]): void {
      const statements = body.filter(meaningful)
      for (const s of statements) {
        const e = record(s.expression), callee = record(e?.callee)
        if (e?.type === 'CallExpression' && callee?.type === 'FunctionExpression' && record(callee.body)?.type === 'BlockStatement') {
          const local = (record(callee.body)!.body as Ast[]).filter(meaningful)
          const parameterShadowed = isWindow(callee.id) || (callee.params as unknown[]).some(bindsWindow)
          if ((e.arguments as Ast[]).some(argument => identityWrites(argument).length > 0) || !parameterShadowed && (callee.params as Ast[]).some(parameter => identityWrites(parameter).length > 0)) throw new Error('Unqualified console identity input')
          if (parameterShadowed || local.some(windowBinding) || hoistedWindow(local)) continue
          scriptBindings({ ...ast, body: local } as unknown as Program)
          if (!local.some(statement => identityWrites(statement).length > 0)) continue
          // Only the finite native literal initializer is a source; no code is executed.
          if (callee.id || callee.async || callee.generator || !Array.isArray(callee.params) || callee.params.length || !Array.isArray(e.arguments) || e.arguments.length) throw new Error('Unqualified console initializer')
          fields(local)
          continue
        }
        const writes = identityWrites(s), loop = record(s.body)
        // Related argument/init writes are checked before an exact abrupt or empty-loop prefix.
        if (!writes.length && (s.type === 'ReturnStatement' || s.type === 'ThrowStatement' || s.type === 'ForStatement' && s.test === null && (loop?.type === 'EmptyStatement' || loop?.type === 'BlockStatement' && (loop.body as unknown[]).length === 0))) break
        if (!writes.length) continue
        const left = record(e?.left), key = identityField(left)
        if (s.type !== 'ExpressionStatement' || e?.type !== 'AssignmentExpression' || e.operator !== '=' || !left || !isWindow(left.object) || left.computed || !key || writes.length !== 1) throw new Error('Unqualified console identity write')
        const right = record(e.right)
        if (!right || key === 'user' && right.type !== 'ObjectExpression' || key === 'csrfToken' && right.type !== 'Literal') throw new Error('Unknown console bootstrap literal')
        for (const node of (key === 'user' ? nodes(right) : []).filter(n => n.type === 'ObjectExpression')) {
          const keys = (node.properties as Ast[]).map(p => record(p.key)?.value)
          if (new Set(keys).size !== keys.length) throw new Error('Duplicate console bootstrap field')
        }
        const value: unknown = key === 'csrfToken' ? right.value : JSON.parse(source.slice(Number(right.start), Number(right.end)))
        if (key === 'csrfToken' && !opaque(value)) throw new Error('Unknown console bootstrap literal')
        candidates.push({ key, value })
      }
    }
    fields(ast.body as unknown as Ast[])
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
  const failed = (reason = failure, nativeCode?: number, redirectReason?: RedirectReason) => unconfirmed(step, reason, httpStatus, nativeCode, boundary, redirectReason)
  try {
    const { state, cookies } = readNativeAccountState(snapshot)
    if (['account', 'expired'].includes(state.phase)) return failed()
    step = state.phase as typeof step
    failure = 'redirect-unconfirmed'; boundary = 'request-target'
    const hosts = state.phase === 'poll' ? ['accounts.feishu.cn'] : state.phase === 'cross-login' ? CROSS_LOGIN_HOSTS : state.phase === 'landing' ? ['ask.feishu.cn'] : CONSOLE_FLOW_HOSTS
    const target = url(state.phase === 'poll' ? uncached(POLL) : state.url ?? '', hosts, state.phase === 'console')
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
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      failure = 'redirect-unconfirmed'; boundary = 'handoff'
      if (state.phase === 'poll') return failed(failure, undefined, 'unexpected-redirect')
      if (++state.hops > redirectLimit(state.phase)) return failed(failure, undefined, 'redirect-limit')
      const location = response.headers.get('location'); if (!location) return failed(failure, undefined, 'missing-location')
      state.url = url(location, hosts, state.phase === 'console', target).href
      state.referer = target.href
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
        if (body?.code !== 0 || !data) return failed()
        boundary = 'transition'
        const polling = data.next_step === null || data.next_step === 'qr_login_polling'
        if (polling && info?.status === 5) { state.phase = 'expired'; stage = 'expired' }
        else if (data.next_step === 'enter_app') {
          // Cross-login is optional; the fixed landing and console still prove the account.
          boundary = 'handoff'
          const cross = info?.cross_login_uri
          if (typeof cross === 'number') return failed()
          if (typeof cross !== 'string' || cross === '') {
            state.url = LANDING; state.phase = 'landing'; state.referer = target.href
          } else {
            if (!text(cross)) return failed()
            failure = 'redirect-unconfirmed'
            state.url = url(cross, CROSS_LOGIN_HOSTS).href; state.phase = 'cross-login'
          }
        } else if (polling && info && Number.isSafeInteger(info.status) && [0, 1, 2].includes(Number(info.status))) stage = info.status === 2 ? 'scanned' : 'waiting'
        else return failed()
      } else if (state.phase === 'cross-login') {
        // Finish the cross-login chain before the original fixed landing, even on the same host.
        state.phase = 'landing'; state.url = LANDING; state.referer = target.href
      }
      else if (state.phase === 'landing') { state.phase = 'console'; state.url = CONSOLE; state.referer = target.href }
      else {
        boundary = 'bootstrap'
        if (!isFeishuConsoleOrigin(target.origin)) return failed('redirect-unconfirmed', undefined, 'unexpected-final-host')
        if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') return failed()
        failure = 'bootstrap-unconfirmed'
        const identity = bootstrap(await readNativeAccountResponse(response)); state.account = identity.account; state.csrf = identity.csrf; state.consoleOrigin = target.origin; state.phase = 'account'; stage = 'account'
      }
    }
    failure = 'invalid-response'; boundary = 'snapshot'
    state.cookieJar = serialize(cookies)
    const challenge = state.phase === 'poll' ? { qrPayload: JSON.stringify({ qrlogin: { token: state.token } }), expiresAt: null, nextPollAt: Date.now() + 1500 } : null
    return { kind: 'progress', stage, challenge, account: stage === 'account' ? state.account! : null, state }
  } catch (error) { return failed(failure, undefined, error instanceof NativeRedirectError ? error.reason : undefined) }
}
