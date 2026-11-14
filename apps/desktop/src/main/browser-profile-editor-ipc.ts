import type { IpcMainInvokeEvent } from 'electron'
import type { BrowserProfileManager } from './browser-profile-manager.js'
import type { BrowserProfileEdit, BrowserProfileList } from '../shared/contracts.js'
import { ipcResult } from '../shared/ipc-result.js'

export function readBrowserProfileSnapshot(profiles: BrowserProfileManager): BrowserProfileList {
  return {
    revision: profiles.listRevision(),
    sequence: profiles.listSequence(),
    profiles: profiles.listProfiles(),
    folders: profiles.listFolders(),
    views: profiles.listViews(),
    proxies: profiles.listProxies()
  }
}

/** Uses Main's trusted-frame registrar and the existing Profile owner. */
export function registerBrowserProfileEditorIpc(ports: {
  handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
  ): void
  profiles: BrowserProfileManager
}): void {
  ports.handle('browser:readProfiles', () =>
    ipcResult(async () => {
      await ports.profiles.initialize()
      await ports.profiles.refresh()
      return readBrowserProfileSnapshot(ports.profiles)
    })
  )
  ports.handle(
    'browser:updateProfile',
    (_event, id: string, edit: BrowserProfileEdit, expectedRevision: string) =>
      ipcResult(() => ports.profiles.updateProfile(id, edit, expectedRevision))
  )
}
