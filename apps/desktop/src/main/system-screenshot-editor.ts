import { BrowserWindow, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent, type Rectangle } from 'electron'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mintObjectId } from '@agentmux/core/object-id'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { AppearanceConfig, BrowserPng } from '../shared/contracts'
import { SYSTEM_SCREENSHOT_EDITOR_CHANNEL, SYSTEM_SCREENSHOT_EDITOR_NOTICE, type ScreenshotEditContext, type SystemScreenshotEditorFinish, type SystemScreenshotEditorInput,
  type SystemScreenshotEditorRetake } from '../shared/system-screenshot-editor'
import { themeBootstrap } from './theme-bootstrap'
import { saveScreenshotPng } from './screenshot-files'
import type { ScreenshotOriginalApi, ScreenshotOriginalReadResult, ScreenshotOriginalSaveInput, ScreenshotOriginalSaveResult } from '../shared/screenshot-original'

type EditRequest = {
  window: BrowserWindow
  input: SystemScreenshotEditorInput
  complete(image: BrowserPng): Promise<void>
  retake: ScreenshotEditContext['retake']
  settle(): void
  pending: boolean
  attempts: Map<string, Promise<SystemScreenshotEditorFinish>>
  attemptFingerprints: Map<string, string>
  originals: (ScreenshotOriginalApi & { dispose?(): void }) | undefined
  originalReads: Map<string, Promise<ScreenshotOriginalReadResult>>
  originalSaves: Map<string, { fingerprint: string; pending: boolean; result?: ScreenshotOriginalSaveResult; promise: Promise<ScreenshotOriginalSaveResult> }>
  contexts: Map<string, { text: string; result: Promise<SystemScreenshotEditorFinish> }>
}

/** Owns only a disposable image editing window. It never acquires a workface or Agent identity. */
export class SystemScreenshotEditor {
  private readonly requests = new Map<IpcMainInvokeEvent['sender'], EditRequest>()
  private disposed = false

  constructor(private readonly readAppearance: () => AppearanceConfig = () => ({ terminalTheme: 'graphite' }),
    private readonly outputs?: { pin(image: BrowserPng, operationId: string, origin?: import('@agentmux/core').ImageOrigin): Promise<import('@agentmux/core').ImageResult>;
      inspectPin?(operationId: string): Promise<import('@agentmux/core').ImageResult>;
      copyText?(text: string): Promise<void>;
      /** Give the previous app focus back; called when the last editor of a capture taken from another app closes. */
      returnFocus?(): void;
      recognizeText?(image: BrowserPng): Promise<import('@agentmux/native-desktop').NativeRecognizedText>;
      originalFiles?(window: BrowserWindow): ScreenshotOriginalApi & { dispose?(): void } }) {
    ipcMain.handle(SYSTEM_SCREENSHOT_EDITOR_CHANNEL, (event, action, input) => this.invoke(event, action, input))
  }

  async edit(image: BrowserPng, attachToDraft: boolean, complete: (image: BrowserPng) => Promise<void>, { source, returnFocus, initialState, initialTool, retake }: ScreenshotEditContext = {}): Promise<void> {
    if (this.disposed) throw new Error('The screenshot editor is closed. Start a new capture to edit another image.')
    pngBytes(image)
    let theme: SystemScreenshotEditorInput['theme']
    try { theme = themeBootstrap(this.readAppearance(), nativeTheme.shouldUseDarkColors) }
    catch (error) { theme = { status: 'unavailable', message: 'Saved appearance could not be loaded. ' + message(error) } }
    const window = new BrowserWindow({
      title: 'Screenshot', ...editorBounds(source?.rect), minWidth: 360, minHeight: 300,
      show: false, autoHideMenuBar: true,
      ...(theme.status === 'available' && theme.variables['--surface-0'] ? { backgroundColor: theme.variables['--surface-0'] } : {}),
      webPreferences: { preload: join(import.meta.dirname, '../preload/screenshot-editor.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
    })
    let settle!: () => void
    const closed = new Promise<void>(resolve => { settle = resolve })
    const request: EditRequest = { window, input: { requestId: mintObjectId(), image, attachToDraft, theme, ...(!this.outputs?.recognizeText ? { textUnavailableReason: 'On-device text recognition is not supported by this host. Open this image on the macOS Desktop to use it.' } : {}), ...(source ? { source } : {}), ...(retake ? { retakable: true } : {}),
      ...(initialState ? { initialState, initialTool } : {}) }, complete, retake, settle,
      pending: false, attempts: new Map(), attemptFingerprints: new Map(), originals: this.outputs?.originalFiles?.(window), originalReads: new Map(), originalSaves: new Map(), contexts: new Map() }
    const contents = window.webContents
    this.requests.set(contents, request)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    window.once('closed', () => {
      if (this.requests.get(contents) === request) this.requests.delete(contents)
      request.originals?.dispose?.()
      request.settle()
    })
    // Closed from the editor itself (not after the user moved to another AgentMux window), and no
    // other editor is left: hand focus back instead of letting macOS raise the workbench.
    if (returnFocus) window.once('close', () => {
      const focused = BrowserWindow.getFocusedWindow()
      if (focused === null || focused === window) window.once('closed', () => { if (this.requests.size === 0 && !this.disposed) this.outputs?.returnFocus?.() })
    })
    window.once('ready-to-show', () => {
      if (this.requests.get(window.webContents) === request && !window.isDestroyed()) { window.show(); window.focus() }
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
    const request = this.requests.get(event.sender)
    // Both the exact contents and main frame are required. Other windows and embedded frames own no image here.
    if (!request || request.window.isDestroyed() || event.senderFrame !== request.window.webContents.mainFrame)
      throw new Error('This screenshot editor request does not belong to the current window.')
    if (action === 'load') return request.input
    const params = input as { requestId?: unknown; operationId?: unknown; image?: BrowserPng; text?: unknown; grantId?: unknown; document?: ScreenshotOriginalSaveInput; logicalSize?: unknown } | undefined
    if (params?.requestId !== request.input.requestId) throw new Error('The original screenshot request is no longer current.')
    if (action === 'recognize-text') {
      if (!this.outputs?.recognizeText) throw new Error(request.input.textUnavailableReason)
      pngBytes(params.image!); return await this.outputs.recognizeText(params.image!)
    }
    if (action === 'cancel') { request.window.close(); return }
    if (action === 'retake') {
      if (!request.retake) throw new Error('This image did not come from a region capture, so it cannot be retaken here. Your image and editing remain available.')
      // The capture surface steps this window out of its grab with every visible AgentMux window and brings it back when it
      // ends; this editor's renderer, marks and bridge stay as they are. present() refuses a second capture while one is open.
      let state: Awaited<ReturnType<NonNullable<EditRequest['retake']>>>
      try { state = await request.retake() }
      catch (error) { return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorRetake }
      if (state === 'cancelled') return { status: 'cancelled' } satisfies SystemScreenshotEditorRetake
      // The new capture took over (delivered, or moved into its own editor), so this one closes in the same turn it came back.
      if (!request.window.isDestroyed()) request.window.close()
      return { status: 'completed' } satisfies SystemScreenshotEditorRetake
    }
    if (['open-original', 'save-original', 'inspect-original', 'original-operation'].includes(String(action))) {
      if (!request.originals) throw new Error('Original files are unavailable in this host. Your image and editing remain available.')
      if (action === 'inspect-original') {
        if (typeof params.grantId !== 'string') throw new Error('Keep the original file grant.')
        return await request.originals.inspect(params.grantId)
      }
      if (typeof params.operationId !== 'string' || !params.operationId.trim()) throw new Error('Keep the original file operation.')
      if (action === 'original-operation') {
        const original = request.originalSaves.get(params.operationId)
        return original ? original.pending ? { status: 'pending' } : original.result ?? null : null
      }
      if (action === 'open-original') {
        const previous = request.originalReads.get(params.operationId)
        if (previous) return await previous
        const result = request.originals.open()
        request.originalReads.set(params.operationId, result)
        return await result
      }
      const fingerprint = JSON.stringify(params.document), previous = request.originalSaves.get(params.operationId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('The original file save cannot change its content or target.')
        return await previous.promise
      }
      const attempt: { fingerprint: string; pending: boolean; result?: ScreenshotOriginalSaveResult; promise: Promise<ScreenshotOriginalSaveResult> } = {
        fingerprint, pending: true, promise: Promise.resolve({ status: 'unknown', message: 'The original save has not been observed.' }) }
      request.originalSaves.set(params.operationId, attempt)
      attempt.promise = request.originals.save(params.document!).then(result => { attempt.result = result; return result }, error => {
        const result: ScreenshotOriginalSaveResult = { status: 'unknown', message: `The original file write is unconfirmed. ${message(error)} Inspect that operation before another save.` }
        attempt.result = result; return result
      }).finally(() => { attempt.pending = false })
      return await attempt.promise
    }
    if (action === 'context') {
      if (typeof params.operationId !== 'string' || !params.operationId.trim() || typeof params.text !== 'string') throw new Error('Keep the original context copy and complete text.')
      const previous = request.contexts.get(params.operationId)
      if (previous) {
        if (previous.text !== params.text) throw new Error('The original context copy cannot change its text.')
        return await previous.result
      }
      if (!this.outputs?.copyText) throw new Error('Context copy is unavailable in this host. Your image and editing remain available.')
      const result = this.outputs.copyText(params.text).then(() => ({ status: 'completed' as const }), error => ({ status: 'failed' as const, message: message(error) }))
      request.contexts.set(params.operationId, { text: params.text, result })
      return await result
    }
    if (action === 'inspect-pin') {
      if (typeof params.operationId !== 'string' || !params.operationId.trim()) throw new Error('Keep the original pin operation.')
      if (!this.outputs?.inspectPin) throw new Error('Pin inspection is unavailable in this host. Your image and other outputs remain available.')
      return await this.outputs.inspectPin(params.operationId)
    }
    if (action === 'pin') {
      if (typeof params.operationId !== 'string' || !params.operationId.trim()) throw new Error('Keep the original pin operation.')
      pngBytes(params.image!)
      if (!this.outputs) throw new Error('Pinned image presentation is unavailable in this host. Your image and editing remain available.')
      // The pin opens where the capture was taken, at the image's own logical size; an edit may have cropped it.
      const source = request.input.source
      return await this.outputs.pin(params.image!, params.operationId, source
        ? { x: source.rect.x, y: source.rect.y, width: params.image!.width / source.scale, height: params.image!.height / source.scale } : undefined)
    }
    if (action === 'save-png') {
      if (params.logicalSize !== undefined && typeof params.logicalSize !== 'boolean') throw new Error('Choose PNG pixels or 1× logical size.')
      const source = request.input.source
      if (params.logicalSize && !source) throw new Error('This image has no display scale, so it cannot be saved at 1×. Save PNG keeps its pixels.')
      return await saveScreenshotPng(params.image!, request.window,
        { capturedAt: source?.capturedAt ?? Date.now(), ...(params.logicalSize ? { logicalScale: source!.scale } : {}) })
    }
    if (action !== 'finish' || typeof params.operationId !== 'string' || !params.operationId.trim())
      throw new Error('The screenshot completion request is invalid.')
    const existing = request.attempts.get(params.operationId)
    if (existing && request.attemptFingerprints.get(params.operationId) !== createHash('sha256').update(JSON.stringify(params.image)).digest('hex'))
      throw new Error('The original screenshot copy cannot change its image.')
    if (existing) return await existing
    if (request.pending) return { status: 'failed', message: 'The previous copy is still in progress. Cancel remains available.' } satisfies SystemScreenshotEditorFinish
    pngBytes(params.image!)
    request.pending = true
    const attempt = this.finish(request, params.image!)
    request.attemptFingerprints.set(params.operationId, createHash('sha256').update(JSON.stringify(params.image)).digest('hex'))
    request.attempts.set(params.operationId, attempt)
    return await attempt
  }

  private async finish(request: EditRequest, image: BrowserPng): Promise<SystemScreenshotEditorFinish> {
    try {
      await request.complete(image)
      // Resolve only this capture's original destination. Its editable image stays open.
      request.settle()
      return { status: 'completed' }
    } catch (error) {
      return { status: 'failed', message: message(error) }
    } finally { request.pending = false }
  }

  /** Bring the newest editor forward with a status; false when no editor is open. */
  notice(message: string): boolean {
    const request = [...this.requests.values()].at(-1)
    if (!request || request.window.isDestroyed()) return false
    request.window.show(); request.window.focus()
    request.window.webContents.send(SYSTEM_SCREENSHOT_EDITOR_NOTICE, message)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeHandler(SYSTEM_SCREENSHOT_EDITOR_CHANNEL)
    for (const request of this.requests.values()) if (!request.window.isDestroyed()) request.window.destroy()
    this.requests.clear()
  }
}

/** Open the editor centred on the display that holds the capture, clamped into its work area. */
function editorBounds(rect: Rectangle | undefined): Partial<Rectangle> & { width: number; height: number } {
  if (!rect) return { width: 1040, height: 760 }
  const work = screen.getDisplayMatching(rect).workArea
  const width = Math.min(1040, work.width), height = Math.min(760, work.height)
  return { width, height, x: Math.round(work.x + (work.width - width) / 2), y: Math.round(work.y + (work.height - height) / 2) }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
