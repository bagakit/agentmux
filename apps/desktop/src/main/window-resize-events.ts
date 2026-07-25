import type { BrowserWindow } from 'electron'
import {
  WINDOW_RESIZE_EVENT_CHANNEL,
  type WindowResizeEvent
} from '../shared/contracts.js'

/** Publishes the native manual-window-resize transaction without owning geometry. */
export function registerWindowResizeEvents(window: BrowserWindow): () => void {
  let active = false
  let disposed = false

  const publish = (next: boolean): void => {
    if (disposed || active === next) return
    active = next
    if (window.webContents.isDestroyed()) return
    const event: WindowResizeEvent = { active: next }
    window.webContents.send(WINDOW_RESIZE_EVENT_CHANNEL, event)
  }
  const begin = (): void => publish(true)
  const end = (): void => publish(false)

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    window.removeListener('will-resize', begin)
    window.removeListener('resized', end)
    window.removeListener('closed', dispose)
  }

  window.on('will-resize', begin)
  window.on('resized', end)
  window.once('closed', dispose)

  return dispose
}
