import type { ConnectionDeliveryWait } from '@agentmux/core/connections'

/** Opaque native resource identities, derived only by the registered preparer. */
export type PublicationRateLimitScopes = { request: string; conversation?: string }
/** Background range position only, never an admission or native quota fact. */
export type PublicationRateLimitCursor = { scopeKey: string; otherKey: string; ordinal: number }
export type PublicationRateLimitPendingCursor = { request: string; conversation: string }
/** Private metadata for one actual native no-effect response, never a public receipt. */
export type PublicationRateLimitAdvice = { scopeKey: string; observedAt: number; resetSeconds?: number }
export type PublicationRateLimitObservation = ConnectionDeliveryWait & {
  source: { kind: 'message'; attempt: number }
  scopeKey: string
}
export const PUBLICATION_LOCAL_RATE_LIMIT_MS = 5_000
const key = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export function publicationRateLimitScopes(value: unknown): PublicationRateLimitScopes | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(field => !['request', 'conversation'].includes(field)) || !key(p.request) || p.conversation !== undefined && !key(p.conversation)) return
  return { request: p.request, ...(p.conversation === undefined ? {} : { conversation: p.conversation as string }) }
}
/** Invalid optional advice never replaces an authoritative public effect result. */
export function publicationRateLimitObservation(attempt: number, value: PublicationRateLimitAdvice | undefined,
  scopes: PublicationRateLimitScopes | undefined): PublicationRateLimitObservation | undefined {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !value || !scopes || !time(value.observedAt) ||
    !key(value.scopeKey) || ![scopes.request, scopes.conversation].includes(value.scopeKey)) return
  const candidate = typeof value.resetSeconds === 'number' && value.resetSeconds >= 0 && Number.isSafeInteger(value.resetSeconds * 1000)
    ? value.observedAt + value.resetSeconds * 1000 : undefined
  const native = time(candidate)
  const notBefore = native ? candidate : value.observedAt + PUBLICATION_LOCAL_RATE_LIMIT_MS
  if (!time(notBefore)) return
  return { source: { kind: 'message', attempt }, scopeKey: value.scopeKey, reason: 'rate-limit', notBefore, basis: native ? 'native' : 'local' }
}
