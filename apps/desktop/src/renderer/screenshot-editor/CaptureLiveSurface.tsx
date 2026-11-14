import { useEffect, useRef, useState } from 'react'
import type { CaptureSurfaceApi, CaptureSurfaceEvent, CaptureSurfaceInput } from '../../shared/capture-surface'
import type { CaptureSequenceApi } from '../../shared/capture-sequence'
import './capture-live-surface.css'

/** The original screenshot overlay becomes transparent; only its toolbar accepts input. */
export function CaptureLiveSurface({ capture, surfaceApi, live }: {
  capture: CaptureSurfaceInput; surfaceApi: CaptureSurfaceApi; live: Extract<CaptureSurfaceEvent, { kind: 'scrolling' }>
}) {
  const api = (window as unknown as { captureSequence: CaptureSequenceApi }).captureSequence
  const { state, frameCount: count } = live.input
  const [error, setIssue] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const issue = error ?? live.input.issue
  const toolbar = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = toolbar.current
    if (!element) return
    const updateBounds = () => {
      const rect = element.getBoundingClientRect()
      void surfaceApi.liveInput(capture.requestId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(error => setIssue(String(error)))
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(element)
    return () => observer.disconnect()
  }, [surfaceApi, capture.requestId, live.toolbar])

  async function act(action: () => Promise<unknown>) {
    setBusy(true); setIssue(null)
    try { await action() } catch (error) { setIssue(String(error)) } finally { setBusy(false) }
  }
  const { selection, toolbar: anchor } = live
  const right = Math.max(8, capture.frame.width - anchor.x - anchor.width)
  return <main className="capture-surface capture-surface--live">
    <div className="capture-live-region" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />
    <nav ref={toolbar} className="capture-live-toolbar" aria-label="Scrolling capture" style={{ right, top: Math.max(capture.safeTop, Math.min(anchor.y, capture.frame.height - 48)) }}>
      <div className="capture-live-toolbar__actions">
        <span role="status">Scrolling · {count} {count === 1 ? 'frame' : 'frames'}</span>
        {state === 'review' ? <button disabled={busy} onClick={() => void act(() => api.start(live.input.requestId, 2))}>Retry capture</button> : null}
        <button disabled={busy} onClick={() => void act(() => api.cancel(live.input.requestId))}>Cancel</button>
        <button className="primary-button" disabled={busy} onClick={() => void act(() => api.stop(live.input.requestId))}>Stop scrolling capture</button>
      </div>
      {issue ? <p role="status">{issue}</p> : null}
    </nav>
  </main>
}
