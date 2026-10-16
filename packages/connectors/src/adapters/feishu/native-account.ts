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
const unconfirmed = (step: NonNullable<AuthenticationDiagnostic['step']>, failure: NonNullable<AuthenticationDiagnostic['failure']>, httpStatus?: number, nativeCode?: number): NativeAccountUnknown => ({ kind: 'unknown', diagnostic: { stage: 'authentication', code: 'native-unconfirmed', step, failure, ...(httpStatus === undefined ? {} : { httpStatus }), ...(nativeCode === undefined ? {} : { nativeCode }) } })
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
    for (const cookie of p.setCookies) cookies.setCookieSync(cookie, INIT)
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
    const body = record(await response.json()), data = record(body?.data), step = record(data?.step_info)
    const flowKey = response.headers.get('x-flow-key')
    const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u0020\u007f]/u.test(value)
    if (Number.isSafeInteger(body?.code) && body!.code !== 0) return unconfirmed('initialize', 'platform-error', httpStatus, Number(body!.code))
    if (body?.code !== 0 || !token(step?.token) || !token(flowKey)) return unconfirmed('initialize', failure, httpStatus)
    const challenge = { qrPayload: JSON.stringify({ qrlogin: { token: step.token } }), expiresAt: null, nextPollAt: Date.now() + 1500 }
    return { kind: 'challenge', challenge, state: { version: 1, flowKey, token: step.token, setCookies: response.headers.getSetCookie() } }
  } catch { return unconfirmed('initialize', failure, httpStatus) }
}

function alias(p: Record<string, unknown>, names: readonly string[], required: boolean): string | undefined {
  const values = names.filter(n => Object.hasOwn(p, n)).map(n => p[n])
  if (values.some(v => !text(v)) || new Set(values).size > 1 || required && values.length === 0) throw new Error('Unknown bootstrap identity')
  return values[0] as string | undefined
}
function account(value: unknown): ConnectionSetupAccount {
  const p = record(value); if (!p) throw new Error('Unknown bootstrap identity')
  const userId = alias(p, ['id', 'userId', 'user_id'], true)!, tenantId = alias(p, ['tenantId', 'tenant_id'], true)!
  if (!opaque(userId) || !opaque(tenantId)) throw new Error('Unknown bootstrap identifiers')
  const name = (a: string | undefined, b: string | undefined) => { if (a && b && a !== b) throw new Error('Conflicting bootstrap name'); return a ?? b }
  const userName = name(alias(p, ['name', 'userName', 'user_name'], false), alias(record(p.displayName) ?? {}, ['value'], false))
  const tenantName = name(alias(record(p.tenantDisplayName) ?? {}, ['value'], false), alias(p, ['tenantName', 'tenant_name'], false))
  return { userId, tenantId, ...(userName ? { userName } : {}), ...(tenantName ? { tenantName } : {}) }
}
function nodes(value: unknown): Ast[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  const p = record(value); if (!p || typeof p.type !== 'string') return []
  return [p as unknown as Ast, ...Object.values(p).flatMap(nodes)]
}
function isWindow(value: unknown): boolean { const p = record(value); return p?.type === 'Identifier' && p.name === 'window' }
function bootstrap(html: string): { account: ConnectionSetupAccount; csrf: string } {
  const candidates: { key: 'user' | 'csrfToken'; value: unknown }[] = []
  function script(source: string): void {
    let ast: Program
    try { ast = parseScript(source, { ecmaVersion: 'latest', sourceType: 'script' }) } catch { throw new Error('Unknown console bootstrap syntax') }
    const all = nodes(ast)
    for (const n of all) {
      if (n.type === 'VariableDeclarator' && nodes(n.id).some(isWindow) || ['FunctionDeclaration', 'ClassDeclaration'].includes(n.type) && isWindow(n.id)) throw new Error('Shadowed bootstrap binding')
      if (n.type === 'AssignmentExpression' && isWindow(n.left)) throw new Error('Replaced bootstrap binding')
    }
    const identityMembers = all.filter(n => n.type === 'MemberExpression' && isWindow(n.object) && ['user', 'csrfToken'].includes(String(n.computed ? record(n.property)?.value : record(n.property)?.name)))
    if (!identityMembers.length) return
    let statements = ast.body.filter(s => s.type !== 'EmptyStatement') as unknown as Ast[]
    const expression = statements.length === 1 ? record(statements[0]!.expression) : null
    const callee = record(expression?.callee)
    const initializer = expression?.type === 'CallExpression' && callee?.type === 'FunctionExpression'
    if (initializer) {
      // The real console also emits this finite literal IIFE, not a general script.
      if (callee.id || callee.async || callee.generator || !Array.isArray(callee.params) || callee.params.length || !Array.isArray(expression.arguments) || expression.arguments.length || record(callee.body)?.type !== 'BlockStatement') throw new Error('Unqualified console initializer')
      statements = record(callee.body)!.body as Ast[]
    }
    const allowed = initializer ? ['user', 'csrfToken', 'nonce', 'features', 'unit', 'unitType', 'isOversea', 'env', 'outDomain', 'resource', 'domainBrand', 'seoType'] : ['user', 'csrfToken']
    const assigned = new Set<string>()
    const direct = new Set<Ast>()
    for (const s of statements) {
      if (s.type === 'EmptyStatement') continue
      const e = record(s.expression), left = record(e?.left), property = record(left?.property), key = String(property?.name)
      if (s.type !== 'ExpressionStatement' || e?.type !== 'AssignmentExpression' || e.operator !== '=' || left?.type !== 'MemberExpression' || !isWindow(left.object) || left.computed || !allowed.includes(key) || assigned.has(key)) throw new Error('Unqualified console bootstrap program')
      const right = record(e.right); if (!right) throw new Error('Unknown console bootstrap literal')
      for (const node of nodes(right).filter(n => n.type === 'ObjectExpression')) {
        const keys = (node.properties as Ast[]).map(p => record(p.key)?.value)
        if (new Set(keys).size !== keys.length) throw new Error('Duplicate console bootstrap field')
      }
      const value: unknown = !initializer && key === 'csrfToken' && right.type === 'Literal' ? right.value : JSON.parse(source.slice(Number(right.start), Number(right.end)))
      if (key === 'user' && right.type !== 'ObjectExpression' || key === 'csrfToken' && (right.type !== 'Literal' || !opaque(value))) throw new Error('Unknown console bootstrap literal')
      assigned.add(key); direct.add(left as unknown as Ast)
      if (key === 'user' || key === 'csrfToken') candidates.push({ key, value })
    }
    if (initializer && (!assigned.has('user') || !assigned.has('csrfToken'))) throw new Error('Incomplete console initializer')
    if (identityMembers.some(n => !direct.has(n))) throw new Error('Indirect console bootstrap')
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
  if (!users.length || !tokens.length || new Set(users.map(u => JSON.stringify(u))).size !== 1 || new Set(tokens).size !== 1) throw new Error('Missing or conflicting console bootstrap')
  return { account: users[0]!, csrf: tokens[0] as string }
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
  try {
    const { state, cookies } = readNativeAccountState(snapshot)
    if (['account', 'expired'].includes(state.phase)) return unconfirmed(step, failure)
    step = state.phase as typeof step
    failure = 'redirect-unconfirmed'
    const hosts = state.phase === 'poll' ? ['accounts.feishu.cn'] : state.phase === 'cross-login' ? ['accounts.feishu.cn', 'ask.feishu.cn'] : state.phase === 'landing' ? ['ask.feishu.cn'] : CONSOLE_HOSTS
    const target = url(state.phase === 'poll' ? uncached(POLL) : state.url ?? '', hosts)
    if (state.phase === 'console') consoleUrl(target.href)
    const headers: Record<string, string> = state.phase === 'poll' ? { ...FEISHU_QR_HEADERS, 'x-flow-key': state.flowKey } : { accept: 'text/html', 'user-agent': FEISHU_BROWSER_USER_AGENT }
    if (state.referer) headers.referer = state.referer
    const cookie = cookies.getCookieStringSync(target.href); if (cookie) headers.cookie = cookie
    const bounded = AbortSignal.timeout(20_000)
    failure = 'transport-unconfirmed'
    const response = await fetch(target.href, { method: state.phase === 'poll' ? 'POST' : 'GET', redirect: 'manual', headers, ...(state.phase === 'poll' ? { body: JSON.stringify({ biz_type: null }) } : {}), signal: signal ? AbortSignal.any([signal, bounded]) : bounded })
    httpStatus = response.status; failure = 'invalid-response'
    if (response.url && new URL(response.url).href !== target.href) return unconfirmed(step, failure, httpStatus)
    for (const value of response.headers.getSetCookie()) cookies.setCookieSync(value, target.href)
    let stage: 'waiting' | 'scanned' | 'handoff' | 'account' | 'expired' = 'handoff'
    if (response.status >= 300 && response.status < 400) {
      failure = 'redirect-unconfirmed'
      if (state.phase === 'poll' || ++state.hops > 8) return unconfirmed(step, failure, httpStatus)
      const location = response.headers.get('location'); if (!location) return unconfirmed(step, failure, httpStatus)
      state.url = url(new URL(location, target).href, hosts).href
      state.referer = target.href
      if (state.phase === 'console') consoleUrl(state.url)
      if (state.phase === 'cross-login' && new URL(state.url).hostname === 'ask.feishu.cn') state.phase = 'landing'
    } else {
      if (!response.ok) return unconfirmed(step, 'http-status', httpStatus)
      state.hops = 0
      if (state.phase === 'poll') {
        const body = record(await response.json()), data = record(body?.data), step = record(data?.step_info)
        if (Number.isSafeInteger(body?.code) && body!.code !== 0) return unconfirmed('poll', 'platform-error', httpStatus, Number(body!.code))
        if (body?.code !== 0 || !data || !step) return unconfirmed('poll', failure, httpStatus)
        const polling = data.next_step === null || data.next_step === 'qr_login_polling'
        if (data.next_step === null && step!.status === 5) { state.phase = 'expired'; stage = 'expired' }
        else if (data.next_step === 'enter_app') {
          // enter_app has its own handoff fields; status belongs to QR polling.
          if (!text(step.cross_login_uri)) return unconfirmed('poll', failure, httpStatus)
          state.url = url(step!.cross_login_uri, ['accounts.feishu.cn']).href; state.phase = 'cross-login'
        } else if (polling && Number.isSafeInteger(step.status) && [1, 2].includes(Number(step.status))) stage = step.status === 2 ? 'scanned' : 'waiting'
        else return unconfirmed('poll', failure, httpStatus)
      } else if (state.phase === 'cross-login') { state.phase = 'landing'; state.url = LANDING; state.referer = target.href }
      else if (state.phase === 'landing') { state.phase = 'console'; state.url = CONSOLE; state.referer = target.href }
      else {
        if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') return unconfirmed(step, failure, httpStatus)
        failure = 'bootstrap-unconfirmed'
        const identity = bootstrap(await readNativeAccountResponse(response)); state.account = identity.account; state.csrf = identity.csrf; state.consoleOrigin = target.origin; state.phase = 'account'; stage = 'account'
      }
    }
    state.cookieJar = serialize(cookies)
    const challenge = state.phase === 'poll' ? { qrPayload: JSON.stringify({ qrlogin: { token: state.token } }), expiresAt: null, nextPollAt: Date.now() + 1500 } : null
    return { kind: 'progress', stage, challenge, account: stage === 'account' ? state.account! : null, state }
  } catch { return unconfirmed(step, failure, httpStatus) }
}
