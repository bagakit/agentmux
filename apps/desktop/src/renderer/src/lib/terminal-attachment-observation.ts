import type { SessionAttachResult } from '../../../shared/contracts'
import { api } from './api'

async function releaseLateAttachment(attachmentId: string): Promise<void> {
  try { await api.sessions.detach(attachmentId) }
  catch (error) { console.warn('[terminal] Late Attachment release was not acknowledged', error) }
}

/** Retire only this view's reader. A late acquired lease still belongs to its original reply. */
export function observeTerminalAttachment(request: Promise<SessionAttachResult>, signal: AbortSignal,
  retainedAttachmentId: string | null): Promise<SessionAttachResult> {
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
          void releaseLateAttachment(result.attachmentId)
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
