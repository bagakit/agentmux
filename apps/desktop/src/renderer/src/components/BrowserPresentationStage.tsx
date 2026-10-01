import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type PointerEvent } from 'react'
import type { BrowserPresentationOccurrence, BrowserPresentationLease, BrowserPresentationCapture, BrowserPresentationGeometry, BrowserPresentationActivationReceipt, BrowserPresentationMouseModifier } from '../../../shared/contracts'
import { api } from '../lib/api'
import { LatestBrowserBoundsSynchronizer, focusRingYieldOf, hasPositiveBrowserStageGeometry, nativeBoundsClearOfFocusRing, regionAncestorOf, rendererCssBoundsToWindowDip } from '../lib/browser-bounds-sync'
import { observeBrowserStageGeometry } from '../lib/browser-stage-geometry'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import type { WorkbenchViewTarget } from '../lib/workbench-presentation'

export type WorkbenchBrowserPresentation = {
  occurrence: BrowserPresentationOccurrence
  stageHostId: string
  visible: boolean
  active: boolean
  yieldToFocusRing: boolean
  target: WorkbenchViewTarget
}

function captureTrackIds(stream: MediaStream): readonly [string, ...string[]] {
  const ids = stream.getTracks().map(track => track.id)
  const first = ids[0]
  if (!first) throw new Error('The page capture has no live media track')
  return [first, ...ids.slice(1)]
}

/** One media owner per original BrowserPane; stage mounts only hold their own leases. */
export function useBrowserPresentationCapture(browserId: string) {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [captureId, setCaptureId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const media = useRef<{ capture: BrowserPresentationCapture; stream: MediaStream } | null>(null)
  const pending = useRef<Promise<void> | null>(null)
  const generation = useRef(0)
  const inputChosen = useRef(false)
  const ensureCapture = useCallback((lease: BrowserPresentationLease): Promise<void> => {
    if (media.current) return Promise.resolve()
    if (pending.current) return pending.current
    const current = generation.current
    const read = async () => {
      let capture: BrowserPresentationCapture | null = null
      let acquired: MediaStream | null = null
      try {
        capture = await api.browser.armPresentationCapture(lease.leaseId)
        acquired = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        if (current !== generation.current) {
          const trackIds = captureTrackIds(acquired)
          acquired.getTracks().forEach(track => track.stop())
          await api.browser.ackPresentationCapture(capture.captureId, { outcome: 'stopped', trackIds })
          return
        }
        await api.browser.ackPresentationCapture(capture.captureId, { outcome: 'ready', trackIds: captureTrackIds(acquired) })
        media.current = { capture, stream: acquired }
        setStream(acquired); setCaptureId(capture.captureId); setNotice(null)
      } catch (error) {
        acquired?.getTracks().forEach(track => track.stop())
        if (capture) void api.browser.ackPresentationCapture(capture.captureId, { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }).catch(() => {})
        if (current === generation.current) setNotice(`Live page preview is unconfirmed. The original page is kept. ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const operation = read().finally(() => { if (pending.current === operation) pending.current = null })
    pending.current = operation
    return operation
  }, [])
  const registered = useCallback(async (lease: BrowserPresentationLease, initialInputOwner: boolean, visible: boolean) => {
    // Only the already-selected original occurrence receives initial native input authority.
    if (initialInputOwner && !inputChosen.current) {
      inputChosen.current = true
      await api.browser.activatePresentation(lease.leaseId, { kind: 'select' })
    }
    if (visible) await ensureCapture(lease)
  }, [ensureCapture])
  useEffect(() => {
    const stop = api.browser.onPresentationEvent(event => {
      if (event.browserId !== browserId || event.type !== 'capture-revoked') return
      const held = media.current
      if (!held || held.capture.captureId !== event.captureId) return
      generation.current += 1
      held.stream.getTracks().forEach(track => track.stop())
      media.current = null; setStream(null); setCaptureId(null)
    })
    return () => {
      stop(); generation.current += 1; inputChosen.current = false
      const held = media.current
      media.current = null
      if (held) {
        const trackIds = captureTrackIds(held.stream)
        held.stream.getTracks().forEach(track => track.stop())
        void api.browser.ackPresentationCapture(held.capture.captureId, { outcome: 'stopped', trackIds }).catch(() => {})
      }
    }
  }, [browserId])
  return { stream, captureId, notice, registered, ensureCapture }
}

type MediaOwner = ReturnType<typeof useBrowserPresentationCapture>
/** A presentation owns geometry/lease/gesture only; page and Browser UI state stay in BrowserPane. */
export function BrowserPresentationStage({ browserId, navigationId, presentation, inputSelected, blocked, media, stageRef, onInputSelected, children }: {
  browserId: string; navigationId: string; presentation: WorkbenchBrowserPresentation; inputSelected: boolean; blocked: boolean
  media: MediaOwner; stageRef?: Ref<HTMLDivElement> | undefined; onInputSelected?: (() => void) | undefined; children?: ReactNode
}) {
  const element = useRef<HTMLDivElement | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const lease = useRef<BrowserPresentationLease | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const latest = useRef({ presentation, blocked })
  latest.current = { presentation, blocked }
  const geometry = useCallback((): BrowserPresentationGeometry => {
    const stage = element.current, facts = latest.current
    if (!stage?.isConnected || !facts.presentation.visible || facts.blocked) return { visible: false }
    const rect = stage.getBoundingClientRect()
    if (!hasPositiveBrowserStageGeometry(rect)) return { visible: false }
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    const region = regionAncestorOf(stage), parent = region?.getBoundingClientRect()
    return { visible: true, bounds: rendererCssBoundsToWindowDip(parent ? nativeBoundsClearOfFocusRing(bounds,
      { x: parent.x, y: parent.y, width: parent.width, height: parent.height }, focusRingYieldOf(region!, facts.presentation.yieldToFocusRing)) : bounds, api.ui.getZoomFactor()) }
  }, [])
  const synchronizer = useRef<LatestBrowserBoundsSynchronizer | null>(null)
  const stopGeometry = useRef<() => void>(() => {})
  const observe = useCallback(() => {
    stopGeometry.current()
    const update = () => { const next = geometry(); synchronizer.current?.observe(next.visible ? next.bounds : null) }
    const stage = element.current
    stopGeometry.current = stage ? observeBrowserStageGeometry(stage, update,
      latest.current.presentation.visible && !latest.current.blocked) : () => {}
    update()
  }, [geometry])
  useLayoutEffect(() => {
    let cancelled = false
    const failure = (error: unknown) => { if (!cancelled) setNotice(error instanceof Error ? error.message : String(error)) }
    const mount = async () => {
      const registered = await api.browser.registerPresentation({ browserId, occurrence: presentation.occurrence, geometry: geometry() })
      if (cancelled) { await api.browser.removePresentation(registered.leaseId); return }
      lease.current = registered
      synchronizer.current = new LatestBrowserBoundsSynchronizer(async bounds => {
        await api.browser.updatePresentation(registered.leaseId, bounds ? { visible: true, bounds } : { visible: false })
        if (bounds && !cancelled) await media.ensureCapture(registered)
      }, failure)
      await media.registered(registered, inputSelected, geometry().visible)
      if (!cancelled) observe()
    }
    // The original stable host attaches after child layout effects.
    queueMicrotask(() => { if (!cancelled) void mount().catch(failure) })
    return () => { cancelled = true; stopGeometry.current(); synchronizer.current?.dispose(); synchronizer.current = null
      const current = lease.current; lease.current = null
      if (current) void api.browser.removePresentation(current.leaseId).catch(() => {}) }
  }, [browserId, presentation.occurrence.presentationId, geometry, observe, media.registered, media.ensureCapture])
  useLayoutEffect(() => { if (lease.current) observe() }, [presentation.visible, presentation.yieldToFocusRing, blocked, observe])
  useLayoutEffect(() => {
    const node = video.current
    if (node && node.srcObject !== media.stream) { node.srcObject = media.stream; if (media.stream) void node.play().catch(() => {}) }
  }, [media.stream])
  const press = useRef<Promise<BrowserPresentationActivationReceipt> | null>(null)
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const stage = element.current, frame = video.current
    if (!stage || !frame || !frame.videoWidth || !frame.videoHeight) return null
    const rect = stage.getBoundingClientRect()
    const scale = Math.min(rect.width / frame.videoWidth, rect.height / frame.videoHeight)
    const width = frame.videoWidth * scale, height = frame.videoHeight * scale
    const x = (event.clientX - rect.x - (rect.width - width) / 2) / width
    const y = (event.clientY - rect.y - (rect.height - height) / 2) / height
    return x >= 0 && x < 1 && y >= 0 && y < 1 ? { x, y } : null
  }
  const modifiers = (event: PointerEvent<HTMLDivElement>): BrowserPresentationMouseModifier[] => [
    ...(event.shiftKey ? ['shift' as const] : []), ...(event.ctrlKey ? ['control' as const] : []),
    ...(event.altKey ? ['alt' as const] : []), ...(event.metaKey ? ['meta' as const] : [])
  ]
  const down = (event: PointerEvent<HTMLDivElement>) => {
    const current = lease.current, captureId = media.captureId, coordinates = point(event)
    if (blocked || !current || !captureId || !coordinates || event.pointerType !== 'mouse' || !event.isTrusted) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const prepared = api.browser.activatePresentation(current.leaseId, { kind: 'prepare-first-press', navigationId, captureId,
      down: coordinates, button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left', clickCount: 1, modifiers: modifiers(event) })
    press.current = prepared
    void prepared.then(result => { if (result.outcome === 'input-unconfirmed') setNotice(result.message) }).catch(error => setNotice(String(error)))
  }
  const up = async (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const prepared = press.current, current = lease.current, coordinates = point(event), keys = modifiers(event)
    press.current = null
    if (!prepared || !current) return
    event.preventDefault(); event.stopPropagation()
    try {
      const result = await prepared
      if (result.outcome !== 'prepared') return
      const committed = await api.browser.activatePresentation(current.leaseId, coordinates && !blocked && !cancelled
        ? { kind: 'commit-first-press', inputScopeId: result.inputScopeId, up: coordinates, modifiers: keys }
        : { kind: 'cancel-first-press', inputScopeId: result.inputScopeId })
      if (committed.outcome === 'input-unconfirmed') setNotice(committed.message)
      else if (committed.outcome === 'input-dispatched') { setNotice(null); onInputSelected?.() }
    } catch (error) { setNotice(String(error)) }
  }
  return <div className="browser-stage" data-native-browser-stage={browserId} data-browser-presentation-id={presentation.occurrence.presentationId}
    ref={node => { element.current = node; if (typeof stageRef === 'function') stageRef(node); else if (stageRef) stageRef.current = node }}
    onPointerDown={down} onPointerUp={event => void up(event)} onPointerCancel={event => void up(event, true)}>
    {media.stream ? <video ref={video} muted playsInline autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} /> : null}
    <ServiceWindowNotice notice={notice ? { kind: 'indeterminate', notice: {
      step: 'Browser presentation is unconfirmed', mode: `The original page is kept. ${notice}`,
      restore: 'Keep this window in the foreground and try this page again. Reopen this presentation if it cannot reconnect.'
    } } : null} />
    {children}
  </div>
}
