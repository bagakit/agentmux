import type { IpcMainInvokeEvent } from 'electron'
import type { NativeDesktop } from '@agentmux/native-desktop'
import type { BrowserPng } from '../shared/contracts.js'
import { captureComposerScreenshot } from './composer-screenshot.js'

type Channel = 'ui:captureScreenshot' | 'ui:readClipboardText' | 'ui:writeClipboardText' | 'ui:writeClipboardImage'

/** Existing preload operations share the same lazy OS owner; Browser pixels remain independent. */
export function registerNativeDesktopIpc(ports: {
  home: string
  native(): Pick<NativeDesktop, 'captureScreenshot' | 'readClipboardText' | 'writeClipboardText' | 'writeClipboardImage'>
  handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void
  trust(channel: Channel, event: IpcMainInvokeEvent): void
}): void {
  ports.handle('ui:captureScreenshot', event => {
    ports.trust('ui:captureScreenshot', event)
    return captureComposerScreenshot(ports.home, ports.native())
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
