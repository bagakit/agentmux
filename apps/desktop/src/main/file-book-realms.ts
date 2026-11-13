import { WORKSPACE_FILE_PREVIEW_FORMATS } from '@agentmux/editor-extensions/catalog'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { BookOpenRequest, OpenedBook } from '@agentmux/editor-extensions/book-reader/protocol'
import type { WorkspaceFileSources } from './workspace-file-sources'
import type { WorkspaceCbrArchives } from './workspace-cbr-archives'

type Realm = { id: string; caller: number; source: string; window: BrowserWindow; reads: Set<string>; closed: boolean }
const formats = new Set(Object.values(WORKSPACE_FILE_PREVIEW_FORMATS).flatMap(format => format.kind === 'book' ? [format.engine] : []))

/** A source-bound, bridge-free parser process for each visible book. No book document runs in the App realm. */
export class FileBookRealms {
  private readonly realms = new Map<string, Realm>()
  private readonly rendererFile: string
  private readonly rendererUrl: string | undefined
  private readonly preload: string
  private readonly channels: string[] = []
  constructor(private readonly sources: WorkspaceFileSources, private readonly archives: WorkspaceCbrArchives,
    options: { rendererFile?: string; rendererUrl?: string; preload?: string } = {}) {
    this.rendererFile = options.rendererFile ?? join(import.meta.dirname, '../renderer/book-reader/index.html')
    const dev = options.rendererUrl ?? process.env.ELECTRON_RENDERER_URL
    this.rendererUrl = dev ? new URL('book-reader/index.html', dev.endsWith('/') ? dev : dev + '/').href : undefined
    this.preload = options.preload ?? join(import.meta.dirname, '../preload/book-reader.cjs')
    const handle = (channel: string, consume: (realm: Realm, ...values: any[]) => unknown) => {
      this.channels.push(channel)
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...values: unknown[]) => {
        const realm = [...this.realms.values()].find(value => value.window.webContents === event.sender && !value.closed)
        if (!realm || event.senderFrame !== event.sender.mainFrame) throw new Error('This document has no book source capability')
        return consume(realm, ...values)
      })
    }
    const operation = async <T>(realm: Realm, id: string, consume: () => Promise<T>) => {
      if (typeof id !== 'string' || !id || realm.reads.has(id)) throw new Error('A book read requires a unique operation')
      realm.reads.add(id)
      try { return await consume() } finally { realm.reads.delete(id) }
    }
    handle('book-reader:read', (realm, id: string, offset: number, length: number) => operation(realm, id, () => this.sources.read(realm.caller, realm.source, id, offset, length)))
    handle('book-reader:entries', (realm, id: string) => operation(realm, id, () => this.archives.entries(realm.caller, realm.source, id)))
    handle('book-reader:entry', (realm, id: string, path: string) => operation(realm, id, () => this.archives.readEntry(realm.caller, realm.source, id, path)))
    handle('book-reader:cancel', (realm, id: string) => { this.sources.cancel(realm.caller, realm.source, id) })
  }

  async open(caller: number, request: BookOpenRequest): Promise<OpenedBook> {
    if (!request || !formats.has(request.format) || typeof request.name !== 'string' || !Number.isSafeInteger(request.size) || request.size < 0) throw new Error('This book request has an invalid format or size')
    const proof = await this.sources.read(caller, request.sourceId, randomUUID(), 0, 0)
    if (proof.status !== 'read') throw Object.assign(new Error(proof.message), { code: proof.code })
    const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: {
      preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, devTools: false, backgroundThrottling: false,
    } })
    const realm: Realm = { id: randomUUID(), caller, source: request.sourceId, window, reads: new Set(), closed: false }
    this.realms.set(realm.id, realm)
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.once('render-process-gone', () => this.release(realm))
    window.once('closed', () => this.release(realm))
    try {
      if (this.rendererUrl) await window.loadURL(this.rendererUrl)
      else await window.loadFile(this.rendererFile)
      if (realm.closed) throw new Error('Book reading was cancelled')
      const book = await this.call(realm, 'open', request)
      if (realm.closed) throw new Error('Book reading was cancelled')
      return { id: realm.id, book }
    } catch (error) { this.release(realm); throw error }
  }
  private owned(caller: number, id: string): Realm {
    const realm = this.realms.get(id)
    if (!realm || realm.closed || realm.caller !== caller) throw new Error('This book view is unavailable for this caller. Reload the original File to read it again.')
    return realm
  }
  private call(realm: Realm, method: 'open' | 'load' | 'unload' | 'resolve', ...args: unknown[]): Promise<any> {
    return realm.window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await window.__agentmuxBookRuntime.${method}(...${JSON.stringify(args)})}}catch(error){return {ok:false,error:{message:error instanceof Error?error.message:String(error),code:typeof error?.code==='string'?error.code:'BOOK_READER_FAILED'}}}})()`).then(result => {
      if (!result.ok) throw Object.assign(new Error(result.error.message), {code: result.error.code})
      return result.value
    })
  }
  async load(caller: number, id: string, index: number): Promise<string> {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('This book section is invalid')
    const realm = this.owned(caller, id), url = await this.call(realm, 'load', index)
    this.owned(caller, id)
    if (typeof url !== 'string' || !url.startsWith('blob:')) throw new Error('The reader did not return a local book document')
    return url
  }
  async unload(caller: number, id: string, index: number): Promise<void> { await this.call(this.owned(caller, id), 'unload', index) }
  resolve(caller: number, id: string, href: string, fromSection?: number) { return this.call(this.owned(caller, id), 'resolve', href, fromSection) }
  close(caller: number, id: string): void { const realm = this.realms.get(id); if (!realm) return; this.owned(caller, id); this.release(realm) }
  private release(realm: Realm): void {
    if (realm.closed) return
    realm.closed = true; this.realms.delete(realm.id)
    for (const id of realm.reads) this.sources.cancel(realm.caller, realm.source, id)
    if (!realm.window.isDestroyed()) realm.window.destroy() // Terminates synchronous parsing in this exact isolated process too.
  }
  releaseSource(caller: number, id: string): void { for (const realm of [...this.realms.values()]) if (realm.caller === caller && realm.source === id) this.release(realm) }
  releaseCaller(caller: number): void { for (const realm of [...this.realms.values()]) if (realm.caller === caller) this.release(realm) }
  dispose(): void { for (const realm of [...this.realms.values()]) this.release(realm); for (const channel of this.channels) ipcMain.removeHandler(channel) }
}
