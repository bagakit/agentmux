import type { BrowserWindow } from 'electron'
import {
  WINDOW_RESIZE_EVENT_CHANNEL,
  type WindowResizeEvent
} from '../shared/contracts.js'

/** Publishes the native manual-window-resize transaction without owning geometry. */
export function registerWindowResizeEvents(window: BrowserWindow): () => void {
  let active = false
  let disposed = false
  let safetyTimeout: ReturnType<typeof setTimeout> | null = null

  const clearSafetyTimeout = (): void => {
    if (safetyTimeout !== null) {
      clearTimeout(safetyTimeout)
      safetyTimeout = null
    }
  }

  const publish = (next: boolean): void => {
    if (disposed || active === next) return
    active = next
    if (window.webContents.isDestroyed()) return
    const event: WindowResizeEvent = { active: next }
    window.webContents.send(WINDOW_RESIZE_EVENT_CHANNEL, event)
  }

  const end = (): void => {
    clearSafetyTimeout()
    publish(false)
  }

  const begin = (): void => {
    publish(true)
    clearSafetyTimeout()
    safetyTimeout = setTimeout(end, 300)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearSafetyTimeout()
    window.removeListener('will-resize', begin)
    window.removeListener('resize', begin)
    window.removeListener('resized', end)
    window.removeListener('maximize', end)
    window.removeListener('unmaximize', end)
    window.removeListener('enter-full-screen', end)
    window.removeListener('leave-full-screen', end)
    window.removeListener('closed', dispose)
  }

  window.on('will-resize', begin)
  window.on('resize', begin)
  window.on('resized', end)
  window.on('maximize', end)
  window.on('unmaximize', end)
  window.on('enter-full-screen', end)
  window.on('leave-full-screen', end)
  window.once('closed', dispose)

  return dispose
}
