import { BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { mintObjectId } from '@agentmux/core/object-id'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { AppearanceConfig, BrowserPng } from '../shared/contracts'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL, type SystemScreenshotEditorFinish, type SystemScreenshotEditorInput } from '../shared/system-screenshot-editor'
import { themeBootstrap } from './theme-bootstrap'

type EditRequest = {
  window: BrowserWindow
  input: SystemScreenshotEditorInput
  complete(image: BrowserPng): Promise<void>
  settle(): void
  pending: boolean
  attempts: Map<string, Promise<SystemScreenshotEditorFinish>>
}

/** Owns only a disposable image editing window. It never acquires a workface or Agent identity. */
export class SystemScreenshotEditor {
  private current: EditRequest | null = null
  private disposed = false

  constructor(private readonly readAppearance: () => AppearanceConfig = () => ({ terminalTheme: 'graphite' })) {
    ipcMain.handle(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, (event, action, input) => this.invoke(event, action, input))
  }

  async edit(image: BrowserPng, attachToDraft: boolean, complete: (image: BrowserPng) => Promise<void>, initialIssue?: string): Promise<void> {
    if (this.disposed) throw new Error('The screenshot editor is closed. Start a new capture to edit another image.')
    if (this.current) throw new Error('A screenshot is already being edited. Finish or cancel that image first.')
    pngBytes(image)
    let theme: SystemScreenshotEditorInput['theme']
    try { theme = themeBootstrap(this.readAppearance(), nativeTheme.shouldUseDarkColors) }
    catch (error) { theme = { status: 'unavailable', message: 'Saved appearance could not be loaded. ' + message(error) } }
    const window = new BrowserWindow({
      title: 'Screenshot', width: 1040, height: 760, minWidth: 360, minHeight: 300,
      show: false, autoHideMenuBar: true,
      ...(theme.status === 'available' && theme.variables['--surface-0'] ? { backgroundColor: theme.variables['--surface-0'] } : {}),
      webPreferences: { preload: join(import.meta.dirname, '../preload/screenshot-editor.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
    })
    let settle!: () => void
    const closed = new Promise<void>(resolve => { settle = resolve })
    const request: EditRequest = { window, input: { requestId: mintObjectId(), image, attachToDraft, theme, ...(initialIssue ? { initialIssue } : {}) }, complete, settle,
      pending: false, attempts: new Map() }
    this.current = request
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    window.once('closed', () => {
      if (this.current === request) this.current = null
      request.settle()
    })
    window.once('ready-to-show', () => {
      if (this.current === request && !window.isDestroyed()) { window.show(); window.focus() }
    })
    try {
      if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(new URL('screenshot-editor/index.html', process.env.ELECTRON_RENDERER_URL).href)
      else await window.loadFile(join(import.meta.dirname, '../renderer/screenshot-editor/index.html'))
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
    await closed
  }

  private async invoke(event: IpcMainInvokeEvent, action: unknown, input: unknown): Promise<unknown> {
    const request = this.current
    // Both the exact contents and main frame are required. Other windows and embedded frames own no image here.
    if (!request || request.window.isDestroyed() || event.sender !== request.window.webContents || event.senderFrame !== request.window.webContents.mainFrame)
      throw new Error('This screenshot editor request does not belong to the current window.')
    if (action === 'load') return request.input
    const params = input as { requestId?: unknown; operationId?: unknown; image?: BrowserPng } | undefined
    if (params?.requestId !== request.input.requestId) throw new Error('The original screenshot request is no longer current.')
    if (action === 'cancel') { request.window.close(); return }
    if (action !== 'finish' || typeof params.operationId !== 'string' || !params.operationId.trim())
      throw new Error('The screenshot completion request is invalid.')
    const existing = request.attempts.get(params.operationId)
    if (existing) return await existing
    if (request.pending) return { status: 'failed', message: 'The previous copy is still in progress. Cancel remains available.' } satisfies SystemScreenshotEditorFinish
    pngBytes(params.image!)
    request.pending = true
    const attempt = this.finish(request, params.image!)
    request.attempts.set(params.operationId, attempt)
    return await attempt
  }

  private async finish(request: EditRequest, image: BrowserPng): Promise<SystemScreenshotEditorFinish> {
    try {
      await request.complete(image)
      // An earlier accepted delivery can settle after Cancel. It never closes or reopens another editor.
      if (this.current === request && !request.window.isDestroyed()) request.window.close()
      return { status: 'completed' }
    } catch (error) {
      return { status: 'failed', message: message(error) }
    } finally { request.pending = false }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeHandler(SYSTEM_SCREENSHOT_EDITOR_CHANNEL)
    if (this.current && !this.current.window.isDestroyed()) this.current.window.destroy()
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
