import type { BrowserWindow, Dialog } from 'electron'
import { prepareWindowWorkbench } from './window-state-persistence.js'

/** Main owns this notice: a crashed renderer cannot draw its own recovery or Quit controls. */
export function registerRendererCrashRecovery(
  window: BrowserWindow,
  dialog: Pick<Dialog, 'showMessageBox'>,
  requestQuit: () => void,
  isQuitting: () => boolean
): () => Promise<void> {
  const contents = window.webContents
  let notice: Promise<void> | null = null
  const recover = (explicit: boolean): Promise<void> => {
    if (window.isDestroyed() || contents.isDestroyed() || isQuitting() || (!explicit && !contents.isCrashed())) {
      return Promise.resolve()
    }
    if (notice) return notice
    const crashed = contents.isCrashed()
    notice = dialog.showMessageBox(window, {
      type: crashed ? 'error' : 'question',
      title: 'AgentMux',
      message: crashed ? 'The interface stopped unexpectedly' : 'Recover the interface',
      detail: crashed
        ? 'Existing data on disk is retained. Agent runs have not been stopped by this interface failure. The last interface changes that were not saved may be lost. Reload to restore your workbench, or quit AgentMux. You can also reopen this notice from View → Recover interface.'
        : 'The interface process is still running; its current display state is unknown. Reload first checks that the workbench can be saved. If saving is unconfirmed, your original window is kept. Existing data and Agent runs are retained. You can also quit AgentMux or keep this window.',
      buttons: ['Reload interface', 'Quit AgentMux', 'Keep window'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    }).then(async ({ response }) => {
      if (window.isDestroyed() || contents.isDestroyed() || isQuitting() || (crashed && !contents.isCrashed())) return
      if (response === 0) {
        try { await prepareWindowWorkbench(window, 'reload') }
        catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(`Interface recovery save is unconfirmed: ${detail}\n`)
          if (!window.isDestroyed() && !contents.isDestroyed() && !isQuitting()) {
            await dialog.showMessageBox(window, {
              type: 'error', title: 'AgentMux', message: 'The workbench save is unconfirmed',
              detail: `Reload was paused and your original window was kept. Agent input was not disabled by this save request. Restore storage access or wait for the current save, then retry View → Recover interface. ${detail}`,
              buttons: ['Keep window'], defaultId: 0, cancelId: 0, noLink: true
            })
          }
          return
        }
        if (!window.isDestroyed() && !contents.isDestroyed() && !isQuitting()) window.reload()
      }
      else if (response === 1) requestQuit()
    }).catch((error: unknown) => {
      process.stderr.write(`Interface recovery notice failed: ${String(error)}\n`)
    }).finally(() => { notice = null })
    return notice
  }
  const onGone = (): void => { void recover(false) }
  contents.on('render-process-gone', onGone)
  window.once('closed', () => {
    contents.removeListener('render-process-gone', onGone)
  })
  return () => recover(true)
}
