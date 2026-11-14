import { BrowserWindow, type Session } from 'electron'

/** A private about:blank target in the original native Session. Never attaches a user's debugger,
 * navigates a website, changes focus, or deletes a directory. Storage is Browser-side, so cold keys
 * do not need a matching frame (unlike CacheStorage.requestCacheNames). */
export async function openBrowserProfileStorageNative(session: Session): Promise<{ clear(storageKey: string): Promise<void>; dispose(): void }> {
  const helper = new BrowserWindow({ show: false, webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const dispose = () => { if (!helper.isDestroyed()) helper.destroy() }
  try {
    await helper.loadURL('about:blank')
    helper.webContents.debugger.attach('1.3')
    return {
      async clear(storageKey) {
        // The mask deliberately excludes Cookies, IDB, localStorage and service_workers.
        await helper.webContents.debugger.sendCommand('Storage.clearDataForStorageKey', { storageKey, storageTypes: 'cache_storage' })
      },
      dispose
    }
  } catch (error) { dispose(); throw error }
}
