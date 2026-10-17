import type { IpcMainInvokeEvent } from 'electron'
import type { BrowserInputContextCaptures } from './browser-input-context-capture.js'
import type { BrowserInputContextFreeze } from '../shared/browser-input-context-capture.js'

type Channel = 'browser:captureInputContext' | 'browser:freezeInputContext'
/** Only the first-party human surface can create a capture. Public inspection remains read-only. */
export function registerBrowserInputContextIpc(ports: {
  handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void
  trust(channel: Channel, event: IpcMainInvokeEvent): void
  captures: BrowserInputContextCaptures
}): void {
  ports.handle('browser:captureInputContext', (event, browserId: string) => {
    ports.trust('browser:captureInputContext', event)
    return ports.captures.capture(browserId)
  })
  ports.handle('browser:freezeInputContext', (event, input: BrowserInputContextFreeze) => {
    ports.trust('browser:freezeInputContext', event)
    return ports.captures.freeze(input)
  })
}
