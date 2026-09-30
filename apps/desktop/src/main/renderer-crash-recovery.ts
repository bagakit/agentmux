import type { BrowserWindow, Dialog } from 'electron'

/** Main owns this notice: a crashed renderer cannot draw its own recovery or Quit controls. */
export function registerRendererCrashRecovery(
  window: BrowserWindow,
  dialog: Pick<Dialog, 'showMessageBox'>,
  requestQuit: () => void,
  isQuitting: () => boolean
): () => Promise<void> {
  const contents = window.webContents
  let notice: Promise<void> | null = null
  const recover = (): Promise<void> => {
    if (window.isDestroyed() || window.webContents.isDestroyed() || isQuitting() || !window.webContents.isCrashed()) {
      return Promise.resolve()
    }
    if (notice) return notice
    notice = dialog.showMessageBox(window, {
      type: 'error',
      title: 'AgentMux',
      message: 'The interface stopped unexpectedly',
      detail: 'Existing data on disk is retained. Agent runs have not been stopped by this interface failure. The last interface changes that were not saved may be lost. Reload to restore your workbench, or quit AgentMux. You can also reopen this notice from View → Recover interface.',
      buttons: ['Reload interface', 'Quit AgentMux', 'Keep window'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    }).then(({ response }) => {
      if (window.isDestroyed() || window.webContents.isDestroyed() || isQuitting() || !window.webContents.isCrashed()) return
      if (response === 0) window.reload()
      else if (response === 1) requestQuit()
    }).catch((error: unknown) => {
      process.stderr.write(`Interface recovery notice failed: ${String(error)}\n`)
    }).finally(() => { notice = null })
    return notice
  }
  const onGone = (): void => { void recover() }
  contents.on('render-process-gone', onGone)
  window.once('closed', () => {
    contents.removeListener('render-process-gone', onGone)
  })
  return recover
}
