import { memo, useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { parseRendererCacheResult, type RendererCacheResult, type RendererCacheSnapshot } from '@agentmux/core/control'
import type { ToolkitMetricsSnapshot } from '../../../../shared/toolkit'
import { api } from '../../lib/api'
import { useBrowserDirectory } from '../../lib/use-browser-directory'
import { BrowserResources } from '../browser/BrowserResources'
import { currentPerformanceCaptureTarget } from './PerformanceCapture'
import { performanceBytes as bytes, performanceMemory as memory } from './performance-format'

function cacheSize(snapshot: RendererCacheSnapshot | null) {
  if (!snapshot) return null
  const entries = Object.values(snapshot.usage)
  return entries.every(entry => entry?.sizeBytes != null) ? entries.reduce((total, entry) => total + entry!.sizeBytes!, 0) : null
}

/** Reuses the original metrics snapshot; only the visible directory has a reader. */
export const PerformanceReclaim = memo(function PerformanceReclaim({ snapshot, active, onInspectResources }: {
  snapshot: ToolkitMetricsSnapshot | null; active: boolean; onInspectResources(): void
}) {
  const directory = useBrowserDirectory(active)
  const [result, setResult] = useState<RendererCacheResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState<'inspect' | 'reclaim' | null>(null)
  const working = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const target = currentPerformanceCaptureTarget(snapshot?.observation)
  const changed = result !== null && JSON.stringify(result.target) !== JSON.stringify(target)

  async function run(action: 'inspect' | 'reclaim') {
    if (!target || working.current) return
    const input = { target: { ...target } }
    working.current = true; setPending(action); setFailure(null)
    try {
      const receipt = parseRendererCacheResult(await (action === 'reclaim' ? api.performance.reclaimCache(input) : api.performance.inspectCache(input)), input, action)
      if (mounted.current) setResult(receipt)
    } catch (error) {
      if (mounted.current) setFailure(`${action === 'reclaim' ? 'Cleanup outcome unconfirmed. It was not retried.' : 'Cache reading unavailable.'} ${presentError(error)}`)
    } finally { working.current = false; if (mounted.current) setPending(null) }
  }

  return <div className="performance-reclaim" data-performance-reclaim>
    <div className="performance-page-heading"><h3>Reclaim memory</h3><p>Keep your work. Choose what can be rebuilt and what may need to reload.</p></div>
    <section className="performance-reclaim-cache" aria-label="Lossless cache cleanup">
      <div className="performance-reclaim-heading"><div><span className="performance-reclaim-eyebrow">Keeps your work</span><h4>Rebuildable caches</h4></div>
        <button type="button" className="performance-inline-action" data-clean-cache disabled={!active || !target || pending !== null} onClick={() => void run('reclaim')}>{pending === 'reclaim' ? 'Cleaning…' : 'Clean caches'}</button></div>
      <p>Releases platform caches in this Renderer process. Pages, drafts, reading positions and running Agents stay.</p>
      <p className="performance-note">May briefly pause and rebuild caches on use. This does not clear website data or guarantee lower RSS.</p>
      <div className="performance-reclaim-inspect"><span>{target ? `Renderer · PID ${target.pid}` : 'Current Renderer identity unavailable. Observation must confirm the original process.'}</span>
        <button type="button" className="performance-inline-action" disabled={!active || !target || pending !== null} onClick={() => void run('inspect')}>{pending === 'inspect' ? 'Reading…' : 'Inspect cache'}</button></div>
      {failure ? <p role="status" className="performance-state" data-tone="warning">{failure}{result ? ' Previous receipt kept below.' : ''}</p> : null}
      {result ? <div className="performance-reclaim-result" role="status" data-cache-result={result.status}>
        <strong>{changed ? 'Previous Renderer · ' : ''}{result.action === 'inspect' ? 'Cache observation' : result.status === 'completed' ? 'Cleanup completed' : result.status === 'failed' ? 'Cleanup failed' : 'Cleanup outcome unconfirmed'}</strong>
        <div className="performance-reclaim-counters"><span>{result.action === 'inspect' ? 'Observed cache' : 'Before'}<b>{bytes(cacheSize(result.before))}</b></span>
          {result.action === 'reclaim' ? <><span aria-hidden="true">→</span><span>After<b>{bytes(cacheSize(result.after))}</b></span></> : null}</div>
        <small>Platform resource counters, not process memory or measured savings.{result.clear.completed && result.status !== 'completed' ? ' Native cleanup returned; final source verification is incomplete.' : ''}</small>
        {result.issues.map((issue, index) => <p className="performance-note" key={index}>{issue.message}</p>)}
        {changed ? <p className="performance-note">This receipt belongs to PID {result.target.pid}, generation {result.target.generation}. It is not a reading of the current target.</p> : null}
      </div> : null}
    </section>
    <section className="performance-reclaim-pages" aria-label="Potentially lossy page release">
      <div className="performance-reclaim-heading"><div><span className="performance-reclaim-eyebrow" data-risk>May lose page state</span><h4>Pages you can reload</h4></div></div>
      <p>Review and select pages below. Releasing a page keeps its place, but forms and temporary page state may be lost. Protected pages stay in use.</p>
      <BrowserResources active={active} directory={directory} app={snapshot?.observation?.app} />
    </section>
    <div className="performance-reclaim-agents"><div><strong>Agents &amp; terminal history</strong><p>{snapshot?.observation?.runTotals ? `${memory(snapshot.observation.runTotals.rssKib)} across observed Run processes. ` : ''}Quiet Agents can still hold useful state. Review their owners before deciding what to end.</p></div>
      <button type="button" className="performance-inline-action" onClick={onInspectResources}>Review processes →</button></div>
  </div>
}, (previous, next) => !previous.active && !next.active)
