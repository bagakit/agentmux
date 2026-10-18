import { useEffect, useMemo, useRef, useState } from 'react'
import { analyseV8Profile, parseRendererTraceResult, parseRendererV8ProfileResult, parseRendererAnimationsResult,
  type MetricsObservation, type RendererTraceResult, type RendererV8ProfileResult, type RendererV8ProfileTarget, type RendererAnimationsResult } from '@agentmux/core/control'
import { api } from '../../lib/api'
import { PerformanceProfileView } from './PerformanceProfileView'
import { downloadPerformanceJSON, downloadPerformanceTrace } from './performance-export'
import { AnimationInspectionResult } from './PerformanceAnimations'

type Capture = { kind: 'profile'; result: RendererV8ProfileResult } | { kind: 'trace'; result: RendererTraceResult }
type Captured = { key: string; value: Capture }

export function currentPerformanceCaptureTarget(observation: MetricsObservation | null | undefined): RendererV8ProfileTarget | null {
  // App process details contain bounded hotspots. The Renderer source owns this
  // exact identity; Main verifies the five-field target again for each capture.
  const source = observation?.renderer, renderer = source?.data, window = observation?.window
  if (source?.state !== 'available' || !renderer || !window || renderer.process.pid === null || renderer.process.creationTime === null ||
    window.windowId !== renderer.window.windowId || window.webContentsId !== renderer.window.webContentsId || window.generation !== renderer.window.generation) return null
  return { ...window, pid: renderer.process.pid, creationTime: renderer.process.creationTime }
}


export function CaptureResult({ capture, sourceChanged, retained = false }: { capture: Capture; sourceChanged: boolean; retained?: boolean }) {
  const result = capture.result
  const analysis = useMemo(() => capture.kind === 'profile' && capture.result.status === 'completed' && capture.result.profile ? analyseV8Profile(capture.result.profile) : null, [capture.kind, capture.result])
  const material = capture.kind === 'profile' ? capture.result.profile : capture.result.trace
  const receipt = capture.kind === 'profile' ? { ...capture.result, profile: material ? '(export original profile)' : null }
    : { ...capture.result, trace: capture.result.trace ? { ...capture.result.trace, data: '(export original native gzip)' } : null }
  return <section className="performance-capture-result" aria-label={retained ? "Retained completed JavaScript profile" : "Capture result"}>
    {retained ? <p className="performance-note">Last completed JavaScript profile. The latest capture has its own receipt above.</p> : null}
    {sourceChanged ? <p className="performance-state">Showing the original captured process. Current window readings changed; this result was not reassigned.</p> : null}
    <div className="performance-section-heading"><strong>{capture.kind === 'profile' ? 'V8 profile' : 'Chromium timeline'}</strong><span>{result.status}</span></div>
    <p className="performance-note">PID {result.target.pid} · generation {result.target.generation} · source verified {String(result.sourceVerified.before)} / {String(result.sourceVerified.after)}</p>
    {result.status !== 'completed' ? <p className="performance-state" data-tone="warning">{result.status === 'unknown' ? 'Capture or cleanup is unconfirmed. Inspect the original receipt before another request.' : 'Capture did not complete.'} {result.issues.map(issue => `${issue.stage}: ${issue.message}`).join(' · ')}</p> : null}
    {analysis?.data ? <PerformanceProfileView analysis={analysis.data} /> : analysis?.reason ? <p className="performance-state">{analysis.reason}</p> : null}
    {capture.kind === 'trace' ? <p className="performance-note">{capture.result.receivedEvents} timeline events · {capture.result.receivedTraceBytes} original bytes{capture.result.trace ? ` · ${capture.result.trace.bytes} compressed bytes` : ''}. Export the original gzip trace to inspect Style, Layout, Paint and compositor work in a trace viewer; categories are requested filters, not proof of coverage.</p> : null}
    <div className="performance-capture-actions">
      {capture.kind === 'profile' && capture.result.profile ? <button type="button" onClick={() => downloadPerformanceJSON(capture.result.profile, 'renderer.cpuprofile')}>Export profile</button> : capture.kind === 'trace' && capture.result.trace ? <button type="button" onClick={() => downloadPerformanceTrace(capture.result.trace!)}>Export trace</button> : null}
      <button type="button" onClick={() => downloadPerformanceJSON(receipt, 'renderer-capture-receipt.json')}>Export receipt</button>
    </div>
    <details className="performance-disclosure"><summary>Capture receipt</summary><pre className="performance-capture-receipt">{JSON.stringify(receipt, null, 2)}</pre></details>
  </section>
}

/** No background work: capture starts only from one explicit click on this exact target. */
export function PerformanceCapture({ observation, externalBusy = false, onBusyChange }: {
  observation: MetricsObservation | null | undefined; externalBusy?: boolean | undefined; onBusyChange?: ((busy: boolean) => void) | undefined
}) {
  const target = currentPerformanceCaptureTarget(observation), key = JSON.stringify(target)
  const [busy, setBusy] = useState<'profile' | 'trace' | 'animations' | null>(null), [capture, setCapture] = useState<Captured | null>(null)
  const [animations, setAnimations] = useState<{ key: string; result: RendererAnimationsResult } | null>(null)
  const [completedProfile, setCompletedProfile] = useState<Captured | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connected = useRef(true), inFlight = useRef(false)
  useEffect(() => { connected.current = true; return () => { connected.current = false } }, [])
  const run = async (kind: 'profile' | 'trace') => {
    if (!target || inFlight.current || externalBusy) return
    const sourceKey = key, input = { target: { ...target }, durationMs: 2000 }
    inFlight.current = true; setBusy(kind); setError(null); onBusyChange?.(true)
    try {
      const value: Capture = kind === 'profile'
        ? { kind, result: parseRendererV8ProfileResult(await api.performance.captureProfile(input), input) }
        : { kind, result: parseRendererTraceResult(await api.performance.captureTrace(input), input) }
      if (connected.current) {
        const captured = { key: sourceKey, value }
        setCapture(captured)
        if (value.kind === 'profile' && value.result.status === 'completed' && value.result.profile) setCompletedProfile(captured)
      }
    } catch (reason) {
      if (connected.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { inFlight.current = false; onBusyChange?.(false); if (connected.current) setBusy(null) }
  }
  const inspectAnimations = async () => {
    if (!target || inFlight.current || externalBusy) return
    const sourceKey = key, input = { target: { ...target } }
    inFlight.current = true; setBusy('animations'); setError(null); onBusyChange?.(true)
    try {
      const result = parseRendererAnimationsResult(await api.performance.inspectAnimations(input), input)
      if (connected.current) setAnimations({ key: sourceKey, result })
    } catch (reason) {
      if (connected.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { inFlight.current = false; onBusyChange?.(false); if (connected.current) setBusy(null) }
  }
  // Retained rows change only with their original result or the exact current target.
  const animationView = useMemo(() => animations ? <AnimationInspectionResult result={animations.result} sourceChanged={animations.key !== key}
    onExport={() => downloadPerformanceJSON(animations.result, 'renderer-animations.json')} /> : null, [animations, key])
  return <details className="performance-disclosure performance-capture" data-performance-capture>
    <summary>Analyse this window <span>Explicit diagnostics</span></summary>
    <p className="performance-note">Capture while reproducing the lag. V8 samples explain JavaScript; timeline records rendering stages. Neither is a leak verdict.</p>
    {!target ? <p className="performance-state">The current Renderer process instance is unconfirmed. Wait for matching window and process readings.</p> : null}
    <div className="performance-capture-actions">
      <button type="button" data-performance-action="profile" disabled={!target || busy !== null || externalBusy} onClick={() => void run('profile')}>{busy === 'profile' ? 'Sampling…' : 'Sample JavaScript · 2s'}</button>
      <button type="button" data-performance-action="trace" disabled={!target || busy !== null || externalBusy} onClick={() => void run('trace')}>{busy === 'trace' ? 'Tracing…' : 'Capture timeline · 2s'}</button>
      <button type="button" data-performance-action="animations" disabled={!target || busy !== null || externalBusy} onClick={() => void inspectAnimations()}>{busy === 'animations' ? 'Inspecting…' : 'Inspect animations'}</button>
    </div>
    {error ? <p className="performance-state" data-tone="warning">{error}</p> : null}
    {animationView}
    {capture && capture !== completedProfile ? <CaptureResult key="latest" capture={capture.value} sourceChanged={capture.key !== key} /> : null}
    {completedProfile ? <CaptureResult key={completedProfile.value.result.timing.requestedAt} capture={completedProfile.value} sourceChanged={completedProfile.key !== key} retained={capture !== completedProfile} /> : null}
  </details>
}
