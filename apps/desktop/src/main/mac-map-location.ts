import { app, BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { MacMapLocationResult } from '../shared/mesh-map-locations.js'

const require = createRequire(import.meta.url)

/** Core Location must run inside the original foreground application bundle. */
async function readMacMapLocation(sender: WebContents): Promise<MacMapLocationResult> {
  if (process.platform !== 'darwin') return { state: 'unavailable' }
  const window = BrowserWindow.fromWebContents(sender)
  if (!window?.isFocused() || !window.isVisible()) return { state: 'not-focused' }
  try {
    const native = require(join(app.getAppPath(), 'resources', 'bin', 'agentmux-mac-location.node')) as {
      read(): Promise<MacMapLocationResult>
    }
    return await native.read()
  } catch {
    return { state: 'unavailable' }
  }
}

export function registerMacMapLocationIpc(
  handle: (channel: string, listener: (event: IpcMainInvokeEvent) => Promise<MacMapLocationResult>) => void
): void {
  handle('ui:requestMacMapLocation', event => readMacMapLocation(event.sender))
}
