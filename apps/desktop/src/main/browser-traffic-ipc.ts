import { app, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { writeNewCliFile } from '@agentmux/core/cli-atomic-file'
import { BrowserTraffic } from './browser-traffic.js'
import type { BrowserViewManager } from './browser-view-manager.js'

export function registerBrowserTrafficIpc(ports: {
  handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void
  browsers: Pick<BrowserViewManager, 'trafficTargets' | 'openTrafficCapture'>
  changed(): void
}): void {
  const owner = new BrowserTraffic({ targets: () => ports.browsers.trafficTargets(),
    attach: (id, signal) => ports.browsers.openTrafficCapture(id, signal), changed: ports.changed })
  ports.handle('browser:trafficTargets', () => owner.targets())
  ports.handle('browser:inspectTraffic', () => owner.inspect())
  ports.handle('browser:startTraffic', (_event, ids: unknown) => owner.start(ids))
  ports.handle('browser:stopTraffic', async (_event, id: string) => await owner.stop(id))
  ports.handle('browser:exportTraffic', async (event, id: string) => {
    const har = owner.har(id)
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) throw new Error('Open the original Browser window to save this HAR.')
    const choice = await dialog.showSaveDialog(parent, { title: 'Export original traffic',
      defaultPath: 'traffic.har', filters: [{ name: 'HTTP archive', extensions: ['har'] }] })
    if (choice.canceled || !choice.filePath) return null
    return await writeNewCliFile(choice.filePath, JSON.stringify(har) + '\n')
  })
  app.once('will-quit', () => owner.shutdown())
}
