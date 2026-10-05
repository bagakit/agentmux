// Minimal IDB event seam for the DOM harness. Real cross-realm exclusion is
// separately exercised with native IndexedDB in two browser pages.
let tail = Promise.resolve()
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
  open() {
    const opening: any = {}
    opening.result = { createObjectStore() {}, close() {}, transaction() {
      const transaction: any = {}
      let aborted = false
      transaction.abort = () => { aborted = true }
      transaction.objectStore = () => ({ get() {
        const request: any = {}
        const next = tail.then(() => new Promise<void>(resolve => {
          queueMicrotask(() => {
            request.onsuccess?.()
            if (aborted) transaction.onabort?.(); else transaction.oncomplete?.()
            resolve()
          })
        }))
        tail = next.catch(() => {}); return request
      } })
      return transaction
    } }
    queueMicrotask(() => opening.onsuccess?.()); return opening
  }
} })
