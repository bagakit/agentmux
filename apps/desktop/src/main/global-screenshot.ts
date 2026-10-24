import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import { SCREENSHOT_ATTACHMENT_RECEIVER } from '../shared/screenshot-attachment.js'
import type { WorkbenchWindowDocument } from '../shared/workbench-windows.js'

type Attachment = { complete(path: string | null): Promise<void> }
type Ports = {
  contents: Pick<WebContents, 'isDestroyed' | 'mainFrame'>
  focusedWindow(): BrowserWindow | null
  windowForDocument(document: WorkbenchWindowDocument): BrowserWindow
  capture(attachToDraft: boolean): Promise<string | null>
  reportIssue(error: unknown): void
}

/** Global capture is owned by Main. An unavailable workbench only loses its optional attachment. */
export class GlobalScreenshot {
  private pending: Promise<void> | null = null
  constructor(private readonly ports: Ports) {}

  run(): Promise<void> {
    if (this.pending) return this.pending
    const action = this.runOnce().finally(() => { if (this.pending === action) this.pending = null })
    this.pending = action
    return action
  }

  private async runOnce(): Promise<void> {
    const attachment = await this.prepare()
    let path: string | null = null
    try { path = await this.ports.capture(attachment !== null) }
    finally {
      // Exactly the original frame and operation receive the final path or cancellation.
      // Failure here cannot undo an independent clipboard write or retarget another draft.
      if (attachment) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const completion = attachment.complete(path).catch(error => this.ports.reportIssue(error))
        try {
          await Promise.race([completion, new Promise<void>(resolve => {
            timer = setTimeout(() => {
              this.ports.reportIssue(new Error(`Original draft attachment is still unconfirmed.${path ? ` The image is saved at ${path}.` : ''} Clipboard delivery is independent. Check the original draft before attaching again.`))
              resolve()
            }, 500)
          })])
        } finally { if (timer) clearTimeout(timer) }
      }
    }
  }

  private async prepare(): Promise<Attachment | null> {
    let request: Promise<unknown> | undefined, complete: ((path: string | null) => Promise<void>) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const release = () => {
      if (request && complete) void request.then(() => complete!(null).catch(error => this.ports.reportIssue(error)), () => {})
    }
    try {
      const focused = this.ports.focusedWindow()
      if (!focused || focused.isDestroyed() || focused.isMinimized() || !focused.isFocused() || this.ports.contents.isDestroyed()) return null
      const frame = this.ports.contents.mainFrame, operationId = mintObjectId()
      complete = (path: string | null) => completeInFrame(frame, operationId, path)
      let expired = false
      request = frame.executeJavaScript(`window.${SCREENSHOT_ATTACHMENT_RECEIVER}?.prepare(${JSON.stringify(operationId)})`)
      const document = await Promise.race([
        request,
        new Promise<null>(resolve => { timeout = setTimeout(() => { expired = true; resolve(null) }, 250) })
      ]) as WorkbenchWindowDocument | null | undefined
      if (expired) {
        release()
        this.ports.reportIssue(new Error('Screenshot draft focus could not be observed in time. This capture will still copy to the clipboard.'))
        return null
      }
      if (!document) return null
      if (this.ports.windowForDocument(document) !== focused || !focused.isFocused() || focused.isMinimized()) {
        release()
        return null
      }
      return { complete }
    } catch (error) {
      this.ports.reportIssue(new Error(`Screenshot draft attachment could not be prepared. Clipboard capture remains available. ${String(error)}`))
      release()
      return null
    } finally { if (timeout) clearTimeout(timeout) }
  }
}

async function completeInFrame(frame: WebFrameMain, operationId: string, path: string | null): Promise<void> {
  await frame.executeJavaScript(`(() => {
    const receiver = window.${SCREENSHOT_ATTACHMENT_RECEIVER};
    if (!receiver) ${path ? `throw new Error(${JSON.stringify(`The original screenshot draft document closed. The image is saved at ${path}; clipboard delivery is independent.`)})` : 'return'};
    return receiver.complete(${JSON.stringify(operationId)}, ${JSON.stringify(path)});
  })()`)
}
