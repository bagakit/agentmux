import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor } from './room-binding-codec.js'
import type { ConnectionActor } from './connections-contract.js'

/** Display observations only. Neither a personal identity credential nor an input grant. */
export type ChannelActorProfile = { name?: string; avatarUrl?: string; observedAt: number }
export type ChannelProfileReason = 'not-observed' | 'adapter-unavailable' | 'credential-unavailable' | 'source-unconfirmed' | 'storage-unconfirmed' | 'not-visible' | 'unsupported-actor'
export type ChannelActorProfileObservation = {
  actor: ConnectionActor
  state: 'observed' | 'unknown' | 'unavailable'
  /** Last confirmed platform fields survive a later failed refresh. */
  profile: ChannelActorProfile | null
  checkedAt: number
  freshness: 'current' | 'stale' | 'unknown'
  reason?: ChannelProfileReason
}

/** Full issuer namespace, independent of Connection aliases, display names and grants. */
export function channelActorKey(actor: ConnectionActor): string {
  return JSON.stringify([actor.application.domain, actor.application.appId, actor.idType, actor.userId])
}

export function parseChannelActorProfileObservation(value: unknown): ChannelActorProfileObservation {
  const fail = (): never => { throw new AgentMuxError('Channel profile observation does not describe its original actor.', 'INVALID_CHANNEL_PROFILE') }
  const p = rpcRecord(value, ['actor', 'state', 'profile', 'checkedAt', 'freshness', 'reason'], 'INVALID_CHANNEL_PROFILE')
  const time = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 0) fail(); return v as number }
  const name = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || /[\u0000-\u001f\u007f]/u.test(v)) fail(); return v as string }
  const avatar = (v: unknown): string => {
    const text = name(v)
    try { const url = new URL(text); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail() } catch { return fail() }
    return text
  }
  if (!['observed', 'unknown', 'unavailable'].includes(String(p.state)) || !['current', 'stale', 'unknown'].includes(String(p.freshness))) fail()
  const reasons: readonly ChannelProfileReason[] = ['not-observed', 'adapter-unavailable', 'credential-unavailable', 'source-unconfirmed', 'storage-unconfirmed', 'not-visible', 'unsupported-actor']
  if (p.reason !== undefined && !reasons.includes(p.reason as ChannelProfileReason)) fail()
  let profile: ChannelActorProfile | null = null
  if (p.profile !== null) {
    const f = rpcRecord(p.profile, ['name', 'avatarUrl', 'observedAt'], 'INVALID_CHANNEL_PROFILE')
    profile = { ...(f.name === undefined ? {} : { name: name(f.name) }), ...(f.avatarUrl === undefined ? {} : { avatarUrl: avatar(f.avatarUrl) }), observedAt: time(f.observedAt) }
  }
  if (p.state === 'observed' && (!profile || p.reason !== undefined) || p.freshness === 'current' && (!profile || p.state !== 'observed')) fail()
  return { actor: parseConnectionActor(p.actor), state: p.state as ChannelActorProfileObservation['state'], profile, checkedAt: time(p.checkedAt), freshness: p.freshness as ChannelActorProfileObservation['freshness'], ...(p.reason === undefined ? {} : { reason: p.reason as ChannelProfileReason }) }
}
