import { createHash, timingSafeEqual } from 'node:crypto'
import type { RelayRouterOptions } from './routing-server.js'

export interface RelayPublisherGrant { readonly serverId: string; readonly tokenHash: string }

export function hashPublisherToken(token: string): string {
  if (typeof token !== 'string' || !token || /[\r\n\0]/u.test(token)) throw new Error('Invalid Relay publisher credential.')
  return createHash('sha256').update(token).digest('hex')
}

/** Explicit route admission only; E2EE peers still authorize RPC at their original endpoint. */
export function createPublisherAdmission(grants: readonly RelayPublisherGrant[]): Pick<RelayRouterOptions, 'acceptsServer' | 'authorizePublisher'> {
  const hashes = new Map<string, Buffer>()
  for (const grant of grants) {
    if (!grant || typeof grant.serverId !== 'string' || !grant.serverId || /[\0-\x20\x7f]/u.test(grant.serverId) ||
        Buffer.byteLength(grant.serverId) > 255 || hashes.has(grant.serverId) || typeof grant.tokenHash !== 'string' || !/^[a-f0-9]{64}$/u.test(grant.tokenHash))
      throw new Error('Relay publisher grants require unique exact server ids and SHA-256 credential hashes.')
    hashes.set(grant.serverId, Buffer.from(grant.tokenHash, 'hex'))
  }
  return {
    acceptsServer: serverId => hashes.has(serverId),
    authorizePublisher: (request, serverId) => {
      const expected = hashes.get(serverId), authorization = request.headers.authorization
      if (!expected || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false
      const received = authorization.slice('Bearer '.length)
      if (!received || /[\r\n\0]/u.test(received)) return false
      return timingSafeEqual(expected, createHash('sha256').update(received).digest())
    },
  }
}
