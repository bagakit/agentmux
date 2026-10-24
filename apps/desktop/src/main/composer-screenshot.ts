import type { NativeDesktop } from '@agentmux/native-desktop'
import { pngBytes } from '@agentmux/native-desktop/image'
import { savePastedImage } from './pasted-image-write.js'

let captureOwner: object | null = null

/** One exact picker request; the native layer owns selection, permissions and its physical lifetime. */
export async function captureComposerScreenshot(home: string, native: Pick<NativeDesktop, 'captureScreenshot'>): Promise<string | null> {
  if (captureOwner) throw new Error('A screen capture is already in progress. Your draft and terminal remain available. Finish the existing selection, then try again.')
  const owner = {}
  captureOwner = owner
  try {
    const result = await native.captureScreenshot({ mode: 'selection' })
    if (result.state === 'cancelled') return null
    if (result.state === 'failed') throw new Error(`Screen capture failed (${result.error?.code ?? 'unknown'}): ${result.error?.message ?? 'No failure details were returned'}. Your draft and terminal remain available. Retry this operation after resolving the reported failure.`)
    const screenshot = result.screenshot
    if (result.state !== 'captured' || !screenshot) throw new Error('The original screen capture result is unconfirmed. Your draft is kept. Check the original selection before starting another capture.')
    const bytes = pngBytes({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + screenshot.data,
      width: screenshot.width, height: screenshot.height, byteLength: Buffer.byteLength(screenshot.data, 'base64') })
    return (await savePastedImage(home, { bytes, extension: 'png' })).path
  } finally {
    // Settlement does not claim an OS selector exited. The native owner retains
    // physical ownership and the original operation if its result is unknown.
    if (captureOwner === owner) captureOwner = null
  }
}
