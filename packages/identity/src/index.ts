import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'

/** New product IDs are opaque, fixed-width Base58; existing IDs need their original owner's validation. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{12}$/u.test(value)
}

/** Reject the entire overflowing sample; truncation or modulo would bias the 58^12 space. */
function encodeObjectId(bytes: Uint8Array): string | null {
  const id = base58.encode(bytes)
  return id.length <= 12 ? id.padStart(12, '1') : null
}

/** Browser/Node portable allocation: 9 secure random bytes, rejection sampled to about 70.3 bits. */
export function mintObjectId(): string {
  for (;;) {
    const id = encodeObjectId(globalThis.crypto.getRandomValues(new Uint8Array(9)))
    if (id !== null) return id
  }
}

/** Stable business-domain identity. Resolve already persisted bindings before deriving a new identity. */
export function deriveObjectId(domain: string, key: string): string {
  // A fixed nonempty domain without ':' keeps domain/nonce/key framing unambiguous.
  // The key is opaque and kept byte-for-byte, including colons and whitespace.
  if (!domain || domain.includes(':')) throw new TypeError('An identity domain must be nonempty and contain no colon.')
  for (let nonce = 0; ; nonce++) {
    const digest = sha256(new TextEncoder().encode(`${domain}:${nonce}:${key}`))
    const id = encodeObjectId(digest.slice(0, 9))
    if (id !== null) return id
  }
}
