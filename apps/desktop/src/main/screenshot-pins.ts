import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, type IpcMainInvokeEvent, type NativeImage, type Rectangle } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxError, parseImageParams, type AgentMuxRpcImageOwner, type ImageActor, type ImageCallContext,
  type ImageMethod, type ImageOperation, type ImageOrigin, type ImageParamsMap, type ImageResult } from '@agentmux/core'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { AppearanceConfig, BrowserPng } from '../shared/contracts'
import { SCREENSHOT_PIN_CHANNEL, type ScreenshotPinInput } from '../shared/screenshot-pin'
import { themeBootstrap } from './theme-bootstrap'
import { saveScreenshotPng, screenshotFileName } from './screenshot-files'
import { nativeImageFromBrowserPng } from './browser-image'

type Pin = { id: string; creation: string; createdAt: number; actor: ImageActor; window: BrowserWindow; image: BrowserPng;
  /** Image pixels per on-screen point of its origin; 1 when the pin has no origin. */
  logicalScale: number
  /** The PNG file written on the first drag-out, removed when the pin closes. */
  drag?: { file: string; icon: NativeImage }
  outputs: Map<string, { kind: string; result: Promise<unknown> }> }
/** Smallest pin side, so its controls stay usable after opening small or zooming out. */
const PIN_MIN = 96
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
          const pin = this.create(image, record, p.origin)
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

  private create(image: BrowserPng, operation: ImageOperation, origin: ImageOrigin | undefined): Pin {
    const bounds = pinBounds(image, origin)
    // Frameless: the image is the whole window. macOS keeps its rounded corners and shadow;
    // the page moves it from a drag handle and the aspect lock keeps resizing exact.
    const window = new BrowserWindow({ title: 'Pinned screenshot', ...bounds, useContentSize: true, frame: false, hasShadow: true,
      show: false, alwaysOnTop: true, autoHideMenuBar: true,
      webPreferences: { preload: join(import.meta.dirname, '../preload/screenshot-pin.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })
    window.setAspectRatio(image.width / image.height)
    const pin: Pin = { id: mintObjectId(), creation: operation.operationId, createdAt: Date.now(), actor: structuredClone(operation.actor), window, image,
      logicalScale: origin ? Math.max(image.width / origin.width, image.height / origin.height) : 1, outputs: new Map() }
    this.pins.set(pin.id, pin)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive() })
    window.once('closed', () => {
      pin.outputs.clear(); pin.image = { ...image, dataUrl: '', byteLength: 0 }
      if (pin.drag) void rm(dirname(pin.drag.file), { recursive: true, force: true }).catch(error => console.warn('Pinned image drag file cleanup failed:', error))
    })
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
      return { pinId: pin.id, image: pin.image, theme, logicalScale: pin.logicalScale } satisfies ScreenshotPinInput
    }
    const params = input as { pinId?: string; operationId?: string; logicalSize?: unknown; factor?: unknown; point?: { x?: unknown; y?: unknown };
      position?: { x?: unknown; y?: unknown }; opacity?: unknown; enabled?: unknown } | undefined
    if (params?.pinId !== pin.id) throw new Error('Keep the original pinned image identity.')
    if (action === 'close') { pin.window.close(); return }
    if (action === 'zoom') {
      const { factor, point } = params
      if (typeof factor !== 'number' || !(Number.isFinite(factor) && factor > 0) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        throw new Error('Zoom needs a positive finite factor and a point inside this pinned image.')
      const bounds = pin.window.getBounds(), work = screen.getDisplayMatching(bounds).workArea
      // Zoom out stops at the smallest usable side; zoom in stops at the work area.
      const next = fit(pin.image, bounds.width / pin.image.width * factor, work), applied = Math.round(pin.image.width * next) / bounds.width
      // Keep the image point under the pointer still while the window grows or shrinks.
      pin.window.setBounds(sized(pin.image, next, { x: bounds.x + (point.x as number) * (1 - applied), y: bounds.y + (point.y as number) * (1 - applied) }, work))
      return
    }
    if (action === 'move') {
      const { position } = params
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('Moving needs a finite window position.')
      pin.window.setPosition(Math.round(position.x as number), Math.round(position.y as number))
      return
    }
    if (action === 'opacity') {
      if (typeof params.opacity !== 'number' || !(params.opacity >= 0.2 && params.opacity <= 1)) throw new Error('Pinned image opacity must be between 20% and 100%.')
      pin.window.setOpacity(params.opacity)
      return
    }
    if (action === 'click-through') {
      if (typeof params.enabled !== 'boolean') throw new Error('Choose whether clicks pass through this pinned image.')
      // forward keeps mouse moves reaching the page, so its restore handle can turn click-through off.
      if (params.enabled) pin.window.setIgnoreMouseEvents(true, { forward: true })
      else pin.window.setIgnoreMouseEvents(false)
      return
    }
    if (action === 'drag') {
      pin.drag ??= writeDragFile(pin)
      event.sender.startDrag(pin.drag)
      return
    }
    if (params.logicalSize !== undefined && typeof params.logicalSize !== 'boolean') throw new Error('Choose PNG pixels or 1× logical size.')
    if (!['copy', 'save'].includes(String(action)) || typeof params.operationId !== 'string' || !params.operationId.trim()) throw new Error('Keep the original pinned image output operation.')
    const old = pin.outputs.get(params.operationId)
    if (old) { if (old.kind !== action) throw new Error('The original image output cannot change its action.'); return await old.result }
    // A pin carries no capture time, so its saved file is named by the time the pin opened.
    const result = action === 'save' ? saveScreenshotPng(pin.image, pin.window, { capturedAt: pin.createdAt, ...(params.logicalSize ? { logicalScale: pin.logicalScale } : {}) }) : this.ports.copy(pin.image).then(() => ({ status: 'completed' }), error => ({ status: 'failed', message: error instanceof Error ? error.message : String(error) }))
    pin.outputs.set(params.operationId, { kind: String(action), result })
    return await result
  }

  hasOpenPins(): boolean {
    return [...this.pins.values()].some(pin => !pin.window.isDestroyed())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeHandler(SCREENSHOT_PIN_CHANNEL)
    for (const pin of this.pins.values()) if (!pin.window.isDestroyed()) pin.window.destroy()
    // Keep tiny original receipts for in-flight readers; closed handlers release image bytes.
  }
}

/** Opens over `origin` when given (fitted inside it), else near the pointer at pixel size; always inside the work area. */
function pinBounds(image: BrowserPng, origin: ImageOrigin | undefined): Rectangle {
  if (!origin) {
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    return sized(image, fit(image, 1, { width: work.width - 48, height: work.height - 48 }), { x: work.x + 24, y: work.y + 24 }, work)
  }
  const work = screen.getDisplayMatching({ x: Math.round(origin.x), y: Math.round(origin.y), width: Math.ceil(origin.width), height: Math.ceil(origin.height) }).workArea
  return sized(image, fit(image, Math.min(origin.width / image.width, origin.height / image.height), work), origin, work)
}
/** The requested scale, raised to the smallest usable side and then reduced only if it would not fit the area. */
function fit(image: BrowserPng, scale: number, area: { width: number; height: number }): number {
  return Math.min(Math.max(scale, PIN_MIN / image.width, PIN_MIN / image.height), area.width / image.width, area.height / image.height)
}
function sized(image: BrowserPng, scale: number, at: { x: number; y: number }, work: Rectangle): Rectangle {
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale))
  const clamp = (value: number, start: number, room: number) => Math.min(Math.max(Math.round(value), start), start + Math.max(0, room))
  return { width, height, x: clamp(at.x, work.x, work.width - width), y: clamp(at.y, work.y, work.height - height) }
}
/** The drag must start inside this dragstart, so the one-time file write is synchronous. */
function writeDragFile(pin: Pin): { file: string; icon: NativeImage } {
  const directory = join(app.getPath('temp'), 'agentmux-pins', pin.id), file = join(directory, screenshotFileName(pin.createdAt)), bytes = pngBytes(pin.image)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(file, bytes, { mode: 0o600 })
  const thumbnail = nativeImage.createFromBuffer(bytes)
  return { file, icon: thumbnail.resize(pin.image.width >= pin.image.height ? { width: 64 } : { height: 64 }) }
}
