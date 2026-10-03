import { generateKeyPair, exportPublicKey, exportSecretKey, importPublicKey, importSecretKey, type KeyPair } from '@agentmux/relay/e2ee'

/** Device-owned key, retained across encrypted reconnects; never placed in a URL or localStorage. */
export async function deviceRelayIdentity(): Promise<KeyPair> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('agentmux-relay-identity', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('identity')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const pair = generateKeyPair()
    const generated = { publicKey: exportPublicKey(pair.publicKey), secretKey: exportSecretKey(pair.secretKey) }
    const value = await new Promise<typeof generated>((resolve, reject) => {
      const transaction = database.transaction('identity', 'readwrite'), store = transaction.objectStore('identity')
      let saved = generated
      const request = store.get('device')
      request.onsuccess = () => { if (request.result !== undefined) saved = request.result; else store.put(generated, 'device') }
      transaction.oncomplete = () => resolve(saved)
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Device identity cannot be saved'))
    })
    return { publicKey: importPublicKey(value.publicKey), secretKey: importSecretKey(value.secretKey) }
  } finally { database.close() }
}
