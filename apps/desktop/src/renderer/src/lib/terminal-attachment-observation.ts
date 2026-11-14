import type { TerminalAttachResult } from '../../../shared/contracts'
import { api } from './api'

async function releaseLateAttachment(attachmentId: string, detach: (id: string) => Promise<void>): Promise<void> {
  try { await detach(attachmentId) }
  catch (error) { console.warn('[terminal] Late Attachment release was not acknowledged', error) }
}

/** Retire only this view's reader. A late acquired lease still belongs to its original reply. */
export function observeTerminalAttachment(request: Promise<TerminalAttachResult>, signal: AbortSignal,
  retainedAttachmentId: string | null, detach: (id: string) => Promise<void> = id => api.sessions.detach(id)): Promise<TerminalAttachResult> {
  // These callbacks live outside the TerminalView effect: an original request may outlive
  // the reader, but must not retain its terminal, replay queue or component callbacks.
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    void request.then(result => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        if (result.attachmentId !== retainedAttachmentId) {
          void releaseLateAttachment(result.attachmentId, detach)
        }
        return
      }
      resolve(result)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
