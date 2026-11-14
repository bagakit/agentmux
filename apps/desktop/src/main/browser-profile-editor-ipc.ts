import { parseBrowserProfileControlPayload, isBrowserProfileCreationOperation, type AgentMuxNameActor, type BrowserProfileControlPayload, type BrowserProfileCreationOperation } from '@agentmux/core/control'
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
  actor?: () => AgentMuxNameActor | undefined
  openBookmark?: (input: import('./browser-profile-bookmark-open.js').BrowserProfileBookmarkOpen, url: string) => Promise<void>
}): void {
  const creationInput = (raw: unknown) => {
    const input = parseBrowserProfileControlPayload(raw as Record<string, unknown>, ['operation'])
    if (!isBrowserProfileCreationOperation(input.operation)) throw new Error('An exact Profile creation request is required.')
    return input as Extract<BrowserProfileControlPayload, { operation: BrowserProfileCreationOperation }>
  }
  ports.handle('browser:createProfileIdentity', (_event, raw: unknown) => ipcResult(async () => {
    const input = creationInput(raw); await ports.profiles.initialize()
    return ports.profiles.createIdentity(input, ports.actor?.())
  }))
  ports.handle('browser:confirmProfileCreation', (_event, raw: unknown) => ipcResult(async () => {
    const input = creationInput(raw); await ports.profiles.initialize()
    return ports.profiles.confirmIdentity(input, ports.actor?.())
  }))
  ports.handle('browser:inspectProfileCreation', (_event, operationId: string) => ipcResult(async () => {
    await ports.profiles.initialize(); return ports.profiles.inspectCreation(operationId, ports.actor?.())
  }))
  ports.handle('browser:prepareProfileCookieImport',(_event,profileId:string,operationId:string,source:import('@agentmux/core/control').BrowserProfileCookieFileLocation,scope:import('@agentmux/core/control').BrowserProfileCookieScope)=>ipcResult(async()=>{await ports.profiles.initialize();return ports.profiles.cookieFiles.prepareImport(profileId,operationId,source,scope)}))
  ports.handle('browser:importProfileCookies',(_event,profileId:string,reviewId:string)=>ipcResult(async()=>{await ports.profiles.initialize();return ports.profiles.cookieFiles.import(profileId,reviewId)}))
  ports.handle('browser:exportProfileCookies',(_event,profileId:string,operationId:string,destination:import('@agentmux/core/control').BrowserProfileCookieFileLocation,scope:import('@agentmux/core/control').BrowserProfileCookieScope)=>ipcResult(async()=>{await ports.profiles.initialize();return ports.profiles.cookieFiles.export(profileId,operationId,destination,scope)}))
  ports.handle('browser:inspectProfileCookieFiles',(_event,profileId:string,operationId?:string,offset?:number,limit?:number)=>ipcResult(async()=>{await ports.profiles.initialize();return ports.profiles.cookieFiles.inspect(profileId,operationId,offset,limit)}))
  ports.handle('browser:discardProfileCookieImport',(_event,profileId:string,reviewId:string)=>ipcResult(async()=>{await ports.profiles.initialize();return ports.profiles.cookieFiles.discard(profileId,reviewId)}))
  ports.handle('browser:revealProfileCookieFile',(_event,profileId:string,operationId:string)=>ipcResult(async()=>{await ports.profiles.initialize();return ports.profiles.cookieFiles.reveal(profileId,operationId)}))
  ports.handle('browser:listProfileBookmarks', (_event, profileId: string, folderId: string | null, operationId?: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.bookmarks.list(profileId, folderId, operationId) }))
  ports.handle('browser:editProfileBookmark', (_event, profileId: string, revision: string, operationId: string, change: import('@agentmux/core/control').BrowserProfileBookmarkChange) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.bookmarks.edit(profileId, revision, operationId, change) }))
  ports.handle('browser:importProfileBookmarks', (_event, profileId: string, folderId: string | null, revision: string, operationId: string, sourcePath: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.bookmarks.import(profileId, folderId, revision, operationId, sourcePath) }))
  ports.handle('browser:exportProfileBookmarks', (_event, profileId: string, folderId: string | null, revision: string, operationId: string, destinationPath: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.bookmarks.export(profileId, folderId, revision, operationId, destinationPath) }))
  ports.handle('browser:openProfileBookmark', (_event, profileId: string, bookmarkId: string, browserId: string, revision: string, operationId: string) => ipcResult(async () => {
    await ports.profiles.initialize()
    if (!ports.openBookmark) throw new Error('Bookmark opening is unavailable in this Browser host. The original library is kept.')
    return ports.profiles.bookmarks.open(profileId, bookmarkId, browserId, revision, operationId, url => ports.openBookmark!({ profileId, browserId, operationId }, url))
  }))
  ports.handle('browser:inspectProfileStorage', (_event, profileId: string, operationId?: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.storage.inspect(profileId, operationId) }))
  ports.handle('browser:clearProfileStorage', (_event, input: import('@agentmux/core/control').BrowserProfileStorageClearInput) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.storage.clear(input) }))
  ports.handle('browser:listProfileExtensions', (_event, id: string, operationId?: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.list(id, operationId) }))
  ports.handle('browser:checkProfileExtensionUpdate', (_event, id: string, extensionId: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.check(id, extensionId) }))
  ports.handle('browser:prepareProfileExtension', (_event, id: string, revision: string, operationId: string, source: import('@agentmux/core/control').BrowserProfileExtensionPreparationSource, extensionId?: string) => ipcResult(async () => { await ports.profiles.initialize(); return ports.profiles.extensions.review(id, revision, operationId, source, extensionId) }))
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
