import { BrowserWindow } from 'electron'
import { meshDevicePartition } from './mesh-device-partition.js'
import { join } from 'node:path'
import { readMeshDeviceLink } from '../shared/mesh-device-link.js'

const windows = new Map<string, { window: BrowserWindow; loaded: Promise<void> }>()

export function existingMeshDeviceWindow(url: string): BrowserWindow | undefined {
  const window = windows.get(url)?.window
  return window && !window.isDestroyed() ? window : undefined
}

/** Each endpoint retains its original device credential and workface in this Desktop profile. */
export async function openMeshDeviceWindow(input: string, directory = join(import.meta.dirname, '../mobile')): Promise<void> {
  const { url, offer } = readMeshDeviceLink(input)
  const existing = windows.get(url)
  if (existing && !existing.window.isDestroyed()) {
    await existing.loaded
    existing.window.show(); existing.window.focus()
    return
  }
  const window = new BrowserWindow({ title: 'AgentMux · ' + offer.serverId, width: 1060, height: 760, show: false,
    webPreferences: { partition: meshDevicePartition(offer), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.once('closed', () => { if (windows.get(url)?.window === window) windows.delete(url) })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-redirect', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    const loaded = window.loadFile(join(directory, 'device.html'), { hash: new URLSearchParams({ link: url }).toString() })
    windows.set(url, { window, loaded })
    await loaded
    window.show()
  } catch (cause) {
    if (!window.isDestroyed()) window.destroy()
    throw cause
  }
}
