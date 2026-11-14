import { app, BrowserWindow, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { ImageOrigin, ImageResult, NativeDesktopPayloadMap } from '@agentmux/core'
import type { NativeDesktop, NativeDisplayFrame, NativeDisplayFrames } from '@agentmux/native-desktop'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { AppearanceConfig, BrowserPng } from '../shared/contracts'
import { CAPTURE_SURFACE_CHANNEL, CAPTURE_SURFACE_EVENT, startCaptureRequestTiming, type CaptureSurfaceEvent, type CaptureSurfaceHandoff, type CaptureSurfaceInput,
  type CaptureSurfaceRect, type CaptureBackground, type CaptureSurfaceFrame, type CaptureRequestTiming, type CaptureRendererTiming } from '../shared/capture-surface'
import type { ScreenshotCaptureSource, SystemScreenshotEditorFinish } from '../shared/system-screenshot-editor'
import { themeBootstrap } from './theme-bootstrap'
import { saveScreenshotPng } from './screenshot-files'

/** Overlays are shown together once every display painted its frozen frame, or after this long at the latest. */
const PRESENT_FALLBACK_MS = 1500

/** One capture's consumer: its primary delivery, and whether ⌘E may move the marks to the window editor. */
export type CaptureSurfaceContinuation = { displayId: number; frame: CaptureSurfaceRect; scale: number; rect: CaptureSurfaceRect }
export type CaptureSurfaceSession = {
  attachToDraft: boolean
  /** Initial Desktop background; public native selection passes excluded explicitly. */
  background?: CaptureBackground
  /** The registered shortcut's request clock; other entries start at present. */
  timing?: CaptureRequestTiming
  /** Explicit geometry from Copy in this same ScreenCapture.capture call; never retained by CaptureSurface. */
  continuation?: CaptureSurfaceContinuation
  /** Public native selection requires its requested source; the GUI may explicitly switch frozen backgrounds. */
  allowBackgroundFallback?: boolean
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
      /** Returns the delivered geometry for an explicit Retake in the same capture call. No document history crosses into the new surface. */
      delivered(): CaptureSurfaceContinuation }

/** Latest capture's phase offsets only; never pixels, filenames or draft content. */
export type CaptureSurfaceNativeTiming = { response: NativeDisplayFrames['timing']; displays: Array<{ displayId: number; timing: NativeDisplayFrame['timing'] }> }
export type CaptureSurfaceTiming = {
  schema: 'agentmux.capture-timing.v2'
  requestId: string
  final: boolean
  recordedAt: number
  physicalKeydownToCallbackMs: null
  callbackToPrepareMs: number | null
  prepareMs: number | null
  screenCaptureMs: number | null
  presentMs: number | null
  windowsStartedMs: number | null
  windowsLoadedMs: Array<number | null>
  includedMs: number | null
  /** Null when no visible host required a second exposure. */
  excludedMs: number | null
  nativeIncluded: CaptureSurfaceNativeTiming | null
  nativeExcluded: CaptureSurfaceNativeTiming | null
  dataReadyMs: number | null
  framesMs: number | null
  rendererMs: Array<CaptureRendererTiming | null>
  presentedMs: Array<number | null>
  shownMs: number
  showEventMs: Array<number | null>
  actualVisible: boolean[]
  displays: number
}

type Ports = {
  native(): Pick<NativeDesktop, 'captureDisplays'>
  appearance(): AppearanceConfig
  pin(image: BrowserPng, operationId: string, origin: ImageOrigin): Promise<ImageResult>
  copyText(text: string): Promise<void>
  /** Gives the app that was in front at capture start its focus back. */
  returnFocus(): void
  recordTiming?(timing: CaptureSurfaceTiming): Promise<void>
}
/** `presentedMs`: since present(), when its renderer painted the frozen frame. */
type Overlay = { window: BrowserWindow; display: { id: number; bounds: CaptureSurfaceRect; scaleFactor: number }; input?: CaptureSurfaceInput;
  loadedMs: number | null; presented: boolean; presentedMs: number | null; showEventMs: number | null; rendererMs: CaptureRendererTiming | null }
type Active = {
  requestId: string
  requestTiming: CaptureRequestTiming
  revision: number
  session: CaptureSurfaceSession
  overlays: Overlay[]
  background: CaptureBackground
  /** performance.now() at present(); the timing line counts from here. */
  startedAt: number
  inputsReady: Promise<void>
  releaseInputs(): void
  windowsStartedMs: number | null
  includedMs: number | null
  excludedMs: number | null
  nativeIncluded: CaptureSurfaceNativeTiming | null
  nativeExcluded: CaptureSurfaceNativeTiming | null
  dataReadyMs: number | null
  framesMs: number | null
  /** The display whose overlay holds the selection; the others only show their frozen frame and cancel. */
  owner: number | null
  shown: boolean
  backupSettled: boolean
  finalTimingExpected: boolean
  finalTimingWritten: boolean
  /** A primary delivery is in flight; a second one would write the clipboard again. */
  finishing: boolean
  fallback: ReturnType<typeof setTimeout> | undefined
  /** Visible, unminimized, non-transparent hosts at capture start decide whether native exclusion needs a second exposure. */
  visibleHosts: number
  focused: BrowserWindow | null
  end(outcome: CaptureSurfaceOutcome | Error): void
}
/** Desktop's one capture surface: a transparent overlay per display over that display's frozen frame. */
export class CaptureSurface {
  private active: Active | null = null
  private disposed = false

  constructor(private readonly ports: Ports) {
    ipcMain.handle(CAPTURE_SURFACE_CHANNEL, (event, action, input) => this.invoke(event, action, input))
  }

  present(session: CaptureSurfaceSession): Promise<CaptureSurfaceOutcome> {
    if (this.disposed) return Promise.reject(new Error('Screen capture is closed. Start a new capture after AgentMux restarts.'))
    // The GUI and the public capture both present here; a second surface would cover the first one's displays.
    if (this.active) return Promise.reject(new Error('A screen capture is already in progress. Finish or cancel that selection, then try again.'))
    let releaseInputs!: () => void
    const inputsReady = new Promise<void>(resolve => { releaseInputs = resolve })
    let end!: Active['end']
    const result = new Promise<CaptureSurfaceOutcome>((resolve, reject) => {
      end = outcome => {
        if (this.active !== active) return
        this.active = null
        active.releaseInputs()
        screen.removeListener('display-added', changed); screen.removeListener('display-removed', changed); screen.removeListener('display-metrics-changed', resized)
        app.removeListener('before-quit', cancel)
        clearTimeout(active.fallback)
        for (const overlay of active.overlays) if (!overlay.window.isDestroyed()) overlay.window.destroy()
        if (outcome instanceof Error || outcome.state !== 'expanded') {
          if (session.returnFocus) this.ports.returnFocus()
          else if (active.focused && !active.focused.isDestroyed()) active.focused.focus()
        }
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
    })
    const requestTiming = session.timing ?? startCaptureRequestTiming()
    requestTiming.presentMs ??= since(requestTiming.startedAt)
    const active: Active = { requestId: requestTiming.requestId, requestTiming, revision: 1, session, overlays: [], background: session.background ?? 'included', startedAt: requestTiming.startedAt, inputsReady, releaseInputs,
      windowsStartedMs: null, includedMs: null, excludedMs: null, nativeIncluded: null, nativeExcluded: null, dataReadyMs: null, framesMs: null,
      owner: null, shown: false, backupSettled: false, finalTimingExpected: false, finalTimingWritten: false, finishing: false, fallback: undefined, visibleHosts: 0, focused: null, end }
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
    active.visibleHosts = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.getOpacity() > 0).length
    const firstMode = active.background, secondMode: CaptureBackground = firstMode === 'included' ? 'excluded' : 'included'
    const firstPending = this.freeze(active, firstMode)
    if (this.active !== active) return
    // The visible-host snapshot predates these shells; hidden, content-protected overlays stay out of both native exposures.
    this.prepareWindows(active)
    const first = await firstPending
    if (this.active !== active) return
    if (!(first instanceof Error)) this.validateFrames(active, first)
    const needsSecond = active.visibleHosts > 0
    if (needsSecond && !usable(first)) {
      // Only a failed selected exposure waits for its alternate. The lease remains strictly sequential.
      const second = await this.freeze(active, secondMode)
      if (this.active !== active) return
      if (!(second instanceof Error)) this.validateFrames(active, second)
      this.installInitial(active, first, second, false)
      active.backupSettled = active.finalTimingExpected = true
      this.release(active)
      return
    }
    if (first instanceof Error) throw first
    if (!usable(first) && !needsSecond) throw new Error('No display returned usable screenshot pixels. Take the screenshot again.')
    if (!needsSecond) {
      this.installInitial(active, first, first, false)
      active.backupSettled = true
      this.release(active)
      return
    }
    this.installInitial(active, first, null, true)
    active.finalTimingExpected = true
    const secondPending = this.freeze(active, secondMode)
    this.release(active)
    void secondPending.then(second => this.completeBackup(active, secondMode, second))
  }

  private async freeze(active: Active, mode: CaptureBackground): Promise<NativeDisplayFrames | Error> {
    try {
      const result = await this.ports.native().captureDisplays({ includeHostWindows: mode === 'included' })
      active[mode === 'included' ? 'nativeIncluded' : 'nativeExcluded'] = { response: result.timing,
        displays: result.displays.map(frame => ({ displayId: frame.displayId, timing: frame.timing })) }
      return result
    }
    catch (error) { return error instanceof Error ? error : new Error(message(error)) }
    finally { active[mode === 'included' ? 'includedMs' : 'excludedMs'] = since(active.startedAt) }
  }

  /** Validate an entire exposure before any overlay consumes even one of its frames. */
  private validateFrames(active: Active, result: NativeDisplayFrames): void {
    const displays = screen.getAllDisplays()
    if (result.displays.length !== displays.length || active.overlays.length !== displays.length || new Set(result.displays.map(frame => frame.displayId)).size !== displays.length) layoutChanged()
    for (const frame of result.displays) {
      const display = displays.find(row => row.id === frame.displayId), prepared = active.overlays.find(row => row.display.id === frame.displayId)
      if (!display || !prepared || !sameRect(display.bounds, frame.frame) || display.scaleFactor !== frame.scale || !Number.isFinite(frame.safeTop) || frame.safeTop < 0
        || !sameRect(prepared.display.bounds, display.bounds) || prepared.display.scaleFactor !== display.scaleFactor) layoutChanged()
    }
  }

  private installInitial(active: Active, first: NativeDisplayFrames | Error, second: NativeDisplayFrames | Error | null, pendingSecond: boolean): void {
    const firstMode = active.background, secondMode: CaptureBackground = firstMode === 'included' ? 'excluded' : 'included'
    const geometry = !(first instanceof Error) ? first : !(second instanceof Error) && second ? second : null
    if (!geometry || (!usable(first) && !usable(second))) {
      if (first instanceof Error && second instanceof Error) throw firstMode === 'included' ? first : second
      if (first instanceof Error && !second) throw first
      throw new Error('No display returned usable screenshot pixels. Take the screenshot again.')
    }
    if (active.session.allowBackgroundFallback === false && !usable(first)) requestedUnavailable(first)
    const theme = captureTheme(this.ports)
    const placed = geometry.displays.map(frame => {
      const initialCrop = this.continued(frame, active.session.continuation)
      const input: CaptureSurfaceInput = { requestId: active.requestId, revision: active.revision, displayId: frame.displayId, frame: frame.frame, scale: frame.scale, safeTop: frame.safeTop,
        attachToDraft: active.session.attachToDraft, expandable: active.session.expandable, theme, background: active.background,
        backgrounds: { [firstMode]: captureFrame(first, frame.displayId), [secondMode]: pendingSecond ? pendingFrame() : captureFrame(second, frame.displayId) } as CaptureSurfaceInput['backgrounds'],
        ...(initialCrop ? { initialCrop } : {}) }
      return { frame, input }
    })
    const updates = active.overlays.map(overlay => {
      const prepared = placed.find(row => row.input.displayId === overlay.display.id)
      if (!prepared) layoutChanged()
      return { overlay, input: prepared.input }
    })
    for (const update of updates) update.overlay.input = update.input
    active.framesMs = since(active.startedAt)
  }

  private completeBackup(active: Active, mode: CaptureBackground, result: NativeDisplayFrames | Error): void {
    if (this.active !== active) return
    let frames: CaptureSurfaceFrame[]
    try {
      if (!(result instanceof Error)) this.validateFrames(active, result)
      frames = active.overlays.map(overlay => captureFrame(result, overlay.display.id))
    } catch (error) {
      frames = active.overlays.map(() => failedFrame(message(error)))
    }
    const revision = active.revision + 1
    const updates = active.overlays.map((overlay, index) => ({ overlay, input: { ...overlay.input!, revision,
      backgrounds: { ...overlay.input!.backgrounds, [mode]: frames[index]! } }, frame: frames[index]! }))
    active.revision = revision
    for (const update of updates) update.overlay.input = update.input
    for (const update of updates) send(update.overlay, { kind: 'snapshot', requestId: active.requestId, revision, background: mode, frame: update.frame })
    active.backupSettled = true
    if (active.shown) this.recordTiming(active, true)
  }

  private release(active: Active): void {
    active.dataReadyMs = since(active.startedAt)
    active.releaseInputs()
    // A renderer that never reports presented must not leave this capture hidden with no visible overlay to cancel.
    active.fallback = setTimeout(() => this.show(active), PRESENT_FALLBACK_MS)
  }

  private prepareWindows(active: Active): void {
    active.windowsStartedMs = since(active.startedAt)
    for (const observed of screen.getAllDisplays()) {
      const display = { id: observed.id, bounds: { ...observed.bounds }, scaleFactor: observed.scaleFactor }
      const window = new BrowserWindow({
        ...display.bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, roundedCorners: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
        alwaysOnTop: true, enableLargerThanScreen: true, title: 'Screenshot', ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        webPreferences: { preload: join(import.meta.dirname, '../preload/capture-surface.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
      })
      window.setContentProtection(true)
      const overlay: Overlay = { window, display, loadedMs: null, presented: false, presentedMs: null, showEventMs: null, rendererMs: null }
      active.overlays.push(overlay)
      window.on('show', () => { overlay.showEventMs ??= since(active.startedAt) })
      raise(window, display.bounds)
      window.once('ready-to-show', () => raise(window, display.bounds))
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-attach-webview', event => event.preventDefault())
      window.webContents.once('render-process-gone', () => active.end(new Error('The screenshot overlay stopped responding. Take the screenshot again.')))
      window.once('closed', () => active.end({ state: 'cancelled' }))
    }
    void Promise.all(active.overlays.map(async overlay => {
      if (process.env.ELECTRON_RENDERER_URL) await overlay.window.loadURL(new URL('screenshot-editor/index.html', process.env.ELECTRON_RENDERER_URL).href)
      else await overlay.window.loadFile(join(import.meta.dirname, '../renderer/screenshot-editor/index.html'))
      overlay.loadedMs = since(active.startedAt)
    })).catch(error => active.end(error))
  }

  /** Every overlay at once, so no display shows the live desktop while another is frozen; keys go to the display under the pointer. */
  private show(active: Active): void {
    if (this.active !== active || active.shown || active.dataReadyMs === null) return
    active.shown = true
    for (const { window } of active.overlays) window.showInactive()
    const pointer = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    const target = active.overlays.find(overlay => overlay.display.id === pointer) ?? active.overlays[0]
    // An explicitly continued selection is the one Enter and the arrows act on, so its display takes the keys.
    const keys = active.overlays.find(overlay => overlay.input?.initialCrop) ?? target
    if (process.platform === 'darwin') app.focus({ steal: true })
    keys?.window.focus()
    this.recordTiming(active, false)
    if (active.backupSettled) this.recordTiming(active, true)
  }

  private recordTiming(active: Active, final: boolean): void {
    if (final && (!active.finalTimingExpected || active.finalTimingWritten)) return
    if (final) active.finalTimingWritten = true
    const timing: CaptureSurfaceTiming = { schema: 'agentmux.capture-timing.v2', requestId: active.requestId, final, recordedAt: Date.now(),
      physicalKeydownToCallbackMs: null, callbackToPrepareMs: active.requestTiming.callbackToPrepareMs, prepareMs: active.requestTiming.prepareMs,
      screenCaptureMs: active.requestTiming.screenCaptureMs, presentMs: active.requestTiming.presentMs,
      windowsStartedMs: active.windowsStartedMs,
      windowsLoadedMs: active.overlays.map(overlay => overlay.loadedMs), includedMs: active.includedMs, excludedMs: active.excludedMs,
      nativeIncluded: active.nativeIncluded, nativeExcluded: active.nativeExcluded,
      dataReadyMs: active.dataReadyMs, framesMs: active.framesMs, rendererMs: active.overlays.map(overlay => overlay.rendererMs),
      presentedMs: active.overlays.map(overlay => overlay.presentedMs), shownMs: since(active.startedAt), showEventMs: active.overlays.map(overlay => overlay.showEventMs),
      actualVisible: active.overlays.map(overlay => !overlay.window.isDestroyed() && overlay.window.isVisible()), displays: active.overlays.length }
    // Keep the terminal diagnostic, and persist only after the workface has become usable.
    console.info('capture-surface timing ' + JSON.stringify(timing))
    void Promise.resolve().then(() => this.ports.recordTiming?.(timing)).catch(error => console.warn('Capture timing could not be recorded: ' + message(error)))
  }

  private async invoke(event: IpcMainInvokeEvent, action: unknown, input: unknown): Promise<unknown> {
    const active = this.active, overlay = active?.overlays.find(row => row.window.webContents === event.sender)
    if (!active || !overlay || overlay.window.isDestroyed() || event.senderFrame !== overlay.window.webContents.mainFrame)
      throw new Error('This screenshot overlay does not belong to the current capture.')
    await active.inputsReady
    const frameInput = overlay.input
    if (this.active !== active || overlay.window.isDestroyed() || !frameInput) throw new Error('The original screenshot request is no longer current.')
    if (action === 'load') return frameInput
    const params = input as { background?: unknown; requestId?: unknown; revision?: unknown; timing?: unknown; operationId?: unknown; image?: BrowserPng; selection?: CaptureSurfaceRect; text?: unknown; handoff?: CaptureSurfaceHandoff } | undefined
    if (params?.requestId !== frameInput.requestId) throw new Error('The original screenshot request is no longer current.')
    if (action === 'frame-ack') {
      if (params.revision !== frameInput.revision) return
      return
    }
    if (action === 'presented') {
      if (params.background !== active.background) return
      overlay.presented = true
      overlay.presentedMs ??= since(active.startedAt)
      overlay.rendererMs ??= rendererTiming(params.timing)
      if (active.overlays.every(row => row.presented)) this.show(active)
      return
    }
    if (action === 'cancel') { active.end({ state: 'cancelled' }); return }
    if (action === 'switch-background') {
      const next = params.background
      if (next !== 'included' && next !== 'excluded') throw new Error('Choose the exact frozen screenshot background.')
      if (active.session.allowBackgroundFallback === false && next !== active.background) {
        send(overlay, { kind: 'notice', message: 'This public capture requires its original excluded screenshot background.' })
        return
      }
      if (active.finishing) { send(overlay, { kind: 'notice', message: 'The current screenshot output is still in progress. Keep its background until that output finishes.' }); return }
      if (active.owner !== null && active.owner !== frameInput.displayId) { send(overlay, { kind: 'notice', message: 'Change the screenshot background on the display that holds the selection.' }); return }
      const target = frameInput.backgrounds[next]
      if (target.status === 'pending') { send(overlay, { kind: 'notice', message: 'The other frozen background is still preparing. The current image and annotations remain available.' }); return }
      if (target.status === 'failed') { send(overlay, { kind: 'notice', message: target.issue }); return }
      active.background = next
      for (const other of active.overlays) send(other, { kind: 'background', background: next })
      return
    }

    if (action === 'select') {
      if (frameInput.backgrounds[active.background].status !== 'ready' || (active.owner !== null && active.owner !== frameInput.displayId)) return false
      if (active.owner === null) {
        active.owner = frameInput.displayId
        for (const other of active.overlays) if (other !== overlay) send(other, { kind: 'locked' })
      }
      return true
    }
    // A sampled color is copied from the loupe, which also shows before any selection exists.
    if (action === 'copy-text') {
      if (typeof params.text !== 'string' || !params.text) throw new Error('Keep the exact text to copy.')
      return await this.ports.copyText(params.text).then((): SystemScreenshotEditorFinish => ({ status: 'completed' }), error => ({ status: 'failed', message: message(error) }))
    }
    if (active.owner !== frameInput.displayId) throw new Error('Only the display that holds the selection can output it.')
    if (params.background !== active.background) throw new Error('The screenshot background changed before this output. Keep the selection and try the output again.')
    const captured = frameInput.backgrounds[active.background]
    if (captured.status === 'pending') throw new Error('The requested frozen background is still preparing. Keep the current document and try again after it is ready.')
    if (captured.status === 'failed') throw new Error(captured.issue)

    if (action === 'expand') {
      if (!active.session.expandable) throw new Error('This capture returns its selection directly. Finish it with Done or cancel it.')
      const handoff = params.handoff
      if (!handoff || !Array.isArray(handoff.shapes) || typeof handoff.tool !== 'string' || !handoff.crop) throw new Error('Keep the original marks and selection to expand.')
      const source = this.source(active, frameInput, handoff.crop), continuation = this.continuation(frameInput, source.rect)
      active.end({ state: 'expanded', image: captured.image, source, handoff, delivered: () => continuation })
      return
    }
    pngBytes(params.image!)
    const source = this.source(active, frameInput, params.selection)
    if (action === 'save-png') return await saveScreenshotPng(params.image!, overlay.window, { capturedAt: captured.capturedAt })
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
    try { await active.session.complete(params.image!, source, captured.engine) }
    catch (error) { return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorFinish }
    finally { active.finishing = false }
    active.end({ state: 'completed' })
    return { status: 'completed' } satisfies SystemScreenshotEditorFinish
  }

  /** Geometry returned to the same capture caller after its independent editor confirms Copy. */
  private continuation(input: CaptureSurfaceInput, rect: CaptureSurfaceRect): CaptureSurfaceContinuation {
    return { displayId: input.displayId, frame: input.frame, scale: input.scale, rect }
  }
  /** The explicit continuation in this frame's pixels, only on its unchanged display. */
  private continued({ displayId, frame, scale }: NativeDisplayFrame, continuation: CaptureSurfaceContinuation | undefined): CaptureSurfaceHandoff['crop'] | undefined {
    if (!continuation || continuation.displayId !== displayId || continuation.scale !== scale || !sameRect(continuation.frame, frame)) return undefined
    return { x: Math.round((continuation.rect.x - frame.x) * scale), y: Math.round((continuation.rect.y - frame.y) * scale),
      width: Math.round(continuation.rect.width * scale), height: Math.round(continuation.rect.height * scale) }
  }

  /** The selection in global points: this display's origin plus its frozen-frame pixels over the display scale. */
  private source(active: Active, input: CaptureSurfaceInput, selection: CaptureSurfaceRect | undefined): ScreenshotCaptureSource {
    const { frame, scale } = input
    const captured = input.backgrounds[active.background]
    if (captured.status !== 'ready') throw new Error(captured.status === 'pending' ? 'The requested frozen background is still preparing.' : captured.issue)
    const { image, capturedAt } = captured
    if (!selection || ![selection.x, selection.y, selection.width, selection.height].every(Number.isFinite) || selection.width <= 0 || selection.height <= 0
      || selection.x < 0 || selection.y < 0 || selection.x + selection.width > image!.width || selection.y + selection.height > image!.height)
      throw new Error('The selection must stay inside its display.')
    return { rect: { x: frame.x + selection.x / scale, y: frame.y + selection.y / scale, width: selection.width / scale, height: selection.height / scale }, scale, capturedAt }
  }

  /** The public selection capture: the same surface without ⌘E, returning the processed selection as Core's public capture result. */
  async captureSelection(returnFocus: boolean): Promise<NativeDesktopPayloadMap['native.capture']> {
    let result: NativeDesktopPayloadMap['native.capture'] | null = null
    try {
      const outcome = await this.present({ attachToDraft: false, background: 'excluded', allowBackgroundFallback: false, expandable: false, returnFocus, complete: async (image, source, engine) => {
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
    const target = active.overlays.find(overlay => overlay.display.id === active.owner) ?? active.overlays[0]
    if (target?.input && !target.window.isDestroyed()) { target.window.focus(); send(target, { kind: 'notice', message: text }) }
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeHandler(CAPTURE_SURFACE_CHANNEL)
    this.active?.end({ state: 'cancelled' })
  }
}

function captureFrame(result: NativeDisplayFrames | Error | null, displayId: number): CaptureSurfaceFrame {
  if (result === null) return pendingFrame()
  if (result instanceof Error) return failedFrame(result.message)
  const frame = result.displays.find(row => row.displayId === displayId)
  if (!frame) layoutChanged()
  return overlayFrame(frame, result.capturedAt)
}
function pendingFrame(): CaptureSurfaceFrame { return { status: 'pending', capturedAt: 0 } }
function failedFrame(issue: string): CaptureSurfaceFrame { return { status: 'failed', capturedAt: 0, issue } }
function usable(result: NativeDisplayFrames | Error | null): boolean {
  return !(result instanceof Error) && result !== null && result.displays.some(frame => frame.issue === undefined)
}
function requestedUnavailable(result: NativeDisplayFrames | Error): never {
  if (result instanceof Error) throw result
  throw Object.assign(new Error('The requested screenshot background is unavailable on every display. Take the screenshot again.'), { code: 'capture_unavailable' })
}
function layoutChanged(): never {
  throw Object.assign(new Error('The display layout changed while the screen was captured. Take the screenshot again.'), { code: 'display_configuration_changed' })
}
function captureTheme(ports: Ports): CaptureSurfaceInput['theme'] {
  try { return themeBootstrap(ports.appearance(), nativeTheme.shouldUseDarkColors) }
  catch (error) { return { status: 'unavailable', message: 'Saved appearance could not be loaded. ' + message(error) } }
}
function overlayFrame(frame: NativeDisplayFrame, capturedAt: number): CaptureSurfaceFrame {
  if (frame.issue !== undefined) return { status: 'failed', capturedAt, issue: frame.issue }
  const image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + frame.png, width: frame.width, height: frame.height, byteLength: Buffer.byteLength(frame.png, 'base64') }
  // NativeDesktop validated this PNG at the private protocol boundary.
  return { status: 'ready', image, windows: displayWindows(frame, image), engine: frame.engine, capturedAt }
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
function rendererTiming(value: unknown): CaptureRendererTiming | null {
  if (!value || typeof value !== 'object') return null
  const timing = value as Record<string, unknown>, keys = ['loadMs', 'decodeMs', 'paintMs', 'presentedMs'] as const
  if (!keys.every(key => typeof timing[key] === 'number' && Number.isFinite(timing[key]) && (timing[key] as number) >= 0)) return null
  return Object.fromEntries(keys.map(key => [key, timing[key]])) as unknown as CaptureRendererTiming
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function since(start: number): number { return Math.round(performance.now() - start) }
