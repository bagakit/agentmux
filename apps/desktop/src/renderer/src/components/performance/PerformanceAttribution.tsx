import { useState, type CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AppUsage, MetricsObservation, RendererPerformanceSnapshot } from '@agentmux/core/control'

export const cpuCoreEquivalent = (value: number | null | undefined, basis: string | undefined) =>
  value == null || basis !== 'one-logical-core' ? null : `${(value / 100).toFixed(2)} cores`
export const cpuCoreLabel = (value: number | null | undefined, basis: string | undefined) =>
  cpuCoreEquivalent(value, basis) ?? (basis === 'one-logical-core' ? 'CPU unknown' : 'Basis unknown')
const resident = (value: number | null | undefined) => value == null ? '—' : value >= 1048576
  ? `${(value / 1048576).toFixed(2)} GiB` : value >= 1024 ? `${Math.round(value / 1024)} MiB` : `${Math.round(value)} KiB`
const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`
const roles = { main: 'Main', renderer: 'Renderer', browser: 'Browser', gpu: 'GPU', utility: 'Utility', other: 'Other' } as const
const roleOrder = ['main', 'renderer', 'browser', 'gpu', 'utility', 'other'] as const
// Independent intensity, never an additive CPU/memory allocation chart.
const heat = (value: number | null, scale: number, available: boolean, color: string): CSSProperties => ({
  '--heat-color': available && value !== null ? `var(${color})` : undefined,
  '--heat-intensity': available && value !== null ? `${Math.round(4 + 18 * Math.min(1, value / Math.max(1, scale)))}%` : undefined
} as CSSProperties)
function CpuCell({ value, basis, available }: { value: number | null; basis: string | undefined; available: boolean }) {
  const cores = cpuCoreLabel(value, basis)
  return <span className="performance-heat-cell" style={heat(basis === 'one-logical-core' ? value : null, 100, available, '--green')}>
    {percent(value)}<small>{cores}</small>
  </span>
}
const timingLabels = {
  'session-event': ['Session events', 'Synchronous work'],
  'terminal-write': ['Terminal writes', 'Parser callback wait'],
  'long-task': ['Long tasks', 'Main-thread duration'],
  'input-delay': ['Input queue', 'Event Timing · ≥16 ms events'],
  'terminal-interaction': ['Terminal input', 'Dispatch / request wait']
} as const
function WorkAndWait({ performance: p, available }: { performance: RendererPerformanceSnapshot; available: boolean }) {
  const epochs = p.timingEpochs
  const [period, setPeriod] = useState<'current' | 'previous'>('current')
  const selected = period === 'previous' && epochs.previous !== null ? 'previous' : 'current'
  const epoch = selected === 'previous' ? epochs.previous! : epochs.current
  const start = Math.max(epoch.startMonoMs, epochs.recordingSinceMonoMs)
  const end = Math.min(epoch.endMonoMs, epochs.observedMonoMs)
  const coverage = Math.max(0, end - start)
  return <details className="performance-work" data-performance-work>
    <summary>Work &amp; wait <span>{selected === 'previous' ? 'Previous period' : 'Current period'}</span><ChevronDown size={12} /></summary>
    <div className="performance-period-controls" role="group" aria-label="Work and wait period">
      <button type="button" data-performance-period="current" aria-pressed={selected === 'current'} onClick={() => setPeriod('current')}>Current</button>
      {epochs.previous ? <button type="button" data-performance-period="previous" aria-pressed={selected === 'previous'} onClick={() => setPeriod('previous')}>Previous</button> : null}
    </div>
    <p className="performance-note">{(coverage / 1000).toFixed(1)}s observed · fixed 10s period{coverage < 10000 ? ' · partial' : ''}. Shade: peak duration, saturates at 50 ms. Wall times overlap; they are not CPU shares.</p>
    <div className="performance-work-grid">
      {Object.entries(timingLabels).map(([key, [label, description]]) => {
        const kind = key as keyof typeof timingLabels, timing = epoch.timings[kind]
        const state = kind === 'long-task' ? p.longTasks.state : kind === 'input-delay' ? p.inputDelay.state : null
        const supported = state === null || state === 'observing'
        return <section key={kind} className="performance-work-cell" data-timing-kind={kind} style={heat(timing.count && supported ? timing.maxMs : null, 50, available, '--amber-text')}>
          <strong>{label}</strong><small>{description}</small>
          <span>{timing.count ? `${Math.round(timing.totalMs)} ms` : 'No samples'}<small>{timing.count} samples · max {timing.maxMs.toFixed(1)} ms</small></span>
          {state && state !== 'observing' ? <small>{state} · {kind === 'long-task' ? p.longTasks.reason : p.inputDelay.reason}</small> : null}
        </section>
      })}
    </div>
    <p className="performance-note">Outside retained periods: {Object.values(epochs.late).reduce((a, b) => a + b, 0)} late · {Object.values(epochs.unknown).reduce((a, b) => a + b, 0)} unknown occurrence. No samples does not prove no delay.</p>
  </details>
}
function CurrentWindow({ observation, paused }: { observation: MetricsObservation; paused: boolean }) {
  const source = observation.renderer, renderer = source.data
  if (!renderer) return <p className="performance-note">Current window diagnostics · {source.reason ?? source.state}</p>
  const memory = renderer.memory, heap = memory.heap
  return <section className="performance-window" data-renderer-memory>
    <div className="performance-section-heading"><strong>This window · PID {renderer.process.pid}</strong><span>{source.state}</span></div>
    <div className="performance-heap-summary"><div><small>V8 heap used</small><strong>{resident(heap?.usedHeapKib)}</strong></div>
      <div><small>Total heap</small><strong>{resident(heap?.totalHeapKib)}</strong></div></div>
    {heap ? <p className="performance-note">Physical heap {resident(heap.physicalHeapKib)} · limit {resident(heap.heapLimitKib)} · {new Date(memory.sampledAt).toLocaleTimeString('en-GB')}. One V8 isolate; these values do not divide process RSS.</p>
      : <p className="performance-state">Heap unavailable · {memory.unavailable ?? 'No heap reading'}</p>}
    {source.state !== 'available' ? <p className="performance-state">Previous window reading · {source.reason ?? source.state}</p> : null}
    <p className="performance-note">Terminal, editor, DOM and native RSS attribution is unknown.</p>
    <WorkAndWait performance={renderer.performance} available={!paused && source.state === 'available'} />
  </section>
}

export function PerformanceAttribution({ observation, paused = false }: { observation: MetricsObservation | null | undefined; paused?: boolean }) {
  const app: AppUsage | null | undefined = observation?.app.data
  if (!app || !observation) return null
  const basis = observation.units.cpuBasis, available = !paused && observation.app.state === 'available'
  const maximumRss = Math.max(1, ...app.groups.map(group => group.rssKib))
  const renderer = observation.renderer.data
  return <section className="performance-attribution" aria-label="Process heatmap">
    <div className="performance-section-heading"><strong>Process heatmap</strong><span>{app.processCount ?? '—'} processes</span></div>
    <p className="performance-note">{basis === 'one-logical-core' ? '100% = 1 logical core' : 'CPU basis unknown'}{app.logicalCpuCount === null ? ' · host capacity unknown' : ` · ${app.logicalCpuCount} logical cores on host`}. CPU shade saturates at 1 core; RSS shade is relative to the largest row at each level.</p>
    <div className="performance-table-head"><span>Group → process</span><span>CPU · 10s peak</span><span>RSS · latest</span></div>
    {roleOrder.flatMap(role => {
      const group = app.groups.find(value => value.role === role)
      if (!group || group.processCount === 0) return []
      const processes = app.processes.filter(value => value.role === role).sort((a, b) => a.pid - b.pid || a.creationTime - b.creationTime)
      const processRss = Math.max(1, ...processes.map(value => value.rssKib))
      const matchedWindow = role === 'renderer' && renderer && observation.window && renderer.process.pid !== null &&
        renderer.window.windowId === observation.window.windowId && renderer.window.webContentsId === observation.window.webContentsId &&
        renderer.window.generation === observation.window.generation && renderer.process.creationTime !== null && processes.some(value =>
        value.pid === renderer.process.pid && value.creationTime === renderer.process.creationTime)
      return [<details className="performance-resource-group" data-performance-role={role} key={role}>
        <summary className="performance-resource-row"><span className="performance-process-name"><ChevronDown size={12} /><strong>{roles[role]}</strong><small>{group.processCount}</small></span>
          <CpuCell value={group.cpuPercent} basis={basis} available={available} /><span className="performance-heat-cell" style={heat(group.rssKib, maximumRss, available, '--blue')}>{resident(group.rssKib)}</span></summary>
        <div className="performance-processes">
          <p className="performance-note">Process CPU is the latest interval average, not the group’s 10s peak. Values use independent intensity; do not add peaks.</p>
          {processes.map(value => <div className="performance-resource-row performance-process-row" key={`${value.pid}:${value.creationTime}`} data-process-pid={value.pid} data-process-created={value.creationTime}>
            <span className="performance-process-name"><strong>PID {value.pid}</strong><small>{value.type}{value.intervalMs === null ? ' · CPU interval unavailable' : ` · ${(value.intervalMs / 1000).toFixed(1)}s interval`}</small></span>
            <CpuCell value={value.cpuPercent} basis={basis} available={available} /><span className="performance-heat-cell" style={heat(value.rssKib, processRss, available, '--blue')}>{resident(value.rssKib)}</span>
          </div>)}
          {processes.length < group.processCount ? <p className="performance-note">{group.processCount - processes.length} process details omitted in this group.</p> : null}
          {role === 'renderer' ? matchedWindow ? <CurrentWindow observation={observation} paused={paused} />
            : <p className="performance-note">Current window measurements could not be matched to a Renderer process instance. Heap and work attribution remain unknown.</p> : null}
        </div>
      </details>]
    })}
    {app.omittedProcesses > 0 ? <p className="performance-state">{app.omittedProcesses} process details omitted · group totals remain complete.</p> : null}
    {!available ? <p className="performance-note">Heat is paused for this {paused ? 'paused' : observation.app.state} source; values above are previous readings.</p> : null}
  </section>
}
