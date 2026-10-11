import { useMemo, useState } from 'react'
import type { MetricsObservation, RendererAllocationsResult, RendererPerformanceScene } from '@agentmux/core/control'
import type { PerformanceSceneState } from '../../lib/use-performance-scene'
import { CaptureResult, currentPerformanceCaptureTarget, downloadPerformanceJSON } from './PerformanceCapture'

const bytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`
const time = (value: number) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function AllocationStacks({ result }: { result: RendererAllocationsResult }) {
  const top = useMemo(() => {
    const profile = result.profile
    if (!profile) return []
    const pending = [profile.head], rows: { id: number; name: string; url: string; line: number; size: number }[] = []
    while (pending.length) {
      const node = pending.pop()!
      for (const child of node.children) pending.push(child)
      if (node.selfSize <= 0) continue
      rows.push({ id: node.id, name: node.callFrame.functionName || '(anonymous)', url: node.callFrame.url,
        line: node.callFrame.lineNumber, size: node.selfSize })
      rows.sort((a, b) => b.size - a.size); if (rows.length > 8) rows.pop()
    }
    return rows
  }, [result.profile])
  return <>
    {result.status !== 'completed' ? <p className="performance-state" data-tone="warning">Allocation capture is {result.status}; source or cleanup may be unconfirmed. Inspect the original capture stages before drawing conclusions.</p> : null}
    <p className="performance-note">Estimated sampled allocations still alive when sampling stopped. This excludes older objects and is not a retaining path, an RSS breakdown or a leak verdict.</p>
    {top.length ? <ol className="performance-allocation-list" aria-label="Sampled allocation stacks">{top.map(row => <li key={row.id}>
      <span title={`${row.url}:${row.line + 1}`}><strong>{row.name}</strong><small>{row.url ? `${row.url.split(/[\\/]/u).at(-1)}:${row.line + 1}` : '(no script)'}</small></span><b>{bytes(row.size)}</b>
    </li>)}</ol> : <p className="performance-state">No surviving allocations with a positive sampled size in this interval.</p>}
  </>
}

function ScenePhases({ scene }: { scene: RendererPerformanceScene }) {
  const phases = [
    ['Resources before', scene.before.resources], ['Heap before', scene.before.memory], ['JavaScript', scene.cpu],
    ['Allocations', scene.allocations], ['Rendering timeline', scene.timeline], ['Resources after', scene.after.resources], ['Heap after', scene.after.memory],
  ] as const
  return <dl className="performance-scene-phases">{phases.map(([label, phase]) => <div key={label}>
    <dt>{label}</dt><dd><strong>{phase.status}</strong><span>{phase.requestedAt === null ? 'Not started' : `${time(phase.requestedAt)} → ${time(phase.finishedAt)}`}</span>
      {phase.issue ? <small>{phase.issue.code}: {phase.issue.message}</small> : null}
      {phase.result && 'issues' in phase.result ? phase.result.issues.map((issue, index) => <small key={index}>{issue.stage}: {issue.message}</small>) : null}
    </dd>
  </div>)}</dl>
}

/** Explicit scene material from the shared Main owner; no recording or analysis starts on render. */
export function PerformanceScene({ state, observation, externalBusy = false }: {
  state: PerformanceSceneState; observation: MetricsObservation | null | undefined; externalBusy?: boolean
}) {
  const target = currentPerformanceCaptureTarget(observation), { scene, persistence } = state
  const sourceChanged = scene !== null && JSON.stringify(scene.target) !== JSON.stringify(target)
  const [exported, setExported] = useState(false)
  const [cpuOpen, setCpuOpen] = useState(false), [allocationsOpen, setAllocationsOpen] = useState(false)
  const exportJSON = (value: unknown, name: string) => { downloadPerformanceJSON(value, name); setExported(true) }
  const allocationResult = scene?.allocations.result
  return <section className="performance-scene" aria-label="Performance scene">
    <div className="performance-section-heading"><strong>Capture the lag</strong><button type="button" className="performance-inline-action"
      data-performance-scene-capture disabled={!target || state.busy || externalBusy} onClick={() => { if (target) { setExported(false); void state.collect(target) } }}>
      {state.busy ? 'Capturing…' : 'Capture scene'}</button></div>
    <p className="performance-note">CPU, allocations and rendering · 2s each, in sequence. Includes resource and heap readings. Kept locally; nothing is uploaded.</p>
    {!target ? <p className="performance-state">Current Renderer identity is unconfirmed. Capture needs matching window and process readings.</p> : null}
    {state.busy ? <p className="performance-state" role="status">Capturing the original process. You can close this panel; no need to keep it open.</p> : null}
    {state.reading ? <p className="performance-note" role="status">Reading the latest local scene…</p> : null}
    {state.error ? <p className="performance-state" data-tone="warning">{state.error}</p> : null}
    {state.inspection?.status === 'unavailable' || state.inspection?.status === 'mismatch' ? <p className="performance-state" data-tone="warning">Latest scene {state.inspection.status}. {state.inspection.issue?.message}</p> : null}
    {state.inspection?.status === 'absent' && scene ? <p className="performance-state" data-tone="warning">The latest local file is absent. This request's original material remains available below.</p> : null}
    {state.inspection?.captureId && scene && state.inspection.captureId !== scene.captureId ? <p className="performance-state">The local file contains a different scene. Keeping this request's unsaved material available below.</p> : null}
    {scene ? <div className="performance-scene-result" aria-label="Captured performance scene">
      <div className="performance-section-heading"><strong>{scene.status === 'completed' ? 'Scene captured' : `Scene ${scene.status}`}</strong><span>{time(scene.requestedAt)}</span></div>
      <p className="performance-note">PID {scene.target.pid} · generation {scene.target.generation} · Main {scene.loaded.package?.sourceCommit.slice(0, 8) ?? 'version unknown'}</p>
      {sourceChanged ? <p className="performance-state">Showing the original process. Current readings changed or are unconfirmed; this scene was not reassigned.</p> : null}
      <p className="performance-state" data-tone={persistence?.status === 'failed' || persistence?.status === 'unknown' ? 'warning' : undefined}>
        {persistence?.status === 'confirmed' ? 'Saved locally · replaces the previous scene.' : persistence?.status === 'failed'
          ? 'Save failed before replacement. This material is available to export; the previous file is preserved.' : persistence?.status === 'unknown'
            ? 'Save durability is unconfirmed. The local file may have changed; this original material is available to export.'
            : 'Read from the local file. The original save durability acknowledgement is not available.'}
        {persistence?.issue ? ` ${persistence.issue.message}` : ''}
      </p>
      <div className="performance-capture-actions">
        <button type="button" onClick={() => exportJSON({ scene, persistence }, 'performance-scene.json')}>Export scene</button>
        {scene.cpu.result?.profile ? <button type="button" onClick={() => exportJSON(scene.cpu.result!.profile, 'renderer.cpuprofile')}>CPU profile</button> : null}
        {allocationResult?.profile ? <button type="button" onClick={() => exportJSON(allocationResult.profile, 'renderer.heapprofile')}>Allocation profile</button> : null}
        {scene.timeline.result?.trace ? <button type="button" onClick={() => exportJSON(scene.timeline.result!.trace, 'renderer-trace.json')}>Timeline</button> : null}
      </div>
      {exported ? <p className="performance-note" role="status">Download requested. Check your selected destination for the saved file.</p> : null}
      <details className="performance-disclosure"><summary>Sources and capture stages</summary>
        <p className="performance-note performance-scene-id">Capture {scene.captureId}<br />Window {scene.target.windowId} · WebContents {scene.target.webContentsId}<br />Renderer {scene.loaded.renderer?.id ?? 'version unknown'}</p>
        <p className="performance-note">Stages have separate intervals. Resource readings retain their own source times in the export; they are not one simultaneous snapshot.</p>
        <ScenePhases scene={scene} />
      </details>
      {scene.cpu.result?.profile ? <details className="performance-disclosure" onToggle={event => setCpuOpen(event.currentTarget.open)}><summary>JavaScript modules and flame graph</summary>{cpuOpen ? <CaptureResult key={scene.captureId} capture={{ kind: 'profile', result: scene.cpu.result }} sourceChanged={sourceChanged} /> : null}</details> : null}
      {allocationResult?.profile ? <details className="performance-disclosure" onToggle={event => setAllocationsOpen(event.currentTarget.open)}><summary>Sampled allocation stacks</summary>{allocationsOpen ? <AllocationStacks result={allocationResult} /> : null}</details> : null}
    </div> : null}
  </section>
}
