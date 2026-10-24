import { app, clipboard, nativeImage } from 'electron'
import { join, resolve } from 'node:path'
import { NativeDesktop } from '@agentmux/native-desktop'
import { nativeImageFromBrowserPng } from './browser-image.js'

/** Explicit host profiles; a missing artifact never selects another executable. */
export function resolvedNativeDesktopOptions(): { appPath: string } | { executablePath: string } {
  return app.isPackaged
    ? { appPath: join(app.getAppPath(), 'resources', 'AgentMux Native.app') }
    : { executablePath: resolve(app.getAppPath(), '../../packages/native-desktop/macos/.build/debug/agentmux-native-macos') }
}

let owner: NativeDesktop | undefined

/** One lazy OS owner for all Desktop windows and the public Core port. No startup preflight. */
export function getNativeDesktopOwner(): NativeDesktop {
  if (!owner) {
    owner = new NativeDesktop(resolvedNativeDesktopOptions())
    app.once('will-quit', () => {
      void owner?.dispose().catch(error => console.warn('The original native desktop connection could not be released:', error))
    })
  }
  return owner
}

type DesktopNativeUiOwner = Pick<NativeDesktop, 'captureScreenshot' | 'readClipboardText' | 'writeClipboardText' | 'writeClipboardImage'>

// These existing Electron operations retain their original platform owner.
// NativeDesktop itself remains macOS-only, including its public Core port.
const electronUiOwner: DesktopNativeUiOwner = {
  captureScreenshot: input => getNativeDesktopOwner().captureScreenshot(input),
  readClipboardText: async () => clipboard.readText(),
  writeClipboardText: async text => { clipboard.writeText(text) },
  writeClipboardImage: async image => { clipboard.writeImage(nativeImageFromBrowserPng(image, nativeImage.createFromBuffer)) }
}

/** Platform is fixed before each operation; a failed native request never changes its owner. */
export function getDesktopNativeUiOwner(): DesktopNativeUiOwner {
  return process.platform === 'darwin' ? getNativeDesktopOwner() : electronUiOwner
}
