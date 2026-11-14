import { isLocalNetworkHost } from '@agentmux/relay/offer'

/** Local document scope for a workface. The original endpoint still owns authorization. */
export function isWorkfaceOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  if (value === 'file://') return globalThis.location?.origin === value
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:' && isLocalNetworkHost(url.hostname))
      && url.origin === value && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
