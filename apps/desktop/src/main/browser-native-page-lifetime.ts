import type { WebContents } from 'electron'

/** Observes one WebContents. The host decides what closure means for its retained Browser. */
export function bindBrowserNativePageLifetime(contents: WebContents, owner: {
  onCloseRequested(): boolean
  onClosePrevented(): void
  onRendererGone(reason: string): void
  onDestroyed(pageRequestedClose: boolean): void
}): () => void {
  let pageRequestedClose = false
  // Electron emits CloseContents as `close`; its WebContents typings omit it.
  const nativeEvents: NodeJS.EventEmitter = contents
  nativeEvents.on('close', () => {
    if (owner.onCloseRequested()) pageRequestedClose = true
  })
  const resetClose = () => { pageRequestedClose = false }
  contents.on('will-prevent-unload', () => {
    resetClose()
    owner.onClosePrevented()
  })
  contents.on('render-process-gone', (_event, details) => owner.onRendererGone(details.reason))
  contents.once('destroyed', () => owner.onDestroyed(pageRequestedClose))
  return resetClose
}
