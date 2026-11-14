import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { getDomain } from 'tldts'
import type { BrowserProfileCookieScope, BrowserProfileCookieFileItem } from '@agentmux/core/control'
export type ProfileFileCookie = { domain: string; hostOnly: boolean; name: string; value: string; path: string; expires: number | null; secure: boolean; httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | 'Unspecified'; partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }; priority?: 'Low' | 'Medium' | 'High'; sourceScheme?: 'Unset' | 'NonSecure' | 'Secure'; sourcePort?: number }
export type ProfileCookieParam = { url: string; name: string; value: string; path: string; secure: boolean; httpOnly: boolean; domain?: string; expires?: number;
  sameSite?: 'Strict' | 'Lax' | 'None'; partitionKey?: ProfileFileCookie['partitionKey']; priority?: ProfileFileCookie['priority']; sourceScheme?: ProfileFileCookie['sourceScheme']; sourcePort?: number }
export type ProfileCookiePlanItem = { index: number; cookie?: ProfileFileCookie; result: BrowserProfileCookieFileItem }
export type ProfileCookiePlan = { items: ProfileCookiePlanItem[]; sites: string[] }
class InvalidCookie extends Error { constructor(readonly reason: 'invalid-cookie' | 'expired' | 'unsupported-cookie') { super(reason) } }
const bad = (reason: InvalidCookie['reason'] = 'invalid-cookie'): never => { throw new InvalidCookie(reason) }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad()
const noControls = (v: unknown): v is string => typeof v === 'string' && !/[\u0000-\u001f\u007f]/u.test(v)
const bool = (v: unknown, fallback: boolean): boolean => v === undefined ? fallback : typeof v === 'boolean' ? v : bad()
function host(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw !== raw.trim() || /[\s/?#@\\]/u.test(raw)) return bad()
  const value = raw.replace(/^\./u, '').replace(/\.$/u, ''), ip = value.replace(/^\[|\]$/g, '')
  if (isIP(ip)) return ip.toLowerCase()
  const domain = domainToASCII(value).toLowerCase()
  if (!domain || domain.split('.').some(part => !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(part))) return bad()
  return domain
}
export function profileCookieSite(domain: string): string { const h = host(domain); return h === 'localhost' || isIP(h) ? h : getDomain(h, { allowPrivateDomains: true }) ?? h }
export function canonicalCookieScope(scope: BrowserProfileCookieScope): BrowserProfileCookieScope {
  if (scope.kind === 'profile') return { kind: 'profile' }
  const sites = scope.sites.map(site => { const h = host(site); if (profileCookieSite(h) !== h || site !== h) return bad(); return h })
  return { kind: 'sites', sites: [...new Set(sites)].sort() }
}
export const cookieInScope = (cookie: ProfileFileCookie, scope: BrowserProfileCookieScope): boolean => scope.kind === 'profile' || scope.sites.includes(profileCookieSite(cookie.domain))
function sameSite(v: unknown): ProfileFileCookie['sameSite'] {
  if (v === undefined || v === null) return 'Unspecified'
  if (typeof v !== 'string') return bad()
  const s = v.toLowerCase(); return s === 'strict' ? 'Strict' : s === 'lax' ? 'Lax' : s === 'none' || s === 'no_restriction' ? 'None' : s === 'unspecified' ? 'Unspecified' : bad()
}
function alias(r: Record<string, unknown>, a: string, b: string): unknown { if (Object.hasOwn(r, a) && Object.hasOwn(r, b) && r[a] !== r[b]) return bad(); return r[a] ?? r[b] }
export function normalizeProfileFileCookie(value: unknown, nowSeconds: number): ProfileFileCookie {
  const r = object(value), fields = ['domain','hostOnly','name','value','path','expires','expirationDate','session','secure','httpOnly','http_only','sameSite','same_site','partitionKey','partitionKeyOpaque','priority','sourceScheme','sourcePort','size','url','sameParty']
  if (Object.keys(r).some(k => !fields.includes(k)) || bool(r.partitionKeyOpaque,false) || bool(r.sameParty,false)) return bad('unsupported-cookie')
  const h = host(r.domain), hostOnly = bool(r.hostOnly, typeof r.domain === 'string' && !r.domain.startsWith('.'))
  if (hostOnly && typeof r.domain === 'string' && r.domain.startsWith('.') || !hostOnly && isIP(h)) return bad()
  if (typeof r.name !== 'string' || !/^[!#$%&'*+\-.^_`|~\dA-Za-z]*$/u.test(r.name) || !noControls(r.value)) return bad()
  const path = r.path === undefined ? '/' : r.path; if (!noControls(path) || !path.startsWith('/')) return bad()
  const secure = bool(r.secure, false), httpOnly = bool(alias(r,'httpOnly','http_only'),false), policy = sameSite(alias(r,'sameSite','same_site'))
  let expires: number | null = null; const rawExpiry = alias(r,'expires','expirationDate')
  if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== -1 && rawExpiry !== 0) { if (typeof rawExpiry !== 'number' || !Number.isFinite(rawExpiry) || rawExpiry < 0) return bad(); if (rawExpiry <= nowSeconds) return bad('expired'); expires = rawExpiry }
  if (r.session !== undefined && typeof r.session !== 'boolean' || r.session === true && expires !== null || r.session === false && expires === null) return bad()
  if ((r.name.startsWith('__Host-') && (!hostOnly || path !== '/' || !secure)) || r.name.startsWith('__Secure-') && !secure || policy === 'None' && !secure) return bad()
  const cookie: ProfileFileCookie = { domain: hostOnly ? h : '.'+h, hostOnly, name: r.name, value: r.value, path, expires, secure, httpOnly, sameSite: policy }
  if (r.partitionKey !== undefined) {
    const p = object(r.partitionKey); if (Object.keys(p).some(k=>!['topLevelSite','hasCrossSiteAncestor'].includes(k)) || typeof p.topLevelSite !== 'string' || typeof p.hasCrossSiteAncestor !== 'boolean' || !secure) return bad()
    let u: URL; try { u = new URL(p.topLevelSite) } catch { return bad() }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') return bad()
    const siteHost=profileCookieSite(u.hostname),siteUrlHost=isIP(siteHost)===6?'['+siteHost+']':siteHost
    cookie.partitionKey = { topLevelSite: u.protocol+'//'+siteUrlHost, hasCrossSiteAncestor: p.hasCrossSiteAncestor }
  }
  if (r.priority !== undefined) { if (!['Low','Medium','High'].includes(r.priority as string)) return bad('unsupported-cookie'); cookie.priority = r.priority as NonNullable<ProfileFileCookie['priority']> }
  if (r.sourceScheme !== undefined) { if (!['Unset','NonSecure','Secure'].includes(r.sourceScheme as string)) return bad('unsupported-cookie'); cookie.sourceScheme = r.sourceScheme as NonNullable<ProfileFileCookie['sourceScheme']> }
  if (r.sourcePort !== undefined) { if (typeof r.sourcePort !== 'number' || !Number.isInteger(r.sourcePort) || r.sourcePort !== -1 && (r.sourcePort < 1 || r.sourcePort > 65535)) return bad(); cookie.sourcePort = r.sourcePort }
  if (r.url !== undefined) { try { const u = new URL(String(r.url)); if (!['http:','https:'].includes(u.protocol) || host(u.hostname) !== h) return bad() } catch { return bad() } }
  return cookie
}
export const profileCookieIdentity = (c: ProfileFileCookie): string => JSON.stringify([c.domain,c.hostOnly,c.path,c.name,c.partitionKey?.topLevelSite ?? null,c.partitionKey?.hasCrossSiteAncestor ?? null])
export function profileCookieParam(c: ProfileFileCookie): ProfileCookieParam {
  const h = host(c.domain), urlHost = isIP(h) === 6 ? '['+h+']' : h
  return { url: `${c.secure ? 'https' : 'http'}://${urlHost}/`, name:c.name,value:c.value,path:c.path,secure:c.secure,httpOnly:c.httpOnly,
    ...(!c.hostOnly?{domain:c.domain}:{}),...(c.expires===null?{}:{expires:c.expires}),...(c.sameSite==='Unspecified'?{}:{sameSite:c.sameSite}),
    ...(c.partitionKey?{partitionKey:{...c.partitionKey}}:{}),...(c.priority?{priority:c.priority}:{}),...(c.sourceScheme?{sourceScheme:c.sourceScheme}:{}),...(c.sourcePort===undefined?{}:{sourcePort:c.sourcePort}) }
}
export function planProfileCookieArray(raw: unknown[], scope: BrowserProfileCookieScope, nowSeconds: number): ProfileCookiePlan {
  const seen = new Set<string>(), sites = new Set<string>()
  const items = raw.map((value,index): ProfileCookiePlanItem => {
    try { const cookie = normalizeProfileFileCookie(value,nowSeconds), key = profileCookieIdentity(cookie)
      if (!cookieInScope(cookie,scope)) return {index,result:{index,status:'skipped',reason:'outside-scope'}}
      if (seen.has(key)) return {index,result:{index,status:'skipped',reason:'duplicate-in-file'}}
      seen.add(key);sites.add(profileCookieSite(cookie.domain));return {index,cookie,result:{index,status:'unknown',reason:'native-unconfirmed'}}
    } catch (cause) { return {index,result:{index,status:'skipped',reason:cause instanceof InvalidCookie?cause.reason:'invalid-cookie'}} }
  })
  return {items,sites:[...sites].sort()}
}
export function decodeProfileCookieFile(bytes: Uint8Array, scope: BrowserProfileCookieScope, nowSeconds: number): ProfileCookiePlan {
  let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) } catch { throw new Error('The selected Cookie file is not valid UTF-8 JSON. Its original bytes and Profile data are kept.') }
  if (!Array.isArray(raw)) throw new Error('The selected Cookie file must contain a JSON array. The original Profile is unchanged.')
  return planProfileCookieArray(raw,scope,nowSeconds)
}
