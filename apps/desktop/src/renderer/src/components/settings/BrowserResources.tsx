import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxBrowserResource, AgentMuxBrowserTarget } from '@agentmux/core'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { useAppStore } from '../../store'
import { usePerformanceObservation } from '../../lib/use-performance-observation'

type Locations = AgentMuxBrowserResource['locations']
type DirectoryRow = { target: AgentMuxBrowserTarget; current: boolean; previousLocations?: Locations }

/** One visible Settings reader; retained rows are observations, never another Browser owner. */
export function useBrowserDirectory(active: boolean) {
  const [rows, setRows] = useState<DirectoryRow[]>([])
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const observation = useRef<{ active: boolean; reading: boolean; reread: boolean; revision: number } | null>(null)
  const refresh = useCallback(async () => {
    const owner = observation.current
    if (!owner?.active) return
    if (owner.reading) { owner.reread = true; setPending(true); return }
    owner.reading = true
    setPending(true)
    try {
      do {
        owner.reread = false
        const issued = ++owner.revision
        try {
          const result = await api.browser.listTargets()
          if (!owner.active || observation.current !== owner) return
          if (issued !== owner.revision) continue
          setRows(previous => {
            const old = new Map(previous.map(row => [row.target.id, row]))
            const next = result.coverage === 'partial'
              ? new Map(previous.map(row => [row.target.id, { ...row, current: false }])) : new Map<string, DirectoryRow>()
            for (const target of result.targets) {
              const before = old.get(target.id)
              const locations = before?.target.resource?.locations
              // A partial native row with no positions cannot prove the saved bindings disappeared.
              const previousLocations = result.coverage === 'partial' && !target.resource?.locations.length
                ? locations?.length ? locations : before?.previousLocations : undefined
              next.set(target.id, { target, current: true, ...(previousLocations?.length ? { previousLocations } : {}) })
            }
            return [...next.values()]
          })
          setNotice(result.coverage === 'partial'
            ? [result.warning, 'This query is partial. Pages not observed here keep their last known entry.'].filter(Boolean).join(' ')
            : result.warning ?? '')
        } catch (error) {
          if (!owner.active || observation.current !== owner) return
          if (issued !== owner.revision) continue
          setRows(previous => previous.map(row => ({ ...row, current: false })))
          setNotice(`Refresh failed. Existing pages are kept. ${presentError(error)}`)
        }
      } while (owner.active && observation.current === owner && owner.reread)
    } finally {
      owner.reading = false
      if (owner.active && observation.current === owner) setPending(false)
    }
  }, [])
  useEffect(() => {
    if (!active) { setRows(previous => previous.map(row => ({ ...row, current: false }))); setPending(false); return }
    const owner = { active: true, reading: false, reread: false, revision: 0 }
    observation.current = owner
    const release = api.browser.onTargetsChanged(() => { void refresh() })
    void refresh()
    return () => { owner.active = false; owner.reread = false; observation.current = null; release() }
  }, [active, refresh])
  const invalidate = useCallback((id: string) => {
    if (observation.current) observation.current.revision++
    setRows(previous => previous.map(row => row.target.id === id ? { ...row, current: false } : row))
  }, [])
  const observedIds = useMemo(() => new Set(rows.filter(row => row.current).map(row => row.target.id)), [rows])
  return { rows, observedIds, pending, notice, refresh, invalidate }
}

type ActionResult = { kind: 'release' | 'restore'; navigationId?: string; status: string; detail: string }
const memory = (kib: number) => kib >= 1048576 ? `${(kib / 1048576).toFixed(2)} GiB` : `${Math.round(kib / 1024)} MiB`
const processKey = (process: { pid: number; creationTime: number }) => `${process.pid}:${process.creationTime}`
const stateLabel = (state: AgentMuxBrowserResource['state'] | undefined) => state === 'live' ? 'Running' : state === 'released' ? 'Released' : state === 'cold' ? 'Not loaded' : 'Unknown'

export function BrowserResources({ active, directory, automatic, onAutomaticChange }: {
  active: boolean
  directory: ReturnType<typeof useBrowserDirectory>
  automatic: boolean
  onAutomaticChange(enabled: boolean): void
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [results, setResults] = useState<ReadonlyMap<string, ActionResult>>(new Map())
  const working = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const workspaces = useAppStore(state => state.config?.workspaces)
  const observation = usePerformanceObservation(api.toolkit, active)
  const app = observation.snapshot?.observation?.app
  const samples = useMemo(() => new Map((app?.data?.processes ?? []).map(process => [processKey(process), process])), [app?.data])
  const embedded = directory.rows.filter(row => row.target.source === 'embedded')
  const counts = new Map<string, number>()
  for (const row of embedded) if (row.current) for (const process of row.target.resource?.processes ?? []) {
    const key = processKey(process); counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const measured = [...counts.keys()].map(key => samples.get(key)).filter(process => process !== undefined)
  const total = measured.reduce((sum, process) => sum + process.rssKib, 0)
  const shown = embedded.filter(({ target }) => (filter === 'all' || target.resource?.state === filter) &&
    `${target.title} ${target.url} ${target.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const canRequestRelease = (target: AgentMuxBrowserTarget) => Boolean(target.navigationId)
  const eligible = (row: DirectoryRow) => row.current && row.target.resource?.state === 'live' &&
    row.target.resource.retention?.status === 'eligible' && canRequestRelease(row.target)
  const releasable = shown.filter(eligible)

  async function perform(rows: readonly DirectoryRow[], kind: 'release' | 'restore') {
    if (working.current) return
    working.current = true
    setBusy(new Set(rows.map(row => row.target.id)))
    try {
      // A finite user-selected batch; every original Main call rechecks its own current owner.
      for (const { target } of rows) {
        directory.invalidate(target.id)
        let result: ActionResult
        try {
          if (kind === 'restore') {
            const restored = await api.browser.restoreResource(target.id)
            if (restored.id !== target.id || restored.source !== 'embedded' || restored.status !== 'ready' || !restored.navigationId) {
              throw new Error('Restoration did not confirm this original page. Keep its identity and inspect the directory before another action.')
            }
            result = { kind, navigationId: restored.navigationId, status: 'ready', detail: 'Original native page ready. Page loading and resource facts are observed separately.' }
          } else {
            const receipt = await api.browser.release(target.id, target.navigationId!)
            if (receipt.browserId !== target.id || receipt.navigationId !== target.navigationId || !['released', 'retained', 'unknown'].includes(receipt.status)) {
              throw new Error('Release did not confirm this original document. Keep its identity and inspect before another action.')
            }
            result = { kind, navigationId: receipt.navigationId, status: receipt.status,
              detail: receipt.reasons.join(', ') || (receipt.status === 'released' ? 'Native page released; original identity kept.'
                : receipt.status === 'retained' ? 'Release not applied; original identity kept.' : 'Release outcome unconfirmed; original identity kept.') }
          }
        } catch (error) {
          result = { kind, ...(target.navigationId ? { navigationId: target.navigationId } : {}), status: 'unknown', detail: presentError(error) }
        }
        if (mounted.current) setResults(previous => new Map(previous).set(target.id, result))
      }
    } finally { working.current = false; if (mounted.current) setBusy(new Set()) }
  }

  return <section className="settings-group browser-resources" data-settings-field="browser-resources">
    <header><span>Browser resources</span><small>{embedded.filter(row => row.current).length} observed · {embedded.filter(row => !row.current).length} previous</small></header>
    <p className="settings-group-note">Release memory keeps Browser, Region, Profile and viewport. Using the page again reloads it; arbitrary forms and page state are not restored. Pages in use or with unconfirmed protection stay available.</p>
    <label className="browser-automation-toggle"><input type="checkbox" checked={automatic} onChange={event => onAutomaticChange(event.target.checked)} />
      <span><strong>Automatically release safe idle pages</strong><small>Keep recently used pages warm. Active or unconfirmed pages are retained.</small></span></label>
    <div className="browser-resources__controls">
      <TextInput aria-label="Find Browser resources" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a page" />
      <select aria-label="Browser resource state" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All states</option><option value="live">Running</option><option value="released">Released</option><option value="cold">Not loaded</option><option value="unknown">Unknown</option></select>
      <button className="small-button" disabled={!active || directory.pending} onClick={() => void directory.refresh()}>{directory.pending ? 'Refreshing…' : 'Refresh'}</button>
      <button className="small-button" disabled={!active || !releasable.length || busy.size > 0} onClick={() => void perform(releasable, 'release')}>Release shown eligible ({releasable.length})</button>
    </div>
    <p className="settings-group-note" data-browser-process-total>{measured.length ? `${memory(total)} in ${measured.length} matched unique processes` : 'No matching process reading'} · observed pages only. Shared processes count once; Electron working set is process memory, not page memory.
      {counts.size > measured.length ? ` ${counts.size - measured.length} process identities have no matching sample.` : ''}
      {app ? ` Reading ${app.state}${app.lastSuccessAt === null ? '' : ` at ${new Date(app.lastSuccessAt).toLocaleTimeString()}`}.` : ' Waiting for process readings.'}
      {app?.data?.omittedProcesses ? ` ${app.data.omittedProcesses} App processes omitted from this reading.` : ''}</p>
    {directory.notice ? <p className="settings-group-note" role="status">{directory.notice}</p> : null}
    {observation.error ? <p className="settings-group-note" role="status">Process observation unavailable: {observation.error}</p> : null}
    {!embedded.length ? <p className="settings-group-note">{directory.pending ? 'Reading Browser owners…' : 'No embedded Browser pages observed. Refresh to inspect the current directory.'}</p> : !shown.length ? <p className="settings-group-note">No pages match this filter.</p> :
      <ul className="browser-resources__list">{shown.map(row => {
        const { target } = row, resource = target.resource, result = results.get(target.id)
        const positions = row.previousLocations ?? resource?.locations
        const previousResult = result?.navigationId !== undefined && target.navigationId !== undefined && target.navigationId !== result.navigationId
        return <li key={target.id} data-browser-resource={target.id}>
          <div className="browser-resources__identity"><strong>{target.title || target.url || 'Original Browser'}</strong><small>{target.url || 'Address unconfirmed'}</small>
            <small>{target.id} · {row.current ? '' : 'Previously observed · '}{stateLabel(resource?.state)}</small>
            <small>{row.previousLocations || !row.current ? 'Previous positions: ' : 'Positions: '}{positions?.length ? positions.map(location => `${workspaces?.find(workspace => workspace.id === location.workspaceId)?.name || location.workspaceId || 'Workspace unknown'} · Tab ${location.tabId} · Region ${location.regionId}`).join('; ') : 'unconfirmed'}</small>
            {resource?.retention?.reasons.length ? <small>{row.current ? 'Kept: ' : 'Previously kept: '}{resource.retention.reasons.join(', ')}</small> : null}
            {!row.current ? <small>Previous resource facts. Refresh for current process ownership.</small> : resource?.processes == null ? <small>Process ownership unconfirmed</small> : resource.processes.map(process => {
              const key = processKey(process), sample = samples.get(key)
              return <small key={key}>PID {process.pid} · {sample ? `${memory(sample.rssKib)} process working set (Electron)${sample.cpuPercent === null ? '' : ` · ${sample.cpuPercent.toFixed(1)}% CPU / ${sample.intervalMs ?? 'unknown'}ms interval`}` : 'No matching process reading'}{(counts.get(key) ?? 0) > 1 ? ' · shared' : ''}{sample && app?.state !== 'available' ? ` · ${app?.state ?? 'unknown'} reading` : ''}</small>
            })}
            {target.warning ? <small>{target.warning}</small> : null}
            {result ? <p role="status">{previousResult ? 'Previous document · ' : ''}{result.kind} {result.status}: {result.detail}</p> : null}
          </div>
          <div className="browser-resources__actions">{resource?.state === 'released' || resource?.state === 'cold'
            ? <button className="small-button" disabled={!active || busy.size > 0} onClick={() => void perform([row], 'restore')}>{busy.has(target.id) ? 'Restoring…' : 'Restore'}</button>
            : <button className="small-button" disabled={!active || busy.size > 0 || !canRequestRelease(target)} onClick={() => void perform([row], 'release')}>{busy.has(target.id) ? 'Releasing…' : 'Release memory'}</button>}</div>
        </li>
      })}</ul>}
    <p className="settings-group-note">Release memory, closing a page and clearing website data are separate actions. External shared tabs remain managed by their own browser.</p>
  </section>
}
