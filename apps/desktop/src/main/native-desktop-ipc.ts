import type { IpcMainInvokeEvent } from 'electron'
import type { NativeDesktop } from '@agentmux/native-desktop'
import type { BrowserPng } from '../shared/contracts.js'

type Channel = 'ui:captureScreenshot' | 'ui:readClipboardText' | 'ui:writeClipboardText' | 'ui:writeClipboardImage'

/** Existing preload operations use their fixed platform owner; Browser pixels remain independent. */
export function registerNativeDesktopIpc(ports: {
  capture(): Promise<string | null>
  native(): Pick<NativeDesktop, 'captureScreenshot' | 'readClipboardText' | 'writeClipboardText' | 'writeClipboardImage'>
  handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void
  trust(channel: Channel, event: IpcMainInvokeEvent): void
}): void {
  ports.handle('ui:captureScreenshot', event => {
    ports.trust('ui:captureScreenshot', event)
    return ports.capture()
  })
  ports.handle('ui:readClipboardText', event => {
    ports.trust('ui:readClipboardText', event)
    return ports.native().readClipboardText()
  })
  ports.handle('ui:writeClipboardText', (event, text: string) => {
    ports.trust('ui:writeClipboardText', event)
    return ports.native().writeClipboardText(text)
  })
  ports.handle('ui:writeClipboardImage', (event, image: BrowserPng) => {
    ports.trust('ui:writeClipboardImage', event)
    return ports.native().writeClipboardImage(image)
  })
}
