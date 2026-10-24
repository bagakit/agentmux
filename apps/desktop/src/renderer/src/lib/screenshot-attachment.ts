import { SCREENSHOT_ATTACHMENT_RECEIVER, type ScreenshotAttachmentReceiver } from '../../../shared/screenshot-attachment'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'

export type ScreenshotAttachment = { document: WorkbenchWindowDocument; complete(path: string | null): Promise<void> }
export type ScreenshotAttachmentTarget = { prepare(): ScreenshotAttachment | null }
let selected: ScreenshotAttachmentTarget | null = null
const pending = new Map<string, ScreenshotAttachment>()

/** The last focus event locates a candidate; prepare must still prove current input focus. */
export function selectScreenshotTarget(target: ScreenshotAttachmentTarget | null): void { selected = target }
export function releaseScreenshotTarget(target: ScreenshotAttachmentTarget): void { if (selected === target) selected = null }

export const screenshotAttachmentReceiver: ScreenshotAttachmentReceiver = {
  prepare(operationId) {
    if (pending.has(operationId)) throw new Error('This screenshot already has its original attachment preparation.')
    const attachment = selected?.prepare()
    if (!attachment) return null
    pending.set(operationId, attachment)
    return attachment.document
  },
  async complete(operationId, path) {
    const attachment = pending.get(operationId)
    if (!attachment) {
      if (path) throw new Error(`The original screenshot draft is no longer available. The image is saved at ${path} and clipboard delivery is independent.`)
      return
    }
    pending.delete(operationId)
    await attachment.complete(path)
  }
}

export function installScreenshotAttachmentReceiver(host: Window): () => void {
  Object.assign(host, { [SCREENSHOT_ATTACHMENT_RECEIVER]: screenshotAttachmentReceiver })
  return () => {
    if ((host as unknown as Record<string, unknown>)[SCREENSHOT_ATTACHMENT_RECEIVER] === screenshotAttachmentReceiver)
      delete (host as unknown as Record<string, unknown>)[SCREENSHOT_ATTACHMENT_RECEIVER]
    for (const id of pending.keys()) void screenshotAttachmentReceiver.complete(id, null).catch(() => {})
  }
}
