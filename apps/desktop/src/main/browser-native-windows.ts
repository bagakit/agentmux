import type { BrowserWindowConstructorOptions, WebContents } from 'electron'
import { browserWindowOpenOutcome } from './browser-app-link.js'

/** The synchronous Chromium creation request is consumed once, without replaying its URL.
 * Page identity, lifecycle, controls and presentation all belong to BrowserViewManager. */
export function installNativeBrowserWindows(source: WebContents, host: {
  create(options: BrowserWindowConstructorOptions): WebContents
  handOff(url: string, scheme: string): void
  report(warning: string, page?: WebContents): void
}): void {
  // Electron 43's public custom-create branch omits OpenURLFromTab's continuation.
  // This envelope is scoped to the original synchronous native dispatch; URLs and
  // dispositions never correlate requests. Keep Electron's original listeners.
  type Request = { event: Electron.Event; navigate: unknown; consumed: boolean }
  let pending: Request | null = null
  const events: NodeJS.EventEmitter = source
  events.prependListener('-new-window', (event: Electron.Event, _url: unknown, _name: unknown,
    _disposition: unknown, _features: unknown, _referrer: unknown, _body: unknown, _sandbox: unknown, navigate: unknown) => {
    pending = { event, navigate, consumed: false }
  })
  events.prependListener('-will-add-new-contents', () => { pending = null })
  events.on('-new-window', (event: Electron.Event) => { if (pending?.event === event) pending = null })
  source.setWindowOpenHandler(({ url }) => {
    const request = pending
    pending = null
    const decision = browserWindowOpenOutcome(url, host.handOff)
    if (decision.action === 'deny') return decision
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: source.session } },
      createWindow: options => {
        const guest = (options as typeof options & { webContents?: WebContents }).webContents
        // Guestful requests keep native preferences, including javascript=no and sandbox.
        const page = host.create(guest ? options : { ...options, webPreferences: {
          ...(source as WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences(),
          ...options.webPreferences, session: source.session
        } })
        if (!guest) {
          const close = () => { if (!page.isDestroyed()) page.close() }
          events.once('current-render-view-deleted', close)
          page.once('destroyed', () => events.removeListener('current-render-view-deleted', close))
          const warn = (detail: string) => host.report(`${detail} The original Browser remains usable. Inspect the original child page before opening the link again.`, page)
          if (!request || request.consumed || typeof request.navigate !== 'function') warn('The original new-window navigation could not be confirmed.')
          else {
            request.consumed = true
            try { request.navigate(page) }
            catch (error) { warn(`The original new-window navigation returned an unknown result: ${error instanceof Error ? error.message : String(error)}.`) }
          }
        }
        return page
      } }
  })
}
