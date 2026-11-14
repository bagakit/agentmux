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
  ports.handle('browser:listProfileExtensions', (_event, id: string, operationId?: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.list(id, operationId) }))
  ports.handle('browser:prepareProfileExtension', (_event, id: string, revision: string, operationId: string, source: string, extensionId?: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.review(id, revision, operationId, source, extensionId) }))
  ports.handle('browser:applyProfileExtension', (_event, id: string, revision: string, reviewId: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.apply(id, revision, reviewId) }))
  ports.handle('browser:removeProfileExtension', (_event, id: string, revision: string, extensionId: string, operationId: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.remove(id, revision, extensionId, operationId) }))
  ports.handle('browser:loadProfileExtension', (_event, id: string, extensionId: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.load(id, extensionId) }))
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
