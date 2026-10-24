export const DEVICE_WORKFACE_KEY = 'agentmux-mobile-workface-v1'

/** IndexedDB readwrite transactions are exclusive across same-origin pages,
 * including LAN HTTP. This database stores no workface facts or credentials. */
export async function withDeviceStorageLock<T>(action: () => T, signal?: AbortSignal): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    let declined = false
    const cancel = () => { declined = true; reject(new DOMException('设备记录等待已取消。', 'AbortError')) }
    if (signal?.aborted) { cancel(); return }
    signal?.addEventListener('abort', cancel, { once: true })
    const opening = indexedDB.open('agentmux-device-workface-write-lock', 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore('write-lock')
    opening.onsuccess = () => { signal?.removeEventListener('abort', cancel); if (declined) opening.result.close(); else resolve(opening.result) }
    opening.onerror = () => { signal?.removeEventListener('abort', cancel); reject(opening.error ?? new Error('设备工作面写锁无法打开')) }
    opening.onblocked = () => { signal?.removeEventListener('abort', cancel); declined = true; reject(new Error('设备工作面写锁升级尚未完成；当前内容保留，可导出备份。')) }
  })
  try {
    return await new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('设备记录等待已取消。', 'AbortError')); return }
      const transaction = database.transaction('write-lock', 'readwrite')
      let result: T, failure: unknown
      const cancel = () => {
        failure = new DOMException('设备记录等待已取消。', 'AbortError')
        try { transaction.abort() } catch { reject(failure) }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      const request = transaction.objectStore('write-lock').get(DEVICE_WORKFACE_KEY)
      request.onsuccess = () => {
        // Keep the complete localStorage read/merge/set synchronous in this
        // active IDB callback. Awaiting external work would release the lock.
        try { if (signal?.aborted) { cancel(); return }; result = action() } catch (error) { failure = error; transaction.abort() }
      }
      transaction.oncomplete = () => { signal?.removeEventListener('abort', cancel); resolve(result) }
      transaction.onerror = transaction.onabort = () => { signal?.removeEventListener('abort', cancel); reject(failure ?? transaction.error ?? new Error('设备工作面写入事务尚未确认')) }
    })
  } finally { database.close() }
}
