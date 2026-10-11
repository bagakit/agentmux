import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5'
import { parse as parseScript, type Node, type Program } from 'acorn'
import { Cookie, CookieJar, type SerializedCookieJar } from 'tough-cookie'
import type { ConnectionSetupAccount } from '@agentmux/core/connections'
import type { SetupAdapterInput, SetupAuthenticationReceipt, SetupInspectionReceipt } from '../../connection-setup-adapter.js'

export const FEISHU_QR_HEADERS = {
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
type Session = SetupAdapterInput & {
  version: 2; flowKey: string; token: string; cookieJar: SerializedCookieJar; phase: Phase; hops: number
  url?: string; account?: ConnectionSetupAccount; csrf?: string; consoleOrigin?: string
}
type Ast = Node & Record<string, unknown>
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\u0000-\u001f\u007f]/u.test(v)
const opaque = (v: unknown): v is string => text(v) && !/\s/u.test(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
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
function session(input: SetupAdapterInput & { privateState: string }): { state: Session; cookies: CookieJar } {
  const p = record(JSON.parse(input.privateState))
  if (!p || p.operationId !== input.operationId || p.connectionId !== input.connectionId || p.attemptId !== input.attemptId || !same(p.application, input.application) || !opaque(p.flowKey) || !opaque(p.token)) throw new Error('Foreign authentication snapshot')
  if (p.version === 1) {
    if (!Array.isArray(p.setCookies) || !p.setCookies.every(text)) throw new Error('Unknown original cookie snapshot')
    const cookies = jar()
    for (const cookie of p.setCookies) cookies.setCookieSync(cookie, INIT)
    return { state: { version: 2, operationId: input.operationId, connectionId: input.connectionId, attemptId: input.attemptId, application: input.application, flowKey: p.flowKey, token: p.token, cookieJar: serialize(cookies), phase: 'poll', hops: 0 }, cookies }
  }
  if (p.version !== 2 || !['poll', 'cross-login', 'landing', 'console', 'account', 'expired'].includes(String(p.phase)) || !Number.isSafeInteger(p.hops) || Number(p.hops) < 0 || Number(p.hops) > 8) throw new Error('Unknown authentication snapshot')
  const state = p as unknown as Session
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
async function page(response: Response): Promise<string> {
  if (!response.body) throw new Error('Missing console document')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 2 * 1024 * 1024) throw new Error('Unconfirmed console document'); chunks.push(next.value) }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
/** One native request only. Its next URL and cookies are returned privately for the next durable action. */
export async function advanceFeishuSession(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupAuthenticationReceipt> {
  if (input.application.domain !== 'open.feishu.cn') return { kind: 'unknown' }
  try {
    const { state, cookies } = session(input)
    if (['account', 'expired'].includes(state.phase)) return { kind: 'unknown' }
    const hosts = state.phase === 'poll' ? ['accounts.feishu.cn'] : state.phase === 'cross-login' ? ['accounts.feishu.cn', 'ask.feishu.cn'] : state.phase === 'landing' ? ['ask.feishu.cn'] : CONSOLE_HOSTS
    const target = url(state.phase === 'poll' ? POLL : state.url ?? '', hosts)
    if (state.phase === 'console') consoleUrl(target.href)
    const headers: Record<string, string> = state.phase === 'poll' ? { ...FEISHU_QR_HEADERS, 'x-flow-key': state.flowKey } : { accept: 'text/html' }
    const cookie = cookies.getCookieStringSync(target.href); if (cookie) headers.cookie = cookie
    const bounded = AbortSignal.timeout(20_000)
    const response = await fetch(target.href, { method: state.phase === 'poll' ? 'POST' : 'GET', redirect: 'manual', headers, ...(state.phase === 'poll' ? { body: JSON.stringify({ biz_type: null }) } : {}), signal: signal ? AbortSignal.any([signal, bounded]) : bounded })
    if (response.url && new URL(response.url).href !== target.href) return { kind: 'unknown' }
    for (const value of response.headers.getSetCookie()) cookies.setCookieSync(value, target.href)
    let stage: 'waiting' | 'scanned' | 'handoff' | 'account' | 'expired' = 'handoff'
    if (response.status >= 300 && response.status < 400) {
      if (state.phase === 'poll' || ++state.hops > 8) return { kind: 'unknown' }
      const location = response.headers.get('location'); if (!location) return { kind: 'unknown' }
      state.url = url(new URL(location, target).href, hosts).href
      if (state.phase === 'console') consoleUrl(state.url)
      if (state.phase === 'cross-login' && new URL(state.url).hostname === 'ask.feishu.cn') state.phase = 'landing'
    } else {
      if (!response.ok) return { kind: 'unknown' }
      state.hops = 0
      if (state.phase === 'poll') {
        const body = record(await response.json()), data = record(body?.data), step = record(data?.step_info)
        if (body?.code !== 0 || !data || !Number.isSafeInteger(step?.status)) return { kind: 'unknown' }
        if (data.next_step === null && step!.status === 5) { state.phase = 'expired'; stage = 'expired' }
        else if (data.next_step === 'enter_app') {
          if (step!.status !== 1 || !text(step!.cross_login_uri)) return { kind: 'unknown' }
          state.url = url(step!.cross_login_uri, ['accounts.feishu.cn']).href; state.phase = 'cross-login'
        } else if (data.next_step === null && [1, 2].includes(Number(step!.status))) stage = step!.status === 2 ? 'scanned' : 'waiting'
        else return { kind: 'unknown' }
      } else if (state.phase === 'cross-login') { state.phase = 'landing'; state.url = LANDING }
      else if (state.phase === 'landing') { state.phase = 'console'; state.url = CONSOLE }
      else {
        if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') return { kind: 'unknown' }
        const identity = bootstrap(await page(response)); state.account = identity.account; state.csrf = identity.csrf; state.consoleOrigin = target.origin; state.phase = 'account'; stage = 'account'
      }
    }
    state.cookieJar = serialize(cookies)
    const challenge = state.phase === 'poll' ? { qrPayload: JSON.stringify({ qrlogin: { token: state.token } }), expiresAt: null, nextPollAt: Date.now() + 1500 } : null
    return { kind: 'progress', stage, challenge, account: stage === 'account' ? state.account! : null, privateState: JSON.stringify(state) }
  } catch { return { kind: 'unknown' } }
}

/** One exact console permission read, not an app-data read or a configuration grant. */
export async function inspectFeishuApplication(input: SetupAdapterInput & { privateState: string }, signal?: AbortSignal): Promise<SetupInspectionReceipt> {
  if (input.application.domain !== 'open.feishu.cn') return { kind: 'unknown' }
  try {
    const { state, cookies } = session(input)
    if (state.phase !== 'account' || !state.account || !opaque(state.csrf) || state.consoleOrigin !== 'https://open.feishu.cn') return { kind: 'unknown' }
    const target = new URL('/developers/v1/app_role/permission/' + encodeURIComponent(input.application.appId), state.consoleOrigin)
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': state.csrf, 'X-Timezone-Offset': String(new Date().getTimezoneOffset()) }
    const cookie = cookies.getCookieStringSync(target.href); if (cookie) headers.cookie = cookie
    const bounded = AbortSignal.timeout(20_000)
    const response = await fetch(target.href, { method: 'POST', redirect: 'manual', headers, body: '{}', signal: signal ? AbortSignal.any([signal, bounded]) : bounded })
    if (!response.ok || response.redirected || response.url && new URL(response.url).href !== target.href || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return { kind: 'unknown' }
    // The same per-response document bound also bounds JSON material retained privately.
    const body = record(JSON.parse(await page(response))), data = record(body?.data), permissions = record(data?.permission)
    if (body?.code !== 0 || !Number.isSafeInteger(data?.roleType) || !permissions || !Object.hasOwn(permissions, String(data!.roleType))) return { kind: 'unknown' }
    const role = record(permissions[String(data!.roleType)]), read = record(role?.readResource), write = record(role?.writeResource)
    if (!read || !write) return { kind: 'unknown' }
    return { kind: 'observed', applicationInfoReadPermission: Object.hasOwn(read, 'app.info') || Object.hasOwn(write, 'app.info') ? 'confirmed' : 'unknown', privateState: JSON.stringify(data) }
  } catch { return { kind: 'unknown' } }
}
