import { useEffect, useMemo, useRef, useState } from 'react'
import { parseRendererTraceResult, parseRendererV8ProfileResult,
  type MetricsObservation, type RendererTraceResult, type RendererV8ProfileResult, type RendererV8ProfileTarget } from '@agentmux/core/control'
import { api } from '../../lib/api'
import { analyseRendererProfile, profileFlameRows, type ProfileAnalysis } from '../../lib/renderer-profile-analysis'

type Capture = { kind: 'profile'; result: RendererV8ProfileResult } | { kind: 'trace'; result: RendererTraceResult }
type Captured = { key: string; value: Capture }
const ms = (value: number) => `${value.toFixed(1)} ms`
const scriptName = (url: string) => url === '(runtime / no script)' ? url : url.split(/[\\/]/u).at(-1) || url

export function currentPerformanceCaptureTarget(observation: MetricsObservation | null | undefined): RendererV8ProfileTarget | null {
  const source = observation?.renderer, renderer = source?.data, window = observation?.window
  if (source?.state !== 'available' || !renderer || !window || renderer.process.pid === null || renderer.process.creationTime === null ||
    window.windowId !== renderer.window.windowId || window.webContentsId !== renderer.window.webContentsId || window.generation !== renderer.window.generation ||
    observation.app.state !== 'available' || !observation.app.data?.processes.some(process => process.role === 'renderer' &&
      process.pid === renderer.process.pid && process.creationTime === renderer.process.creationTime)) return null
  return { ...window, pid: renderer.process.pid, creationTime: renderer.process.creationTime }
}

export function downloadPerformanceJSON(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function ProfileView({ analysis }: { analysis: ProfileAnalysis }) {
  const [path, setPath] = useState<number[]>([analysis.root])
  const root = path.at(-1)!, selected = analysis.frames.get(root)!, flame = useMemo(() => profileFlameRows(analysis, root), [analysis, root])
  return <>
    <div className="performance-section-heading"><strong>Module samples</strong><span>{analysis.samples} samples · {ms(analysis.sampledMs)}</span></div>
    <p className="performance-note">Self time from V8 sample weights. Select a module to inspect its hottest call frame. Script modules are not React components; idle and native work may be outside these samples.</p>
    <div className="performance-module-list" aria-label="Module sample heatmap">
      {analysis.modules.slice(0, 12).map(module => <button type="button" className="performance-module-row" key={module.url}
        aria-label={`Inspect hottest call frame in ${module.url}`} title={`Inspect hottest call frame in ${module.url}`}
        onClick={() => { const frame = [...analysis.frames.values()].filter(frame => (frame.url || '(runtime / no script)') === module.url).sort((a, b) => b.selfMs - a.selfMs)[0]; if (frame) setPath(frame.id === analysis.root ? [analysis.root] : [analysis.root, frame.id]) }}
        style={{ background: `color-mix(in srgb,var(--green) ${Math.round(4 + 18 * module.selfMs / analysis.sampledMs)}%,transparent)` }}>
        <span title={module.url}>{scriptName(module.url)}</span><strong>{ms(module.selfMs)} <small>{(module.selfMs / analysis.sampledMs * 100).toFixed(1)}%</small></strong>
      </button>)}
    </div>
    {analysis.modules.length > 12 ? <p className="performance-note">Top 12 of {analysis.modules.length} modules. Full data is in the original profile.</p> : null}
    <div className="performance-section-heading"><strong>Call stack flame graph</strong><button type="button" className="performance-inline-action" disabled={path.length === 1} onClick={() => setPath(value => value.slice(0, -1))}>Back</button></div>
    <p className="performance-note">Width is inclusive sampled time, not a timeline. Select a frame to zoom; parent and child time overlap.</p>
    <div className="performance-flame" aria-label="Sampled call stacks" style={{ height: `${(Math.max(0, ...flame.rows.map(row => row.depth)) + 1) * 25}px` }}>
      {flame.rows.map(row => { const frame = analysis.frames.get(row.id)!; return <button key={row.id} type="button"
        title={`${frame.name}\n${frame.url || '(no script)'}:${frame.line + 1}\nSelf ${ms(frame.selfMs)} · inclusive ${ms(frame.totalMs)}`}
        aria-label={`${frame.name}, self ${ms(frame.selfMs)}, inclusive ${ms(frame.totalMs)}`} aria-pressed={row.id === root}
        style={{ left: `${row.left}%`, width: `${row.width}%`, top: `${row.depth * 25}px` }}
        onClick={() => { if (row.id !== root) setPath(value => [...value, row.id]) }}>{frame.name}</button> })}
    </div>
    {flame.omitted ? <p className="performance-note">{flame.omitted} branches outside this view. Select a parent frame to inspect deeper, or export.</p> : null}
    <div className="performance-frame-detail" aria-live="polite"><strong>{selected.name}</strong><span>{selected.url || '(runtime / no script)'}{selected.line >= 0 ? `:${selected.line + 1}` : ''}</span><small>Self {ms(selected.selfMs)} · inclusive {ms(selected.totalMs)}</small></div>
  </>
}

export function CaptureResult({ capture, sourceChanged, retained = false }: { capture: Capture; sourceChanged: boolean; retained?: boolean }) {
  const result = capture.result
  const analysis = useMemo(() => capture.kind === 'profile' && capture.result.status === 'completed' && capture.result.profile ? analyseRendererProfile(capture.result.profile) : null, [capture.kind, capture.result])
  const material = capture.kind === 'profile' ? capture.result.profile : capture.result.trace
  return <section className="performance-capture-result" aria-label={retained ? "Retained completed JavaScript profile" : "Capture result"}>
    {retained ? <p className="performance-note">Last completed JavaScript profile. The latest capture has its own receipt above.</p> : null}
    {sourceChanged ? <p className="performance-state">Showing the original captured process. Current window readings changed; this result was not reassigned.</p> : null}
    <div className="performance-section-heading"><strong>{capture.kind === 'profile' ? 'V8 profile' : 'Chromium timeline'}</strong><span>{result.status}</span></div>
    <p className="performance-note">PID {result.target.pid} · generation {result.target.generation} · source verified {String(result.sourceVerified.before)} / {String(result.sourceVerified.after)}</p>
    {result.status !== 'completed' ? <p className="performance-state" data-tone="warning">{result.status === 'unknown' ? 'Capture or cleanup is unconfirmed. Inspect the original receipt before another request.' : 'Capture did not complete.'} {result.issues.map(issue => `${issue.stage}: ${issue.message}`).join(' · ')}</p> : null}
    {analysis?.data ? <ProfileView analysis={analysis.data} /> : analysis?.reason ? <p className="performance-state">{analysis.reason}</p> : null}
    {capture.kind === 'trace' ? <p className="performance-note">{capture.result.receivedEvents} timeline events. Export the original trace to inspect Style, Layout, Paint and compositor work in a trace viewer; categories are requested filters, not proof of coverage.</p> : null}
    <div className="performance-capture-actions">
      {material ? <button type="button" onClick={() => downloadPerformanceJSON(material, capture.kind === 'profile' ? 'renderer.cpuprofile' : 'renderer-trace.json')}>Export {capture.kind === 'profile' ? 'profile' : 'trace'}</button> : null}
      <button type="button" onClick={() => downloadPerformanceJSON(result, 'renderer-capture-receipt.json')}>Export receipt</button>
    </div>
    <details className="performance-disclosure"><summary>Capture receipt</summary><pre className="performance-capture-receipt">{JSON.stringify({ ...result, ...(capture.kind === 'profile' ? { profile: material ? '(export original profile)' : null } : { trace: material ? '(export original trace)' : null }) }, null, 2)}</pre></details>
  </section>
}

/** No background work: capture starts only from one explicit click on this exact target. */
export function PerformanceCapture({ observation, externalBusy = false, onBusyChange }: {
  observation: MetricsObservation | null | undefined; externalBusy?: boolean | undefined; onBusyChange?: ((busy: boolean) => void) | undefined
}) {
  const target = currentPerformanceCaptureTarget(observation), key = JSON.stringify(target)
  const [busy, setBusy] = useState<'profile' | 'trace' | null>(null), [capture, setCapture] = useState<Captured | null>(null)
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
  return <details className="performance-disclosure performance-capture" data-performance-capture>
    <summary>Analyse this window <span>Explicit 2s capture</span></summary>
    <p className="performance-note">Capture while reproducing the lag. V8 samples explain JavaScript; timeline records rendering stages. Neither is a leak verdict.</p>
    {!target ? <p className="performance-state">The current Renderer process instance is unconfirmed. Wait for matching window and process readings.</p> : null}
    <div className="performance-capture-actions">
      <button type="button" disabled={!target || busy !== null || externalBusy} onClick={() => void run('profile')}>{busy === 'profile' ? 'Sampling…' : 'Sample JavaScript · 2s'}</button>
      <button type="button" disabled={!target || busy !== null || externalBusy} onClick={() => void run('trace')}>{busy === 'trace' ? 'Tracing…' : 'Capture timeline · 2s'}</button>
    </div>
    {error ? <p className="performance-state" data-tone="warning">{error}</p> : null}
    {capture && capture !== completedProfile ? <CaptureResult key="latest" capture={capture.value} sourceChanged={capture.key !== key} /> : null}
    {completedProfile ? <CaptureResult key={completedProfile.value.result.timing.requestedAt} capture={completedProfile.value} sourceChanged={completedProfile.key !== key} retained={capture !== completedProfile} /> : null}
  </details>
}
