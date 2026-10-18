import { mintObjectId } from '@agentmux/core/object-id'
import { BrowserWindow, WebContentsView, dialog, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import type { AgentMuxBrowserMode } from '@agentmux/core'
import { BROWSER_POPUP_CHANNELS, type BrowserPopupCommand, type BrowserPopupSnapshot } from '../shared/browser-popup-navigation.js'
import type { ThemeBootstrap } from '../shared/theme-bootstrap.js'
import { appLinkOutcome, appLinkRefusedMessage, browserWindowOpenOutcome, classifyBrowserTarget } from './browser-app-link.js'
import type { AppLinkHost } from './browser-view-manager.js'
import type { BrowserWebAuthnOwner } from './browser-webauthn-accounts.js'
import { installTextEditContextMenu } from './text-edit-context-menu.js'
import { windowSecurityWebPreferences } from './window-security.js'

export interface BrowserPopupHost {
  appLinks: AppLinkHost
  rendererUrl(): string
  preloadPath: string
  readTheme(): ThemeBootstrap
  normalizeAddress(address: string): string
  confirmLeave?(window: BrowserWindow): Promise<boolean>
}

export interface BrowserPopupCreation {
  mode: AgentMuxBrowserMode
  /** Also called for every nested popup; the original Browser owns private lifetime. */
  onCreated?(window: BrowserWindow): void
}

type Popup = {
  window: BrowserWindow
  view: WebContentsView
  documentURL: string
  creation: BrowserPopupCreation
  chromeHeight: number
  error: string | null
  warning: string | null
  appLinkPrompt: BrowserPopupSnapshot['appLinkPrompt']
  linkRequest: symbol | null
  loadRequest: symbol | null
  closeRequest: { prompted: boolean } | null
  chromeFailure: string | null
  chromeRequest: symbol | null
}

const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), address: z.string() }).strict(),
  z.object({ kind: z.enum(['back', 'forward', 'reload', 'stop']) }).strict(),
  z.object({ kind: z.literal('chrome-height'), height: z.number().finite().min(44).max(160) }).strict(),
  z.object({ kind: z.literal('answer-app-link'), promptId: z.string(), allow: z.boolean(), remember: z.boolean() }).strict()
])

/** Native popups retain Chromium's original page, Session, opener and close ownership.
 * Only the fixed local chrome receives the narrow navigation bridge. */
export class BrowserPopupWindows {
  private readonly popups = new Map<WebContents, Popup>()
  private disposed = false

  constructor(private readonly host: BrowserPopupHost) {}

  create(options: BrowserWindowConstructorOptions, creation: BrowserPopupCreation): WebContents {
    if (this.disposed) throw new Error('The original Browser popup owner has ended')
    const documentURL = this.host.rendererUrl()
    // Electron supplies a pre-created guest in this otherwise internal option. Moving it
    // into the chrome first, or rebuilding only webPreferences, loses native popup identity.
    const { webContents: _guest, webPreferences: _preferences, ...shellOptions } = options as BrowserWindowConstructorOptions & { webContents?: WebContents }
    const window = new BrowserWindow({ ...shellOptions, frame: true, closable: true, minWidth: 320, minHeight: 220,
      webPreferences: { ...windowSecurityWebPreferences(this.host.preloadPath), focusOnNavigation: false } })
    let view: WebContentsView
    try { view = new WebContentsView(options) }
    catch (error) { window.destroy(); throw error }
    const page = view.webContents
    const popup: Popup = { window, view, documentURL, creation,
      chromeHeight: 44, error: null, warning: null, appLinkPrompt: null, linkRequest: null, loadRequest: null, closeRequest: null,
      chromeFailure: null, chromeRequest: null }
    this.popups.set(page, popup)
    window.contentView.addChildView(view)
    const layout = () => {
      if (!this.live(popup)) return
      const { width, height } = window.getContentBounds()
      view.setBounds({ x: 0, y: popup.chromeHeight, width, height: Math.max(0, height - popup.chromeHeight) })
    }
    window.on('resize', layout)
    layout()
    this.installChrome(popup)
    this.installPage(popup)
    // A close request is not destruction. A page that prevents unload keeps its shell.
    window.on('close', event => {
      if (page.isDestroyed()) return
      event.preventDefault()
      if (popup.closeRequest?.prompted) return
      popup.closeRequest = { prompted: false }
      page.close({ waitForBeforeUnload: true })
    })
    page.on('will-prevent-unload', () => { void this.confirmClose(popup) })
    page.once('destroyed', () => {
      this.popups.delete(page)
      popup.linkRequest = null
      if (!window.isDestroyed()) window.close()
    })
    window.once('closed', () => {
      this.popups.delete(page)
      popup.linkRequest = null
      // A forcibly destroyed shell cannot retain an invisible orphan page.
      if (!page.isDestroyed()) page.close()
    })
    installTextEditContextMenu(page, window, { isCurrent: () => this.live(popup), origin: () => ({ x: 0, y: popup.chromeHeight }) })
    installTextEditContextMenu(window.webContents, window, { isCurrent: () => this.live(popup) })
    const focusAddress = (event: Electron.Event, input: Electron.Input) => {
      if (input.type !== 'keyDown' || input.isComposing || !this.live(popup)) return
      const modifier = process.platform === 'darwin' ? input.meta : input.control
      if (modifier && !input.alt && input.key.toLowerCase() === 'l') {
        event.preventDefault()
        const focus = () => { if (this.live(popup)) { window.webContents.focus(); window.webContents.send(BROWSER_POPUP_CHANNELS.focusAddress) } }
        if (popup.chromeFailure) void this.loadChrome(popup).then(loaded => { if (loaded) focus() })
        else focus()
      } else if (modifier && !input.alt && input.key.toLowerCase() === 'r') {
        event.preventDefault()
        page.reload()
      } else if (process.platform === 'darwin' ? input.meta && !input.alt && input.key === '[' : input.alt && !input.control && input.key === 'ArrowLeft') {
        event.preventDefault()
        if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack()
      } else if (process.platform === 'darwin' ? input.meta && !input.alt && input.key === ']' : input.alt && !input.control && input.key === 'ArrowRight') {
        event.preventDefault()
        if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward()
      }
    }
    page.on('before-input-event', focusAddress)
    window.webContents.on('before-input-event', focusAddress)
    void this.loadChrome(popup)
    creation.onCreated?.(window)
    // Chromium continues the original request, including POST/referrer/opener semantics.
    return page
  }

  find(contents: WebContents): (BrowserWebAuthnOwner & { view: WebContentsView }) | null {
    const popup = this.popups.get(contents)
    if (!popup || !this.live(popup)) return null
    const frame = contents.mainFrame, processId = frame.processId, frameToken = frame.frameToken
    return { window: popup.window, view: popup.view,
      get bounds() { return popup.view.getVisible() ? popup.view.getBounds() : null },
      isCurrent: () => this.live(popup) && !frame.detached && !frame.isDestroyed() &&
        contents.mainFrame === frame && frame.processId === processId && frame.frameToken === frameToken,
      report: warning => {
        if (!this.live(popup) || frame.isDestroyed() || frame.detached || frame.processId !== processId || frame.frameToken !== frameToken) return
        popup.warning = warning
        this.emit(popup)
      } }
  }

  dispose(): void {
    this.disposed = true
    // Manager retirement is distinct from a person's Close request above.
    for (const popup of this.popups.values()) if (!popup.view.webContents.isDestroyed()) popup.view.webContents.close()
  }

  private live(popup: Popup): boolean {
    return this.popups.get(popup.view.webContents) === popup && !popup.window.isDestroyed() && !popup.view.webContents.isDestroyed()
  }

  private snapshot(popup: Popup): BrowserPopupSnapshot {
    const page = popup.view.webContents
    let theme: ThemeBootstrap
    try { theme = this.host.readTheme() }
    catch (error) { theme = { status: 'unavailable', message: `Appearance could not be read: ${message(error)}` } }
    return { url: page.getURL(), title: page.getTitle(), canGoBack: page.navigationHistory.canGoBack(),
      canGoForward: page.navigationHistory.canGoForward(), loading: page.isLoading(), error: popup.error,
      warning: popup.chromeFailure ?? popup.warning, mode: popup.creation.mode, theme, appLinkPrompt: popup.appLinkPrompt }
  }

  private emit(popup: Popup): void {
    if (!this.live(popup) || popup.window.webContents.isDestroyed()) return
    popup.window.webContents.send(BROWSER_POPUP_CHANNELS.changed, this.snapshot(popup))
  }

  private requireChrome(popup: Popup, event: IpcMainInvokeEvent): void {
    const chrome = popup.window.webContents, frame = event.senderFrame
    if (!this.live(popup) || event.sender !== chrome || !frame || frame.isDestroyed() || frame.detached ||
      frame.parent !== null || frame !== chrome.mainFrame || frame.url !== popup.documentURL || chrome.getURL() !== popup.documentURL) {
      throw new Error('Untrusted Browser popup navigation document')
    }
  }

  private installChrome(popup: Popup): void {
    const chrome = popup.window.webContents
    chrome.ipc.handle(BROWSER_POPUP_CHANNELS.inspect, event => {
      this.requireChrome(popup, event)
      return this.snapshot(popup)
    })
    chrome.ipc.handle(BROWSER_POPUP_CHANNELS.command, (event, input: unknown) => {
      this.requireChrome(popup, event)
      return this.command(popup, commandSchema.parse(input))
    })
    chrome.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: Electron.Event, url: string) => { if (url !== popup.documentURL) event.preventDefault() }
    chrome.on('will-navigate', guard)
    chrome.on('will-redirect', guard)
  }

  private installPage(popup: Popup): void {
    const page = popup.view.webContents
    const handOff = (url: string, scheme: string) => { void this.handOff(popup, url, scheme) }
    page.setWindowOpenHandler(({ url }) => {
      const decision = browserWindowOpenOutcome(url, handOff)
      return decision.action === 'allow' ? { action: 'allow', createWindow: options => this.create(options, popup.creation) } : decision
    })
    const guard = (event: Electron.Event & { url: string }) => {
      const target = classifyBrowserTarget(event.url)
      if (target.kind !== 'hand-off') return
      event.preventDefault()
      handOff(event.url, target.scheme!)
    }
    page.on('will-navigate', guard)
    page.on('will-frame-navigate', guard)
    page.on('will-redirect', guard)
    page.on('did-start-navigation', event => {
      if (!event.isMainFrame) return
      popup.error = null
      popup.warning = null
      popup.appLinkPrompt = null
      popup.linkRequest = null
      popup.loadRequest = null
      popup.closeRequest = null
      this.emit(popup)
    })
    const changed = () => this.emit(popup)
    page.on('did-start-loading', changed)
    page.on('did-stop-loading', changed)
    page.on('did-navigate', changed)
    page.on('did-navigate-in-page', changed)
    page.on('page-title-updated', (_event, title) => {
      if (!this.live(popup)) return
      popup.window.setTitle(popup.chromeFailure ? `Navigation controls unavailable — ${title}` : title)
      this.emit(popup)
    })
    page.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3 || !this.live(popup)) return
      popup.error = description
      this.emit(popup)
    })
    page.on('render-process-gone', (_event, details) => {
      if (!this.live(popup)) return
      popup.appLinkPrompt = null
      popup.linkRequest = null
      popup.error = `Page process ended (${details.reason}). Reload to try again.`
      this.emit(popup)
    })
  }

  private async command(popup: Popup, command: BrowserPopupCommand): Promise<BrowserPopupSnapshot> {
    const page = popup.view.webContents
    switch (command.kind) {
      case 'navigate': {
        let url: string
        try { url = this.host.normalizeAddress(command.address) }
        catch (error) {
          const address = command.address.trim(), target = classifyBrowserTarget(address)
          if (target.kind !== 'hand-off') throw error
          await this.handOff(popup, address, target.scheme!)
          break
        }
        await this.load(popup, url)
        break
      }
      case 'back': if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack(); break
      case 'forward': if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward(); break
      case 'reload': page.reload(); break
      case 'stop': page.stop(); break
      case 'chrome-height': {
        popup.chromeHeight = Math.round(command.height)
        const { width, height } = popup.window.getContentBounds()
        popup.view.setBounds({ x: 0, y: popup.chromeHeight, width, height: Math.max(0, height - popup.chromeHeight) })
        break
      }
      case 'answer-app-link': await this.answerAppLink(popup, command); break
    }
    return this.snapshot(popup)
  }

  private async confirmClose(popup: Popup): Promise<void> {
    const request = popup.closeRequest
    if (!request || request.prompted || !this.live(popup)) return
    request.prompted = true
    const page = popup.view.webContents, frame = page.mainFrame
    const processId = frame.processId, frameToken = frame.frameToken
    const current = () => this.live(popup) && popup.closeRequest === request && !frame.isDestroyed() && !frame.detached &&
      page.mainFrame === frame && frame.processId === processId && frame.frameToken === frameToken
    try {
      const leave = this.host.confirmLeave ? await this.host.confirmLeave(popup.window) :
        (await dialog.showMessageBox(popup.window, { type: 'warning', title: 'Leave this page?',
          message: 'This page is asking to stay open.', detail: 'Changes you made may not be saved.',
          buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1, noLink: true })).response === 0
      if (!current()) return
      popup.closeRequest = null
      if (leave) page.close()
    } catch (error) {
      if (!current()) return
      popup.closeRequest = null
      popup.warning = `The close confirmation could not be shown: ${message(error)}. Close this window to try again.`
      this.emit(popup)
    }
  }

  private async load(popup: Popup, url: string): Promise<void> {
    const page = popup.view.webContents
    const request = Symbol('address navigation')
    popup.loadRequest = request
    try { await page.loadURL(url) }
    catch (error) {
      // Once native navigation starts, did-fail-load owns its failure. This only
      // reports a rejected load that never started and still belongs to this request.
      if (!this.live(popup) || popup.loadRequest !== request || (error as { code?: string }).code === 'ERR_ABORTED') return
      popup.error = message(error)
      this.emit(popup)
    } finally { if (popup.loadRequest === request) popup.loadRequest = null }
  }

  private async loadChrome(popup: Popup): Promise<boolean> {
    const request = Symbol('navigation controls load')
    popup.chromeRequest = request
    try {
      await popup.window.loadURL(popup.documentURL)
      if (!this.live(popup) || popup.chromeRequest !== request) return false
      popup.chromeFailure = null
      popup.window.setTitle(popup.view.webContents.getTitle() || 'Browser')
      return true
    } catch (error) {
      if (!this.live(popup) || popup.chromeRequest !== request) return false
      const shortcut = process.platform === 'darwin' ? 'Cmd+L' : 'Ctrl+L'
      popup.chromeFailure = `Navigation controls could not load: ${message(error)}. Press ${shortcut} to retry the controls.`
      popup.window.setTitle(`Navigation controls unavailable — Press ${shortcut} to retry`)
      console.warn(popup.chromeFailure)
      return false
    } finally { if (popup.chromeRequest === request) popup.chromeRequest = null }
  }

  private async handOff(popup: Popup, url: string, scheme: string): Promise<void> {
    const request = Symbol('app-link'), page = popup.view.webContents
    const frame = page.mainFrame, token = frame.frameToken, processId = frame.processId
    popup.linkRequest = request
    popup.appLinkPrompt = null
    this.emit(popup)
    const current = () => this.live(popup) && popup.linkRequest === request && !frame.isDestroyed() && !frame.detached &&
      page.mainFrame === frame && frame.frameToken === token && frame.processId === processId
    try {
      const choice = (await this.host.appLinks.rememberedSchemes())[scheme]
      if (!current()) return
      popup.error = null
      const outcome = appLinkOutcome(url, scheme, choice, target => { void this.openExternal(popup, target, current) })
      popup.appLinkPrompt = outcome.kind === 'ask' ? { id: mintObjectId(), url, scheme } : null
      if (outcome.kind === 'refused') popup.error = appLinkRefusedMessage(scheme)
    } catch (error) { if (current()) popup.error = `Could not check the app-link choice: ${message(error)}. Try the original link again.` }
    if (current()) this.emit(popup)
  }

  private async answerAppLink(popup: Popup, command: Extract<BrowserPopupCommand, { kind: 'answer-app-link' }>): Promise<void> {
    const pending = popup.appLinkPrompt
    if (!pending || pending.id !== command.promptId) throw new Error('This app-link prompt is no longer current')
    const request = popup.linkRequest
    const current = () => this.live(popup) && popup.linkRequest === request && popup.appLinkPrompt === pending
    const choice = command.allow ? 'allow' : 'deny'
    if (command.remember) {
      try { await this.host.appLinks.rememberScheme(pending.scheme, choice) }
      catch (error) { if (current()) popup.warning = `This choice could not be saved: ${message(error)}` }
    }
    if (!current()) return
    popup.error = null
    const outcome = appLinkOutcome(pending.url, pending.scheme, choice, target => {
      // The same request continues after this prompt is consumed.
      void this.openExternal(popup, target, () => this.live(popup) && popup.linkRequest === request)
    })
    popup.appLinkPrompt = null
    if (outcome.kind === 'refused') popup.error = appLinkRefusedMessage(pending.scheme)
    this.emit(popup)
  }

  private async openExternal(popup: Popup, target: string, current: () => boolean): Promise<void> {
    try { await this.host.appLinks.openExternal(target) }
    catch (error) {
      if (!current()) return
      popup.error = `Could not open this link in another app: ${message(error)}`
      this.emit(popup)
    }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
