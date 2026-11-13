import { app, BrowserWindow, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { mintObjectId } from '@agentmux/core/object-id'
import type { ImageOrigin, ImageResult, NativeDesktopPayloadMap } from '@agentmux/core'
import type { NativeDesktop, NativeDisplayFrame } from '@agentmux/native-desktop'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { AppearanceConfig, BrowserPng } from '../shared/contracts'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT, type CaptureSurfaceEvent, type CaptureSurfaceHandoff, type CaptureSurfaceInput,
  type CaptureSurfaceRect } from '../shared/capture-surface'
import type { ScreenshotCaptureSource, SystemScreenshotEditorFinish } from '../shared/system-screenshot-editor'
import { themeBootstrap } from './theme-bootstrap'
import { saveScreenshotPng } from './screenshot-files'

/** Overlays are shown together once every display painted its frozen frame, or after this long at the latest. */
const PRESENT_FALLBACK_MS = 1500

/** One capture's consumer: its primary delivery, and whether ⌘E may move the marks to the window editor. */
export type CaptureSurfaceSession = {
  attachToDraft: boolean
  expandable: boolean
  /** Another app was in front at capture start; closing the surface gives it focus back. */
  returnFocus: boolean
  /** Primary delivery of the processed selection, with the native engine of its frozen frame. A rejection keeps the surface and shows the reason. */
  complete(image: BrowserPng, source: ScreenshotCaptureSource, engine: string): Promise<void>
}
export type CaptureSurfaceOutcome =
  | { state: 'completed' }
  | { state: 'cancelled' }
  /** The marks move to the window editor on this display's full frozen frame; `source.rect` is the selection. */
  | { state: 'expanded'; image: BrowserPng; source: ScreenshotCaptureSource; handoff: CaptureSurfaceHandoff
      /** Called once the window editor delivers this selection, so the next capture opens on it. */
      delivered(): void }

type Ports = {
  native(): Pick<NativeDesktop, 'captureDisplays'>
  appearance(): AppearanceConfig
  pin(image: BrowserPng, operationId: string, origin: ImageOrigin): Promise<ImageResult>
  copyText(text: string): Promise<void>
  /** Gives the app that was in front at capture start its focus back. */
  returnFocus(): void
}
/** `presentedMs`: since present(), when its renderer painted the frozen frame. */
type Overlay = { window: BrowserWindow; input: CaptureSurfaceInput; engine: string | undefined; presented: boolean; presentedMs: number | null }
type Active = {
  session: CaptureSurfaceSession
  overlays: Overlay[]
  capturedAt: number
  /** performance.now() at present(); the timing line counts from here. */
  startedAt: number
  settleMs: number
  framesMs: number | null
  /** The display whose overlay holds the selection; the others only show their frozen frame and cancel. */
  owner: number | null
  shown: boolean
  /** A primary delivery is in flight; a second one would write the clipboard again. */
  finishing: boolean
  fallback: ReturnType<typeof setTimeout> | undefined
  /** AgentMux windows faded out of the grab with the opacity each had (a pin keeps its own), and the one that had focus. */
  faded: Array<{ window: BrowserWindow; opacity: number }>
  focused: BrowserWindow | null
  end(outcome: CaptureSurfaceOutcome | Error): void
}
/** The selection the last primary delivery confirmed, with its display as it was then; this process only, never persisted. */
type Recall = { displayId: number; frame: CaptureSurfaceRect; scale: number; rect: CaptureSurfaceRect }

/** Desktop's one capture surface: a transparent overlay per display over that display's frozen frame. */
export class CaptureSurface {
  private active: Active | null = null
  private disposed = false
  private recall: Recall | null = null

  constructor(private readonly ports: Ports) {
    ipcMain.handle(CAPTURE_SURFACE_CHANNEL, (event, action, input) => this.invoke(event, action, input))
  }

  present(session: CaptureSurfaceSession): Promise<CaptureSurfaceOutcome> {
    if (this.disposed) return Promise.reject(new Error('Screen capture is closed. Start a new capture after AgentMux restarts.'))
    // The GUI and the public capture both present here; a second surface would cover the first one's displays.
    if (this.active) return Promise.reject(new Error('A screen capture is already in progress. Finish or cancel that selection, then try again.'))
    let end!: Active['end']
    const result = new Promise<CaptureSurfaceOutcome>((resolve, reject) => {
      end = outcome => {
        if (this.active !== active) return
        this.active = null
        screen.removeListener('display-added', changed); screen.removeListener('display-removed', changed); screen.removeListener('display-metrics-changed', resized)
        app.removeListener('before-quit', cancel)
        clearTimeout(active.fallback)
        for (const overlay of active.overlays) if (!overlay.window.isDestroyed()) overlay.window.destroy()
        // Focus goes back before the faded windows return, so a workbench that is about to hide never flashes.
        if (outcome instanceof Error || outcome.state !== 'expanded') {
          if (session.returnFocus) this.ports.returnFocus()
          else if (active.focused && !active.focused.isDestroyed()) active.focused.focus()
        }
        for (const { window, opacity } of active.faded) if (!window.isDestroyed()) window.setOpacity(opacity)
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
    })
    const active: Active = { session, overlays: [], capturedAt: 0, startedAt: performance.now(), settleMs: 0, framesMs: null, owner: null, shown: false, finishing: false, fallback: undefined, faded: [], focused: null, end }
    const changed = () => active.end(Object.assign(new Error('The display layout changed during this capture, so its selection no longer matches the screen. Take the screenshot again.'),
      { code: 'display_configuration_changed' }))
    // A work area change (Dock or menu bar) leaves every frozen frame where it was; bounds, scale or rotation do not.
    const resized = (_event: unknown, _display: unknown, metrics: string[]) => { if (metrics.some(metric => metric !== 'workArea')) changed() }
    const cancel = () => active.end({ state: 'cancelled' })
    this.active = active
    screen.on('display-added', changed); screen.on('display-removed', changed); screen.on('display-metrics-changed', resized)
    app.once('before-quit', cancel)
    void this.start(active).catch(error => active.end(error))
    return result
  }

  private async start(active: Active): Promise<void> {
    active.focused = BrowserWindow.getFocusedWindow()
    // Step out without leaving the stacking order or focus, so nothing flashes in the Dock or Mission Control.
    // A window already at opacity 0 is out of the grab and keeps its own value.
    active.faded = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible() && !window.isMinimized())
      .map(window => ({ window, opacity: window.getOpacity() })).filter(({ opacity }) => opacity > 0)
    for (const { window } of active.faded) window.setOpacity(0)
    // Only a window that was on screen can be in the grab; with none faded the grab starts at once.
    if (active.faded.length && process.platform === 'darwin') {
      await new Promise(resolve => setTimeout(resolve, stepOutSettleMs()))
      active.settleMs = since(active.startedAt)
    }
    if (this.active !== active) return
    const frames = await this.ports.native().captureDisplays()
    if (this.active !== active) return
    active.framesMs = since(active.startedAt)
    active.capturedAt = frames.capturedAt
    const displays = screen.getAllDisplays()
    let theme: CaptureSurfaceInput['theme']
    try { theme = themeBootstrap(this.ports.appearance(), nativeTheme.shouldUseDarkColors) }
    catch (error) { theme = { status: 'unavailable', message: 'Saved appearance could not be loaded. ' + message(error) } }
    const placed = frames.displays.map(frame => {
      const bounds = displays.find(display => display.id === frame.displayId)?.bounds
      if (!bounds || bounds.x !== frame.frame.x || bounds.y !== frame.frame.y || bounds.width !== frame.frame.width || bounds.height !== frame.frame.height)
        throw Object.assign(new Error('The display layout changed while the screen was captured. Take the screenshot again.'), { code: 'display_configuration_changed' })
      return { frame, input: overlayInput(frame, active.session, theme, this.recalled(frame)) }
    })
    for (const { frame, input } of placed) {
      const window = new BrowserWindow({
        ...frame.frame, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, roundedCorners: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
        alwaysOnTop: true, enableLargerThanScreen: true, title: 'Screenshot', ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        webPreferences: { preload: join(import.meta.dirname, '../preload/capture-surface.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
      })
      const overlay: Overlay = { window, input, engine: frame.engine, presented: false, presentedMs: null }
      active.overlays.push(overlay)
      raise(window, frame.frame)
      window.once('ready-to-show', () => raise(window, frame.frame))
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-attach-webview', event => event.preventDefault())
      window.webContents.once('render-process-gone', () => active.end(new Error('The screenshot overlay stopped responding. Take the screenshot again.')))
      window.once('closed', () => active.end({ state: 'cancelled' }))
    }
    // A renderer that never reports presented must not leave the workbench faded out with no visible overlay to cancel.
    active.fallback = setTimeout(() => this.show(active), PRESENT_FALLBACK_MS)
    await Promise.all(active.overlays.map(({ window }) => process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(new URL('screenshot-editor/index.html', process.env.ELECTRON_RENDERER_URL).href)
      : window.loadFile(join(import.meta.dirname, '../renderer/screenshot-editor/index.html'))))
  }

  /** Every overlay at once, so no display shows the live desktop while another is frozen; keys go to the display under the pointer. */
  private show(active: Active): void {
    if (this.active !== active || active.shown) return
    active.shown = true
    // One line per capture, so a packaged build started from a terminal shows where the time before the first frame went.
    console.info('capture-surface timing ' + JSON.stringify({ settleMs: active.settleMs, framesMs: active.framesMs,
      presentedMs: active.overlays.map(overlay => overlay.presentedMs), shownMs: since(active.startedAt), displays: active.overlays.length }))
    for (const { window } of active.overlays) window.showInactive()
    const pointer = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    const target = active.overlays.find(overlay => overlay.input.displayId === pointer) ?? active.overlays[0]
    // A remembered selection is the one Enter and the arrows act on, so its display takes the keys.
    const keys = active.overlays.find(overlay => overlay.input.initialCrop) ?? target
    if (process.platform === 'darwin') app.focus({ steal: true })
    keys?.window.focus()
  }

  private async invoke(event: IpcMainInvokeEvent, action: unknown, input: unknown): Promise<unknown> {
    const active = this.active, overlay = active?.overlays.find(row => row.window.webContents === event.sender)
    if (!active || !overlay || overlay.window.isDestroyed() || event.senderFrame !== overlay.window.webContents.mainFrame)
      throw new Error('This screenshot overlay does not belong to the current capture.')
    if (action === 'load') return overlay.input
    const params = input as { requestId?: unknown; operationId?: unknown; image?: BrowserPng; selection?: CaptureSurfaceRect; text?: unknown; handoff?: CaptureSurfaceHandoff } | undefined
    if (params?.requestId !== overlay.input.requestId) throw new Error('The original screenshot request is no longer current.')
    if (action === 'presented') {
      overlay.presented = true
      overlay.presentedMs ??= since(active.startedAt)
      if (active.overlays.every(row => row.presented)) this.show(active)
      return
    }
    if (action === 'cancel') { active.end({ state: 'cancelled' }); return }
    if (action === 'select') {
      if (overlay.input.image === undefined || (active.owner !== null && active.owner !== overlay.input.displayId)) return false
      if (active.owner === null) {
        active.owner = overlay.input.displayId
        for (const other of active.overlays) if (other !== overlay) send(other, { kind: 'locked' })
      }
      return true
    }
    // A sampled color is copied from the loupe, which also shows before any selection exists.
    if (action === 'copy-text') {
      if (typeof params.text !== 'string' || !params.text) throw new Error('Keep the exact text to copy.')
      return await this.ports.copyText(params.text).then((): SystemScreenshotEditorFinish => ({ status: 'completed' }), error => ({ status: 'failed', message: message(error) }))
    }
    if (active.owner !== overlay.input.displayId) throw new Error('Only the display that holds the selection can output it.')
    if (action === 'expand') {
      if (!active.session.expandable) throw new Error('This capture returns its selection directly. Finish it with Done or cancel it.')
      const handoff = params.handoff
      if (!handoff || !Array.isArray(handoff.shapes) || typeof handoff.tool !== 'string' || !handoff.crop) throw new Error('Keep the original marks and selection to expand.')
      const source = this.source(active, overlay, handoff.crop), remembered = this.remember(overlay, source.rect)
      active.end({ state: 'expanded', image: overlay.input.image!, source, handoff, delivered: () => { this.recall = remembered } })
      return
    }
    pngBytes(params.image!)
    if (action === 'save-png') return await saveScreenshotPng(params.image!, overlay.window, { capturedAt: active.capturedAt })
    const source = this.source(active, overlay, params.selection)
    if (action === 'pin') {
      if (typeof params.operationId !== 'string' || !params.operationId.trim()) throw new Error('Keep the original pin operation.')
      // The pin opens on the selection at the image's own logical size.
      const pinned = await this.ports.pin(params.image!, params.operationId, { ...source.rect, width: params.image!.width / source.scale, height: params.image!.height / source.scale })
      // A pin is a final output: the open surface would show the same selection beside it. A failed or unconfirmed pin keeps the surface and its status.
      if (pinned.recordedOperation?.state === 'completed') active.end({ state: 'completed' })
      return pinned
    }
    if (action !== 'finish') throw new Error('The screenshot overlay request is invalid.')
    if (active.finishing) return { status: 'failed', message: 'The previous copy is still in progress. Cancel remains available.' } satisfies SystemScreenshotEditorFinish
    active.finishing = true
    try { await active.session.complete(params.image!, source, overlay.engine!) }
    catch (error) { return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorFinish }
    finally { active.finishing = false }
    this.recall = this.remember(overlay, source.rect)
    active.end({ state: 'completed' })
    return { status: 'completed' } satisfies SystemScreenshotEditorFinish
  }

  /** The remembered selection in this frame's pixels, only on its own display while that display's frame and scale are unchanged. */
  /** The selection a delivery confirms, with its display as it was then. */
  private remember(overlay: Overlay, rect: CaptureSurfaceRect): Recall {
    return { displayId: overlay.input.displayId, frame: overlay.input.frame, scale: overlay.input.scale, rect }
  }
  private recalled({ displayId, frame, scale }: NativeDisplayFrame): CaptureSurfaceHandoff['crop'] | undefined {
    const last = this.recall
    if (!last || last.displayId !== displayId || last.scale !== scale || !sameRect(last.frame, frame)) return undefined
    return { x: Math.round((last.rect.x - frame.x) * scale), y: Math.round((last.rect.y - frame.y) * scale),
      width: Math.round(last.rect.width * scale), height: Math.round(last.rect.height * scale) }
  }

  /** The selection in global points: this display's origin plus its frozen-frame pixels over the display scale. */
  private source(active: Active, overlay: Overlay, selection: CaptureSurfaceRect | undefined): ScreenshotCaptureSource {
    const { frame, scale, image } = overlay.input
    if (!selection || ![selection.x, selection.y, selection.width, selection.height].every(Number.isFinite) || selection.width <= 0 || selection.height <= 0
      || selection.x < 0 || selection.y < 0 || selection.x + selection.width > image!.width || selection.y + selection.height > image!.height)
      throw new Error('The selection must stay inside its display.')
    return { rect: { x: frame.x + selection.x / scale, y: frame.y + selection.y / scale, width: selection.width / scale, height: selection.height / scale }, scale, capturedAt: active.capturedAt }
  }

  /** The public selection capture: the same surface without ⌘E, returning the processed selection as Core's public capture result. */
  async captureSelection(returnFocus: boolean): Promise<NativeDesktopPayloadMap['native.capture']> {
    let result: NativeDesktopPayloadMap['native.capture'] | null = null
    try {
      const outcome = await this.present({ attachToDraft: false, expandable: false, returnFocus, complete: async (image, source, engine) => {
        result = { state: 'captured', engine, selectionRect: source.rect,
          screenshot: { format: 'png', data: image.dataUrl.slice('data:image/png;base64,'.length), width: image.width, height: image.height, scale: source.scale } }
      } })
      return outcome.state === 'completed' && result ? result : { state: 'cancelled' }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return { state: 'failed', error: { code: typeof code === 'string' && code ? code : 'capture_failed', message: message(error) } }
    }
  }

  /** Bring the surface forward with a status; false when no capture surface is open. */
  notice(text: string): boolean {
    const active = this.active
    if (!active) return false
    const target = active.overlays.find(overlay => overlay.input.displayId === active.owner) ?? active.overlays[0]
    if (target && !target.window.isDestroyed()) { target.window.focus(); send(target, { kind: 'notice', message: text }) }
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeHandler(CAPTURE_SURFACE_CHANNEL)
    this.active?.end({ state: 'cancelled' })
  }
}

function overlayInput(frame: NativeDisplayFrame, session: CaptureSurfaceSession, theme: CaptureSurfaceInput['theme'], initialCrop: CaptureSurfaceHandoff['crop'] | undefined): CaptureSurfaceInput {
  const base = { requestId: mintObjectId(), displayId: frame.displayId, frame: frame.frame, scale: frame.scale, attachToDraft: session.attachToDraft, expandable: session.expandable, theme }
  if (frame.issue !== undefined) return { ...base, issue: frame.issue }
  const image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + frame.png, width: frame.width, height: frame.height, byteLength: Buffer.byteLength(frame.png, 'base64') }
  pngBytes(image)
  return { ...base, image, windows: displayWindows(frame, image), ...(initialCrop ? { initialCrop } : {}) }
}

/** Native's global window bounds as this frame's pixels, clipped to the frame; windows off it are dropped and the order is kept. */
function displayWindows({ frame, scale, windows }: NativeDisplayFrame, image: BrowserPng): CaptureSurfaceRect[] {
  return windows.flatMap(({ frame: bounds }) => {
    const x = Math.max(0, (bounds.x - frame.x) * scale), y = Math.max(0, (bounds.y - frame.y) * scale)
    const width = Math.min(image.width, (bounds.x + bounds.width - frame.x) * scale) - x
    const height = Math.min(image.height, (bounds.y + bounds.height - frame.y) * scale) - y
    return width > 0 && height > 0 ? [{ x, y, width, height }] : []
  })
}
function sameRect(a: CaptureSurfaceRect, b: CaptureSurfaceRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
/** Above full-screen apps and the menu bar on every Space; set again after the first paint because mixed-scale displays can misplace the first bounds. */
function raise(window: BrowserWindow, bounds: CaptureSurfaceRect): void {
  if (window.isDestroyed()) return
  window.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  window.setBounds(bounds)
}
function send(overlay: Overlay, event: CaptureSurfaceEvent): void {
  if (!overlay.window.isDestroyed()) overlay.window.webContents.send(CAPTURE_SURFACE_EVENT, event)
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
/** setOpacity(0) commits to WindowServer at the end of this run loop turn and is composited on the next refresh;
 *  a second refresh covers a commit that just missed one. Counted on the slowest display, never shorter than two 60 Hz frames. */
function stepOutSettleMs(): number {
  const hz = Math.min(60, ...screen.getAllDisplays().map(display => display.displayFrequency).filter(frequency => frequency > 0))
  return Math.ceil(2000 / hz)
}
function since(start: number): number { return Math.round(performance.now() - start) }
