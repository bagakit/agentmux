import { useEffect, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { api } from '../lib/api'
import type { BrowserTrafficTarget } from '../../../shared/browser-traffic'
import { useTrafficReceipt } from './browser-traffic-receipt'

export function BrowserRequestCapture({ browserId, visible }: { browserId: string; visible: boolean }) {
  const [targets, setTargets] = useState<BrowserTrafficTarget[]>([])
  const [selected, setSelected] = useState<string[]>([browserId])
  const [query, setQuery] = useState('')
  const [selectedRow, selectRow] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ captureId: string; path: string } | null>(null)
  const { receipt, error, busy, recording, act } = useTrafficReceipt(visible)

  useEffect(() => {
    if (!visible || recording) return
    let active = true
    void api.browser.trafficTargets().then(rows => { if (active) setTargets(rows) }, () => { if (active) setTargets([]) })
    return () => { active = false }
  }, [recording, visible])

  const available = targets.filter(target => selected.includes(target.id))
  const rows = receipt?.rows.filter(row => `${row.method} ${row.status} ${row.url}`.toLowerCase().includes(query.toLowerCase())) ?? []
  const detail = rows.find(row => row.key === selectedRow)
  const canExport = receipt?.status === 'finished' && receipt.retained > 0
  const savedPath = saved?.captureId === receipt?.captureId ? saved?.path : undefined
  return <div className="browser-traffic__body">
    {!recording ? <details className="browser-traffic__targets">
      <summary>Pages <small>{available.length} selected</small></summary>
      {targets.length ? targets.map(target => <label key={target.id} title={target.url}>
        <input type="checkbox" name="traffic-source" value={target.id} checked={selected.includes(target.id)}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, target.id] : previous.filter(id => id !== target.id))} />
        <span>{target.title || target.url || 'Untitled page'}</span>
      </label>) : <p>No live pages are available.</p>}
    </details> : null}
    <div className="browser-traffic__actions">
      {canExport ? <Button type="button" variant="primary" disabled={busy} onClick={() => void act(async () => {
        const file = await api.browser.exportTraffic(receipt.captureId)
        if (file) setSaved({ captureId: receipt.captureId, path: file.path })
        return null
      })}>Export HAR…</Button> : null}
      {recording && receipt ? <Button type="button" disabled={busy} onClick={() => void act(() => api.browser.stopTraffic(receipt.captureId))}>Stop</Button> :
        <Button type="button" {...(canExport ? {} : { variant: 'primary' as const })} disabled={busy || !available.length || available.length > 8} onClick={() => {
          setSaved(null)
          selectRow(null)
          void act(() => api.browser.startTraffic(available.map(target => target.id)))
        }}>{canExport ? 'New recording' : 'Record requests'}</Button>}
    </div>
    {receipt ? <div className="browser-traffic__receipt" role="status">
      <strong>{receipt.status === 'recording' ? 'Recording' : receipt.status === 'finished' ? 'Recording ended' : receipt.status}</strong>
      <span>{receipt.retained} requests{receipt.pending ? ` · ${receipt.pending} pending` : ''}
        {receipt.dropped ? ` · ${receipt.dropped} dropped` : ''}{receipt.unmatched ? ` · ${receipt.unmatched} unmatched events` : ''}</span>
      {receipt.sources.filter(source => source.detail).map(source => <span key={source.id}>{source.title || source.url}: {source.detail}</span>)}
      {savedPath ? <span className="browser-traffic__destination" title={savedPath}>Saved {savedPath.split(/[\\/]/u).at(-1) || savedPath}</span> : null}
    </div> : <p className="browser-traffic__hint">Record selected pages across navigations. HAR contains request metadata.</p>}
    {receipt?.rows.length ? <>
      <label>Filter requests<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Path or status" /></label>
      <ul className="browser-traffic__requests" aria-label="Recorded requests">
        {rows.map(row => <li key={row.key}>
          <button type="button" aria-pressed={row.key === selectedRow} title={row.url} onClick={() => selectRow(row.key)}>
            <span>{row.method}</span><span>{row.status || row.state}</span><span>{new URL(row.url).pathname}</span>
          </button>
        </li>)}
      </ul>
      {detail ? <dl className="browser-traffic__detail">
        <dt>Page</dt><dd>{receipt.sources.find(source => source.id === detail.browserId)?.title || detail.browserId}</dd>
        <dt>Request</dt><dd>{detail.url}</dd>
        <dt>Duration</dt><dd>{Math.round(detail.duration)} ms</dd>
        {detail.mimeType ? <><dt>Content type</dt><dd>{detail.mimeType}</dd></> : null}
        {detail.redirectURL ? <><dt>Redirect</dt><dd>{detail.redirectURL}</dd></> : null}
      </dl> : null}
    </> : null}
    {error ? <div className="browser-traffic__receipt" role="alert">{error}</div> : null}
  </div>
}
