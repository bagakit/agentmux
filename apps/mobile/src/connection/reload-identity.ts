import { fileUploadRevision } from '@agentmux/core/files'
import type { KeyPair } from '@agentmux/relay/e2ee'
import type { ConnectionOffer } from '@agentmux/relay/offer'

const key = 'agentmux.mobile-update.identity.v1'
export const mobileUpdateFragment = '#amux-update'
export function reloadOfferIdentity(offer: ConnectionOffer): string {
  return JSON.stringify([offer.v, offer.serverId, offer.daemonPublicKeyB64, offer.relay.endpoint, offer.relay.useTls])
}
function fingerprint(identity: KeyPair, offer: string, recordId: string | null): string {
  const bytes = new Uint8Array(identity.publicKey.length + identity.secretKey.length)
  bytes.set(identity.publicKey); bytes.set(identity.secretKey, identity.publicKey.length)
  return JSON.stringify({ schema: 'agentmux.mobile-update-identity.v1', key: fileUploadRevision(bytes), offer: fileUploadRevision(new TextEncoder().encode(offer)), recordId })
}

/** This Tab retains only fingerprints, never the key or the connection offer. */
export function prepareReloadIdentity(identity: KeyPair, offer: string, recordId: string | null): () => void {
  const expected = fingerprint(identity, offer, recordId), previous = sessionStorage.getItem(key)
  if (previous !== null && previous !== expected) throw new Error('原更新身份交接尚未解决；请先恢复该原连接。')
  if (previous === null) sessionStorage.setItem(key, expected)
  if (sessionStorage.getItem(key) !== expected) throw new Error('原更新身份交接未保存。')
  return () => { if (previous === null && sessionStorage.getItem(key) === expected) sessionStorage.removeItem(key) }
}
export function matchesReloadIdentity(identity: KeyPair, offer: string, recordId: string | null): boolean {
  return sessionStorage.getItem(key) === fingerprint(identity, offer, recordId)
}
export function finishReloadIdentity(identity: KeyPair, offer: string, recordId: string | null): void {
  if (matchesReloadIdentity(identity, offer, recordId)) sessionStorage.removeItem(key)
}
