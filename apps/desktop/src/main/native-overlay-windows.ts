import type { BrowserWindow } from 'electron'
import { NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_BROWSER_VISIBILITY_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL } from '../shared/contracts.js'
import type { WorkbenchWindowDocument } from '../shared/workbench-windows.js'
import type { NativeOverlayRegion, NativeOverlayReceipt, NativeBrowserVisibility } from '../shared/native-overlay.js'
import type { BrowserViewManager, NativeBrowserOwner, NativeBrowserPageInput } from './browser-view-manager.js'
import type { WorkbenchWindows } from './workbench-windows.js'
import { NativeOverlaySurfaces } from './native-overlay-surfaces.js'
import { installNativeOverlayFocus } from './native-overlay-focus.js'

type Entry = { document?: WorkbenchWindowDocument; surfaces: NativeOverlaySurfaces; release(): void }

/** Native projections only. Every handler and original workface still belongs to the one Renderer. */
export class NativeOverlayWindows {
  private readonly entries = new Map<BrowserWindow, Entry>()
  private revision = 0
  private disposed = false
  private readonly releaseFocus: () => void

  constructor(private readonly main: BrowserWindow, private readonly browsers: Pick<BrowserViewManager, 'visibleNativeBounds' | 'nativeOwner' | 'nativeOwnerForView' | 'windowForView'>,
    private readonly windows: Pick<WorkbenchWindows, 'windowForDocument'>) {
    this.releaseFocus = installNativeOverlayFocus(main,
      { hasProjectionInFocusedWindow: () => this.entries.get(main)?.surfaces.hasProjectionInFocusedWindow() === true },
      document => this.entry(document).surfaces)
  }

  async update(regions: NativeOverlayRegion[], document?: WorkbenchWindowDocument): Promise<NativeOverlayReceipt> {
    return await this.entry(document).surfaces.update(regions)
  }

  visibility(document?: WorkbenchWindowDocument): NativeBrowserVisibility {
    const entry = this.entry(document), window = this.windows.windowForDocument(document)
    return { revision: this.revision, bounds: this.browsers.visibleNativeBounds(window), zoomFactor: window.webContents.getZoomFactor(),
      ...(entry.document ? { document: entry.document } : {}) }
  }

  visibilityChanged(window?: BrowserWindow): void {
    ++this.revision
    for (const [host, entry] of this.entries) {
      if (window && host !== window || host.isDestroyed()) continue
      try {
        this.send(NATIVE_BROWSER_VISIBILITY_CHANNEL, this.visibility(entry.document))
        void entry.surfaces.refresh().catch(() => this.warning(entry, 'Native floating content could not be refreshed. Original Browser content remains available; reopen this floating control.'))
      } catch { /* An old document cannot publish demand for its replacement. */ }
    }
  }

  forwardBrowserInput(owner: NativeBrowserOwner, input: NativeBrowserPageInput): boolean {
    // This is the original Browser manager's actual native attachment, never its title or selected Tab.
    return this.entries.get(this.browsers.windowForView(owner.view))?.surfaces.forwardBrowserInput(owner, input) ?? false
  }

  async refresh(window: BrowserWindow = this.main): Promise<void> {
    const entry = this.entries.get(window)
    if (!entry) return
    await entry.surfaces.refresh().catch(() => {
      this.warning(entry, 'Native floating content could not be refreshed. Original Browser content remains available; reopen this floating control.')
    })
  }

  resourceProcessIds(): number[] {
    return [...new Set([...this.entries.values()].flatMap(entry => entry.surfaces.resourceProcessIds()))]
  }

  releaseWindow(window: BrowserWindow): void {
    const entry = this.entries.get(window)
    if (!entry) return
    this.entries.delete(window)
    entry.release()
  }

  dispose(): void {
    this.disposed = true
    this.releaseFocus()
    for (const window of this.entries.keys()) this.releaseWindow(window)
  }

  private entry(document?: WorkbenchWindowDocument): Entry {
    if (this.disposed) throw new Error('The native projection owner is unavailable. Original work remains.')
    const window = this.windows.windowForDocument(document)
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('The exact native document is unavailable. Original work remains.')
    const existing = this.entries.get(window)
    if (existing) return existing
    const contents = window.webContents
    const entry: Entry = {
      ...(document ? { document: { ...document } } : {}),
      surfaces: new NativeOverlaySurfaces(window, {
        visibleNativeBounds: () => this.browsers.visibleNativeBounds(window),
        nativeOwner: browserId => this.browsers.nativeOwner(browserId, window),
        nativeOwnerForView: view => this.browsers.nativeOwnerForView(view, window)
      }, (message, modalId) => this.warning(entry, message, modalId), input => this.send(NATIVE_BROWSER_INPUT_CHANNEL,
        { ...input, ...(entry.document ? { document: entry.document } : {}) })),
      release: () => {
        window.off('closed', release)
        contents.off('did-start-navigation', navigation)
        contents.off('render-process-gone', release)
        entry.surfaces.dispose()
      }
    }
    const release = (): void => this.releaseWindow(window)
    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (mainFrame && !inPlace) release()
    }
    this.entries.set(window, entry)
    window.once('closed', release)
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', release)
    return entry
  }

  private warning(entry: Entry, message: string, modalId?: string): void {
    this.send(NATIVE_OVERLAY_WARNING_CHANNEL, { message, ...(modalId ? { modalId } : {}), ...(entry.document ? { document: entry.document } : {}) })
  }
  private send(channel: string, value: unknown): void {
    if (!this.disposed && !this.main.isDestroyed() && !this.main.webContents.isDestroyed()) this.main.webContents.send(channel, value)
  }
}
