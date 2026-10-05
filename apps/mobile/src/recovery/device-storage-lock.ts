export const DEVICE_WORKFACE_KEY = 'agentmux-mobile-workface-v1'

/** IndexedDB readwrite transactions are exclusive across same-origin pages,
 * including LAN HTTP. This database stores no workface facts or credentials. */
export async function withDeviceStorageLock<T>(action: () => T): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let declined = false
    const opening = indexedDB.open('agentmux-device-workface-write-lock', 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore('write-lock')
    opening.onsuccess = () => { if (declined) opening.result.close(); else resolve(opening.result) }
    opening.onerror = () => reject(opening.error ?? new Error('设备工作面写锁无法打开'))
    opening.onblocked = () => { declined = true; reject(new Error('设备工作面写锁升级尚未完成；当前内容保留，可导出备份。')) }
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('write-lock', 'readwrite')
      let result: T, failure: unknown
      const request = transaction.objectStore('write-lock').get(DEVICE_WORKFACE_KEY)
      request.onsuccess = () => {
        // Keep the complete localStorage read/merge/set synchronous in this
        // active IDB callback. Awaiting external work would release the lock.
        try { result = action() } catch (error) { failure = error; transaction.abort() }
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('设备工作面写入事务尚未确认'))
    })
  } finally { database.close() }
}
