import { BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError, parseImageParams, type AgentMuxRpcImageOwner, type ImageActor, type ImageCallContext,
  type ImageMethod, type ImageOperation, type ImageParamsMap, type ImageResult } from '@agentmux/core'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { AppearanceConfig, BrowserPng } from '../shared/contracts'
import { SCREENSHOT_PIN_CHANNEL } from '../shared/screenshot-pin'
import { themeBootstrap } from './theme-bootstrap'
import { exportScreenshotPng, writeScreenshotFile } from './screenshot-files'
import { nativeImageFromBrowserPng } from './browser-image'

type Pin = { id: string; creation: string; actor: ImageActor; window: BrowserWindow; image: BrowserPng;
  outputs: Map<string, { kind: string; result: Promise<unknown> }> }
type Operation = { fingerprint: string; record: ImageOperation; result: Promise<void> }
const sameActor = (a: ImageActor, b: ImageActor) => a.kind === b.kind && a.id === b.id

/** Owns only fixed-image reference windows and their original operation receipts. */
export class ScreenshotPins implements AgentMuxRpcImageOwner {
  private readonly pins = new Map<string, Pin>()
  private readonly operations = new Map<string, Operation>()
  private disposed = false
  constructor(private readonly ports: { hostId: string; appearance(): AppearanceConfig; copy(image: BrowserPng): Promise<void> }) {
    ipcMain.handle(SCREENSHOT_PIN_CHANNEL, (event, action, input) => this.invoke(event, action, input))
  }

  async call<M extends ImageMethod>(method: M, value: ImageParamsMap[M], context: ImageCallContext): Promise<ImageResult> {
    const input = parseImageParams(method, value)
    if (input.hostId !== this.ports.hostId) throw new AgentMuxError('This image presentation belongs to another Host.', 'CONTROL_PERMISSION_DENIED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
    if (method === 'image.inspect') {
      const selected = input as ImageParamsMap['image.inspect']
      if (selected.operationId !== undefined) {
        const original = this.operations.get(selected.operationId)
        if (original && !sameActor(original.record.actor, context.actor)) throw new AgentMuxError('The original image operation belongs to another actor.', 'CONTROL_PERMISSION_DENIED')
        return this.snapshot(original?.record.pinId ?? null, original?.record ?? null)
      }
      const pin = this.pins.get(selected.pinId!)
      if (pin && !sameActor(pin.actor, context.actor)) throw new AgentMuxError('The original image belongs to another actor.', 'CONTROL_PERMISSION_DENIED')
      return this.snapshot(selected.pinId!, null)
    }
    if (this.disposed) throw new AgentMuxError('The original image presentation owner is closed. Retain the original operation and saved image.', 'CONTROL_UNAVAILABLE')
    const request = input as ImageParamsMap['image.pin'] | ImageParamsMap['image.close']
    if ('pinId' in request) {
      const target = this.pins.get(request.pinId)
      if (target && !sameActor(target.actor, context.actor)) throw new AgentMuxError('The original image belongs to another actor.', 'CONTROL_PERMISSION_DENIED')
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ method, input })).digest('hex')
    const old = this.operations.get(request.operationId)
    if (old) {
      if (!sameActor(old.record.actor, context.actor) || old.fingerprint !== fingerprint)
        throw new AgentMuxError('The original image operation cannot change its actor, target or pixels.', 'CONTROL_PERMISSION_DENIED')
      await old.result
      return this.snapshot(old.record.pinId, old.record)
    }
    const record: ImageOperation = { operationId: request.operationId, method, actor: structuredClone(context.actor),
      pinId: 'pinId' in request ? request.pinId : null, state: 'pending', effect: null, message: null }
    const operation: Operation = { fingerprint, record, result: Promise.resolve() }
    this.operations.set(request.operationId, operation)
    operation.result = (async () => {
      try {
        context.signal?.throwIfAborted(); await context.assertCurrent?.()
        if (this.disposed) throw new AgentMuxError('The original image presentation owner closed before this action. Retain the original operation.', 'CONTROL_UNAVAILABLE')
        if (method === 'image.pin') {
          const p = request as ImageParamsMap['image.pin']
          const image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + p.image.data,
            width: p.image.width, height: p.image.height, byteLength: Buffer.byteLength(p.image.data, 'base64') }
          pngBytes(image)
          nativeImageFromBrowserPng(image, nativeImage.createFromBuffer)
          const pin = this.create(image, record)
          record.pinId = pin.id
          try {
            if (process.env.ELECTRON_RENDERER_URL) await pin.window.loadURL(new URL('screenshot-pin/index.html', process.env.ELECTRON_RENDERER_URL).href)
            else await pin.window.loadFile(join(import.meta.dirname, '../renderer/screenshot-pin/index.html'))
          } catch (error) { if (!pin.window.isDestroyed()) pin.window.destroy(); throw error }
          if (pin.window.isDestroyed() || this.disposed) throw new Error('The original pinned image window closed before opening was confirmed.')
          record.effect = 'opened'
        } else {
          const pin = this.pins.get(record.pinId!)
          if (pin && !sameActor(pin.actor, context.actor)) throw new AgentMuxError('The original image belongs to another actor.', 'CONTROL_PERMISSION_DENIED')
          if (pin && !pin.window.isDestroyed()) {
            await new Promise<void>(resolve => { pin.window.once('closed', resolve); pin.window.close() })
            record.effect = 'closed'
          }
          else record.effect = 'missing'
        }
        record.state = 'completed'
      } catch (error) { record.state = 'failed'; record.effect = null; record.message = error instanceof Error ? error.message : String(error) }
    })()
    await operation.result
    return this.snapshot(record.pinId, record)
  }

  private create(image: BrowserPng, operation: ImageOperation): Pin {
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const scale = Math.min(1, (work.width - 48) / image.width, (work.height - 110) / image.height)
    const window = new BrowserWindow({ title: 'Pinned screenshot', x: work.x + 24, y: work.y + 24,
      width: Math.max(260, Math.round(image.width * scale)), height: Math.max(150, Math.round(image.height * scale) + 44),
      minWidth: 220, minHeight: 120, show: false, alwaysOnTop: true, autoHideMenuBar: true,
      webPreferences: { preload: join(import.meta.dirname, '../preload/screenshot-pin.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })
    const pin: Pin = { id: mintObjectId(), creation: operation.operationId, actor: structuredClone(operation.actor), window, image,
      outputs: new Map() }
    this.pins.set(pin.id, pin)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive() })
    window.once('closed', () => { pin.outputs.clear(); pin.image = { ...image, dataUrl: '', byteLength: 0 } })
    return pin
  }

  private snapshot(id: string | null, operation: ImageOperation | null): ImageResult {
    const pin = id === null ? undefined : this.pins.get(id)
    return { hostId: this.ports.hostId, pinId: id, creationOperationId: pin?.creation ?? null,
      state: pin ? pin.window.isDestroyed() ? 'closed' : 'open' : id === null || operation?.state === 'pending' || operation?.state === 'unknown' ? 'unknown' : 'missing',
      recordedOperation: operation ? structuredClone(operation) : null }
  }

  private async invoke(event: IpcMainInvokeEvent, action: unknown, input: unknown): Promise<unknown> {
    const pin = [...this.pins.values()].find(item => !item.window.isDestroyed() && item.window.webContents === event.sender && event.senderFrame === item.window.webContents.mainFrame)
    if (!pin) throw new Error('This pinned image request does not belong to the original window.')
    if (action === 'load') {
      let theme: import('../shared/theme-bootstrap').ThemeBootstrap
      try { theme = themeBootstrap(this.ports.appearance(), nativeTheme.shouldUseDarkColors) }
      catch (error) { theme = { status: 'unavailable', message: 'Saved appearance could not be read. ' + String(error) } }
      return { pinId: pin.id, image: pin.image, theme }
    }
    const params = input as { pinId?: string; operationId?: string; chromeHeight?: number } | undefined
    if (params?.pinId !== pin.id) throw new Error('Keep the original pinned image identity.')
    if (action === 'close') { pin.window.close(); return }
    if (action === 'layout') {
      if (typeof params.chromeHeight !== 'number' || !Number.isFinite(params.chromeHeight) || params.chromeHeight < 0)
        throw new Error('The pinned image layout has no finite control height.')
      const work = screen.getDisplayMatching(pin.window.getBounds()).workArea
      const extra = Math.min(Math.ceil(params.chromeHeight), Math.max(0, work.height - 120))
      const [width, height] = pin.window.getContentSize(), ratio = pin.image.width / pin.image.height
      const imageHeight = Math.min(width / ratio, Math.max(1, work.height - extra))
      const targetWidth = Math.max(220, Math.round(imageHeight * ratio)), targetHeight = Math.max(120, Math.round(imageHeight) + extra)
      pin.window.setAspectRatio(ratio, { width: 0, height: extra })
      if (Math.abs(targetWidth - width) > 1 || Math.abs(targetHeight - height) > 1) pin.window.setContentSize(targetWidth, targetHeight)
      return
    }
    if (!['copy', 'save'].includes(String(action)) || typeof params.operationId !== 'string' || !params.operationId.trim()) throw new Error('Keep the original pinned image output operation.')
    const old = pin.outputs.get(params.operationId)
    if (old) { if (old.kind !== action) throw new Error('The original image output cannot change its action.'); return await old.result }
    const result = action === 'save' ? exportScreenshotPng(pin.image, {
      chooseFile: async filename => { const selected = await dialog.showSaveDialog(pin.window, { title: 'Save pinned PNG', defaultPath: filename, filters: [{ name: 'PNG image', extensions: ['png'] }] }); return selected.canceled ? null : selected.filePath ?? null },
      writeFile: writeScreenshotFile
    }) : this.ports.copy(pin.image).then(() => ({ status: 'completed' }), error => ({ status: 'failed', message: error instanceof Error ? error.message : String(error) }))
    pin.outputs.set(params.operationId, { kind: String(action), result })
    return await result
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeHandler(SCREENSHOT_PIN_CHANNEL)
    for (const pin of this.pins.values()) if (!pin.window.isDestroyed()) pin.window.destroy()
    // Keep tiny original receipts for in-flight readers; closed handlers release image bytes.
  }
}
