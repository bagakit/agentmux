import { useState } from 'react'
import { sameRendererV8ProfileTarget, type MetricsObservation } from '@agentmux/core/control'
import { api } from '../../lib/api'
import type { PerformanceHeapSnapshotState } from '../../lib/use-performance-heap-snapshot'
import { currentPerformanceCaptureTarget } from './PerformanceCapture'

/** Explicit heavy investigation, separate from ordinary scene and observation. */
export function PerformanceHeapSnapshot({ state, observation, externalBusy = false }: {
  state: PerformanceHeapSnapshotState; observation: MetricsObservation | null | undefined; externalBusy?: boolean
}) {
  const target = currentPerformanceCaptureTarget(observation), capture = state.capture
  const [actionBusy, setActionBusy] = useState(false), [notice, setNotice] = useState<string | null>(null)
  const artifact = capture?.artifact
  const act = async (action: 'save' | 'reveal' | 'devtools') => {
    if (!capture || actionBusy) return
    setActionBusy(true); setNotice(null)
    const input = { captureId: capture.captureId }
    try {
      if (action === 'save') {
        const result = await api.performance.saveHeapSnapshot(input)
        setNotice(result.status === 'saved' ? `Saved to ${result.path}. Any pending private copy was released; the previous latest file was preserved.` : 'Save cancelled. Original file retained.')
      } else if (action === 'reveal') await api.performance.revealHeapSnapshot(input)
      else await api.performance.openHeapDevTools(input)
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setActionBusy(false) }
  }
  const originalIsCurrent = !!capture && !!target && sameRendererV8ProfileTarget(capture.target, target)
  const observed = (value: boolean | null) => value === null ? 'unknown' : value ? 'yes' : 'no'
  return <section className="performance-scene" aria-label="Retained object investigation">
    <div className="performance-section-heading"><strong>Why objects stay alive</strong></div>
    <p className="performance-note">Heavy heap snapshot · pauses this Renderer and may trigger GC. Native memory and disk use can be substantial. Contains private object strings; nothing is uploaded.</p>
    <p className="performance-note">Save your baseline before taking another snapshot. The next published snapshot replaces the retained file. A single file supports DevTools Retainers; Comparison needs separately verified object-ID continuity.</p>
    <div className="performance-capture-actions">
      <button type="button" data-performance-heap-capture disabled={!target || state.busy || externalBusy}
        onClick={() => { if (target) { setNotice(null); void state.collect(target) } }}>{state.busy ? 'Waiting…' : 'Take heap snapshot'}</button>
      <button type="button" disabled={state.busy} onClick={() => { void state.inspect() }}>Inspect original</button>
    </div>
    {state.busy ? <p className="performance-state" role="status">Waiting for the original operation. Closing this panel does not stop V8 collection.</p> : null}
    {state.error ? <p className="performance-state" data-tone="warning">{state.error} Inspect the original capture ID; do not automatically repeat collection.</p> : null}
    {state.captureId ? <p className="performance-note performance-scene-id">Capture {state.captureId}</p> : null}
    {capture ? <div className="performance-scene-result">
      {capture.captureId !== state.captureId ? <p className="performance-state">Showing earlier material from capture {capture.captureId}; the newer request has no complete reply.</p> : null}
      <p className="performance-state">Snapshot {capture.status} · PID {capture.target.pid} · generation {capture.target.generation}<br />
        Native requested {observed(capture.native.requested)} · settled {observed(capture.native.settled)} · succeeded {observed(capture.native.succeeded)}</p>
      {!originalIsCurrent ? <p className="performance-state">Original Renderer material; current identity changed or is unconfirmed. The capture was not reassigned.</p> : null}
      {capture.issues.map((issue, index) => <p key={index} className="performance-state" data-tone="warning">{issue.stage}: {issue.message}</p>)}
      <p className="performance-note">Exporting saves the original bytes, or a small attempt receipt when no file exists, then releases any pending private candidate. It does not confirm missing native completion or overwrite incompatible earlier material.</p>
      <div className="performance-capture-actions"><button type="button" disabled={actionBusy || state.busy} onClick={() => { void act('save') }}>Save snapshot…</button></div>
      {artifact ? <>
        <p className="performance-note performance-scene-id">Host {artifact.host.hostname} · Main {artifact.host.mainPid}<br />{artifact.path}<br />
          {(artifact.byteLength / 1048576).toFixed(1)} MiB · SHA-256 {artifact.sha256}</p>
        <p className="performance-state">{state.persistence?.status === 'confirmed' ? 'Original publication confirmed.'
          : state.persistence ? `Publication ${state.persistence.status}: ${state.persistence.issue?.message}` : 'Original file observed; earlier write acknowledgement is unavailable.'}</p>
        <div className="performance-capture-actions">
          {state.persistence?.phase === 'before-replace' && capture.status === 'completed' ? <button type="button" disabled={state.busy}
            onClick={() => { void state.retryPublication() }}>Retry saving receipt</button> : null}
          <button type="button" disabled={actionBusy} onClick={() => { void act('reveal') }}>Reveal file</button>
          <button type="button" disabled={actionBusy || !originalIsCurrent} onClick={() => { void act('devtools') }}>Open DevTools</button>
        </div>
        <p className="performance-note">In DevTools, choose Memory → Load, select this .heapsnapshot, then inspect an object’s Retainers. This is V8 object evidence, not all workers, native/GPU memory, an RSS breakdown or a leak verdict.</p>
      </> : null}
    </div> : null}
    {notice ? <p className="performance-state" role="status">{notice}</p> : null}
  </section>
}
