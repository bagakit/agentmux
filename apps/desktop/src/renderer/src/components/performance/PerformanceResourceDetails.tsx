import { PerformanceSourceNote } from './PerformanceSourceNote'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RunUsage, ToolkitAgentCard as AgentCard, ToolkitAgentCardField } from '@agentmux/core/control'
import type { ToolkitMetricsSnapshot } from '../../../../shared/toolkit'
import { PerformanceAttribution, cpuCoreLabel } from './PerformanceAttribution'
import { PerformanceTrend } from './PerformanceTrend'
import { LiquidSelectionSurface } from '../LiquidSelectionSurface'
import { ToolkitAgentCard, toolkitAgentCardKey, useToolkitAgentCards, type ToolkitAgentCardFacts } from '../toolkit/ToolkitAgentCards'
import { performanceCPU as cpu, performanceMemory as memory, performanceBytes as bytes, performanceReadingTime as readingTime } from './performance-format'
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeObjectRunsIcon = semanticIconComponent('object.runs')
const NO_CARDS: AgentCard[] = []
const NO_FIELDS: ToolkitAgentCardField[] = []
const runKey = (run: Pick<RunUsage, 'hostId' | 'runId'>) => JSON.stringify([run.hostId, run.runId])


function Metric({ label, value, hint, points, color, sourceKey, unit = '%' }: { label: string; value: string; hint: string; points?: { id: string; at: number; value: number | null }[]; color: string; sourceKey?: string; unit?: '%' | 'KiB' }) {
  return <section className="performance-metric"><span className="performance-metric__label">{label}</span><strong>{value}</strong><small>{hint}</small>
    {points ? <PerformanceTrend key={sourceKey} points={points} color={color} label={label} unit={unit} /> : null}</section>
}
function Facts({ children }: { children: React.ReactNode }) { return <dl className="performance-facts">{children}</dl> }
function RunRow({ run, card, fields, facts, onToggle, basis }: { run: RunUsage; card: AgentCard | null | undefined; fields: readonly ToolkitAgentCardField[]; facts: ToolkitAgentCardFacts | undefined; onToggle(key: string, open: boolean): void; basis: string | undefined }) {
  return <details className="performance-contributor" data-run-id={run.runId} data-run-host={run.hostId} onToggle={event => onToggle(runKey(run), event.currentTarget.open)}>
    <summary className="performance-contributor__row"><span className="performance-run-identity"><ThemeNavigationDownIcon size={11} className="performance-run-chevron" aria-hidden="true" />
      {card ? <ToolkitAgentCard card={card} fields={fields} resolvedFacts={facts} /> : <span className="performance-identity"><strong title={run.runId}>{run.runId}</strong><small>{card === null ? 'Agent card ambiguous' : 'Agent card unavailable'}</small></span>}</span>
      <span>{cpu(run.cpuPercent)}<small className="performance-core-equivalent">{cpuCoreLabel(run.cpuPercent, basis)}</small></span><span>{memory(run.rssKib)}</span></summary>
    <Facts><dt>Run</dt><dd>{run.runId}</dd><dt>Host</dt><dd>{run.hostId}</dd><dt>Processes</dt><dd>{run.processCount ?? '—'}</dd>
      <dt>Root · PID {run.rootPid}</dt><dd>{memory(run.rootRssKib)}</dd><dt>Descendants · {run.descendantProcessCount ?? '—'} processes</dt><dd>{memory(run.descendantsRssKib)}</dd></Facts>
  </details>
}

/** Keep the resource reader mounted, but do not process new hidden observations. */
export const PerformanceResourceDetails = memo(function PerformanceResourceDetails({ snapshot, paused, active }: {
  snapshot: ToolkitMetricsSnapshot | null; paused: boolean; active: boolean
}) {
  const [scope, setScope] = useState<'app' | 'runs' | 'runtime'>('app')
  const [sort, setSort] = useState<'cpu' | 'rss'>('cpu')
  const [all, setAll] = useState(false)
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [lockedOrder, setLockedOrder] = useState<string[] | null>(null)
  const openRuns = useRef(new Set<string>())
  const list = useRef<HTMLDivElement>(null)
  const [runTrend, setRunTrend] = useState<{ key: string; lastSourceAt: number | null; points: { at: number; cpu: number | null; rss: number | null }[] }>({ key: '', lastSourceAt: null, points: [] })
  const [appTrend, setAppTrend] = useState<{ key: string; lastSourceAt: number | null; resumePending: boolean; points: ToolkitMetricsSnapshot['trend'] }>({ key: '', lastSourceAt: null, resumePending: false, points: [] })
  const observation = snapshot?.observation
  const observationKey = JSON.stringify([snapshot?.executionId, snapshot?.run?.hostId, snapshot?.run?.runId, observation?.scope.hostId])
  const app = observation?.app.data
  const runs = observation?.process.data ?? []
  const ranked = useMemo(() => [...runs].sort((a, b) => ((sort === 'cpu' ? b.cpuPercent : b.rssKib) ?? -1) - ((sort === 'cpu' ? a.cpuPercent : a.rssKib) ?? -1) || runKey(a).localeCompare(runKey(b))), [runs, sort])
  const ordered = useMemo(() => {
    if (!lockedOrder) return ranked
    const byKey = new Map(ranked.map(run => [runKey(run), run]))
    return [...lockedOrder.flatMap(key => byKey.has(key) ? [byKey.get(key)!] : []), ...ranked.filter(run => !lockedOrder.includes(runKey(run)))]
  }, [ranked, lockedOrder])
  const activeRun = runs.find(run => runKey(run) === selectedRun) ?? null
  const rows = all ? ordered : ordered.slice(0, 5)
  const cardDocument = snapshot?.document?.agentCards
  const fields = cardDocument?.fields ?? NO_FIELDS
  const cardsByRun = useMemo(() => {
    const result = new Map<string, AgentCard | null>()
    for (const card of cardDocument?.items ?? NO_CARDS) {
      if (card.reference.kind !== 'run') continue
      const key = runKey(card.reference)
      result.set(key, result.has(key) ? null : card)
    }
    return result
  }, [cardDocument?.items])
  const visibleCardSignature = JSON.stringify(active && scope === 'runs' ? [...new Set([...rows.map(runKey), ...(selectedRun ? [selectedRun] : [])])] : [])
  const visibleCards = useMemo(() => (JSON.parse(visibleCardSignature) as string[]).flatMap(key => {
    const card = cardsByRun.get(key); return card ? [card] : []
  }), [visibleCardSignature, cardsByRun])
  const cardFacts = useToolkitAgentCards(visibleCards, fields, active && scope === 'runs')
  const totals = observation?.runTotals
  const source = scope === 'app' ? observation?.app : scope === 'runs' ? observation?.process : observation?.runtime
  // 只投影真实 owner 的有界点；自己的暂停断点不能被其他 watcher 的连续观察填上。
  useEffect(() => {
    if (!snapshot) return
    setAppTrend(previous => {
      const incoming = snapshot.trend.slice(-60)
      const numeric = (point: ToolkitMetricsSnapshot['trend'][number]) => point.appCpuPercent !== null || point.appRssKib !== null
      if (previous.key !== observationKey) {
        let lastSourceAt: number | null = null
        for (let index = incoming.length - 1; index >= 0; index--) {
          const point = incoming[index]!
          if (numeric(point)) { lastSourceAt = point.observedAt; break }
        }
        return { key: observationKey, lastSourceAt, resumePending: paused, points: incoming }
      }
      if (paused) {
        if (previous.resumePending) return previous
        return { ...previous, resumePending: true, points: previous.points.length ? [...previous.points,
          { observedAt: snapshot.observedAt ?? previous.lastSourceAt ?? 0, appCpuPercent: null, appRssKib: null }].slice(-60) : previous.points }
      }
      const fresh = incoming.filter(point => numeric(point) && (previous.lastSourceAt === null || point.observedAt > previous.lastSourceAt))
      if (previous.resumePending) {
        const latest = fresh.at(-1)
        return latest ? { key: observationKey, lastSourceAt: latest.observedAt, resumePending: false,
          points: [...previous.points, latest].slice(-60) } : previous
      }
      let anchor = -1
      for (let index = incoming.length - 1; index >= 0; index--) {
        const point = incoming[index]!
        if (numeric(point) && point.observedAt === previous.lastSourceAt) { anchor = index; break }
      }
      const start = anchor >= 0 ? anchor + 1 : fresh.length ? incoming.indexOf(fresh[0]!) : incoming.length - 1
      const points = previous.points.slice()
      let lastSourceAt = previous.lastSourceAt
      for (const point of incoming.slice(start)) {
        if (numeric(point)) {
          if (lastSourceAt !== null && point.observedAt <= lastSourceAt) continue
          lastSourceAt = point.observedAt; points.push(point)
        } else if (points.length && numeric(points.at(-1)!)) points.push(point)
      }
      return points.length === previous.points.length ? previous : { key: observationKey, lastSourceAt, resumePending: false, points: points.slice(-60) }
    })
  }, [observationKey, snapshot?.trend, paused])
  const trend = appTrend.key === observationKey ? appTrend.points : []
  const selectScope = (next: typeof scope) => { setScope(next); setAll(false) }
  const lock = () => setLockedOrder(previous => previous ?? ranked.map(runKey))
  const toggleRun = (key: string, open: boolean) => {
    if (open) { openRuns.current.add(key); lock(); setSelectedRun(key) }
    else {
      openRuns.current.delete(key)
      if (!openRuns.current.size && !list.current?.contains(document.activeElement)) setLockedOrder(null)
    }
  }
  useEffect(() => {
    const source = observation?.process, at = source?.observedAt
    if (!selectedRun || !source || !observation) return
    const key = JSON.stringify([observationKey, selectedRun])
    const gap = paused || !active || scope !== 'runs' || source.state !== 'available' || !activeRun || at == null
    setRunTrend(previous => {
      const points = previous.key === key ? previous.points : []
      const lastSourceAt = previous.key === key ? previous.lastSourceAt : null
      const last = points.at(-1)
      if (gap) {
        // 不把缺测边界当数值点；重复不可用不增长，恢复后不会跨空段连线。
        if (!points.length || last?.cpu === null && last.rss === null) return previous
        return { key, lastSourceAt, points: [...points, { at: observation.observedAt, cpu: null, rss: null }].slice(-60) }
      }
      if (lastSourceAt === at) return previous
      return { key, lastSourceAt: at!, points: [...points, { at: at!, cpu: activeRun!.cpuPercent, rss: activeRun!.rssKib }].slice(-60) }
    })
  }, [observation?.process, observation?.observedAt, activeRun, selectedRun, paused, scope, active, observationKey])
  const runSourceKey = JSON.stringify([observationKey, selectedRun])
  const selectedTrend = activeRun && runTrend.key === runSourceKey ? runTrend.points : []
  const renderRuntimeFacts = () => <>
    <PerformanceSourceNote source={observation?.runtime} />
    {observation?.runtime.data?.length === 0 ? <p className="performance-empty">No connected Runtime</p> : null}
    {observation?.runtime.data?.map(runtime => <section className="performance-runtime" key={runtime.hostId}>
      <div className="performance-section-heading"><strong>ctxmux</strong><span title={runtime.hostId}>{runtime.hostId}</span></div>
      <div className="performance-runtime__overview"><div><small>Retained output</small><strong>{bytes(runtime.resources?.retainedOutputBytes)}</strong></div>
        <div><small>Runs</small><strong>{runtime.resources?.runCount ?? '—'}<em>{runtime.resources ? ` · ${runtime.resources.runningRuns} running` : ''}</em></strong></div></div>
      {runtime.unavailable ? <p className="performance-state" data-tone="warning">{runtime.unavailable}</p> : null}
      <p className="performance-note">CPU / RSS unavailable · {readingTime(runtime.resources?.observedAt ?? observation.runtime.lastSuccessAt, snapshot?.observedAt)}</p>
      <details className="performance-disclosure"><summary>Runtime details <ThemeNavigationDownIcon size={12} /></summary><Facts>
        <dt>Host</dt><dd>{runtime.hostId}</dd><dt>Attachments</dt><dd>{runtime.resources?.attachments ?? '—'}</dd>
        <dt>Ended / unattached</dt><dd>{runtime.resources ? `${runtime.resources.terminatedRuns} / ${runtime.resources.terminatedUnattachedRuns}` : '—'}</dd>
        <dt>Storage · disk</dt><dd>{bytes(runtime.runtimeStorage?.bytes)}</dd>
        <dt>Storage observed</dt><dd>{readingTime(runtime.runtimeStorageObservedAt, snapshot?.observedAt)}</dd>
        <dt>Storage path</dt><dd>{runtime.runtimeStorage?.path ?? runtime.runtimeStorageUnavailable ?? 'Unavailable'}</dd>
        <dt>Process source</dt><dd>{runtime.process.unavailable}</dd>
      </Facts><p className="performance-note">Retention is an observation, not a leak verdict.</p></details>
    </section>)}
  </>
  return <>
    <span className="performance-reading-time">{readingTime(source?.lastSuccessAt, snapshot?.observedAt)}</span>
    <div className="performance-scopes" role="group" aria-label="Resource scope" data-paused={paused}>
      <LiquidSelectionSurface selected={scope} active={!paused} targetAttribute="data-settings-target" />
      {([['app', 'App'], ['runs', 'Runs'], ['runtime', 'Runtime']] as const).map(([id, label]) => <button key={id} type="button" data-settings-target={id} aria-pressed={scope === id} onClick={() => selectScope(id)}>{label}</button>)}
    </div>
      {scope !== 'runtime' ? <>
        {scope === 'app' ? <div className="performance-metrics"><Metric label="CPU" value={cpu(app?.cpuPercent)} hint={`${cpuCoreLabel(app?.cpuPercent, observation?.units.cpuBasis)} · 10s reading peak`} points={trend.map(p => ({ id: JSON.stringify(p), at: p.observedAt, value: p.appCpuPercent }))} sourceKey={observationKey} color="var(--green)" />
          <Metric label="Resident memory" value={memory(app?.rssKib)} hint="Latest · RSS" points={trend.map(p => ({ id: JSON.stringify(p), at: p.observedAt, value: p.appRssKib }))} sourceKey={observationKey} unit="KiB" color="var(--blue)" /></div>
          : <><div className="performance-run-summary" data-run-totals><ThemeObjectRunsIcon size={14} /><span>All tracked Runs</span>
            <small>{totals ? `${totals.coverage.observedRoots} / ${totals.coverage.trackedRuns} roots observed` : 'Coverage unavailable'}</small></div>
            <div className="performance-metrics" data-run-total-values><Metric label="Total CPU" value={cpu(totals?.cpuPercent)} hint={`${cpuCoreLabel(totals?.cpuPercent, observation?.units.cpuBasis)} · 10s peak of batch sums`} color="var(--green)" />
              <Metric label="Total resident memory" value={memory(totals?.rssKib)} hint="Latest · unique sampled PIDs" color="var(--blue)" /></div>
            <p className="performance-note">Observed local Run processes · RSS includes shared pages. Each CPU batch is summed before its 10s peak; row peaks can occur at different times.</p>
            {totals && totals.coverage.missingRoots > 0 ? <p className="performance-state" data-tone="warning">{totals.coverage.missingRoots} tracked roots missing · complete totals unavailable</p> : null}
            {activeRun ? <><div className="performance-run-summary"><span title={activeRun.runId}>Selected Run · {activeRun.runId}</span></div>
              <div className="performance-metrics performance-metrics--run"><Metric label="Selected CPU" value={cpu(activeRun.cpuPercent)} hint={`${cpuCoreLabel(activeRun.cpuPercent, observation?.units.cpuBasis)} · 10s reading peak`} points={selectedTrend.map(point => ({ id: JSON.stringify(point), at: point.at, value: point.cpu }))} sourceKey={runSourceKey} color="var(--green)" />
              <Metric label="Selected resident memory" value={memory(activeRun.rssKib)} hint="Latest · root + descendants" points={selectedTrend.map(point => ({ id: JSON.stringify(point), at: point.at, value: point.rss }))} sourceKey={runSourceKey} unit="KiB" color="var(--blue)" /></div></> : null}</>}
        <PerformanceSourceNote source={source} />
        {scope === 'app' && app && app.cpuPercent === null ? <p className="performance-state">CPU unavailable · waiting for a valid interval</p> : null}
        {scope === 'app' ? <><PerformanceAttribution observation={observation} paused={paused} /></> : <>
          <div className="performance-section-heading"><strong>Run processes</strong><div className="performance-sort" role="group" aria-label="Sort contributors">
            <button type="button" aria-pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>CPU</button><button type="button" aria-pressed={sort === 'rss'} onClick={() => setSort('rss')}>RSS</button></div></div>
          <div className="performance-table-head"><span>Run</span><span>CPU</span><span>RSS</span></div>
          <div ref={list} className="performance-run-list" onFocusCapture={lock} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !openRuns.current.size) setLockedOrder(null) }}>
            {rows.map(run => { const card = cardsByRun.get(runKey(run)); return <RunRow key={runKey(run)} run={run} card={card} fields={fields}
              facts={card ? cardFacts.get(toolkitAgentCardKey(card.reference)) : undefined} onToggle={toggleRun} basis={observation?.units.cpuBasis} /> })}</div>
          {cardDocument?.omittedItems ? <p className="performance-note">{cardDocument.omittedItems} Agent cards omitted by the result budget. Run readings and totals include all tracked Runs.</p> : null}
          {!runs.length ? <p className="performance-empty">{source?.state === 'available' ? 'No observed Runs' : 'Waiting for Run readings'}</p> : null}
          {ranked.length > 5 ? <button type="button" className="performance-show-all" onClick={() => setAll(!all)}>{all ? 'Show top five' : `View all ${ranked.length} Runs`}<ThemeNavigationDownIcon size={12} /></button> : null}
        </>}
        <details className="performance-disclosure"><summary>Resource owners <span>Main & this window</span><ThemeNavigationDownIcon size={12} /></summary><Facts>
          <dt>Main reading</dt><dd>{observation?.main.state ?? 'pending'} · {readingTime(observation?.main.lastSuccessAt, snapshot?.observedAt)}{observation?.main.reason ? ` · ${observation.main.reason}` : ''}</dd>
          <dt>Attachment owners / leases</dt><dd>{observation?.main.data ? `${observation.main.data.sessionAttachmentOwners} / ${observation.main.data.sessionAttachmentLeases}` : '—'}</dd>
          <dt>File watchers</dt><dd>{observation?.main.data?.fileWatchers ?? '—'}</dd><dt>Browser views / released</dt><dd>{observation?.main.data ? `${observation.main.data.browserViews} / ${observation.main.data.releasedBrowserViews}` : '—'}</dd>
          <dt>Window reading</dt><dd>{observation?.renderer.state ?? 'pending'} · {readingTime(observation?.renderer.lastSuccessAt, snapshot?.observedAt)}{observation?.renderer.reason ? ` · ${observation.renderer.reason}` : ''}</dd>
          <dt>Terminal views / addons / listeners</dt><dd>{observation?.renderer.data ? `${observation.renderer.data.counts.terminalViews} / ${observation.renderer.data.counts.terminalAddons} / ${observation.renderer.data.counts.terminalListeners}` : '—'}</dd>
          <dt>Editors / models / documents</dt><dd>{observation?.renderer.data ? `${observation.renderer.data.counts.monacoEditors ?? '—'} / ${observation.renderer.data.counts.monacoModels ?? '—'} / ${observation.renderer.data.counts.documents}` : '—'}</dd>
          <dt>Runtime subscriptions</dt><dd>{observation?.renderer.data?.counts.runtimeSubscriptions ?? '—'}</dd>
        </Facts></details>
      </> : renderRuntimeFacts()}
  </>
}, (previous, next) => !previous.active && !next.active)
