import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type PointerEvent } from 'react'
import type { BrowserPresentationOccurrence, BrowserPresentationLease, BrowserPresentationCapture, BrowserPresentationGeometry, BrowserPresentationActivationReceipt, BrowserPresentationMouseModifier, BrowserBounds } from '../../../shared/contracts'
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
  const [capturePhase, setCapturePhase] = useState<'idle' | 'arming' | 'acquiring' | 'confirming' | 'ready' | 'failed'>('idle')
  const media = useRef<{ capture: BrowserPresentationCapture; stream: MediaStream; detach: () => void } | null>(null)
  const captureRequest = useRef<BrowserPresentationCapture | null>(null)
  const pending = useRef<Promise<void> | null>(null)
  const captureFailed = useRef(false)
  const generation = useRef(0)
  const inputChosen = useRef<string | null>(null)
  const ownerRevision = useRef(0)
  const [ownerClearedRevision, setOwnerClearedRevision] = useState(0)
  const inputIntentRevision = useRef(0)
  const inputSelectionLease = useRef<string | null>(null)
  const readInputIntentRevision = useCallback(() => inputIntentRevision.current, [])
  const inputSelection = useRef<Promise<void> | null>(null)
  const retireCapture = useCallback((reason: string | null) => {
    generation.current += 1
    captureRequest.current = null
    captureFailed.current = reason !== null
    const held = media.current
    media.current = null
    held?.detach()
    held?.stream.getTracks().forEach(track => track.stop())
    setStream(null); setCaptureId(null); setNotice(reason); setCapturePhase(reason ? 'failed' : 'idle')
  }, [])
  const ensureCapture = useCallback((lease: BrowserPresentationLease): Promise<void> => {
    if (media.current) return Promise.resolve()
    if (pending.current) return pending.current
    if (captureFailed.current) return Promise.resolve()
    const current = generation.current
    const read = async () => {
      let capture: BrowserPresentationCapture | null = null
      let acquired: MediaStream | null = null
      try {
        setCapturePhase('arming')
        capture = await api.browser.armPresentationCapture(lease.leaseId)
        if (current !== generation.current) {
          await api.browser.ackPresentationCapture(capture.captureId, { outcome: 'failed', message: 'The page preview request is no longer current' }).catch(() => {})
          return
        }
        captureRequest.current = capture
        setCapturePhase('acquiring')
        acquired = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        if (current !== generation.current) {
          const trackIds = captureTrackIds(acquired)
          acquired.getTracks().forEach(track => track.stop())
          await api.browser.ackPresentationCapture(capture.captureId, { outcome: 'stopped', trackIds })
          return
        }
        setCapturePhase('confirming')
        await api.browser.ackPresentationCapture(capture.captureId, { outcome: 'ready', trackIds: captureTrackIds(acquired) })
        // The owner may have unmounted while the acknowledgement was in flight.
        if (current !== generation.current) {
          const trackIds = captureTrackIds(acquired)
          acquired.getTracks().forEach(track => track.stop())
          await api.browser.ackPresentationCapture(capture.captureId, { outcome: 'stopped', trackIds })
          return
        }
        const tracks = acquired.getTracks()
        const held = { capture, stream: acquired, detach: () => tracks.forEach(track => track.removeEventListener('ended', ended)) }
        const ended = () => {
          if (current !== generation.current || media.current !== held) return
          const trackIds = captureTrackIds(held.stream)
          retireCapture('Live preview media ended. Retry the preview to reconnect it.')
          void api.browser.ackPresentationCapture(held.capture.captureId, { outcome: 'stopped', trackIds }).catch(() => {})
        }
        media.current = held
        tracks.forEach(track => track.addEventListener('ended', ended))
        if (tracks.some(track => track.readyState === 'ended')) { ended(); return }
        setStream(acquired); setCaptureId(capture.captureId); setNotice(null); setCapturePhase('ready')
      } catch (error) {
        acquired?.getTracks().forEach(track => track.stop())
        if (current === generation.current) {
          captureFailed.current = true
          setNotice(`Live page preview is unconfirmed. ${error instanceof Error ? error.message : String(error)}`)
          setCapturePhase('failed')
        }
        if (capture) await api.browser.ackPresentationCapture(capture.captureId, { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }).catch(() => {})
      }
    }
    const operation = read().finally(() => { if (pending.current === operation) pending.current = null })
    pending.current = operation
    return operation
  }, [retireCapture])
  const retryCapture = useCallback((lease: BrowserPresentationLease) => {
    if (pending.current || media.current) return pending.current ?? Promise.resolve()
    captureFailed.current = false
    return ensureCapture(lease)
  }, [ensureCapture])
  const registered = useCallback(async (lease: BrowserPresentationLease, initialInputOwner: boolean, visible: boolean,
    inputCurrent: () => boolean, intentRevision: number | null) => {
    const current = generation.current
    if (visible && initialInputOwner && inputCurrent()) {
      // Await only real in-flight selections; another lease's receipt cannot select this one.
      while (inputSelection.current) {
        await inputSelection.current.catch(() => {})
        if (current !== generation.current || !inputCurrent()) return
      }
      if (inputChosen.current !== lease.leaseId && (inputChosen.current === null || intentRevision === inputIntentRevision.current)) {
        if (current !== generation.current || !inputCurrent()) return
        const selectedAt = ownerRevision.current
        inputSelectionLease.current = lease.leaseId
        const selection = api.browser.activatePresentation(lease.leaseId, { kind: 'select', focus: 'preserve' }).then(receipt => {
          if (current !== generation.current || !inputCurrent()) return
          if (receipt.outcome !== 'selected') throw new Error(receipt.outcome === 'input-unconfirmed'
            ? receipt.message : 'The Browser presentation input owner could not be confirmed')
          if (ownerRevision.current === selectedAt) inputChosen.current = lease.leaseId
        }).finally(() => { if (inputSelection.current === selection) { inputSelection.current = null; inputSelectionLease.current = null } })
        inputSelection.current = selection
        await selection
      }
    }
    if (visible && current === generation.current && (!initialInputOwner || inputCurrent())) await ensureCapture(lease)
  }, [ensureCapture])
  useEffect(() => {
    const stop = api.browser.onPresentationEvent(event => {
      if (event.browserId !== browserId) return
      if (event.type === 'input-owner-changed') {
        ownerRevision.current += 1
        // The expected pending selection confirms its own lease; it does not retire a newer queued UI intent.
        if (event.leaseId !== inputSelectionLease.current || event.leaseId === null) inputIntentRevision.current += 1
        inputChosen.current = event.leaseId
        if (event.leaseId === null) setOwnerClearedRevision(ownerRevision.current)
        return
      }
      if (event.type !== 'capture-revoked') return
      const held = media.current
      if (held?.capture.captureId !== event.captureId && captureRequest.current?.captureId !== event.captureId) return
      retireCapture(event.reason === 'no-visible-presentations' ? null : event.reason === 'source-replaced'
        ? 'Live preview source changed. Retry the preview to reconnect the original page.'
        : `Live preview stopped (${event.reason}). Retry the preview to reconnect it.`)
    })
    return () => {
      stop(); generation.current += 1; inputChosen.current = null; inputSelection.current = null; inputSelectionLease.current = null; captureFailed.current = false; captureRequest.current = null; pending.current = null
      const held = media.current
      media.current = null
      if (held) {
        const trackIds = captureTrackIds(held.stream)
        held.detach()
        held.stream.getTracks().forEach(track => track.stop())
        void api.browser.ackPresentationCapture(held.capture.captureId, { outcome: 'stopped', trackIds }).catch(() => {})
      }
    }
  }, [browserId, retireCapture])
  return { stream, captureId, notice, capturePhase, registered, ensureCapture, retryCapture, ownerClearedRevision, readInputIntentRevision }
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
  const [notice, setNotice] = useState<{ source: 'registration' | 'presentation' | 'input'; message: string } | null>(null)
  const [registrationPending, setRegistrationPending] = useState(true)
  const latest = useRef({ presentation, blocked, navigationId, inputSelected })
  latest.current = { presentation, blocked, navigationId, inputSelected }
  const lastInputSelected = useRef(inputSelected)
  const selectionIntent = useRef<number | null>(inputSelected ? media.readInputIntentRevision() : null)
  if (lastInputSelected.current !== inputSelected) {
    lastInputSelected.current = inputSelected
    selectionIntent.current = inputSelected ? media.readInputIntentRevision() : null
  }
  const registrationRetry = useRef<((explicit?: boolean) => void) | null>(null)
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
  const geometryWriter = useRef<((bounds: BrowserBounds | null, intentRevision?: number | null) => Promise<void>) | null>(null)
  const inputCurrent = useCallback((registered: BrowserPresentationLease) =>
    lease.current === registered && latest.current.inputSelected && geometry().visible, [geometry])
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
    let registering = false, registrationFailed = false
    let attemptedNavigationId: string | null = null
    const failure = (error: unknown, source: 'registration' | 'presentation' = 'presentation') => {
      if (!cancelled) setNotice({ source, message: error instanceof Error ? error.message : String(error) })
    }
    const retry = (explicit = false) => {
      if (cancelled || registering || lease.current || !registrationFailed) return
      if (!explicit && attemptedNavigationId === latest.current.navigationId) return
      void mount().catch(failure)
    }
    const mount = async () => {
      registering = true
      registrationFailed = false
      setRegistrationPending(true)
      const attemptNavigationId = latest.current.navigationId
      attemptedNavigationId = attemptNavigationId
      let registered: BrowserPresentationLease
      try {
        registered = await api.browser.registerPresentation({ browserId, occurrence: presentation.occurrence, geometry: geometry() })
      } catch (error) {
        registrationFailed = true
        failure(error, 'registration')
        return
      } finally {
        registering = false
        if (!cancelled) setRegistrationPending(false)
        // Creation can finish while the original failed request is still pending.
        if (!cancelled && attemptNavigationId !== latest.current.navigationId) retry()
      }
      if (cancelled) { await api.browser.removePresentation(registered.leaseId); return }
      lease.current = registered
      registrationFailed = false
      setNotice(null) // A real lease confirms this registration.
      const writeGeometry = async (bounds: BrowserBounds | null, intentRevision: number | null = null) => {
        await api.browser.updatePresentation(registered.leaseId, bounds ? { visible: true, bounds } : { visible: false })
        if (bounds && !cancelled) {
          void media.registered(registered, latest.current.inputSelected, true, () => !cancelled && inputCurrent(registered), intentRevision).then(() => {
            if (!cancelled) setNotice(current => current?.source === 'presentation' ? null : current)
          }).catch(failure)
        }
      }
      geometryWriter.current = writeGeometry
      synchronizer.current = new LatestBrowserBoundsSynchronizer(writeGeometry, failure)
      observe() // Native geometry stays current while preview capture is pending.
      await media.registered(registered, latest.current.inputSelected, geometry().visible, () => !cancelled && inputCurrent(registered), selectionIntent.current)
    }
    registrationRetry.current = retry
    // Renderer load completion precedes trusted Main registration. A single task also lets
    // the original stable host attach; unlike an animation frame, it runs while hidden.
    let mountTask: ReturnType<typeof setTimeout> | undefined
    const documentReady = () => {
      window.removeEventListener('load', documentReady)
      if (!cancelled) mountTask = setTimeout(() => { mountTask = undefined; if (!cancelled) void mount().catch(failure) }, 0)
    }
    if (document.readyState === 'complete') documentReady()
    else window.addEventListener('load', documentReady, { once: true })
    return () => { cancelled = true; window.removeEventListener('load', documentReady); clearTimeout(mountTask); if (registrationRetry.current === retry) registrationRetry.current = null
      stopGeometry.current(); synchronizer.current?.dispose(); synchronizer.current = null; geometryWriter.current = null
      const current = lease.current; lease.current = null
      if (current) void api.browser.removePresentation(current.leaseId).catch(() => {}) }
  }, [browserId, presentation.occurrence.presentationId, geometry, observe, inputCurrent, media.registered, media.ensureCapture])
  useLayoutEffect(() => { registrationRetry.current?.() }, [navigationId])
  useLayoutEffect(() => { if (lease.current) observe() }, [presentation.visible, presentation.yieldToFocusRing, blocked, observe])
  useLayoutEffect(() => {
    const current = lease.current
    if (!inputSelected || !current) return
    const next = geometry()
    if (!next.visible) return
    // Selection is a separate fact: confirm geometry through the original writer even if its rectangle is unchanged.
    void geometryWriter.current?.(next.bounds, selectionIntent.current).catch(error => {
      if (lease.current === current && latest.current.inputSelected) setNotice({ source: 'presentation', message: String(error) })
    })
  }, [inputSelected, media.ownerClearedRevision, geometry])
  const [playbackRevision, setPlaybackRevision] = useState(0)
  const [playback, setPlayback] = useState<{ stream: MediaStream | null; phase: 'idle' | 'starting' | 'first-frame' | 'ready' | 'failed'; message?: string }>({ stream: null, phase: 'idle' })
  useLayoutEffect(() => {
    const node = video.current, stream = media.stream
    if (!node || !stream) { setPlayback({ stream: null, phase: 'idle' }); return }
    let cancelled = false, playing = false
    node.srcObject = stream
    setPlayback({ stream, phase: 'starting' })
    const frame = () => {
      if (cancelled || node.srcObject !== stream || !playing) return
      if (node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && node.videoWidth > 0 && node.videoHeight > 0)
        setPlayback({ stream, phase: 'ready' })
    }
    node.addEventListener('loadeddata', frame); node.addEventListener('playing', frame)
    void node.play().then(() => {
      if (cancelled || node.srcObject !== stream) return
      playing = true; setPlayback({ stream, phase: 'first-frame' }); frame()
    }).catch(error => {
      if (!cancelled && node.srcObject === stream) setPlayback({ stream, phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true; node.removeEventListener('loadeddata', frame); node.removeEventListener('playing', frame) }
  }, [media.stream, playbackRevision])
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
    if (playback.stream !== media.stream || playback.phase !== 'ready') return
    const current = lease.current, captureId = media.captureId, coordinates = point(event)
    if (blocked || !current || !captureId || !coordinates || event.pointerType !== 'mouse' || !event.isTrusted) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const prepared = api.browser.activatePresentation(current.leaseId, { kind: 'prepare-first-press', navigationId, captureId,
      down: coordinates, button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left', clickCount: 1, modifiers: modifiers(event) })
    press.current = prepared
    void prepared.then(result => { if (result.outcome === 'input-unconfirmed') setNotice({ source: 'input', message: result.message }) })
      .catch(error => setNotice({ source: 'input', message: String(error) }))
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
      if (committed.outcome === 'input-unconfirmed') setNotice({ source: 'input', message: committed.message })
      else if (committed.outcome === 'input-dispatched') { setNotice(null); onInputSelected?.() }
    } catch (error) { setNotice({ source: 'input', message: String(error) }) }
  }
  const [retrying, setRetrying] = useState(false)
  const retry = async () => {
    if (retrying) return
    if (playback.stream === media.stream && (playback.phase === 'failed' || playback.phase === 'first-frame')) { setPlaybackRevision(value => value + 1); return }
    const current = lease.current
    if (!current) { registrationRetry.current?.(true); return }
    setRetrying(true)
    try {
      const next = geometry()
      await api.browser.updatePresentation(current.leaseId, next)
      await media.registered(current, latest.current.inputSelected, next.visible, () => inputCurrent(current), null)
      if (next.visible) await media.retryCapture(current)
      setNotice(null)
    } catch (error) { setNotice({ source: 'presentation', message: error instanceof Error ? error.message : String(error) }) }
    finally { setRetrying(false) }
  }
  const playbackCurrent = playback.stream === media.stream ? playback : null
  const capturePending = media.capturePhase === 'arming' || media.capturePhase === 'acquiring' || media.capturePhase === 'confirming'
  const waiting = registrationPending ? 'Connecting page preview' : media.capturePhase === 'arming' ? 'Connecting live preview'
    : media.capturePhase === 'acquiring' ? 'Waiting for live preview' : media.capturePhase === 'confirming' ? 'Confirming live preview'
      : playbackCurrent?.phase === 'starting' ? 'Starting preview playback' : playbackCurrent?.phase === 'first-frame' ? 'Waiting for the first preview frame' : null
  const playbackError = playbackCurrent?.phase === 'failed' ? playbackCurrent.message : null
  const presentationNotice = notice?.message ?? media.notice ?? playbackError ?? waiting
  const retryPending = retrying || registrationPending || capturePending || playbackCurrent?.phase === 'starting'
  return <div className="browser-presentation">
    <div className="browser-presentation-notice">
      <ServiceWindowNotice notice={presentationNotice ? { kind: 'indeterminate', notice: {
        step: notice || media.notice || playbackError ? notice?.source === 'registration' ? 'Page connection needs attention' : 'Page preview needs attention' : waiting!,
        mode: `The original page is kept. ${presentationNotice}`,
        restore: waiting && !notice && !media.notice && !playbackError ? 'You can keep using the address and original page while the preview waits.' : 'Retry here. The address, page and other open presentations are preserved.'
      } } : null}
        disclosure={{ scope: `browser-presentation:${presentation.occurrence.presentationId}`, id: 'live-preview',
          occurrence: navigationId, cause: presentationNotice ?? '', visible: presentation.visible }} />
      {presentationNotice ? <button className="small-button" type="button" disabled={retryPending || !presentation.visible || blocked} title={!presentation.visible || blocked ? 'Return to this preview to retry' : undefined} onClick={() => void retry()}>
        {retryPending ? 'Waiting…' : notice?.source === 'registration' ? 'Retry connection' : playbackError || playbackCurrent?.phase === 'first-frame' ? 'Retry playback' : 'Retry preview'}
      </button> : null}
    </div>
    <div className="browser-stage" data-native-browser-stage={browserId} data-browser-presentation-id={presentation.occurrence.presentationId}
      ref={node => { element.current = node; if (typeof stageRef === 'function') stageRef(node); else if (stageRef) stageRef.current = node }}
      onPointerDown={down} onPointerUp={event => void up(event)} onPointerCancel={event => void up(event, true)}>
      {media.stream ? <video ref={video} muted playsInline autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} /> : null}
      {children}
    </div>
  </div>
}
