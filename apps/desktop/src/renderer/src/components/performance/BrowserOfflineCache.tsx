import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { assertBrowserProfileStorageTarget, parseBrowserProfileStorageResult,
  type BrowserProfileStorageClearInput, type BrowserProfileStorageInspect, type BrowserProfileStorageReceipt,
  type BrowserProfileStorageSelection, type BrowserProfileStorageUsage } from '@agentmux/core/control'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { performanceBytes as bytes, performanceReadingTime as readingTime } from './performance-format'

type Cleanup = { kind: 'receipt'; receipt: BrowserProfileStorageReceipt; message?: string } |
  { kind: 'unknown'; input: BrowserProfileStorageClearInput; message: string }
const originalOf = (item: Cleanup) => item.kind === 'receipt' ? item.receipt : item.input
const sampledSize = (usage: BrowserProfileStorageUsage | undefined, value: number | null) => !usage || !usage.complete && !value ? 'Unknown' : `${bytes(value)}${usage.complete ? '' : ' known'}`
const size = (usage: BrowserProfileStorageUsage) => sampledSize(usage, usage.allocatedBytes ?? usage.logicalBytes)
const statuses: Record<BrowserProfileStorageReceipt['status'], string> = {
  'awaiting-confirmation': 'Awaiting confirmation', pending: 'In progress', completed: 'Request completed',
  cancelled: 'Cancelled', partial: 'Partially acknowledged', unknown: 'Unconfirmed', failed: 'Failed'
}

/** Transient views of the original Profile owner. No website data is cleared on entry or refresh. */
export function BrowserOfflineCache({ active }: { active: boolean }) {
  const [profiles, setProfiles] = useState<BrowserProfileSummary[]>([]), [profileId, setProfileId] = useState('')
  const [profilesReady, setProfilesReady] = useState(false), [profileRefresh, setProfileRefresh] = useState(0)
  const [profileError, setProfileError] = useState<string | null>(null), [readError, setReadError] = useState<string | null>(null)
  const [reading, setReading] = useState<BrowserProfileStorageInspect | null>(null), [readingId, setReadingId] = useState<string | null>(null)
  const [cleanups, setCleanups] = useState<Record<string, Cleanup[]>>({}), [clearing, setClearing] = useState<string[]>([])
  const mounted = useRef(true), live = useRef({ active, profileId }), generation = useRef(0), working = useRef(new Set<string>())
  live.current = { active, profileId }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  useEffect(() => {
    if (!active) { generation.current++; setProfilesReady(false); return }
    let cancelled = false
    setProfilesReady(false); setProfileError(null)
    void api.browser.listProfiles().then(values => {
      if (cancelled) return
      setProfiles(values)
      setProfileId(previous => values.some(profile => profile.id === previous) ? previous : values.find(profile => profile.isDefault)?.id ?? '')
      setProfilesReady(true)
    }).catch(error => { if (!cancelled) setProfileError(presentError(error)) })
    return () => { cancelled = true }
  }, [active, profileRefresh])
  useEffect(() => { if (active && profilesReady && profileId) void inspect(profileId) }, [active, profilesReady, profileId])

  function remember(id: string, value: Cleanup) {
    setCleanups(previous => {
      const entries = previous[id] ?? [], index = entries.findIndex(item => originalOf(item).operationId === originalOf(value).operationId)
      const old = entries[index]
      // A transport error or older in-flight read cannot erase an original confirmed terminal receipt.
      const next = old?.kind === 'receipt' && value.kind === 'unknown' ? { ...old, message: value.message }
        : old?.kind === 'receipt' && old.receipt.finishedAt !== null && value.kind === 'receipt' && value.receipt.finishedAt === null ? old : value
      return { ...previous, [id]: index < 0 ? [...entries, next] : entries.map((item, i) => i === index ? next : item) }
    })
  }

  async function inspect(id: string, operationId?: string) {
    if (!live.current.active) return
    const serial = ++generation.current
    setReadingId(id); setReadError(null)
    const current = () => mounted.current && live.current.active && live.current.profileId === id && generation.current === serial
    try {
      const request = { operation: 'browser.profile.storage.inspect' as const, profileId: id, ...(operationId ? { operationId } : {}) }
      const result = parseBrowserProfileStorageResult(request.operation, { operation: request.operation, ...await api.browser.inspectProfileStorage(id, operationId) })
      assertBrowserProfileStorageTarget(request, result)
      if (!current() || result.operation !== request.operation) return
      setReading(previous => previous?.snapshot.profileId === id && previous.snapshot.observedAt > result.snapshot.observedAt ? previous : result)
      if (operationId && result.receipt) remember(id, { kind: 'receipt', receipt: result.receipt })
      if (operationId && !result.receipt) setReadError('The original operation has no confirmed saved receipt. No deletion was replayed.')
    } catch (error) { if (current()) setReadError(presentError(error)) }
    finally { if (current()) setReadingId(null) }
  }

  async function clear(sites: BrowserProfileStorageSelection[]) {
    const snapshot = reading?.snapshot
    if (!active || !snapshot || snapshot.profileId !== profileId || !sites.length || working.current.has(profileId)) return
    // Copy the complete selected keys once. The original Main owner confirms this exact one/all selection.
    const input: BrowserProfileStorageClearInput = { profileId, expectedRevision: snapshot.profileRevision, operationId: crypto.randomUUID(), sites: structuredClone(sites) }
    working.current.add(input.profileId); setClearing([...working.current])
    remember(input.profileId, { kind: 'unknown', input, message: 'Waiting for the original confirmation and cleanup result.' })
    try {
      const result = parseBrowserProfileStorageResult('browser.profile.storage.clear', { operation: 'browser.profile.storage.clear', receipt: await api.browser.clearProfileStorage(input) })
      assertBrowserProfileStorageTarget({ operation: 'browser.profile.storage.clear', ...input }, result)
      if (!mounted.current || result.operation !== 'browser.profile.storage.clear') return
      const receipt = result.receipt
      remember(input.profileId, { kind: 'receipt', receipt })
      if (receipt.after && live.current.active && live.current.profileId === input.profileId) {
        setReading(previous => previous && previous.snapshot.profileId === input.profileId && previous.snapshot.observedAt > receipt.after!.observedAt ? previous : {
          snapshot: receipt.after!, receipt, pending: (previous?.snapshot.profileId === input.profileId ? previous.pending : []).filter(item => item.operationId !== input.operationId)
        })
      }
    } catch (error) {
      if (mounted.current) remember(input.profileId, { kind: 'unknown', input, message: presentError(error) })
    } finally { working.current.delete(input.profileId); if (mounted.current) setClearing([...working.current]) }
  }

  const current = reading?.snapshot.profileId === profileId ? reading : null, snapshot = current?.snapshot
  const busy = clearing.includes(profileId), loading = readingId === profileId
  const cleanup: Cleanup | null = cleanups[profileId]?.at(-1) ?? (current?.pending.length ? { kind: 'receipt' as const, receipt: current.pending.at(-1)! } : null)
  const receipt = cleanup?.kind === 'receipt' ? cleanup.receipt : null, original = cleanup?.kind === 'unknown' ? cleanup.input : receipt
  const status = cleanup?.kind === 'unknown' ? busy ? 'pending' : 'unknown' : receipt?.status
  const sites = [...snapshot?.sites ?? []].sort((a, b) => (b.usage.allocatedBytes ?? b.usage.logicalBytes) - (a.usage.allocatedBytes ?? a.usage.logicalBytes) || a.origin.localeCompare(b.origin))
  const before = receipt?.before?.usage, after = receipt?.after?.usage
  const allocated = before?.allocatedBytes != null && after?.allocatedBytes != null
  const beforeBytes = before ? allocated ? before.allocatedBytes! : before.logicalBytes : null, afterBytes = after ? allocated ? after.allocatedBytes! : after.logicalBytes : null
  const delta = before?.complete && after?.complete && beforeBytes !== null && afterBytes !== null ? afterBytes - beforeBytes : null
  const records = new Map((current?.pending ?? []).map(item => [item.operationId, { kind: 'receipt', receipt: item } as Cleanup]))
  for (const item of cleanups[profileId] ?? []) records.set(originalOf(item).operationId, item)
  const earlier = [...records.values()].filter(item => originalOf(item).operationId !== original?.operationId)

  return <section className="performance-offline-cache" aria-label="Website offline disk cache" data-offline-cache>
    <div className="performance-reclaim-heading"><h4>Website offline cache</h4><span className="performance-reclaim-preserved">Sign-in data kept</span></div>
    <label className="performance-offline-profile">Browser Profile
      <select aria-label="Offline cache Profile" value={profileId} disabled={!active || !profiles.length} onChange={event => { generation.current++; setReadError(null); setProfileId(event.target.value) }}>
        {!profileId ? <option value="">Choose a Profile</option> : null}
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.isDefault ? ' (default)' : ''}</option>)}
      </select>
    </label>
    {profileError ? <div className="performance-offline-status" role="status">{profileError} <button type="button" className="performance-inline-action" onClick={() => setProfileRefresh(value => value + 1)}>Retry Profiles</button></div> : null}
    <div className="performance-reclaim-primary"><div><strong data-offline-size>{snapshot ? size(snapshot.usage) : 'Unknown'}</strong>
      <small>{loading ? 'Reading offline disk cache...' : snapshot ? `${snapshot.usage.allocatedBytes === null ? 'File sizes; disk allocation unavailable' : 'Disk blocks'}${snapshot.usage.complete ? '' : ' · partial reading'} · ${readingTime(snapshot.observedAt, Date.now())}` : profilesReady ? profileId ? 'No disk reading' : 'Choose a Profile to inspect' : 'Reading Profiles...'}</small></div>
      <button type="button" className="performance-inline-action" data-offline-clear-all disabled={!active || !snapshot || !sites.length || busy} onClick={() => void clear(sites.map(({ origin, storageKeys }) => ({ origin, storageKeys })))}>{busy ? 'Clearing...' : 'Clear all...'}</button></div>
    <div className="performance-reclaim-inspect"><span>Offline copies may be lost. Websites can rebuild caches.</span>
      <button type="button" className="performance-inline-action" aria-label="Refresh offline cache" disabled={!active || !profileId || loading} onClick={() => void inspect(profileId)}>Refresh</button></div>
    {readError ? <p role="status" className="performance-offline-status">{readError}</p> : null}
    <ul className="performance-offline-sites" aria-label="Offline cache by site">
      {sites.map(site => <li key={site.origin} data-offline-site={site.origin}><span title={site.origin}>{site.origin}</span><small>{size(site.usage)}</small>
        <button type="button" className="performance-inline-action" aria-label={`Clear offline cache for ${site.origin}`} disabled={!active || busy} onClick={() => void clear([{ origin: site.origin, storageKeys: site.storageKeys }])}>Clear...</button></li>)}
    </ul>
    {snapshot && !sites.length ? <p>{snapshot.usage.complete ? 'No identified offline cache sites.' : 'No site keys could be confirmed in this reading.'}</p> : null}
    {snapshot && (!snapshot.unattributed.complete || snapshot.unattributed.logicalBytes > 0) ? <p className="performance-offline-status" data-offline-unattributed>Unattributed storage: {size(snapshot.unattributed)}. It cannot identify additional sites to clear.</p> : null}
    {cleanup && original ? <div className="performance-reclaim-result" role="status" data-offline-result={status}>
      <div className="performance-reclaim-heading"><span>Last offline cleanup · {original.sites.length} site{original.sites.length === 1 ? '' : 's'}</span><strong>{statuses[status!]}</strong></div>
      <dl className="performance-reclaim-counters"><div><dt>Profile before</dt><dd>{sampledSize(before, beforeBytes)}</dd></div><div><dt>Profile after</dt><dd>{sampledSize(after, afterBytes)}</dd></div>
        <div><dt>Observed change</dt><dd data-offline-change>{delta === null ? 'Unknown' : delta === 0 ? 'Unchanged' : `${delta > 0 ? '+' : '-'}${bytes(Math.abs(delta))}`}</dd></div></dl>
      {cleanup.message ? <p>{cleanup.message}</p> : null}
      <button type="button" className="performance-inline-action" data-offline-check-original disabled={!active || loading} onClick={() => void inspect(original.profileId, original.operationId)}>Check original operation</button>
      <details className="performance-reclaim-details"><summary>Cleanup details</summary><p>{allocated ? 'Disk blocks' : 'File sizes'} before and after are Profile-wide samples, not guaranteed space freed.</p>
        <p>Operation: {original.operationId}</p><p>{original.sites.map(site => site.origin).join(', ')}</p>{receipt?.issues.map((issue, index) => <p key={index}>{issue}</p>)}</details>
    </div> : null}
    {earlier.map(item => { const input = originalOf(item); return <details key={input.operationId} className="performance-offline-status" data-offline-earlier={input.operationId}>
      <summary>Earlier cleanup: {item.kind === 'unknown' ? 'Unconfirmed' : statuses[item.receipt.status]}</summary><p>{input.sites.map(site => site.origin).join(', ')}</p><p>Operation: {input.operationId}</p>
      {item.message ? <p>{item.message}</p> : null}<button type="button" className="performance-inline-action" disabled={!active || loading} onClick={() => void inspect(input.profileId, input.operationId)}>Check original operation</button>
    </details> })}
    <details className="performance-reclaim-details"><summary>Scope and disk readings{snapshot?.issues.length ? ' · needs attention' : ''}</summary>
      <p>One site or all identified sites in this Profile, confirmed once before clearing. All current Cache API buckets under the selected site partitions are included, even if some cannot be measured.</p>
      <p>Cookies, IndexedDB, localStorage and Service Worker registrations stay. Memory caches and other Profiles are separate. Unrecognized data never establishes extra deletion targets.</p>
      <p>Disk blocks and file sizes differ. Partial readings are known samples, not complete totals. Native acknowledgements do not guarantee bytes removed; unconfirmed operations are checked by their original ID and never automatically repeated.</p>
      {snapshot?.issues.map((issue, index) => <p key={index}>{issue}</p>)}
    </details>
  </section>
}
