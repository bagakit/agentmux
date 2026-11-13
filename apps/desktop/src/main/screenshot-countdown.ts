import { BrowserWindow, globalShortcut, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron'
import type { AppearanceConfig } from '../shared/contracts'
import type { ThemeBootstrap } from '../shared/theme-bootstrap'
import { themeBootstrap } from './theme-bootstrap'
import { join } from 'node:path'
import { SCREENSHOT_COUNTDOWN_CHANNEL, SCREENSHOT_COUNTDOWN_TICK, SCREENSHOT_DELAYS, type ScreenshotDelaySeconds } from '../shared/screenshot-countdown'

type Run = { window: BrowserWindow; theme: ThemeBootstrap; seconds: number; finish(started: boolean): void }
const SIZE = { width: 176, height: 132 }

/** Owns the one delayed-capture countdown. The window never takes focus, so the app being captured stays active. */
export class ScreenshotCountdown {
  private current: Run | null = null
  private disposed = false
  constructor(private readonly appearance: () => AppearanceConfig) {
    ipcMain.handle(SCREENSHOT_COUNTDOWN_CHANNEL, (event, action) => this.invoke(event, action))
  }

  /** Resolves true when the delay elapsed and selection may start, false when the user cancelled. */
  async wait(seconds: ScreenshotDelaySeconds): Promise<boolean> {
    if (this.disposed) throw new Error('The screenshot countdown is closed. Start a new capture.')
    if (!SCREENSHOT_DELAYS.includes(seconds)) throw new Error('Choose a 3, 5 or 10 second delay.')
    if (this.current) throw new Error('A screenshot countdown is already running. Cancel it or wait for it to finish.')
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const window = new BrowserWindow({ ...SIZE, x: Math.round(work.x + (work.width - SIZE.width) / 2), y: Math.round(work.y + work.height - SIZE.height - 48),
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
      webPreferences: { preload: join(import.meta.dirname, '../preload/screenshot-countdown.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })
    window.setAlwaysOnTop(true, 'screen-saver')
    // Without skipTransformProcessType macOS turns the whole app into a UIElement: the Dock icon and ⌘Tab entry vanish.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    let timer: ReturnType<typeof setTimeout> | undefined, escape = false, settle!: (started: boolean) => void
    const result = new Promise<boolean>(resolve => { settle = resolve })
    let theme: ThemeBootstrap
    try { theme = themeBootstrap(this.appearance(), nativeTheme.shouldUseDarkColors) }
    catch (error) { theme = { status: 'unavailable', message: 'Saved appearance could not be read. ' + String(error) } }
    const run: Run = { window, theme, seconds, finish: started => {
      if (this.current !== run) return
      this.current = null
      clearTimeout(timer)
      if (escape) globalShortcut.unregister('Escape')
      if (!window.isDestroyed()) window.destroy()
      settle(started)
    } }
    this.current = run
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.once('closed', () => run.finish(false))
    // The window cannot hold keyboard focus, so Esc is taken globally for the few seconds it is shown.
    // If another owner holds Esc, Cancel stays available and that owner is left untouched.
    escape = globalShortcut.register('Escape', () => run.finish(false))
    const tick = () => {
      if (this.current !== run) return
      run.seconds -= 1
      if (run.seconds === 0) { run.finish(true); return }
      window.webContents.send(SCREENSHOT_COUNTDOWN_TICK, run.seconds)
      timer = setTimeout(tick, 1000)
    }
    window.webContents.once('did-finish-load', () => { if (!window.isDestroyed()) { window.showInactive(); timer = setTimeout(tick, 1000) } })
    try {
      if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(new URL('screenshot-editor/index.html?countdown', process.env.ELECTRON_RENDERER_URL).href)
      else await window.loadFile(join(import.meta.dirname, '../renderer/screenshot-editor/index.html'), { search: 'countdown' })
    } catch (error) { run.finish(false); throw error }
    return await result
  }

  private invoke(event: IpcMainInvokeEvent, action: unknown): { theme: ThemeBootstrap; seconds: number } | void {
    const run = this.current
    if (!run || run.window.isDestroyed() || event.sender !== run.window.webContents || event.senderFrame !== run.window.webContents.mainFrame)
      throw new Error('This countdown request does not belong to the current countdown window.')
    if (action === 'load') return { theme: run.theme, seconds: run.seconds }
    if (action !== 'cancel') throw new Error('The countdown action is invalid.')
    run.finish(false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeHandler(SCREENSHOT_COUNTDOWN_CHANNEL)
    this.current?.finish(false)
  }
}
