import { useEffect, useRef, useState } from 'react'
import type { AgentMuxBrowserTarget } from '@agentmux/core'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import type { MetricsObservation } from '@agentmux/core/control'
import type { useBrowserDirectory } from '../../lib/use-browser-directory'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { browserProcessReadings, eligibleForRelease, memory, pageAddress, pageName, processKey, retentionReason, stateLabel, type BrowserDirectoryRow } from '../../lib/browser-resource-view'
import '../../styles/browser-resources.css'

type DirectoryRow = BrowserDirectoryRow


type ActionResult = { target: AgentMuxBrowserTarget; kind: 'release' | 'restore'; navigationId?: string; status: string; detail: string }
const BrowserIcon = semanticIconComponent('object.browser')
const RefreshIcon = semanticIconComponent('action.refresh')
const resultLabel = (result: ActionResult) => result.status === 'released' ? 'Released' : result.status === 'retained' ? 'Kept'
  : result.status === 'ready' ? 'Restored' : 'Unconfirmed'

export function BrowserResources({ active, directory, app, observationError }: {
  active: boolean
  app: MetricsObservation['app'] | undefined
  observationError?: string | null
  directory: ReturnType<typeof useBrowserDirectory>
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<ReadonlyMap<string, DirectoryRow>>(new Map())
  const [order, setOrder] = useState<{ by: 'page' | 'memory'; ids: string[] } | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [results, setResults] = useState<ReadonlyMap<string, ActionResult>>(new Map())
  const working = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const workspaces = useAppStore(state => state.config?.workspaces)
  const embedded = directory.rows.filter(row => row.target.source === 'embedded')
  const readings = browserProcessReadings(embedded, app?.data?.processes ?? [])
  const rank = new Map(order?.ids.map((id, index) => [id, index]))
  const shown = embedded.filter(({ target }) => (filter === 'all' || (target.resource?.state ?? 'unknown') === filter) &&
    `${target.title} ${target.url} ${target.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => (rank.get(a.target.id) ?? Infinity) - (rank.get(b.target.id) ?? Infinity))
  const selectable = shown.filter(eligibleForRelease)
  const allSelected = selectable.length > 0 && selectable.every(row => selected.has(row.target.id))
  const selectedRows = [...selected.values()]
  const positions = (row: DirectoryRow) => row.previousLocations ?? row.target.resource?.locations ?? []
  const workspaceName = (id: string | null) => workspaces?.find(workspace => workspace.id === id)?.name || id || 'Workspace unconfirmed'

  function toggle(row: DirectoryRow) {
    setSelected(previous => {
      const next = new Map(previous)
      if (next.has(row.target.id)) next.delete(row.target.id)
      else next.set(row.target.id, structuredClone(row))
      return next
    })
  }
  function sort(by: 'page' | 'memory') {
    const rows = [...embedded].sort((a, b) => by === 'page' ? pageName(a.target).localeCompare(pageName(b.target)) || a.target.id.localeCompare(b.target.id)
      : (readings.row(b).kib ?? -1) - (readings.row(a).kib ?? -1) || a.target.id.localeCompare(b.target.id))
    // Explicit sort cuts one display order. Later measurements never move a button under the pointer.
    setOrder({ by, ids: rows.map(row => row.target.id) })
  }

  async function perform(rows: readonly DirectoryRow[], kind: 'release' | 'restore') {
    if (working.current || !rows.length) return
    const batch = structuredClone(rows)
    working.current = true
    setBusy(new Set(batch.map(row => row.target.id)))
    try {
      for (const { target } of batch) {
        directory.invalidate(target.id)
        let result: ActionResult
        try {
          if (kind === 'restore') {
            const restored = await api.browser.restoreResource(target.id)
            if (restored.id !== target.id || restored.source !== 'embedded' || restored.status !== 'ready' || !restored.navigationId) {
              throw new Error('Restoration did not confirm this original page. Keep its identity and inspect before another action.')
            }
            result = { target, kind, navigationId: restored.navigationId, status: 'ready', detail: 'Original native page ready. Page loading is observed separately.' }
          } else {
            const receipt = await api.browser.release(target.id, target.navigationId!)
            if (receipt.browserId !== target.id || receipt.navigationId !== target.navigationId || !['released', 'retained', 'unknown'].includes(receipt.status)) {
              throw new Error('Release did not confirm this original document. Keep its identity and inspect before another action.')
            }
            result = { target, kind, navigationId: receipt.navigationId, status: receipt.status,
              detail: receipt.reasons.map(retentionReason).join(' · ') || (receipt.status === 'released' ? 'Native page released; original identity kept.'
                : receipt.status === 'retained' ? 'Release not applied; original identity kept.' : 'Release outcome unconfirmed; original identity kept.') }
          }
        } catch (error) {
          result = { target, kind, ...(target.navigationId ? { navigationId: target.navigationId } : {}), status: 'unknown', detail: presentError(error) }
        }
        if (mounted.current) setResults(previous => new Map(previous).set(target.id, result))
      }
    } finally { working.current = false; if (mounted.current) setBusy(new Set()) }
  }

  return <section className="settings-group browser-resources" data-settings-field="browser-resources">
    <header><span>Browser resources</span><small>Page actions apply immediately</small></header>
    <div className="browser-resources__overview">
      <div><span>Pages observed</span><strong>{embedded.filter(row => row.current).length}</strong><small>{embedded.filter(row => !row.current).length} previous entries retained</small></div>
      <div data-browser-process-total><span>Memory in use</span><strong>{readings.measured.length ? `${readings.counts.size > readings.measured.length ? '≥ ' : ''}${memory(readings.totalKib)}` : '—'}</strong>
        <small>{readings.measured.length ? `${readings.measured.length} unique processes` : 'Reading not confirmed'}</small></div>
    </div>
    <details className="browser-resources__measurement"><summary>About these readings</summary><p>Observed process working set, shared pages counted once.
        {readings.counts.size > readings.measured.length ? ` ${readings.counts.size - readings.measured.length} unmatched process identities.` : ''}
        {app && app.state !== 'available' ? ` ${app.state} reading.` : ''}
        {app?.lastSuccessAt != null ? ` Read at ${new Date(app.lastSuccessAt).toLocaleTimeString()}.` : ''}</p></details>
    <div className="browser-resources__controls">
      <TextInput aria-label="Find Browser resources" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a page…" />
      <select aria-label="Browser resource state" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All states</option><option value="live">Running</option><option value="released">Released</option><option value="cold">Not loaded</option><option value="unknown">Unknown</option></select>
      <button className="small-button" disabled={!active || directory.pending} onClick={() => void directory.refresh()}><RefreshIcon size={13} />{directory.pending ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    {selected.size ? <div className="browser-resources__selection" role="group" aria-label="Selected Browser resources">
      <span>{selected.size} selected{selected.size !== shown.filter(row => selected.has(row.target.id)).length ? ' · includes pages outside this filter' : ''}</span>
      <button className="small-button" disabled={!active || busy.size > 0} onClick={() => void perform(selectedRows, 'release')}>Release selected ({selected.size})</button>
      <button className="browser-resources__text-button" disabled={busy.size > 0} onClick={() => setSelected(new Map())}>Clear selection</button>
    </div> : null}
    {directory.notice || observationError ? <div className="browser-resources__notices">
      <div role="status"><strong>{directory.notice ? 'Page directory needs attention' : 'Memory reading unavailable'}</strong><p>Refresh to check again. Previous entries are kept.</p></div>
      <details><summary>Observation details</summary>
        {directory.notice ? <p className="browser-resources__notice">{directory.notice}</p> : null}
        {observationError ? <p className="browser-resources__notice">Process observation unavailable: {observationError}</p> : null}
      </details>
    </div> : null}
    {!embedded.length ? <p className="settings-group-note">{directory.pending ? 'Checking open pages…' : 'No Browser pages observed. Refresh to check for pages in AgentMux.'}</p> : !shown.length ? <p className="settings-group-note">No pages match this filter.</p> : <>
      <div className="browser-resources__columns" aria-hidden="false">
        <input type="checkbox" aria-label="Select eligible pages in this filter" checked={allSelected} disabled={!active || !selectable.length || busy.size > 0}
          ref={input => { if (input) input.indeterminate = !allSelected && selectable.some(row => selected.has(row.target.id)) }}
          onChange={() => setSelected(previous => {
            const next = new Map(previous)
            for (const row of selectable) if (allSelected) next.delete(row.target.id); else next.set(row.target.id, structuredClone(row))
            return next
          })} />
        <button type="button" aria-pressed={order?.by === 'page'} onClick={() => sort('page')}>Page</button>
        <span>State</span><button type="button" aria-pressed={order?.by === 'memory'} onClick={() => sort('memory')}>Process memory{order?.by === 'memory' ? ' ↓' : ''}</button><span>Action</span>
      </div>
      <ul className="browser-resources__list">{shown.map(row => {
        const { target } = row, resource = target.resource, result = results.get(target.id), reading = readings.row(row)
        const locations = positions(row), names = [...new Set(locations.map(location => workspaceName(location.workspaceId)))]
        const kept = resource?.retention?.reasons ?? []
        const previousResult = result?.navigationId !== undefined && target.navigationId !== undefined && target.navigationId !== result.navigationId
        return <li key={target.id} data-browser-resource={target.id} data-selected={selected.has(target.id) || undefined}>
          <div className="browser-resources__row">
            <input type="checkbox" aria-label={`Select ${pageName(target)} for release`} checked={selected.has(target.id)}
              disabled={!active || busy.size > 0 || !selected.has(target.id) && !eligibleForRelease(row)} onChange={() => toggle(row)} />
            <div className="browser-resources__identity"><BrowserIcon size={16} /><div><strong title={pageName(target)}>{pageName(target)}</strong>
              <small title={target.url}>{pageAddress(target.url)}{target.mode === 'private' ? ' · Private' : ''}{names.length ? ` · ${names.length === 1 ? names[0] : `${names.length} workspaces`}` : ''}</small></div></div>
            <div className="browser-resources__state"><span>{row.current ? stateLabel(resource?.state) : 'Previously observed'}</span>
              <small>{!row.current ? 'Refresh for current facts' : kept.length ? retentionReason(kept[0]!) : resource?.retention?.status === 'eligible' ? 'Can release' : resource?.state === 'released' || resource?.state === 'cold' ? 'Reload on use' : 'Protection unconfirmed'}</small></div>
            <div className="browser-resources__memory"><strong>{reading.kib === null ? '—' : `${reading.incomplete ? '≥ ' : ''}${memory(reading.kib)}`}</strong>
              <small>{!row.current ? 'Previous ownership' : reading.shared ? 'Shared process' : reading.incomplete ? 'Reading incomplete' : reading.kib === null ? 'No native reading' : `${reading.keys.length} ${reading.keys.length === 1 ? 'process' : 'processes'}`}</small></div>
            <div className="browser-resources__actions">{resource?.state === 'released' || resource?.state === 'cold'
              ? <button className="small-button" disabled={!active || busy.size > 0} onClick={() => void perform([row], 'restore')}>{busy.has(target.id) ? 'Restoring…' : 'Restore'}</button>
              : <button className="small-button" disabled={!active || busy.size > 0 || !target.navigationId} onClick={() => void perform([row], 'release')}>{busy.has(target.id) ? 'Releasing…' : 'Release memory'}</button>}</div>
          </div>
          {result ? <p className="browser-resources__result" role="status" data-result={result.status}><strong>{previousResult ? 'Previous document · ' : ''}{resultLabel(result)}</strong> · {result.detail}</p> : null}
          <details className="browser-resources__details"><summary>Details<span>{locations.length ? `${locations.length} ${locations.length === 1 ? 'position' : 'positions'}` : 'Position unconfirmed'}</span></summary>
            <dl><dt>Address</dt><dd>{target.url || 'Unconfirmed'}</dd><dt>Browser</dt><dd><code>{target.id}</code>{target.navigationId ? <> · document <code>{target.navigationId}</code></> : null}</dd>
              <dt>{row.previousLocations || !row.current ? 'Previous positions' : 'Positions'}</dt><dd>{locations.length ? locations.map(location => <div key={`${location.workspaceId}:${location.tabId}:${location.regionId}`}>{workspaceName(location.workspaceId)} · Tab <code>{location.tabId}</code> · Region <code>{location.regionId}</code></div>) : 'Unconfirmed'}</dd>
              <dt>Protection</dt><dd>{kept.length ? kept.map(retentionReason).join(' · ') : resource?.retention?.status === 'eligible' ? 'Eligible when last observed; Main checks again before release.' : 'No confirmed protection reading.'}</dd>
              <dt>Processes</dt><dd>{!row.current ? 'Previous resource facts. Refresh for current process ownership.' : resource?.processes == null ? 'Process ownership unconfirmed' : !resource.processes.length ? 'No owned native processes observed.' : resource.processes.map(process => {
                const key = processKey(process), sample = readings.samples.get(key)
                return <div key={key}>PID {process.pid} · born {process.creationTime} · {sample ? `${memory(sample.rssKib)} process working set${sample.cpuPercent === null ? '' : ` · ${sample.cpuPercent.toFixed(1)}% CPU / ${sample.intervalMs ?? 'unknown'}ms`}` : 'No matching process reading'}{(readings.counts.get(key) ?? 0) > 1 ? ' · shared' : ''}{sample && app?.state !== 'available' ? ` · ${app?.state ?? 'unknown'} reading` : ''}</div>
              })}</dd></dl>
            {target.warning ? <p>{target.warning}</p> : null}
          </details>
        </li>
      })}</ul>
    </>}
    {results.size ? <details className="browser-resources__batch-results"><summary>Recent actions · {[...results.values()].filter(result => result.status === 'released' || result.status === 'ready').length} applied · {[...results.values()].filter(result => result.status === 'retained').length} kept · {[...results.values()].filter(result => result.status === 'unknown').length} unconfirmed</summary>
      <ul>{[...results.values()].map(result => <li key={result.target.id}><strong>{pageName(result.target)} · {resultLabel(result)}</strong><span>{result.detail}</span></li>)}</ul></details> : null}
    <details className="browser-resources__help"><summary>What does releasing a page keep?</summary><p>Browser, Region, Profile and viewport stay. Using the page reloads it; forms and arbitrary page state are not restored. Shared processes may stay in use. Closing pages and clearing website data are separate actions; external shared tabs stay managed by their browser.</p>
      {app?.data?.omittedProcesses ? <p>{app.data.omittedProcesses} App processes omitted from this reading.</p> : null}</details>
  </section>
}
