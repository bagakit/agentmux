import type { IpcMainInvokeEvent } from 'electron'
import type { NativeDesktop } from '@agentmux/native-desktop'
import type { BrowserPng } from '../shared/contracts.js'

/** Existing preload operations use their fixed platform owner; Browser pixels remain independent. */
export function registerNativeDesktopIpc(ports: {
  capture(mode?: import('../shared/screenshot-source').ScreenshotCaptureMode): Promise<string | null>
  native(): Pick<NativeDesktop, 'captureScreenshot' | 'readClipboardText' | 'writeClipboardText' | 'writeClipboardImage'>
  handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void
}): void {
  ports.handle('ui:captureScreenshot', (event, mode?: import('../shared/screenshot-source').ScreenshotCaptureMode) => {
    return ports.capture(mode)
  })
  ports.handle('ui:readClipboardText', event => {
    return ports.native().readClipboardText()
  })
  ports.handle('ui:writeClipboardText', (event, text: string) => {
    return ports.native().writeClipboardText(text)
  })
  ports.handle('ui:writeClipboardImage', (event, image: BrowserPng) => {
    return ports.native().writeClipboardImage(image)
  })
}
