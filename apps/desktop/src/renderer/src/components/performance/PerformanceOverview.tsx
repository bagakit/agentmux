import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Code2, Cpu, Layers, Pause, Play, Settings2, X } from 'lucide-react'
import { LiquidSelectionSurface } from '../settings/LiquidSelectionSurface'
import type { MetricsSource, RunUsage } from '@agentmux/core/control'
import type { ToolkitSnapshot } from '../../../../shared/toolkit'

export type RunContext = { label: string; context: string; state: string; workspace?: string; provider?: string }
export const runKey = (run: Pick<RunUsage, 'hostId' | 'runId'>) => JSON.stringify([run.hostId, run.runId])
const cpu = (n: number | null | undefined) => n == null ? '—' : `${n.toFixed(1)}%`
const memory = (n: number | null | undefined) => n == null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} GiB` : n >= 1024 ? `${Math.round(n / 1024)} MiB` : `${Math.round(n)} KiB`
const bytes = (n: number | null | undefined) => n == null ? '—' : n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GiB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`
const roleLabel: Record<string, string> = { main: 'Main', renderer: 'Renderer', gpu: 'GPU', browser: 'Browser', utility: 'Utility', other: 'Other' }
function time(at: number | null | undefined) { return at == null ? 'Waiting for a reading' : new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function readingTime(at: number | null | undefined, updateAt: number | null | undefined) {
  if (at == null) return time(at)
  const age = updateAt == null ? 0 : Math.max(0, Math.floor((updateAt - at) / 1000))
  return `${time(at)}${age ? ` · ${age >= 60 ? `${Math.floor(age / 60)}m` : `${age}s`} old` : ''}`
}
function SourceNote({ source }: { source: MetricsSource<unknown> | undefined }) {
  if (!source) return <p className="performance-state">Waiting for the first observation.</p>
  if (source.state === 'available') return null
  return <p className="performance-state" data-tone={source.state === 'pending' ? 'neutral' : 'warning'}>
    {source.state === 'pending' ? 'Collecting this source…' : source.state === 'stale' ? 'Previous reading' : 'Source unavailable'}
    {source.reason ? ` · ${source.reason}` : ''}
  </p>
}
function Sparkline({ values, color, label }: { values: (number | null)[]; color: string; label: string }) {
  const valid = values.filter((n): n is number => n !== null && Number.isFinite(n))
  const max = valid.length ? Math.max(1, ...valid) * 1.12 : 1
  let d = '', connected = false
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value == null || !Number.isFinite(value)) { connected = false; continue }
    const x = values.length > 1 ? i / (values.length - 1) * 180 : 180, y = 42 - value / max * 34
    d += `${connected ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `; connected = true
  }
  return <svg className="performance-trend" viewBox="0 0 180 48" role="img" aria-label={label} style={{ color }}>
    <path className="performance-trend__baseline" d="M0 43H180" />
    {valid.length > 1 ? <path d={d} /> : <text x="0" y="32">Collecting history</text>}
  </svg>
}
function Metric({ label, value, hint, values, color }: { label: string; value: string; hint: string; values?: (number | null)[]; color: string }) {
  return <section className="performance-metric"><span className="performance-metric__label">{label}</span><strong>{value}</strong>
    {values ? <Sparkline values={values} color={color} label={`${label} · ${hint} · this observation`} /> : null}<small>{hint}</small></section>
}
function Facts({ children }: { children: React.ReactNode }) { return <dl className="performance-facts">{children}</dl> }
function RunRow({ run, context, onToggle }: { run: RunUsage; context: RunContext | undefined; onToggle(key: string, open: boolean): void }) {
  return <details className="performance-contributor" data-run-id={run.runId} data-run-host={run.hostId} onToggle={event => onToggle(runKey(run), event.currentTarget.open)}>
    <summary className="performance-contributor__row"><span className="performance-identity"><strong><ChevronDown size={11} className="performance-run-chevron" aria-hidden="true" /><span title={context?.label ?? run.runId}>{context?.label ?? (run.runId.length > 18 ? `${run.runId.slice(0, 8)}…${run.runId.slice(-6)}` : run.runId)}</span></strong>
      <small title={context?.context}>{context?.context ?? 'Context unavailable'} · {context?.state ?? 'unknown'}</small></span>
      <span>{cpu(run.cpuPercent)}</span><span>{memory(run.rssKib)}</span></summary>
    <Facts><dt>Run</dt><dd>{run.runId}</dd><dt>Identity</dt><dd>{context?.label ?? 'Unattributed Run'}</dd>
      <dt>Workspace / provider</dt><dd>{context?.workspace ? `${context.workspace} · ${context.provider ?? 'Provider unavailable'}` : context?.context ?? 'Unknown'}</dd><dt>Host</dt><dd>{run.hostId}</dd>
      <dt>Processes</dt><dd>{run.processCount ?? '—'}</dd>
      <dt>Root · PID {run.rootPid}</dt><dd>{memory(run.rootRssKib)}</dd><dt>Descendants · {run.descendantProcessCount ?? '—'} processes</dt><dd>{memory(run.descendantsRssKib)}</dd></Facts>
  </details>
}

export function PerformanceOverview({ snapshot, contexts, close, paused = false, pending = false, error, onPause, onConfigure, onViewScript, onVisibleRunKeysChange }: {
  snapshot: ToolkitSnapshot | null; contexts: Record<string, RunContext>; close(): void
  paused?: boolean; pending?: boolean; error?: string | null; onPause?(): void; onConfigure(): void; onViewScript(): void
  onVisibleRunKeysChange?(keys: readonly string[]): void
}) {
  const [scope, setScope] = useState<'app' | 'runs' | 'runtime'>('app')
  const [sort, setSort] = useState<'cpu' | 'rss'>('cpu')
  const [all, setAll] = useState(false)
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [lockedOrder, setLockedOrder] = useState<string[] | null>(null)
  const openRuns = useRef(new Set<string>())
  const list = useRef<HTMLDivElement>(null)
  const [runTrend, setRunTrend] = useState<{ key: string; lastSourceAt: number | null; points: { at: number; cpu: number | null; rss: number | null }[] }>({ key: '', lastSourceAt: null, points: [] })
  const [appTrend, setAppTrend] = useState<{ executionId: string | null; lastSourceAt: number | null; resumePending: boolean; points: ToolkitSnapshot['trend'] }>({ executionId: null, lastSourceAt: null, resumePending: false, points: [] })
  const observation = snapshot?.observation
  const app = observation?.app.data
  const appGroups = useMemo(() => [...(app?.groups ?? [])].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || a.role.localeCompare(b.role)), [app?.groups])
  const runs = observation?.process.data ?? []
  const ranked = useMemo(() => [...runs].sort((a, b) => ((sort === 'cpu' ? b.cpuPercent : b.rssKib) ?? -1) - ((sort === 'cpu' ? a.cpuPercent : a.rssKib) ?? -1) || runKey(a).localeCompare(runKey(b))), [runs, sort])
  const ordered = useMemo(() => {
    if (!lockedOrder) return ranked
    const byKey = new Map(ranked.map(run => [runKey(run), run]))
    return [...lockedOrder.flatMap(key => byKey.has(key) ? [byKey.get(key)!] : []), ...ranked.filter(run => !lockedOrder.includes(runKey(run)))]
  }, [ranked, lockedOrder])
  const activeRun = runs.find(run => runKey(run) === selectedRun) ?? null
  const rows = all ? ordered : ordered.slice(0, 5)
  const visibleKeys = scope === 'runs' ? [...new Set([...rows.map(runKey), ...(selectedRun ? [selectedRun] : [])])] : []
  const keySignature = JSON.stringify(visibleKeys)
  useEffect(() => { onVisibleRunKeysChange?.(JSON.parse(keySignature)) }, [keySignature, onVisibleRunKeysChange])
  const contextFor = (run: RunUsage) => run.hostId === snapshot?.run?.hostId && run.runId === snapshot.run.runId
    ? { label: 'Performance toolkit', context: `Official tool · ${run.hostId}`, state: snapshot.state }
    : contexts[runKey(run)]
  const source = scope === 'app' ? observation?.app : scope === 'runs' ? observation?.process : observation?.runtime
  const state = paused ? 'Paused here' : error ? 'Observation unavailable' : pending ? 'Starting…' : snapshot?.state === 'observing' ? 'Observing' : snapshot?.state === 'starting' ? 'Starting…' : snapshot?.state === 'stopping' ? 'Stopping…' : snapshot?.state === 'paused' ? 'Observation stopped' : snapshot?.state === 'failed' ? 'Observation failed' : snapshot?.state === 'unknown' ? 'Unconfirmed' : 'No observation'
  // 只投影真实 owner 的有界点；自己的暂停断点不能被其他 watcher 的连续观察填上。
  useEffect(() => {
    if (!snapshot) return
    setAppTrend(previous => {
      const incoming = snapshot.trend.slice(-60)
      const numeric = (point: ToolkitSnapshot['trend'][number]) => point.appCpuPercent !== null || point.appRssKib !== null
      if (previous.executionId !== snapshot.executionId) {
        let lastSourceAt: number | null = null
        for (let index = incoming.length - 1; index >= 0; index--) {
          const point = incoming[index]!
          if (numeric(point)) { lastSourceAt = point.observedAt; break }
        }
        return { executionId: snapshot.executionId, lastSourceAt, resumePending: paused, points: incoming }
      }
      if (paused) {
        if (previous.resumePending) return previous
        return { ...previous, resumePending: true, points: previous.points.length ? [...previous.points,
          { observedAt: snapshot.observedAt ?? previous.lastSourceAt ?? 0, appCpuPercent: null, appRssKib: null }].slice(-60) : previous.points }
      }
      const fresh = incoming.filter(point => numeric(point) && (previous.lastSourceAt === null || point.observedAt > previous.lastSourceAt))
      if (previous.resumePending) {
        const latest = fresh.at(-1)
        return latest ? { executionId: snapshot.executionId, lastSourceAt: latest.observedAt, resumePending: false,
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
      return points.length === previous.points.length ? previous : { executionId: snapshot.executionId, lastSourceAt, resumePending: false, points: points.slice(-60) }
    })
  }, [snapshot?.executionId, snapshot?.trend, paused])
  const trend = appTrend.points
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
    const key = JSON.stringify([snapshot?.executionId, selectedRun])
    const gap = paused || scope !== 'runs' || source.state !== 'available' || !activeRun || at == null
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
  }, [observation?.process, observation?.observedAt, activeRun, selectedRun, paused, scope, snapshot?.executionId])
  const selectedTrend = activeRun && runTrend.key === JSON.stringify([snapshot?.executionId, selectedRun]) ? runTrend.points : []
  const renderRuntimeFacts = () => <>
    <SourceNote source={observation?.runtime} />
    {observation?.runtime.data?.length === 0 ? <p className="performance-empty">No connected Runtime</p> : null}
    {observation?.runtime.data?.map(runtime => <section className="performance-runtime" key={runtime.hostId}>
      <div className="performance-section-heading"><strong>ctxmux</strong><span title={runtime.hostId}>{runtime.hostId}</span></div>
      <div className="performance-runtime__overview"><div><small>Retained output</small><strong>{bytes(runtime.resources?.retainedOutputBytes)}</strong></div>
        <div><small>Runs</small><strong>{runtime.resources?.runCount ?? '—'}<em>{runtime.resources ? ` · ${runtime.resources.runningRuns} running` : ''}</em></strong></div></div>
      {runtime.unavailable ? <p className="performance-state" data-tone="warning">{runtime.unavailable}</p> : null}
      <p className="performance-note">CPU / RSS unavailable · {readingTime(runtime.resources?.observedAt ?? observation.runtime.lastSuccessAt, snapshot?.observedAt)}</p>
      <details className="performance-disclosure"><summary>Runtime details <ChevronDown size={12} /></summary><Facts>
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
    <header className="performance-header"><div className="performance-title"><Cpu size={15} /><h2>Performance</h2><span className="performance-official">Official</span></div>
      <button type="button" className="performance-icon-button" aria-label="Close Performance" data-performance-close onClick={close}><X size={14} /></button></header>
    <div className="performance-observation"><span className="performance-status" data-state={paused ? 'paused' : error ? 'failed' : snapshot?.state}><i />{state}</span><span>{readingTime(source?.lastSuccessAt, snapshot?.observedAt)}</span></div>
    <div className="performance-scopes" role="group" aria-label="Resource scope" data-paused={paused}>
      <LiquidSelectionSurface selected={scope} active={!paused} targetAttribute="data-settings-target" />
      {([['app', 'App'], ['runs', 'Runs'], ['runtime', 'Runtime']] as const).map(([id, label]) => <button key={id} type="button" data-settings-target={id} aria-pressed={scope === id} onClick={() => selectScope(id)}>{label}</button>)}
    </div>
    <div className="performance-body">
      {error || snapshot?.reason ? <p className="performance-state" data-tone="warning">{error ?? snapshot?.reason}</p> : null}
      {scope !== 'runtime' ? <>
        {scope === 'app' ? <div className="performance-metrics"><Metric label="CPU" value={cpu(app?.cpuPercent)} hint="10s reading peak" values={trend.map(p => p.appCpuPercent)} color="var(--green)" />
          <Metric label="Resident memory" value={memory(app?.rssKib)} hint="Latest · RSS" values={trend.map(p => p.appRssKib)} color="var(--blue)" /></div>
          : <><div className="performance-run-summary"><Layers size={14} /><span>{activeRun ? (contextFor(activeRun)?.label ?? activeRun.runId) : 'Select a Run to inspect its processes'}</span>
            <small>{runs.length} {runs.length === 1 ? 'Run' : 'Runs'}</small></div>
            {activeRun ? <div className="performance-metrics performance-metrics--run"><Metric label="CPU" value={cpu(activeRun.cpuPercent)} hint="10s reading peak" values={selectedTrend.map(point => point.cpu)} color="var(--green)" />
              <Metric label="Resident memory" value={memory(activeRun.rssKib)} hint="Latest · root + descendants" values={selectedTrend.map(point => point.rss)} color="var(--blue)" /></div> : null}</>}
        <SourceNote source={source} />
        {scope === 'app' && app && app.cpuPercent === null ? <p className="performance-state">CPU warming up · waiting for the second sample</p> : null}
        <div className="performance-section-heading"><strong>{scope === 'app' ? 'Contributors' : 'Run processes'}</strong>
          {scope === 'app' ? <span>{app?.processCount ?? '—'} processes</span> : <div className="performance-sort" role="group" aria-label="Sort contributors">
            <button type="button" aria-pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>CPU</button><button type="button" aria-pressed={sort === 'rss'} onClick={() => setSort('rss')}>RSS</button></div>}</div>
        <div className="performance-table-head"><span>{scope === 'app' ? 'Process' : 'Run'}</span><span>CPU</span><span>RSS</span></div>
        {scope === 'app' ? (all ? appGroups : appGroups.slice(0, 5)).map(group => <div className="performance-role-row" key={group.role}><span>{roleLabel[group.role]}<small>{group.processCount}</small></span><span>{cpu(group.cpuPercent)}</span><span>{memory(group.rssKib)}</span></div>)
          : <div ref={list} className="performance-run-list" onFocusCapture={lock} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !openRuns.current.size) setLockedOrder(null) }}>
            {rows.map(run => <RunRow key={runKey(run)} run={run} context={contextFor(run)} onToggle={toggleRun} />)}</div>}
        {scope === 'runs' && !runs.length ? <p className="performance-empty">{source?.state === 'available' ? 'No observed Runs' : 'Waiting for Run readings'}</p> : null}
        {scope === 'runs' && ranked.length > 5 ? <button type="button" className="performance-show-all" onClick={() => setAll(!all)}>{all ? 'Show top five' : `View all ${ranked.length} Runs`}<ChevronDown size={12} /></button> : null}
        {scope === 'app' && appGroups.length > 5 ? <button type="button" className="performance-show-all" onClick={() => setAll(!all)}>{all ? 'Show top five' : `View all ${appGroups.length} groups`}<ChevronDown size={12} /></button> : null}
        <details className="performance-disclosure"><summary>Resource owners <span>Main & this window</span><ChevronDown size={12} /></summary><Facts>
          <dt>Main reading</dt><dd>{observation?.main.state ?? 'pending'} · {readingTime(observation?.main.lastSuccessAt, snapshot?.observedAt)}{observation?.main.reason ? ` · ${observation.main.reason}` : ''}</dd>
          <dt>Attachment owners / leases</dt><dd>{observation?.main.data ? `${observation.main.data.sessionAttachmentOwners} / ${observation.main.data.sessionAttachmentLeases}` : '—'}</dd>
          <dt>File watchers</dt><dd>{observation?.main.data?.fileWatchers ?? '—'}</dd><dt>Browser views / released</dt><dd>{observation?.main.data ? `${observation.main.data.browserViews} / ${observation.main.data.releasedBrowserViews}` : '—'}</dd>
          <dt>Window reading</dt><dd>{observation?.renderer.state ?? 'pending'} · {readingTime(observation?.renderer.lastSuccessAt, snapshot?.observedAt)}{observation?.renderer.reason ? ` · ${observation.renderer.reason}` : ''}</dd>
          <dt>Terminal views / addons / listeners</dt><dd>{observation?.renderer.data ? `${observation.renderer.data.counts.terminalViews} / ${observation.renderer.data.counts.terminalAddons} / ${observation.renderer.data.counts.terminalListeners}` : '—'}</dd>
          <dt>Editors / models / documents</dt><dd>{observation?.renderer.data ? `${observation.renderer.data.counts.monacoEditors ?? '—'} / ${observation.renderer.data.counts.monacoModels ?? '—'} / ${observation.renderer.data.counts.documents}` : '—'}</dd>
          <dt>Runtime subscriptions</dt><dd>{observation?.renderer.data?.counts.runtimeSubscriptions ?? '—'}</dd>
        </Facts></details>
      </> : renderRuntimeFacts()}
      <details className="performance-disclosure performance-sources"><summary>Observation details <ChevronDown size={12} /></summary><Facts>
        <dt>Host / Main</dt><dd>{observation ? `${observation.scope.hostname} · ${observation.scope.mainPid}` : '—'}</dd>
        <dt>Execution</dt><dd>{snapshot?.executionId ?? '—'}</dd><dt>Source state</dt><dd>{source?.state ?? 'pending'}</dd>
        <dt>Observed</dt><dd>{readingTime(source?.observedAt, snapshot?.observedAt)}</dd><dt>CPU · App / Run</dt><dd>Interval average / ps average · 10s reading peak</dd>
        <dt>Run RSS</dt><dd>Root + attributed descendants; shared pages may count in multiple processes.</dd>
      </Facts></details>
    </div>
    <footer className="performance-actions"><button type="button" onClick={onViewScript}><Code2 size={13} />View script</button>
      {onPause ? <button type="button" data-performance-observation-toggle onClick={onPause}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? 'Resume' : 'Pause'}</button> : null}
      <button type="button" onClick={onConfigure}><Settings2 size={13} />Configure</button></footer>
  </>
}
