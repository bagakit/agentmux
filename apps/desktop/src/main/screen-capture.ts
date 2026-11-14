import { startCaptureRequestTiming, type CaptureBackground, type CaptureRequestTiming } from '../shared/capture-surface.js'
import type { CaptureParams, NativeDesktop } from '@agentmux/native-desktop'
import { pngBytes } from '@agentmux/native-desktop/image'
import type { BrowserPng } from '../shared/contracts.js'
import type { ScreenshotEditContext } from '../shared/system-screenshot-editor.js'
import type { CaptureSurfaceContinuation, CaptureSurfaceOutcome, CaptureSurfaceSession } from './capture-surface.js'
import { SCREENSHOT_DELAYS, type ScreenshotDelaySeconds } from '../shared/screenshot-countdown.js'
import type { ScreenshotCaptureMode, ScreenshotCaptureOptions } from '../shared/screenshot-source.js'
import { savePastedImage, type PastedImageWriteReceipt } from './pasted-image-write.js'

type Ports = {
  home: string
  native(): Pick<NativeDesktop, 'captureScreenshot' | 'writeClipboardImage'>
  /** Whether an AgentMux window has focus, read once at capture start. */
  appActive(): boolean
  edit(image: BrowserPng, attachToDraft: boolean, complete: (image: BrowserPng) => Promise<void>, context: ScreenshotEditContext): Promise<void>
  /** The per-display capture surface; selection, marks and the primary delivery happen there. */
  present(session: CaptureSurfaceSession): Promise<CaptureSurfaceOutcome>
  sequence?(mode: 'scroll' | 'gif', selection: { image: BrowserPng; source: import('../shared/system-screenshot-editor').ScreenshotCaptureSource; background?: CaptureBackground }): Promise<BrowserPng | string | null>
  reportIssue(error: unknown): void
  chooseSource?(mode: 'display' | 'window'): Promise<CaptureParams | null>
  /** Shows the countdown; resolves false when the user cancelled it. */
  countdown?(seconds: ScreenshotDelaySeconds): Promise<boolean>
}

/** One Desktop capture and delivery owner: a region goes through the capture surface, a display or window through the editor. */
export class ScreenCapture {
  private busy = false
  constructor(private readonly ports: Ports) {}

  async capture(attachToDraft: boolean, mode: ScreenshotCaptureMode = 'selection', { delaySeconds }: ScreenshotCaptureOptions = {}, background: CaptureBackground = 'included', timing = startCaptureRequestTiming()): Promise<string | null> {
    if (this.busy) throw new Error('A screen capture is already in progress. Finish or cancel that selection or editor, then try again.')
    this.busy = true
    try { return await this.perform(attachToDraft, mode, delaySeconds === undefined ? {} : { delaySeconds }, background, timing) }
    finally { this.busy = false }
  }
  private async perform(attachToDraft: boolean, mode: ScreenshotCaptureMode, { delaySeconds }: ScreenshotCaptureOptions, background: CaptureBackground, timing: ReturnType<typeof startCaptureRequestTiming>): Promise<string | null> {
    timing.screenCaptureMs ??= performance.now() - timing.startedAt
    if (!['selection', 'display', 'window', 'scroll', 'gif'].includes(mode)) throw new Error('Choose a supported screenshot source. Your draft is kept.')
    if (delaySeconds !== undefined) {
      if (mode !== 'selection' || !SCREENSHOT_DELAYS.includes(delaySeconds)) throw new Error('A delayed capture is a region capture in 3, 5 or 10 seconds. Your draft is kept.')
      if (!this.ports.countdown) throw new Error('Delayed capture is unavailable in this host. Region capture and your draft remain available.')
      if (!await this.ports.countdown(delaySeconds)) return null
    }
    // Read after any countdown and before the source picker or selection takes focus: the app in
    // front at that moment is the one the user is capturing and returns to.
    const returnFocus = !this.ports.appActive()
    if (mode === 'scroll' || mode === 'gif') {
      if (!this.ports.sequence) throw new Error('Continuous capture is unavailable in this host. Ordinary screenshots remain available.')
      let selected: { image: BrowserPng; source: import('../shared/system-screenshot-editor').ScreenshotCaptureSource; background?: CaptureBackground } | null = null
      await this.ports.present({ attachToDraft: false, expandable: false, returnFocus: false, background, timing,
        complete: async (image, source, _engine, frozenBackground) => { selected = { image, source, background: frozenBackground ?? background } } })
      if (!selected) return null
      return await this.sequence(attachToDraft, mode, selected, returnFocus)
    }
    const native = this.ports.native()
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
    if (mode === 'selection') {
      // A failed delivery keeps the surface, its selection and marks; Done retries only the unconfirmed destination.
      // Retake in the window editor presents the surface again for this same consumer. Its surface gives focus back to
      // that editor, which a cancel returns to and a completion closes, so the editor's own close returns focus as before.
      const held: { editor: Promise<void> | null } = { editor: null }
      // Request-local only: Copy returns crop geometry for a later Retake in this capture call. A fresh call starts with none.
      let continuation: CaptureSurfaceContinuation | undefined
      const surface = async (retaking: boolean): Promise<'completed' | 'cancelled' | 'expanded'> => {
        // Once the original draft has its image, a retaken surface and its editor only copy; the draft is never attached twice.
        const attaching = attachToDraft && !originalDelivered
        const surfaceTiming = retaking ? startCaptureRequestTiming() : timing
        surfaceTiming.presentMs ??= performance.now() - surfaceTiming.startedAt
        const outcome = await this.ports.present({ attachToDraft: attaching, expandable: true, sourceChoices: true, returnFocus: returnFocus && !retaking, complete, background, timing: surfaceTiming,
          ...(retaking && continuation ? { continuation } : {}) })
        if (outcome.state === 'source') {
          path = await this.perform(attachToDraft && !originalDelivered, typeof outcome.mode === 'number' ? 'selection' : outcome.mode, typeof outcome.mode === 'number' ? { delaySeconds: outcome.mode } : {}, outcome.background, startCaptureRequestTiming()); return 'completed'
        }
        if (outcome.state === 'sequence') { path = await this.sequence(attachToDraft && !originalDelivered, outcome.mode, outcome, returnFocus); return 'completed' }
        if (outcome.state !== 'expanded') return outcome.state
        // Only the confirmed independent-editor Copy creates a continuation; shapes and Undo stay in that editor.
        const deliverHere = (final: BrowserPng) => complete(final).then(() => { continuation = outcome.delivered() })
        const editing = this.ports.edit(outcome.image, attaching, deliverHere,
          { source: outcome.source, initialState: { shapes: outcome.handoff.shapes, crop: outcome.handoff.crop }, initialTool: outcome.handoff.tool,
            ...(returnFocus ? { returnFocus } : {}), retake: () => surface(true) })
        // After the editor's first Copy this capture has returned and nobody awaits a retaken editor, so its failure is reported here.
        held.editor = retaking ? editing.catch(error => this.ports.reportIssue(error)) : editing
        return outcome.state
      }
      await surface(false)
      // A retake that expands opens the next editor before the previous one closes; the capture lasts until the current one ends.
      for (let current = held.editor; current; current = held.editor === current ? null : held.editor) await current
    } else {
      if (!this.ports.chooseSource) throw new Error('Source selection is unavailable in this host. Region capture and your draft remain available.')
      const target = await this.ports.chooseSource(mode)
      if (!target) return null
      if (target.mode !== mode) throw new Error('The selected capture source does not match the original request. Your draft is kept.')
      const capturedAt = Date.now(), result = await native.captureScreenshot(target)
      if (result.state === 'failed') throw new Error(`Screen capture failed (${result.error?.code ?? 'unknown'}): ${result.error?.message ?? 'No failure details were returned'}. Your work remains available.`)
      if (result.state !== 'captured' || !result.screenshot) throw new Error('The original screen capture result is unconfirmed. Check that operation before taking another screenshot.')
      const shot = result.screenshot
      const image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + shot.data,
        width: shot.width, height: shot.height, byteLength: Buffer.byteLength(shot.data, 'base64') }
      pngBytes(image)
      // Native reports the source in Quartz global points, which equal Electron DIP on macOS.
      const rect = result.selectionRect
      await this.ports.edit(image, attachToDraft, complete, { ...(returnFocus ? { returnFocus } : {}), ...(rect && rect.width > 0 && rect.height > 0 && shot.scale > 0
        ? { source: { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scale: shot.scale, capturedAt } } : {}) })
    }
    // Cancel closes UI, not a clipboard/save that has already been submitted.
    if (submitted) await Promise.resolve(submitted).catch(() => {})
    return path
  }
  private async sequence(attachToDraft: boolean, mode: 'scroll' | 'gif', selected: { image: BrowserPng; source: import('../shared/system-screenshot-editor').ScreenshotCaptureSource; background?: CaptureBackground }, returnFocus: boolean): Promise<string | null> {
    const result = await this.ports.sequence!(mode, selected)
    if (typeof result === 'string') return attachToDraft ? result : null
    if (!result) return null
    let path: string | null = null
    await this.ports.edit(result, attachToDraft, async final => {
      await this.ports.native().writeClipboardImage(final)
      if (attachToDraft && !path) path = (await savePastedImage(this.ports.home, { bytes: pngBytes(final), extension: 'png' })).path
    }, { ...(returnFocus ? { returnFocus } : {}) })
    return path
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
