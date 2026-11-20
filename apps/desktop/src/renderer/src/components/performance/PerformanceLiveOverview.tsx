import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { ToolkitMetricsSnapshot } from '../../../../shared/toolkit'
import { cpuCoreLabel } from './PerformanceAttribution'
import { PerformanceHostResources } from './PerformanceHostResources'
import { PerformanceMetric } from './PerformanceMetric'
import { PerformanceSourceNote } from './PerformanceSourceNote'
import { performanceCPU as cpu, performanceMemory as memory, performanceReadingTime as readingTime } from './performance-format'
import { usePerformanceAppTrend } from './use-performance-app-trend'

export function PerformanceLiveOverview({ snapshot, paused, onInspectResources, onDiagnose, onArtifacts }: {
  snapshot: ToolkitMetricsSnapshot | null; paused: boolean; onInspectResources(): void; onDiagnose(): void; onArtifacts(): void
}) {
  const observation = snapshot?.observation, source = observation?.app, app = source?.data, totals = observation?.runTotals
  const observationKey = JSON.stringify([snapshot?.executionId, snapshot?.run?.hostId, snapshot?.run?.runId, observation?.scope.hostId])
  const trend = usePerformanceAppTrend(snapshot, paused, observationKey)
  const live = !paused && snapshot?.state === 'observing' && source?.state === 'available'
  return <>
    <section className="performance-live" aria-label="AgentMux current load" data-performance-live>
      <div className="performance-section-heading performance-live__heading"><div><strong>AgentMux</strong><span className="performance-reading-time">{readingTime(source?.lastSuccessAt, snapshot?.observedAt)}</span></div>
        <button type="button" className="performance-inline-action" onClick={onInspectResources}>Processes <span aria-hidden="true">→</span></button></div>
      <div className="performance-live-metrics">
        <PerformanceMetric compact live={live} emptyLabel={source?.state === 'available' ? 'Collecting history' : 'History unavailable'} label="App CPU" value={cpu(app?.cpuPercent)} hint={`${cpuCoreLabel(app?.cpuPercent, observation?.units.cpuBasis)} · 10s peak`}
          points={trend.map(point => ({ id: JSON.stringify(point), at: point.observedAt, value: point.appCpuPercent }))} sourceKey={observationKey} color="var(--green)" />
        <PerformanceMetric compact live={live} emptyLabel={source?.state === 'available' ? 'Collecting history' : 'History unavailable'} label="Resident memory" value={memory(app?.rssKib)} hint={`${app?.processCount ?? '—'} app processes · latest RSS`}
          points={trend.map(point => ({ id: JSON.stringify(point), at: point.observedAt, value: point.appRssKib }))} sourceKey={observationKey} unit="KiB" color="var(--blue)" />
      </div>
      <PerformanceSourceNote source={source} />
      <button type="button" className="performance-run-summary performance-overview-runs" onClick={onInspectResources}>
        <span className="performance-run-summary__icon"><SemanticIcon name="object.runs" size={16} aria-hidden="true" /></span>
        <span className="performance-run-summary__label"><strong>Agent Runs</strong><small>{totals ? `${totals.coverage.observedRoots} / ${totals.coverage.trackedRuns} roots observed` : 'Coverage unavailable'}</small></span>
        <span className="performance-run-summary__value"><strong>{cpu(totals?.cpuPercent)}</strong><small>{memory(totals?.rssKib)} RSS</small></span>
        <span className="performance-run-summary__arrow" aria-hidden="true">→</span>
      </button>
      <PerformanceSourceNote source={observation?.process} />
      <details className="performance-measurement-note"><summary>Measurement scope</summary>
        <p>{readingTime(observation?.process.lastSuccessAt, snapshot?.observedAt)}{totals && totals.coverage.missingRoots > 0 ? ` · ${totals.coverage.missingRoots} missing roots; totals incomplete` : ''}</p>
        <p>App and Run observations have separate coverage and CPU windows. They are not a whole-computer total.</p>
      </details>
    </section>
    <PerformanceHostResources observation={observation} observedAt={snapshot?.observedAt} />
    <div className="performance-next-actions"><button type="button" onClick={onDiagnose}><strong>Investigate a hotspot</strong><small>Sample functions, rendering or memory</small><span aria-hidden="true">→</span></button>
      <button type="button" onClick={onArtifacts}><strong>Capture or open evidence</strong><small>Keep originals and a technical report</small><span aria-hidden="true">→</span></button></div>
  </>
}
