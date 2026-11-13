import { BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { mintObjectId } from '@agentmux/core/object-id'
import type { CaptureParams, NativeDesktop } from '@agentmux/native-desktop'
import type { AppearanceConfig } from '../shared/contracts'
import { SCREENSHOT_SOURCE_CHANNEL, type ScreenshotSourceInput, type ScreenshotSourceList } from '../shared/screenshot-source'
import { themeBootstrap } from './theme-bootstrap'

type App = { pid: number; processStartedAt: number; name: string }
type Request = { window: BrowserWindow; input: ScreenshotSourceInput; choices: Map<string, CaptureParams>; apps: Map<string, App>;
  settled: boolean; resolve(value: CaptureParams | null): void }
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** Exact OS identities are held here; labels and Renderer rows never grant capture targets. */
export class ScreenshotSourcePicker {
  private current: Request | null = null
  private disposed = false
  constructor(private readonly ports: { native(): Pick<NativeDesktop, 'request'>; appearance(): AppearanceConfig }) {
    ipcMain.handle(SCREENSHOT_SOURCE_CHANNEL, (event, action, input) => this.invoke(event, action, input))
  }

  async choose(kind: 'display' | 'window'): Promise<CaptureParams | null> {
    if (this.disposed) throw new Error('The original screenshot source owner is closed. Your image and drafts are kept.')
    if (this.current) throw new Error('A screenshot source is already being selected. Finish or cancel that source first.')
    let theme: ScreenshotSourceInput['theme']
    try { theme = themeBootstrap(this.ports.appearance(), nativeTheme.shouldUseDarkColors) }
    catch (error) { theme = { status: 'unavailable', message: 'Saved appearance could not be read. ' + String(error) } }
    const window = new BrowserWindow({ title: kind === 'display' ? 'Capture a display' : 'Capture a window', width: 560, height: 580,
      minWidth: 360, minHeight: 340, show: false, autoHideMenuBar: true,
      webPreferences: { preload: join(import.meta.dirname, '../preload/screenshot-source.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } })
    let resolve!: Request['resolve']
    const selected = new Promise<CaptureParams | null>(done => { resolve = done })
    const request: Request = { window, input: { requestId: mintObjectId(), kind, theme },
      choices: new Map(), apps: new Map(), settled: false, resolve }
    this.current = request
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.once('render-process-gone', () => { if (!window.isDestroyed()) window.destroy() })
    window.once('closed', () => { if (!request.settled) request.resolve(null); request.settled = true; if (this.current === request) this.current = null })
    window.once('ready-to-show', () => { if (!window.isDestroyed()) { window.show(); window.focus() } })
    try {
      if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(new URL('screenshot-editor/index.html', process.env.ELECTRON_RENDERER_URL).href)
      else await window.loadFile(join(import.meta.dirname, '../renderer/screenshot-editor/index.html'))
    } catch (error) { if (!window.isDestroyed()) window.destroy(); throw error }
    return await selected
  }

  private async invoke(event: IpcMainInvokeEvent, action: unknown, value: unknown): Promise<unknown> {
    const request = this.current
    if (!request || request.window.isDestroyed() || event.sender !== request.window.webContents || event.senderFrame !== request.window.webContents.mainFrame)
      throw new Error('This source selection does not belong to the original window.')
    if (action === 'load') return request.input
    const input = value as { requestId?: string; key?: string } | undefined
    if (input?.requestId !== request.input.requestId) throw new Error('The original source selection is no longer current.')
    if (action === 'cancel') { request.window.close(); return }
    if (action === 'select') {
      const target = typeof input.key === 'string' ? request.choices.get(input.key) : undefined
      if (!target) throw new Error('Choose an exact source returned by this original selection.')
      request.settled = true; request.window.close(); request.resolve(target); return
    }
    if (action !== 'list' && action !== 'windows') throw new Error('The screenshot source action is invalid.')
    const native = this.ports.native(), choices: ScreenshotSourceList['choices'] = [], issues: string[] = []
    if (action === 'windows') {
      const app = typeof input.key === 'string' ? request.apps.get(input.key) : undefined
      if (!app) throw new Error('Choose an application from this original source list.')
      const result = await native.request('listWindows', { app: `pid:${app.pid}`, processStartedAt: app.processStartedAt }) as { windows?: unknown[] }
      if (!Array.isArray(result.windows)) throw new Error('The original window list is unavailable. Your image and drafts are kept.')
      for (const raw of result.windows) {
        const w = raw as { id?: unknown; title?: unknown; width?: unknown; height?: unknown }
        if (!positive(w.id) || !Number.isSafeInteger(w.id)) { issues.push('One window has no confirmed identity.'); continue }
        const key = mintObjectId()
        request.choices.set(key, { mode: 'window', app: `pid:${app.pid}`, processStartedAt: app.processStartedAt, windowId: w.id })
        choices.push({ key, label: typeof w.title === 'string' && w.title ? w.title : app.name,
          detail: positive(w.width) && positive(w.height) ? `${Math.round(w.width)} × ${Math.round(w.height)} pt` : 'Window dimensions unavailable' })
      }
    } else if (request.input.kind === 'display') {
      const result = await native.request('listDisplays') as { displays?: unknown[] }
      if (!Array.isArray(result.displays)) throw new Error('The original display list is unavailable. Your drafts are kept.')
      for (const raw of result.displays) {
        const d = raw as { id?: unknown; width?: unknown; height?: unknown; scale?: unknown; isMain?: unknown }
        if (!positive(d.id) || !Number.isSafeInteger(d.id) || !positive(d.width) || !positive(d.height) || !positive(d.scale)) { issues.push('One display has incomplete geometry.'); continue }
        const key = mintObjectId()
        request.choices.set(key, { mode: 'display', displayId: d.id })
        choices.push({ key, label: d.isMain === true ? 'Main display' : `Display ${choices.length + 1}`,
          detail: `${Math.round(d.width * d.scale)} × ${Math.round(d.height * d.scale)} px · ${d.scale}×` })
      }
    } else {
      const result = await native.request('listApps') as { apps?: unknown[] }
      if (!Array.isArray(result.apps)) throw new Error('The original application list is unavailable. Your drafts are kept.')
      for (const raw of result.apps) {
        const app = raw as { pid?: unknown; processStartedAt?: unknown; name?: unknown }
        if (!positive(app.pid) || !Number.isSafeInteger(app.pid) || !positive(app.processStartedAt)) { issues.push('One application has no confirmed process identity.'); continue }
        const key = mintObjectId(), name = typeof app.name === 'string' && app.name ? app.name : 'Application'
        request.apps.set(key, { pid: app.pid, processStartedAt: app.processStartedAt, name })
        choices.push({ key, label: name, detail: `Process ${app.pid}` })
      }
      choices.sort((a, b) => a.label.localeCompare(b.label))
    }
    // Late reads retain the original request only; they never create or reopen a source window.
    return { choices, issues }
  }

  dispose(): void { this.disposed = true; ipcMain.removeHandler(SCREENSHOT_SOURCE_CHANNEL); if (this.current && !this.current.window.isDestroyed()) this.current.window.destroy() }
}
