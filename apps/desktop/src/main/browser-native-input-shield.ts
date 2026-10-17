import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'

const DOCUMENT = 'data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;user-select:none}</style>')

/** A sibling native surface owns human hit-testing; CDP still addresses the original page.
 * Never prevent mouse events on the page: Electron sends CDP mouse input through
 * that same before-mouse-event boundary. No event trust/appearance test can fix it.
 */
export class BrowserNativeInputShield {
  readonly view: WebContentsView
  readonly contents: WebContents
  private readonly source: WebContents
  readonly ready: Promise<void>
  private disposed = false
  private host: BrowserWindow | undefined
  private readonly focused = (): void => {
    try {
      if (!this.current() || !this.source.isFocused()) return
      if (this.contents.isDestroyed()) throw new Error('The native input surface ended before focus transfer')
      this.contents.focus()
    } catch { this.failed() }
  }
  private readonly boundsChanged = (): void => {
    try { this.synchronize() } catch { this.failed() }
  }

  constructor(private readonly page: WebContentsView, private readonly window: () => BrowserWindow,
    private readonly isCurrent: () => boolean, private readonly onFailure: () => void) {
    this.source = page.webContents
    this.view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      focusOnNavigation: false, navigateOnDragDrop: false } })
    this.contents = this.view.webContents
    this.view.setBackgroundColor('#00000000')
    this.contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.contents.on('will-navigate', event => event.preventDefault())
    this.contents.on('will-frame-navigate', event => event.preventDefault())
    this.contents.on('context-menu', event => event.preventDefault())
    // macOS does not route OS input into a nested WebContentsView reliably.
    // Use the same native parent as the page; the Browser owner exposes the
    // ordered pair to Chrome so a floating stage moves both original surfaces.
    try {
      page.on('bounds-changed', this.boundsChanged)
      this.source.on('focus', this.focused)
      this.synchronize()
      this.ready = this.contents.loadURL(DOCUMENT).then(() => {
        if (!this.current()) return
        this.synchronize()
        this.focused()
      })
    } catch (error) {
      try { this.dispose() } catch { /* Preserve the original admission failure. */ }
      throw error
    }
  }

  get isolated(): boolean {
    if (!this.current() || this.contents.isDestroyed() || !this.host || this.host !== this.window() || this.host.isDestroyed()) return false
    const children = this.host.contentView.children, pageIndex = children.indexOf(this.page)
    if (pageIndex < 0 || children.indexOf(this.view) !== pageIndex + 1) return false
    const bounds = this.view.getBounds(), source = this.page.getBounds()
    return bounds.x === source.x && bounds.y === source.y && bounds.width === source.width && bounds.height === source.height &&
      (!this.page.getVisible() || this.view.getVisible())
  }

  synchronize(): void {
    if (!this.current() || this.contents.isDestroyed()) return
    const host = this.window()
    if (this.host !== host || host.contentView.children.indexOf(this.view) !== host.contentView.children.indexOf(this.page) + 1) {
      if (this.host && !this.host.isDestroyed() && this.host.contentView.children.includes(this.view)) this.host.contentView.removeChildView(this.view)
      this.host = host
      const index = host.contentView.children.indexOf(this.page)
      if (index < 0) throw new Error('The original Browser native parent is not attached')
      host.contentView.addChildView(this.view, index + 1)
    }
    this.view.setBounds(this.page.getBounds())
    this.view.setVisible(this.page.getVisible())
  }

  dispose(): void {
    const restoreFocus = !this.contents.isDestroyed() && this.contents.isFocused()
    this.disposed = true
    const failures: unknown[] = []
    for (const release of [
      () => this.page.off('bounds-changed', this.boundsChanged),
      () => { if (!this.source.isDestroyed()) this.source.off('focus', this.focused) },
      () => {
        if (this.host && !this.host.isDestroyed() && this.host.contentView.children.includes(this.view)) this.host.contentView.removeChildView(this.view)
      },
      () => { if (!this.contents.isDestroyed()) this.contents.close() }
    ]) try { release() } catch (error) { failures.push(error) }
    const host = this.window()
    if (restoreFocus && !this.source.isDestroyed() && this.page.getVisible() && !host.isDestroyed() && host.isFocused()) this.source.focus()
    if (failures.length) throw new AggregateError(failures, 'The exact Browser native input surface could not be released')
  }

  private current(): boolean { return !this.disposed && this.isCurrent() && !this.source.isDestroyed() }

  private failed(): void {
    // The owner records current failure facts before notifying clients. A failed
    // notification must not escape a native callback and take down a healthy page.
    try { this.onFailure() } catch { /* The exact owner retains its service state for the next read. */ }
  }
}
