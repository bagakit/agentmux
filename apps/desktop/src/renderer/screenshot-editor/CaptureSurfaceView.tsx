import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { CaptureSurfaceApi, CaptureSurfaceInput } from '../../shared/capture-surface'
import { ImageAnnotationEditor } from '../src/components/image-annotation/ImageAnnotationEditor'
import { composeScreenshot } from '../src/components/image-annotation/compose'
import type { ImageAnnotationInput } from '../src/components/image-annotation/types'

/** One display's overlay. The shared editor draws selection, loupe, toolbar and marks; this host only routes outputs to Main. */
export function CaptureSurfaceView({ input, api }: { input: CaptureSurfaceInput; api: CaptureSurfaceApi }) {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<string | null>(null)
  const [locked, setLocked] = useState(false), [decoded, setDecoded] = useState(!input.image)
  const pending = useRef(false), claimed = useRef<Promise<boolean> | null>(null)
  useEffect(() => api.onEvent(event => { if (event.kind === 'locked') setLocked(true); else setStatus(event.message) }), [api])
  // The editor mounts on an already decoded frame, so its first paint is the frozen image, never an empty overlay.
  useEffect(() => {
    if (!input.image) return
    const image = new Image(); image.src = input.image.dataUrl
    void image.decode().then(() => setDecoded(true), () => setDecoded(true))
  }, [input.image])
  // Main shows every overlay together once each one has painted; the next frame is the first one on screen.
  useEffect(() => {
    if (!decoded) return
    const frame = requestAnimationFrame(() => { void api.presented(input.requestId).catch(() => {}) })
    return () => cancelAnimationFrame(frame)
  }, [api, input.requestId, decoded])
  // A display without pixels has no editor, so Esc is handled here.
  useEffect(() => {
    if (input.image) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); void api.cancel(input.requestId) } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [api, input.requestId, input.image])
  // A selection made or kept here claims the capture's one selection; Main locks the other displays, and a lost race locks this one.
  // Main never releases an owner, so one answer serves the whole capture; a failed claim is asked again.
  function claim(): Promise<boolean> {
    claimed.current ??= api.select(input.requestId).then(owned => { if (!owned) setLocked(true); return owned },
      cause => { claimed.current = null; setStatus(presentError(cause)); return false })
    return claimed.current
  }

  async function output(edit: ImageAnnotationInput, kind: 'finish' | 'save' | 'pin'): Promise<boolean> {
    if (pending.current) return false
    pending.current = true; setBusy(true); setStatus(null)
    try {
      // A remembered selection output unchanged was never claimed by a gesture.
      if (!await claim()) return false
      const image = await composeScreenshot({ ...edit, outputScale: 1, document: edit.image.ownerDocument })
      if (kind === 'finish') {
        const result = await api.finish(input.requestId, image, selectionOf(edit))
        if (result.status === 'failed') setStatus(result.message)
        return result.status === 'completed'
      }
      if (kind === 'pin') {
        const result = await api.pin(input.requestId, mintObjectId(), image, selectionOf(edit))
        if (result.recordedOperation?.state === 'completed') setStatus('Reference pinned')
        else setStatus(result.recordedOperation?.message ?? 'The original pin operation is unconfirmed. Keep that operation before another pin.')
        return result.recordedOperation?.state === 'completed'
      }
      const result = await api.savePng(input.requestId, image)
      if (result.status === 'saved') setStatus('PNG saved · ' + result.path)
      else if (result.status !== 'cancelled') setStatus(result.message)
      return result.status === 'saved'
    } catch (cause) { setStatus(presentError(cause)); return false }
    finally { pending.current = false; setBusy(false) }
  }
  async function copyColor(hex: string) {
    try {
      const result = await api.copyText(input.requestId, hex)
      setStatus(result.status === 'completed' ? hex + ' copied' : result.message)
    } catch (cause) { setStatus(presentError(cause)) }
  }

  if (!input.image) return <main className="capture-surface capture-surface--issue" role="alert">
    <p><strong>This display could not be captured.</strong> {input.issue}</p>
    <p>Select on another display, or press Esc to cancel.</p>
  </main>
  if (!decoded) return <main className="capture-surface" />
  return <main className="capture-surface">
    <ImageAnnotationEditor presentation="capture" image={input.image} busy={busy} pixelRatio={input.scale} origin={{ x: input.frame.x, y: input.frame.y }} windows={input.windows} safeTop={input.safeTop}
      {...(input.initialCrop ? { initialState: { shapes: [], crop: input.initialCrop } } : {})} locked={locked} onSelect={() => void claim()}
      completeLabel="Done" busyLabel="Copying…" documentStatus={status ?? (input.theme.status === 'unavailable' ? input.theme.message : null)}
      onComplete={edit => output(edit, 'finish')} onSavePng={edit => output(edit, 'save')} onPin={edit => output(edit, 'pin')}
      onCopyColor={hex => void copyColor(hex)} onExpand={handoff => void claim().then(owned => owned ? api.expand(input.requestId, handoff) : undefined).catch(cause => setStatus(presentError(cause)))}
      onCancel={() => void api.cancel(input.requestId)} onError={cause => setStatus(presentError(cause))} />
  </main>
}

/** The selection is the editor's crop, in this display's frozen-frame pixels. */
function selectionOf(edit: ImageAnnotationInput) {
  return edit.crop ?? { x: 0, y: 0, width: edit.displayWidth, height: edit.displayHeight }
}
