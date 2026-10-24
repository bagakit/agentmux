import { afterEach, expect, it, vi } from 'vitest'
import { exportPublicKey, exportSecretKey, generateKeyPair } from '@agentmux/relay/e2ee'
import { existingDeviceRelayIdentity } from '../src/connection/relay-identity'
import { finishReloadIdentity, matchesReloadIdentity, prepareReloadIdentity } from '../src/connection/reload-identity'

afterEach(() => vi.restoreAllMocks())

it('reads the existing original key through a readonly transaction', async () => {
  const key = generateKeyPair(), saved = { publicKey: exportPublicKey(key.publicKey), secretKey: exportSecretKey(key.secretKey) }
  let current: any
  const get = vi.fn(() => { const request: any = { result: saved }; queueMicrotask(() => { request.onsuccess(); current.oncomplete() }); return request })
  const transaction = vi.fn(() => { current = { objectStore: () => ({ get }) }; return current })
  vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    const opening: any = { result: { transaction, close() {} } }
    queueMicrotask(() => opening.onsuccess()); return opening
  })
  const loaded = await existingDeviceRelayIdentity()
  expect(loaded?.publicKey).toEqual(key.publicKey)
  expect(loaded?.secretKey).toEqual(key.secretKey)
  expect(transaction).toHaveBeenCalledExactlyOnceWith('identity', 'readonly')
  expect(get).toHaveBeenCalledExactlyOnceWith('device')
})

it('aborts creation if the original identity database is missing', async () => {
  const abort = vi.fn()
  vi.spyOn(indexedDB, 'open').mockImplementation(() => {
    const opening: any = { transaction: { abort }, error: new Error('missing identity') }
    queueMicrotask(() => { opening.onupgradeneeded(); opening.onerror() })
    return opening
  })
  await expect(existingDeviceRelayIdentity()).rejects.toThrow('missing identity')
  expect(abort).toHaveBeenCalledOnce()
})

it('retains an unresolved handoff and binds it to the exact original key and offer', () => {
  sessionStorage.clear()
  const original = generateKeyPair(), other = generateKeyPair()
  const rollback = prepareReloadIdentity(original, 'original-offer', 'original-record')
  expect(matchesReloadIdentity(original, 'original-offer', 'original-record')).toBe(true)
  expect(matchesReloadIdentity(original, 'other-offer', 'original-record')).toBe(false)
  expect(matchesReloadIdentity(other, 'original-offer', 'original-record')).toBe(false)
  expect(matchesReloadIdentity(original, 'original-offer', 'replacement-record')).toBe(false)
  expect(() => prepareReloadIdentity(other, 'original-offer', 'original-record')).toThrow('尚未解决')
  expect(matchesReloadIdentity(original, 'original-offer', 'original-record')).toBe(true)
  finishReloadIdentity(other, 'original-offer', 'original-record')
  expect(matchesReloadIdentity(original, 'original-offer', 'original-record')).toBe(true)
  rollback()
  expect(matchesReloadIdentity(original, 'original-offer', 'original-record')).toBe(false)
})
