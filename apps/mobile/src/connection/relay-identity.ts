import { generateKeyPair, exportPublicKey, exportSecretKey, importPublicKey, importSecretKey, type KeyPair } from '@agentmux/relay/e2ee'

/** Read the existing key without creating or replacing a device identity. */
export async function existingDeviceRelayIdentity(): Promise<KeyPair | null> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('agentmux-relay-identity')
    request.onupgradeneeded = () => request.transaction?.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Device identity cannot be read'))
  })
  try {
    const value = await new Promise<{ publicKey: string; secretKey: string } | undefined>((resolve, reject) => {
      const transaction = database.transaction('identity', 'readonly')
      const request = transaction.objectStore('identity').get('device')
      let saved: { publicKey: string; secretKey: string } | undefined
      request.onsuccess = () => { saved = request.result }
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => resolve(saved)
      transaction.onabort = () => reject(transaction.error ?? new Error('Device identity cannot be read'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Device identity cannot be read'))
    })
    return value ? { publicKey: importPublicKey(value.publicKey), secretKey: importSecretKey(value.secretKey) } : null
  } finally { database.close() }
}

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
