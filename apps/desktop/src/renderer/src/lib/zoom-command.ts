import type { BrowserZoomStep } from '../../../shared/contracts'
import { api } from './api'
import { focusedWorkbenchDocument, workbenchDocumentIdentity } from './workbench-window-registry'

/**
 * View menu zoom that reached the renderer because a workbench window had focus. Focus inside a Browser's surface,
 * marked with `data-browser-surface`, zooms that Browser's page; focus anywhere else zooms the window's interface.
 */
export async function runZoomCommand(step: BrowserZoomStep, doc: Document = focusedWorkbenchDocument()): Promise<void> {
  const browserId = doc.activeElement?.closest<HTMLElement>('[data-browser-surface]')?.dataset.browserSurface
  if (browserId) await api.browser.zoom(browserId, step)
  else await api.ui.zoomInterface(step, workbenchDocumentIdentity(doc) ?? undefined)
}
