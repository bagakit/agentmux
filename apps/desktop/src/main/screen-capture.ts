import type { CaptureParams, NativeDesktop } from '@agentmux/native-desktop'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { BrowserPng } from '../shared/contracts.js'
import type { ScreenshotEditContext } from '../shared/system-screenshot-editor.js'
import { savePastedImage, type PastedImageWriteReceipt } from './pasted-image-write.js'

type Ports = {
  home: string
  native(): Pick<NativeDesktop, 'captureScreenshot' | 'writeClipboardImage'>
  /** Whether an AgentMux window has focus, read once at capture start. */
  appActive(): boolean
  edit(image: BrowserPng, attachToDraft: boolean, complete: (image: BrowserPng) => Promise<void>, context: ScreenshotEditContext): Promise<void>
  reportIssue(error: unknown): void
  chooseSource?(mode: 'display' | 'window'): Promise<CaptureParams | null>
}

/** One Desktop capture and delivery owner. Native retains the physical selector's lifetime. */
export class ScreenCapture {
  private busy = false
  constructor(private readonly ports: Ports) {}

  async capture(attachToDraft: boolean, mode: import('../shared/screenshot-source').ScreenshotCaptureMode = 'selection'): Promise<string | null> {
    if (this.busy) throw new Error('A screen capture is already in progress. Finish or cancel that selection or editor, then try again.')
    this.busy = true
    try {
      // Read before the source picker or selection takes focus.
      const returnFocus = !this.ports.appActive()
      const native = this.ports.native()
      if (!['selection', 'display', 'window'].includes(mode)) throw new Error('Choose a supported screenshot source. Your draft is kept.')
      if (mode !== 'selection' && !this.ports.chooseSource) throw new Error('Source selection is unavailable in this host. Region capture and your draft remain available.')
      const target = mode === 'selection' ? { mode: 'selection' as const, allowEditing: true } : await this.ports.chooseSource?.(mode)
      if (!target) return null
      if (target.mode !== mode) throw new Error('The selected capture source does not match the original request. Your draft is kept.')
      const capturedAt = Date.now(), result = await native.captureScreenshot(target)
      if (result.state === 'cancelled') return null
      if (result.state === 'failed') throw new Error(`Screen capture failed (${result.error?.code ?? 'unknown'}): ${result.error?.message ?? 'No failure details were returned'}. Your work remains available.`)
      if (result.state !== 'captured' || !result.screenshot) throw new Error('The original screen capture result is unconfirmed. Check that operation before taking another screenshot.')
      const shot = result.screenshot
      const image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + shot.data,
        width: shot.width, height: shot.height, byteLength: Buffer.byteLength(shot.data, 'base64') }
      pngBytes(image)
      // Native reports the selection in Quartz global points, which equal Electron DIP on macOS.
      const rect = result.selectionRect
      const context: ScreenshotEditContext = { ...(returnFocus ? { returnFocus } : {}), ...(rect && rect.width > 0 && rect.height > 0 && shot.scale > 0
        ? { source: { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scale: shot.scale, capturedAt } } : {}) }
      let path: string | null = null
      // This is one capture's destination receipt, never a second image/document store.
      let delivery: { pixels: string; clipboard: PromiseSettledResult<void>; saved: PromiseSettledResult<PastedImageWriteReceipt | null> } | null = null
      const deliver = async (final: BrowserPng) => {
        const bytes = pngBytes(final)
        const previous = delivery?.pixels === final.dataUrl ? delivery : null
        path = null
        const keep = <T>(receipt: PromiseSettledResult<T>): Promise<T> => receipt.status === 'fulfilled' ? Promise.resolve(receipt.value) : Promise.reject(receipt.reason)
        const [clipboard, saved] = await Promise.allSettled([
          previous && (previous.clipboard.status === 'fulfilled' || unknownWrite(previous.clipboard.reason))
            ? keep(previous.clipboard) : native.writeClipboardImage(final),
          previous?.saved.status === 'fulfilled' ? keep(previous.saved) : attachToDraft
            ? savePastedImage(this.ports.home, { bytes, extension: 'png' }) : Promise.resolve(null)
        ])
        delivery = { pixels: final.dataUrl, clipboard, saved }
        if (saved.status === 'fulfilled') path = saved.value?.path ?? null
        const failures = [clipboard.status === 'rejected' ? `Clipboard copy was not confirmed: ${describeWrite(clipboard.reason)}` : null,
          saved.status === 'rejected' ? `The screenshot could not be saved for the original draft: ${String(saved.reason)}` : null].filter(Boolean)
        if (failures.length) {
          const error = new Error(failures.join('\n') + (path ? `\nThe image is saved at ${path}.` : clipboard.status === 'fulfilled' ? '\nThe image is on the clipboard.' : ''),
            { cause: clipboard.status === 'rejected' ? clipboard.reason : saved.status === 'rejected' ? saved.reason : undefined })
          this.ports.reportIssue(error)
          throw error // The same editor retains the final pixels and destination receipts.
        }
      }
      let submitted: Promise<void> | null = null
      let originalDelivered = false
      const complete = (final: BrowserPng) => {
        // Later copies belong to the retained editor, never a second insertion into an old draft.
        const result = originalDelivered ? native.writeClipboardImage(final) : deliver(final).then(() => { originalDelivered = true })
        submitted = result
        void result.catch(() => {}) // The editor consumes this same receipt; closing it cannot erase submission.
        return result
      }
      if (result.completionAction === 'edit' || mode !== 'selection') await this.ports.edit(image, attachToDraft, complete, context)
      else {
        try { await deliver(image) }
        catch (error) {
          // A failed delivery keeps this image in the shared result surface. No recapture,
          // new target or repeated successful/unknown destination is involved.
          await this.ports.edit(image, attachToDraft, complete, { ...context, initialIssue: error instanceof Error ? error.message : String(error) })
        }
      }
      // Cancel closes UI, not a clipboard/save that has already been submitted.
      if (submitted) await Promise.resolve(submitted).catch(() => {})
      return path
    } finally {
      // This does not claim an unknown native producer has stopped. Native owns
      // its original operation and physical occupancy independently.
      this.busy = false
    }
  }
}

function unknownWrite(error: unknown): boolean {
  const receipt = error as { code?: unknown; operation?: { state?: unknown } } | null
  return receipt?.code === 'operation_unknown' || receipt?.operation?.state === 'unknown'
}
function describeWrite(error: unknown): string {
  const receipt = error as { operation?: { operationId?: string; instanceId?: string } } | null
  const original = receipt?.operation
  return String(error) + (unknownWrite(error) ? ` The original write remains unknown${original ? ` (operation ${original.operationId}, instance ${original.instanceId})` : ''}; check that write or the clipboard before another copy. This write will not be replayed.` : '')
}
