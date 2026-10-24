import { PerformanceSourceNote } from './PerformanceSourceNote'
import { useContext, useId, useLayoutEffect, useRef, useState } from 'react'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import { ToolkitActions } from '../toolkit/ToolkitActions'
import type { ToolkitMetricsSnapshot } from '../../../../shared/toolkit'
import { cpuCoreLabel } from './PerformanceAttribution'
import { PerformanceResourceDetails } from './PerformanceResourceDetails'
import { PerformanceHostResources } from './PerformanceHostResources'
import { ToolkitPopoverSurface } from './PerformancePopover'
import { performanceCPU as cpu, performanceMemory as memory, performanceReadingTime as readingTime } from './performance-format'
import { PerformanceCapture } from './PerformanceCapture'
import { PerformanceProfileImport } from './PerformanceProfileImport'
import { PerformanceScene } from './PerformanceScene'
import { PerformanceHeapSnapshot } from './PerformanceHeapSnapshot'
import type { PerformanceHeapSnapshotState } from '../../lib/use-performance-heap-snapshot'
import type { PerformanceSceneState } from '../../lib/use-performance-scene'


const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeObjectProcessorIcon = semanticIconComponent('object.processor')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeObjectSourceCodeIcon = semanticIconComponent('object.source-code')
const ThemeActionResumeIcon = semanticIconComponent('action.resume')
const ThemeActionPauseIcon = semanticIconComponent('action.pause')
const ThemeObjectSettingsIcon = semanticIconComponent('object.settings')
const ExpandIcon = semanticIconComponent('layout.expand')
const CompactIcon = semanticIconComponent('layout.collapse')
const sections = [['overview', 'Overview', 'Environment and load'], ['resources', 'Resources', 'Processes and owners'], ['diagnostics', 'Diagnose', 'CPU and memory'], ['artifacts', 'Artifacts', 'Scenes and saved files']] as const
type Section = typeof sections[number][0]


function Facts({ children }: { children: React.ReactNode }) { return <dl className="performance-facts">{children}</dl> }

export function PerformanceOverview({ snapshot, close, paused = false, pending = false, error, onPause, onConfigure, onViewScript, onManageBrowsers,
  scene, heap, singleCaptureBusy = false, onSingleCaptureBusyChange, recovering = false, startNewObservation }: {
  snapshot: ToolkitMetricsSnapshot | null; close(): void
  paused?: boolean; pending?: boolean; error?: string | null; onPause?(): void; onConfigure(): void; onViewScript(): void
  onManageBrowsers?(): void
  scene?: PerformanceSceneState; singleCaptureBusy?: boolean; onSingleCaptureBusyChange?(busy: boolean): void
  heap?: PerformanceHeapSnapshotState
  recovering?: boolean; startNewObservation?(): void
}) {
  const [section, setSection] = useState<Section>('overview')
  const [expanded, setExpanded] = useState(false)
  const surface = useContext(ToolkitPopoverSurface), navigationId = useId()
  const body = useRef<HTMLDivElement>(null), scroll = useRef<Partial<Record<Section, number>>>({})
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = scroll.current[section] ?? 0 }, [section])
  useLayoutEffect(() => {
    const panel = surface?.panel.current
    if (!panel) return
    panel.dataset.performanceExpanded = String(expanded); surface!.setResizable(expanded)
    return () => { delete panel.dataset.performanceExpanded; surface!.setResizable(false) }
  }, [surface, expanded])
  const observation = snapshot?.observation, source = observation?.app, app = source?.data, totals = observation?.runTotals
  const state = paused ? 'Paused here' : error ? 'Observation unavailable' : pending ? 'Starting…' : snapshot?.state === 'observing' ? 'Observing' : snapshot?.state === 'starting' ? 'Starting…' : snapshot?.state === 'stopping' ? 'Stopping…' : snapshot?.state === 'paused' ? 'Observation stopped' : snapshot?.state === 'failed' ? 'Observation failed' : snapshot?.state === 'unknown' ? 'Unconfirmed' : 'No observation'
  const viewScriptButton = <button type="button" onClick={onViewScript}><ThemeObjectSourceCodeIcon size={13} /><span>View script</span></button>
  return <>
    <header className="performance-header"><div className="performance-title"><ThemeObjectProcessorIcon size={15} /><h2>Performance</h2></div>
      <span className="performance-status" data-state={paused ? 'paused' : error ? 'failed' : snapshot?.state}><SemanticIcon size={5} name={`status.observation-${paused ? 'paused' : error ? 'failed' : pending ? 'starting' : snapshot?.state ?? 'unknown'}`} />{state}</span>
      <button type="button" className="performance-icon-button" aria-label={expanded ? 'Compact Performance' : 'Expand Performance'} title={expanded ? 'Compact view' : 'Expand analysis view'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <CompactIcon size={14} /> : <ExpandIcon size={14} />}</button>
      <button type="button" className="performance-icon-button" aria-label="Close Performance" data-toolkit-close onClick={close}><ThemeActionCloseIcon size={14} /></button></header>

    <div className="performance-workbench" data-expanded={expanded}>
      <nav className="performance-navigation" role="tablist" aria-label="Performance sections" aria-orientation={expanded ? 'vertical' : 'horizontal'}>
        {sections.map(([id, label, hint], index) => <button key={id} id={navigationId + '-' + id} type="button" role="tab" aria-selected={section === id}
          aria-controls={navigationId + '-panel-' + id} tabIndex={section === id ? 0 : -1} data-performance-section-tab={id} onClick={() => setSection(id)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
            const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
            if (!step && event.key !== 'Home' && event.key !== 'End') return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + step + sections.length) % sections.length
            setSection(sections[next]![0]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
          }}><strong>{label}</strong><small>{hint}</small></button>)}
      </nav>
    <div ref={body} className="performance-body" onScroll={event => { scroll.current[section] = event.currentTarget.scrollTop }}>
      <span className="performance-reading-time">{readingTime(source?.lastSuccessAt, snapshot?.observedAt)}</span>
      {error || snapshot?.reason ? <p className="performance-state" data-tone="warning">{error ?? snapshot?.reason}</p> : null}
      {snapshot?.state === 'unknown' && snapshot.run === null && startNewObservation ? <div className="performance-state">
        <p>The previous creation is unconfirmed. A new observation keeps its original record and does not retry or stop that execution.</p>
        <button type="button" className="performance-inline-action" disabled={recovering} onClick={startNewObservation}>{recovering ? 'Starting new observation…' : 'Start new observation'}</button>
      </div> : null}
      <section role="tabpanel" id={navigationId + '-panel-overview'} aria-labelledby={navigationId + '-overview'} hidden={section !== 'overview'} data-performance-section="overview">
        <PerformanceHostResources observation={observation} observedAt={snapshot?.observedAt} />
        <div className="performance-section-heading"><strong>AgentMux</strong><button type="button" className="performance-inline-action" onClick={() => setSection('resources')}>Inspect resources →</button></div>
        <div className="performance-overview-load"><div><small>App CPU</small><strong>{cpu(app?.cpuPercent)}</strong><small>{cpuCoreLabel(app?.cpuPercent, observation?.units.cpuBasis)} · 10s peak</small></div>
          <div><small>Resident memory</small><strong>{memory(app?.rssKib)}</strong><small>{app?.processCount ?? '—'} app processes · latest RSS</small></div></div>
        <PerformanceSourceNote source={observation?.app} />
        <div className="performance-overview-runs"><span>Agent Runs <small>{totals ? [totals.coverage.observedRoots, '/', totals.coverage.trackedRuns, 'roots observed'].join(' ') : 'Coverage unavailable'}</small></span><strong>{cpu(totals?.cpuPercent)}<small>{memory(totals?.rssKib)} RSS</small></strong></div>
        <p className="performance-note">{readingTime(observation?.process.lastSuccessAt, snapshot?.observedAt)}{totals && totals.coverage.missingRoots > 0 ? ` · ${totals.coverage.missingRoots} missing roots; totals incomplete` : ''}</p>
        <PerformanceSourceNote source={observation?.process} />
        <p className="performance-note">App and Run observations have separate coverage and CPU windows. They are not a whole-computer total.</p>
        <div className="performance-next-actions"><button type="button" onClick={() => setSection('diagnostics')}><strong>Investigate a hotspot</strong><small>Sample functions, rendering or memory</small></button>
          <button type="button" onClick={() => setSection('artifacts')}><strong>Capture or open evidence</strong><small>Keep originals and a technical report</small></button></div>
      </section>
      <section role="tabpanel" id={navigationId + '-panel-resources'} aria-labelledby={navigationId + '-resources'} hidden={section !== 'resources'} data-performance-section="resources">
        <PerformanceResourceDetails snapshot={snapshot} paused={paused} active={section === 'resources'} onNavigate={close} />
      </section>
      <section role="tabpanel" id={navigationId + '-panel-diagnostics'} aria-labelledby={navigationId + '-diagnostics'} hidden={section !== 'diagnostics'} data-performance-section="diagnostics">
        <div className="performance-page-heading"><h3>Diagnose this window</h3><p>Explicit, short investigations of the original Renderer. Opening this view does not start a capture.</p></div>
        <PerformanceCapture observation={observation} externalBusy={scene?.busy || heap?.busy} onBusyChange={onSingleCaptureBusyChange} />
        {heap ? <PerformanceHeapSnapshot state={heap} observation={observation} externalBusy={singleCaptureBusy || scene?.busy === true} /> : null}
      </section>
      <section role="tabpanel" id={navigationId + '-panel-artifacts'} aria-labelledby={navigationId + '-artifacts'} hidden={section !== 'artifacts'} data-performance-section="artifacts">
        <div className="performance-page-heading"><h3>Scenes &amp; saved originals</h3><p>Keep the original source and capture receipts. Historical files remain separate from the current window.</p></div>
        {scene ? <PerformanceScene state={scene} observation={observation} externalBusy={singleCaptureBusy || heap?.busy === true} /> : null}
        <PerformanceProfileImport />
      </section>
      <details className="performance-disclosure performance-sources"><summary>Observation details <ThemeNavigationDownIcon size={12} /></summary><Facts>
        <dt>Host / Main</dt><dd>{observation ? `${observation.scope.hostname} · ${observation.scope.mainPid}` : '—'}</dd>
        <dt>Execution</dt><dd>{snapshot?.executionId ?? '—'}</dd><dt>Source state</dt><dd>{source?.state ?? 'pending'}</dd>
        {snapshot?.previousUnknownExecutionId ? <><dt>Previous unconfirmed execution</dt><dd>{snapshot.previousUnknownExecutionId}</dd></> : null}
        <dt>Observed</dt><dd>{readingTime(source?.observedAt, snapshot?.observedAt)}</dd><dt>CPU · App / Run</dt><dd>100% = one logical core · interval / ps averages · 10s reading peak</dd>
        <dt>Run RSS</dt><dd>Root + attributed descendants; shared pages may count in multiple processes.</dd>
      </Facts></details>
    </div>
    </div>
    <ToolkitActions primary={onPause ? <button type="button" data-performance-observation-toggle onClick={onPause}>{paused ? <ThemeActionResumeIcon size={12} /> : <ThemeActionPauseIcon size={12} />}<span>{paused ? 'Resume' : 'Pause'}</span></button> : viewScriptButton}>
      {onPause ? viewScriptButton : null}
      {onManageBrowsers ? <button type="button" onClick={onManageBrowsers}>Manage browsers</button> : null}
      <button type="button" onClick={onConfigure}><ThemeObjectSettingsIcon size={13} /><span>Configure</span></button>
    </ToolkitActions>
  </>
}
