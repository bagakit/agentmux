import { memo, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseRendererCacheResult, sameRendererV8ProfileTarget, type RendererCacheResult, type RendererCacheSnapshot, type RendererV8ProfileTarget } from '@agentmux/core/control'
import type { ToolkitMetricsSnapshot } from '../../../../shared/toolkit'
import { api } from '../../lib/api'
import { useBrowserDirectory } from '../../lib/use-browser-directory'
import { BrowserResources } from '../browser/BrowserResources'
import { currentPerformanceCaptureTarget } from './PerformanceCapture'
import { performanceBytes as bytes, performanceMemory as memory, performanceReadingTime as readingTime } from './performance-format'

type Cleanup = { kind: 'receipt'; result: RendererCacheResult } | { kind: 'unconfirmed'; target: RendererV8ProfileTarget; message: string }
function cacheSize(snapshot: RendererCacheSnapshot | null) {
  if (!snapshot) return null
  const entries = Object.values(snapshot.usage)
  return entries.every(entry => entry?.sizeBytes != null) ? entries.reduce((total, entry) => total + entry!.sizeBytes!, 0) : null
}

/** One cache read per visible entry and target; cleanup remains an explicit action. */
export const PerformanceReclaim = memo(function PerformanceReclaim({ snapshot, active, onInspectResources }: {
  snapshot: ToolkitMetricsSnapshot | null; active: boolean; onInspectResources(): void
}) {
  const directory = useBrowserDirectory(active)
  const [reading, setReading] = useState<RendererCacheResult | null>(null)
  const [cleanup, setCleanup] = useState<Cleanup | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [pending, setPending] = useState<'inspect' | 'reclaim' | null>(null)
  const working = useRef(false), mounted = useRef(true), inspected = useRef<string | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const target = currentPerformanceCaptureTarget(snapshot?.observation), targetKey = JSON.stringify(target)
  useEffect(() => {
    if (!active) { inspected.current = null; return }
    if (!target || pending !== null || inspected.current === targetKey) return
    void run('inspect')
  }, [active, targetKey, pending])

  async function run(action: 'inspect' | 'reclaim') {
    if (!active || !target || working.current) return
    const input = { target: { ...target } }
    // Mark only a dispatched read. A new entry/target waiting for an older request
    // is serviced by the effect when that original request settles.
    working.current = true; inspected.current = targetKey; setPending(action)
    if (action === 'inspect') setReadError(null)
    try {
      const receipt = parseRendererCacheResult(await (action === 'reclaim' ? api.performance.reclaimCache(input) : api.performance.inspectCache(input)), input, action)
      if (mounted.current) {
        setReading(receipt); setReadError(null)
        if (action === 'reclaim') setCleanup({ kind: 'receipt', result: receipt })
      }
    } catch (error) {
      if (mounted.current) {
        if (action === 'reclaim') setCleanup({ kind: 'unconfirmed', target: input.target, message: presentError(error) })
        else setReadError(presentError(error))
      }
    } finally { working.current = false; if (mounted.current) setPending(null) }
  }

  const current = reading && target && sameRendererV8ProfileTarget(reading.target, target) && reading.sourceVerified.after ? reading : null
  const observed = current ? current.action === 'reclaim' ? current.after : current.before : null
  const result = cleanup?.kind === 'receipt' ? cleanup.result : null
  const cleanupTarget = cleanup?.kind === 'unconfirmed' ? cleanup.target : result?.target
  const previous = cleanupTarget && (!target || !sameRendererV8ProfileTarget(cleanupTarget, target))
  const before = cacheSize(result?.before ?? null), after = cacheSize(result?.after ?? null)
  const delta = result?.status === 'completed' && before !== null && after !== null ? after - before : null
  const status = cleanup?.kind === 'unconfirmed' ? 'unknown' : result?.status
  const issues = [...new Set([readError, cleanup?.kind === 'unconfirmed' ? cleanup.message : null,
    ...reading?.issues.map(issue => issue.message) ?? [], ...result?.issues.map(issue => issue.message) ?? []].filter((value): value is string => Boolean(value)))]
  const runRss = snapshot?.observation?.runTotals?.rssKib

  return <div className="performance-reclaim" data-performance-reclaim>
    <div className="performance-page-heading"><h3>Reclaim memory</h3></div>
    <section className="performance-reclaim-cache" aria-label="Lossless cache cleanup">
      <div className="performance-reclaim-heading"><h4>Rebuildable cache</h4><span className="performance-reclaim-preserved">Keeps your work</span></div>
      <div className="performance-reclaim-primary"><div><strong data-cache-size>{bytes(cacheSize(observed))}</strong>
        <small>{pending === 'inspect' ? 'Reading cache…' : !target ? 'Waiting for this Renderer' : readError || !observed ? 'Reading unavailable' : `Observed cache · ${readingTime(observed.sampledAt, snapshot?.observedAt)}`}</small></div>
        <button type="button" className="performance-inline-action" data-clean-cache disabled={!active || !target || pending !== null} onClick={() => void run('reclaim')}>{pending === 'reclaim' ? 'Cleaning…' : 'Clean caches'}</button></div>
      <div className="performance-reclaim-inspect"><span>Release amount varies; caches rebuild on use.</span>
        <button type="button" className="performance-inline-action" aria-label="Refresh cache reading" disabled={!active || !target || pending !== null} onClick={() => void run('inspect')}>Refresh</button></div>
      {cleanup ? <div className="performance-reclaim-result" role="status" data-cache-result={status}>
        <div className="performance-reclaim-heading"><span>{previous ? 'Previous Renderer cleanup' : 'Last cleanup'}</span><strong>{status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : 'Unconfirmed'}</strong></div>
        <dl className="performance-reclaim-counters"><div><dt>Before</dt><dd>{bytes(before)}</dd></div><div><dt>After</dt><dd>{bytes(after)}</dd></div>
          <div><dt>Cache change</dt><dd data-cache-change>{delta === null ? '—' : delta === 0 ? 'Unchanged' : `${delta > 0 ? '+' : '−'}${bytes(Math.abs(delta))}`}</dd></div></dl>
      </div> : null}
      <details className="performance-reclaim-details"><summary>{issues.length ? 'Details · needs attention' : 'What is cleared?'}</summary>
        <p>Platform caches in this Renderer process. Documents, drafts, reading positions and running Agents stay. Website data is untouched.</p>
        <p>Cleanup may pause briefly. These resource counters and their change are not RSS or guaranteed memory savings. Missing readings stay unknown; an unconfirmed cleanup is never automatically retried.</p>
        <p>{target ? `Current PID ${target.pid} · generation ${target.generation}` : 'Current Renderer identity unavailable.'}{cleanupTarget ? ` · Last cleanup PID ${cleanupTarget.pid}, generation ${cleanupTarget.generation}` : ''}</p>
        {issues.map(message => <p key={message}>{message}</p>)}
      </details>
    </section>
    <section className="performance-reclaim-pages" aria-label="Potentially lossy page release">
      <div className="performance-reclaim-heading"><h4>Browser pages</h4><span className="performance-reclaim-risk">Reloads on use</span></div>
      <p>Forms and temporary page state may be lost.</p>
      <BrowserResources active={active} directory={directory} app={snapshot?.observation?.app} />
    </section>
    <div className="performance-reclaim-agents"><div><strong>Agents &amp; terminal history</strong><small>{runRss == null ? 'Inspect original resource owners' : `${memory(runRss)} · observed Run processes`}</small></div>
      <button type="button" className="performance-inline-action" onClick={onInspectResources}>Review →</button></div>
  </div>
}, (previous, next) => !previous.active && !next.active)
