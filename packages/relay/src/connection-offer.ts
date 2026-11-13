// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0.
// Adapted from Paseo connection-offer: framework-independent strict public DTO.
export function isLocalNetworkHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (['localhost', '::1'].includes(value) || value.endsWith('.local')) return true
  if (/^(fc|fd)[a-f0-9]{2}:/i.test(value) || /^fe[89ab][a-f0-9]:/i.test(value)) return true
  const parts = value.split('.').map(Number)
  return parts.length === 4 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255) &&
    (parts[0] === 127 || parts[0] === 10 || parts[0] === 192 && parts[1] === 168 ||
      parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 169 && parts[1] === 254)
}
export type ConnectionOffer = { v: 2; serverId: string; daemonPublicKeyB64: string; relay: { endpoint: string; useTls: boolean } }
export function parseConnectionOffer(value: unknown): ConnectionOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection offer.')
  const p = value as Record<string, unknown>, relay = p.relay as Record<string, unknown> | undefined
  if (Object.keys(p).some(k => !['v', 'serverId', 'daemonPublicKeyB64', 'relay'].includes(k)) || p.v !== 2 ||
    typeof p.serverId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(p.serverId) ||
    typeof p.daemonPublicKeyB64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(p.daemonPublicKeyB64) ||
    !relay || typeof relay !== 'object' || Array.isArray(relay) || Object.keys(relay).some(k => !['endpoint','useTls'].includes(k)) ||
    typeof relay.endpoint !== 'string' || typeof relay.useTls !== 'boolean') throw new Error('Invalid connection offer.')
  const url = new URL(`${relay.useTls ? 'wss' : 'ws'}://${relay.endpoint}`)
  if (!relay.useTls && !isLocalNetworkHost(url.hostname)) throw new Error('Unencrypted Relay transport is restricted to the local network.')
  if (url.username || url.password || url.pathname !== '/' || url.hash || url.search) throw new Error('Invalid Relay address.')
  return p as ConnectionOffer
}

/**
 * The link fragment is one base64url string of bytes, so a QR code stays sparse and a copied link stays
 * short. The Mac's full public key always travels in it: the phone checks the Mac and derives the
 * end-to-end key from it, so it is never shortened or swapped for a code the phone would have to trade.
 *
 *   byte 0      format and flags: 0x02 = this layout, | 0x01 when the Relay endpoint is written out
 *   bytes 1-32  the Mac's X25519 public key
 *   byte 33     serverId length n, then n ASCII bytes of serverId
 *   if flagged: endpoint length m, then m UTF-8 bytes of host:port
 *
 * Without the flag the Relay endpoint is the page's own host:port and its TLS follows the page scheme.
 */
const FORMAT = 0x02, EXPLICIT_ENDPOINT = 0x01, KEY_BYTES = 32
// One format byte, the key, two length bytes, the longest Host ID and endpoint.
const MAX_FRAGMENT = Math.ceil((1 + KEY_BYTES + 1 + 160 + 1 + 255) / 3) * 4
const decodeText = (bytes: Uint8Array) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/[\u0000-\u0020\u007f]/u.test(text)) throw new Error('Invalid connection link.')
  return text
}
const base64urlEncode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const base64urlDecode = (text: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error('Invalid connection link.')
  const raw = text.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '=')), c => c.charCodeAt(0))
}

/**
 * The first two base64url characters identify format 0x02 or 0x03: 'A', then an index in 32..63.
 * The rest is validated by the parser, so a truncated or polluted offer cannot become an absent offer
 * and silently select a saved connection. Other page fragments are not connection links.
 */
export function hasConnectionOffer(input: string): boolean {
  const fragment = new URL(input).hash.slice(1)
  return /^A[g-z0-9_-]/.test(fragment)
}

/** The offer in a link, or null when the link carries none. A malformed offer fragment is refused. */
export function parseConnectionOfferUrl(input: string): ConnectionOffer | null {
  if (!hasConnectionOffer(input)) return null
  const url = new URL(input), fragment = url.hash.slice(1)
  if (fragment.length > MAX_FRAGMENT) throw new Error('Invalid connection link.')
  const bytes = base64urlDecode(fragment)
  if (bytes.length < 1 + KEY_BYTES + 1 || (bytes[0]! & ~EXPLICIT_ENDPOINT) !== FORMAT) throw new Error('Invalid connection link.')
  let at = 1
  const key = bytes.slice(at, at += KEY_BYTES)
  const take = () => {
    const length = bytes[at++]
    if (length === undefined || at + length > bytes.length) throw new Error('Invalid connection link.')
    return decodeText(bytes.slice(at, at += length))
  }
  const serverId = take()
  const explicit = (bytes[0]! & EXPLICIT_ENDPOINT) !== 0
  const endpoint = explicit ? take() : url.host
  if (at !== bytes.length) throw new Error('Invalid connection link.')
  return parseConnectionOffer({ v: 2, serverId, daemonPublicKeyB64: btoa(String.fromCharCode(...key)),
    relay: { endpoint, useTls: url.protocol === 'https:' } })
}

export function connectionOfferUrl(appUrl: string, offer: ConnectionOffer): string {
  const url = new URL(appUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalNetworkHost(url.hostname))) throw new Error('The mobile application requires HTTPS outside the local network.')
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid mobile application address.')
  const value = parseConnectionOffer(offer)
  const key = Uint8Array.from(atob(value.daemonPublicKeyB64), c => c.charCodeAt(0))
  const sameEndpoint = value.relay.endpoint === url.host && value.relay.useTls === (url.protocol === 'https:')
  // A Relay on another host, or with another TLS choice than the page, is written out; TLS then
  // follows the page, so an endpoint whose TLS differs from the page cannot be expressed.
  if (!sameEndpoint && value.relay.useTls !== (url.protocol === 'https:')) throw new Error('The Relay must use the same TLS choice as the mobile page.')
  const text = (s: string) => { const bytes = new TextEncoder().encode(s); if (bytes.length > 255) throw new Error('Invalid connection offer.'); return [bytes.length, ...bytes] }
  const bytes = Uint8Array.from([FORMAT | (sameEndpoint ? 0 : EXPLICIT_ENDPOINT), ...key, ...text(value.serverId), ...(sameEndpoint ? [] : text(value.relay.endpoint))])
  url.hash = base64urlEncode(bytes)
  return url.href
}
