import type { IpcMainInvokeEvent, NativeImage } from 'electron'
import { BrowserInputContextCaptureFiles, BrowserInputContextCaptures } from './browser-input-context-capture.js'
import type { BrowserInputContextFreeze, BrowserInputSelectionPrepare } from '../shared/browser-input-context-capture.js'
import type { BrowserViewManager } from './browser-view-manager.js'
import type { BrowserInputImageReference } from '@agentmux/core/browser-input-context'
import type { PastedImage } from '@agentmux/client-ui/pasted-images'
import { browserInputSelectionImages, readBrowserInputSelectionImage } from './browser-input-selection-image.js'

type Channel = 'browser:captureInputContext' | 'browser:freezeInputContext' | 'browser:captureInputFrame' |
  'browser:prepareInputSelection' | 'browser:readInputSelection' | 'browser:readSelectionImage'

/** Main wiring shares the original capture journal and pasted resource owners. */
export function createBrowserInputContextPorts(options: {
  hostId: string; home: string; directory: string
  browsers: Pick<BrowserViewManager, 'inputContext' | 'captureInputFrame'>
  createFromBuffer(bytes: Buffer): NativeImage
}) {
  return {
    captures: new BrowserInputContextCaptures({ hostId: options.hostId,
      source: id => options.browsers.inputContext(id, options.hostId),
      captureFrame: id => options.browsers.captureInputFrame(id, options.hostId),
      selectionImages: browserInputSelectionImages(options.home, bytes => options.createFromBuffer(bytes)),
      files: new BrowserInputContextCaptureFiles(options.directory) }),
    readSelectionImage: (reference: BrowserInputImageReference) => readBrowserInputSelectionImage(options.home, options.hostId, reference, bytes => options.createFromBuffer(bytes))
  }
}
/** First-party capture data grants neither input authorship nor control. Public inspection stays read-only. */
export function registerBrowserInputContextIpc(ports: {
  handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void
  trust(channel: Channel, event: IpcMainInvokeEvent): void
  captures: BrowserInputContextCaptures
  readSelectionImage(reference: BrowserInputImageReference): Promise<PastedImage | null>
}): void {
  ports.handle('browser:captureInputContext', (event, browserId: string) => {
    ports.trust('browser:captureInputContext', event)
    return ports.captures.capture(browserId)
  })
  ports.handle('browser:freezeInputContext', (event, input: BrowserInputContextFreeze) => {
    ports.trust('browser:freezeInputContext', event)
    return ports.captures.freeze(input)
  })
  ports.handle('browser:captureInputFrame', (event, browserId: string) => {
    ports.trust('browser:captureInputFrame', event)
    return ports.captures.captureFrame(browserId)
  })
  ports.handle('browser:prepareInputSelection', (event, input: BrowserInputSelectionPrepare) => {
    ports.trust('browser:prepareInputSelection', event)
    return ports.captures.prepareSelection(input)
  })
  ports.handle('browser:readInputSelection', (event, operationId: string) => {
    ports.trust('browser:readInputSelection', event)
    return ports.captures.readSelection(operationId)
  })
  ports.handle('browser:readSelectionImage', (event, reference: BrowserInputImageReference) => {
    ports.trust('browser:readSelectionImage', event)
    return ports.readSelectionImage(reference)
  })
}
