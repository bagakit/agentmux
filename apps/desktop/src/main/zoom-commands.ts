import type { WebContents } from 'electron'
import { ZOOM_COMMAND_CHANNEL, type BrowserZoomStep } from '../shared/contracts.js'

/** What View menu zoom reaches once the workbench window's IPC owner is registered. */
export interface ZoomCommandTargets {
  /** The Browser showing this page now, if any. */
  browserIdFor(contents: WebContents): string | null
  zoomBrowser(browserId: string, step: BrowserZoomStep): void
  /** Whether this is the page of a workbench window itself, not a page placed inside one. */
  isWorkbench(contents: WebContents): boolean
  /** The renderer that drives every workbench window; only it sees which element holds focus. */
  workbench: WebContents
}

/** Electron's View menu zoom roles: half a zoom level a step, and level 0 for Actual Size. */
export function stepInterfaceZoom(contents: WebContents, step: BrowserZoomStep): void {
  contents.zoomLevel = step === 'reset' ? 0 : contents.zoomLevel + (step === 'in' ? 0.5 : -0.5)
}

/**
 * View menu zoom acts on what a person is looking at. A focused Browser page zooms through its manager, a focused
 * workbench window lets its renderer choose between the Browser whose surface holds focus and the interface, and any
 * other page zooms as Electron's roles did.
 */
export class ZoomCommands {
  private targets: ZoomCommandTargets | null = null

  attach(targets: ZoomCommandTargets): () => void {
    this.targets = targets
    return () => { if (this.targets === targets) this.targets = null }
  }

  run(step: BrowserZoomStep, focused: WebContents | null): void {
    if (!focused || focused.isDestroyed()) return
    const targets = this.targets
    const browserId = targets?.browserIdFor(focused) ?? null
    if (targets && browserId) {
      try { targets.zoomBrowser(browserId, step) }
      catch (error) {
        targets.workbench.send(ZOOM_COMMAND_CHANNEL, { kind: 'failed', message: `Page zoom could not finish: ${error instanceof Error ? error.message : String(error)}. The page is kept; retry the zoom command.` })
      }
    } else if (targets?.isWorkbench(focused) && !targets.workbench.isDestroyed()) targets.workbench.send(ZOOM_COMMAND_CHANNEL, { kind: 'step', step })
    else stepInterfaceZoom(focused, step)
  }
}
