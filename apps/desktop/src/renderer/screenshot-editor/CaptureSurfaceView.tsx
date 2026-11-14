import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { CaptureSurfaceApi, CaptureSurfaceInput } from '../../shared/capture-surface'
import { ImageAnnotationEditor } from '../src/components/image-annotation/ImageAnnotationEditor'
import { composeScreenshot } from '../src/components/image-annotation/compose'
import type { ImageAnnotationInput } from '../src/components/image-annotation/types'

/** One display's overlay. The shared editor draws selection, loupe, toolbar and marks; this host only routes outputs to Main. */
export function CaptureSurfaceView({ input, api, diagnostic }: { input: CaptureSurfaceInput; api: CaptureSurfaceApi; diagnostic?: { startedAt: number; loadedAt: number } }) {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<string | null>(null)
  const trace = useRef<{ startedAt: number; loadedAt: number; decodedAt?: number } | null>(null)
  trace.current ??= { startedAt: diagnostic?.startedAt ?? performance.now(), loadedAt: diagnostic?.loadedAt ?? performance.now() }
  const [locked, setLocked] = useState(false)
  const [background, setBackground] = useState(input.background), [switching, setSwitching] = useState(false)
  const [backgrounds, setBackgrounds] = useState(input.backgrounds)
  const backgroundsRef = useRef(backgrounds), revision = useRef(input.revision), requestedBackground = useRef(input.background)
  backgroundsRef.current = backgrounds
  const frame = backgrounds[background], otherBackground = background === 'included' ? 'excluded' : 'included'
  const pending = useRef(false), claimed = useRef<Promise<boolean> | null>(null)
  function reportPresented() {
    const now = performance.now(), current = trace.current!, decodedAt = current.decodedAt ?? current.loadedAt
    void api.presented(input.requestId, background, { loadMs: Math.max(0, current.loadedAt - current.startedAt), decodeMs: Math.max(0, decodedAt - current.loadedAt),
      paintMs: Math.max(0, now - decodedAt), presentedMs: Math.max(0, now - current.startedAt) }).catch(() => {})
  }
  useEffect(() => {
    let current = true
    const unsubscribe = api.onEvent(event => {
    if (event.kind === 'locked') setLocked(true)
    else if (event.kind === 'snapshot') {
      if (event.requestId !== input.requestId || event.revision <= revision.current) return
      revision.current = event.revision
      const next = { ...backgroundsRef.current, [event.background]: event.frame }
      backgroundsRef.current = next
      setBackgrounds(next)
    }
    else if (event.kind === 'background') {
      const next = event.background, target = backgroundsRef.current[next]
      requestedBackground.current = next
      if (target.status === 'pending') { setStatus('The other frozen background is still preparing. The current image and annotations remain available.'); setSwitching(false); return }
      if (target.status === 'failed') { setStatus(target.issue); setSwitching(false); return }
      // Keep the current editor/document visible until the requested frozen source is decoded.
      setSwitching(true)
      const image = new Image(); image.src = target.image.dataUrl
      void image.decode().then(() => {
        if (!current || requestedBackground.current !== next) return
        setBackground(next); setStatus(null); setSwitching(false)
      }, () => {
        if (!current || requestedBackground.current !== next) return
        setSwitching(false); setStatus('The requested frozen background could not be decoded. Current annotations are kept. Cancel or choose the other background.')
      })
    }
    else setStatus(event.message)
    })
    return () => { current = false; unsubscribe() }
  }, [api, input.requestId])
  // A display without pixels paints its issue instead of an editor and handles Esc here. A pending source has no presentation receipt.
  useEffect(() => {
    if (frame.status !== 'failed') return
    const paint = requestAnimationFrame(reportPresented)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); void api.cancel(input.requestId) } }
    window.addEventListener('keydown', escape)
    return () => { cancelAnimationFrame(paint); window.removeEventListener('keydown', escape) }
  }, [api, input.requestId, frame.status, background])
  // A selection made or kept here claims the capture's one selection; Main locks the other displays, and a lost race locks this one.
  // Main never releases an owner, so one answer serves the whole capture; a failed claim is asked again.
  function claim(): Promise<boolean> {
    claimed.current ??= api.select(input.requestId).then(owned => { if (!owned) setLocked(true); return owned },
      cause => { claimed.current = null; setStatus(presentError(cause)); return false })
    return claimed.current
  }

  async function requestSwitch() {
    if (pending.current || switching || locked) return
    const next = requestedBackground.current === 'included' ? 'excluded' : 'included', target = backgroundsRef.current[next]
    if (target.status === 'pending') { setStatus('The other frozen background is still preparing. The current image and annotations remain available.'); return }
    if (target.status === 'failed') { setStatus(target.issue); return }
    pending.current = true; setSwitching(true)
    try {
      const image = new Image(); image.src = target.image.dataUrl; await image.decode()
      await api.switchBackground(input.requestId, next)
    } catch (cause) { setStatus(presentError(cause)) }
    finally {
      pending.current = false
      // After Main announces a background, its decode owns readiness. A refused request has no new frame to wait for.
      if (requestedBackground.current !== next) setSwitching(false)
    }
  }

  // Plain Tab chooses the other frozen background. Text editing and modified Tab keep their own navigation.
  useEffect(() => {
    const tab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      event.preventDefault()
      void requestSwitch()
    }
    window.addEventListener('keydown', tab, true)
    return () => window.removeEventListener('keydown', tab, true)
  })

  async function output(edit: ImageAnnotationInput, kind: 'finish' | 'save' | 'pin'): Promise<boolean> {
    const selection = edit.crop
    if (!selection || pending.current || switching) return false
    pending.current = true; setBusy(true); setStatus(null)
    try {
      // A continued selection output unchanged was never claimed by a gesture.
      if (!await claim()) return false
      const image = await composeScreenshot({ ...edit, outputScale: 1, document: edit.image.ownerDocument })
      if (kind === 'finish') {
        const result = await api.finish(input.requestId, background, image, selection)
        if (result.status === 'failed') setStatus(result.message)
        return result.status === 'completed'
      }
      if (kind === 'pin') {
        const result = await api.pin(input.requestId, background, mintObjectId(), image, selection)
        if (result.recordedOperation?.state === 'completed') setStatus('Reference pinned')
        else setStatus(result.recordedOperation?.message ?? 'The original pin operation is unconfirmed. Keep that operation before another pin.')
        return result.recordedOperation?.state === 'completed'
      }
      const result = await api.savePng(input.requestId, background, image, selection)
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

  if (frame.status !== 'ready') return <main className="capture-surface capture-surface--issue" role={frame.status === 'failed' ? 'alert' : 'status'}>
    <p><strong>{frame.status === 'pending' ? 'This frozen background is still preparing.' : 'This display could not be captured.'}</strong> {frame.status === 'failed' ? frame.issue : 'The current document remains available.'}</p>
    {backgrounds[otherBackground].status === 'ready' ? <button type="button" disabled={switching} onClick={() => void requestSwitch()}>
      Use background {otherBackground === 'included' ? 'including' : 'excluding'} AgentMux
    </button> : null}
    {status ? <p role="status">{status}</p> : null}
    <p>Select on another display, or press Esc to cancel.</p>
  </main>
  return <main className="capture-surface" onLoadCapture={event => { if (event.target instanceof HTMLImageElement) trace.current!.decodedAt ??= performance.now() }}>
    <ImageAnnotationEditor presentation="capture" image={frame.image} busy={busy || switching} pixelRatio={input.scale} origin={{ x: input.frame.x, y: input.frame.y }} windows={frame.windows} safeTop={input.safeTop} backgroundHint={background === 'included' ? 'Includes AgentMux · Tab to hide' : 'Excludes AgentMux · Tab to include'}
      {...(input.initialCrop ? { initialState: { shapes: [], crop: input.initialCrop } } : {})} locked={locked} onSelect={() => void claim()}
      completeLabel="Done" busyLabel="Copying…" documentStatus={status ?? input.notice ?? (input.theme.status === 'unavailable' ? input.theme.message : null)}
      onComplete={edit => output(edit, 'finish')} onSavePng={edit => output(edit, 'save')} onPin={edit => output(edit, 'pin')}
      onCopyColor={hex => void copyColor(hex)} onExpand={handoff => void claim().then(owned => owned ? api.expand(input.requestId, background, handoff) : undefined).catch(cause => setStatus(presentError(cause)))}
      onPresented={reportPresented}
      onCancel={() => void api.cancel(input.requestId)} onError={cause => setStatus(presentError(cause))} />
  </main>
}
