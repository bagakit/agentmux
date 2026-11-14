import { submitProfileCreation } from '../../lib/browser-profile-creations'
import { BrowserProxyLibrary } from './BrowserProxyLibrary'
import { useEffect, useMemo, useRef, useState } from 'react'
import { parseBrowserProfileQuery, queryBrowserProfiles, type BrowserProfileQuery, type BrowserProfileBulkAction, type BrowserProfileBulkItemResult } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import type { BrowserProfilesState } from '../../lib/browser-profiles'
import { api } from '../../lib/api'
import { ProfileMark } from '../ProfileMark'
import { SettingsResourceLibrary } from './SettingsResourceLibrary'

/** This pane owns query/selection drafts only. Main remains the owner of all saved facts and writes. */
export function BrowserProfileLibrary({ list, active, selectedId, onSelect, focusRequest, assignment, openCounts, detailLine }: {
  list: BrowserProfilesState; active: boolean; selectedId: string | null; onSelect: (id: string) => void
  focusRequest: { id: string | null } | null; assignment: ReadonlyMap<string, number>; openCounts: ReadonlyMap<string, number>; detailLine: (profile: BrowserProfileSummary) => string
}) {
  const [proxyId, setProxyId] = useState('')
  const proxies = list.proxies ?? []
  const profiles = list.profiles ?? [], folders = list.folders ?? [], views = list.views ?? []
  const [query, setQuery] = useState<BrowserProfileQuery>({})
  const [viewId, setViewId] = useState(''), [viewRevision, setViewRevision] = useState<number | null>(null), [label, setLabel] = useState('')
  const [selecting, setSelecting] = useState(false), [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [kind, setKind] = useState<BrowserProfileBulkAction['kind']>('pin'), [value, setValue] = useState(''), [unpin, setUnpin] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [results, setResults] = useState<BrowserProfileBulkItemResult[] | null>(null)
  const [now, setNow] = useState(Date.now)
  // A reply may advance only the exact view draft that submitted it. Later input has its own context.
  const editingContext = useRef<object>({})
  const relativeTime = query.lastUsed !== undefined && query.lastUsed !== 'unknown'
  useEffect(() => {
    if (!active || !relativeTime) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [active, relativeTime])
  // Snapshot delivery also reevaluates dates, without a clock for queries that do not need one.
  const evaluatedAt = Math.max(now, Date.now())
  let visible = profiles, scopeError: string | null = null
  try { visible = queryBrowserProfiles(profiles, folders, query, evaluatedAt) }
  catch (cause) { visible = []; scopeError = presentError(cause) }
  const visibleIds = new Set(visible.map(profile => profile.id)), hiddenCount = [...selected].filter(id => !visibleIds.has(id)).length
  const tags = useMemo(() => [...new Set(profiles.flatMap(profile => profile.tags ?? []))].sort(), [list.profiles])
  const selectedView = views.find(view => view.id === viewId)
  const change = (patch: { [K in keyof BrowserProfileQuery]?: BrowserProfileQuery[K] | undefined }) => {
    editingContext.current = {}
    setQuery(current => parseBrowserProfileQuery(Object.fromEntries(Object.entries({ ...current, ...patch }).filter(([, v]) => v !== undefined))))
  }
  const applyView = (id: string) => {
    editingContext.current = {}
    const view = views.find(candidate => candidate.id === id)
    setViewId(id); setViewRevision(list.revision); setError(null)
    setLabel(view?.label ?? ''); setQuery(view ? structuredClone(view.query) : {})
  }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await action() } catch (cause) { setError(presentError(cause)) } finally { setBusy(false) }
  }
  const saveView = (id?: string) => {
    const expectedRevision = id === undefined ? list.revision : viewRevision
    if (expectedRevision === null) return
    const submitted = editingContext.current
    void run(async () => {
      const receipt = id === undefined ? await (async () => {
        const result = await submitProfileCreation({ operation: 'browser.profile.view.create', label, query, expectedRevision })
        if (result.creation.current.state !== 'present') throw new Error('The original saved view is now ' + result.creation.current.state + '. Its creation receipt is retained.')
        return { view: { id: result.creation.receipt!.createdId }, revision: result.revision }
      })() : await api.browser.saveProfileView(label, query, expectedRevision, id)
      if (submitted !== editingContext.current) return
      setViewId(receipt.view.id); setViewRevision(receipt.revision)
    })
  }
  const deleteView = (id: string) => {
    const submitted = editingContext.current
    void run(async () => {
      await api.browser.deleteProfileView(id, list.revision!)
      if (submitted !== editingContext.current) return
      setViewId(''); setViewRevision(null)
    })
  }
  const bulk = () => {
    // Freeze exact IDs/tokens once; later snapshots or filter results cannot expand this batch.
    const items = [...selected].map(profileId => ({ profileId, expectedRevision: profiles.find(profile => profile.id === profileId)?.revision ?? 'unavailable' }))
    const action: BrowserProfileBulkAction = kind === 'pin' ? { kind, pinned: !unpin } : kind === 'move' ? { kind, folderId: value || null } : { kind, tag: value }
    void run(async () => { setResults(await api.browser.bulkUpdateProfiles(items, action)) })
  }
  const assignProxy = () => {
    const proxy = proxies.find(item => item.id === proxyId)
    if (!proxy) return
    const items = [...selected].map(profileId => ({ profileId, expectedRevision: profiles.find(profile => profile.id === profileId)?.revision ?? 'unavailable' }))
    void run(async () => { setResults(await api.browser.assignProxy(proxy.id, proxy.revision, items)) })
  }
  return <div className="browser-profile-library">
    <div className="browser-profile-library__views">
      <label>View<select aria-label="Saved Profile view" value={viewId} onChange={event => applyView(event.target.value)}><option value="">All Profiles</option>{views.map(view => <option key={view.id} value={view.id}>{view.label}</option>)}</select></label>
      {viewId && !selectedView ? <p role="status">This saved view is no longer available. Its current query is kept.</p> : null}
      <details><summary>Filters and order{Object.keys(query).length ? ` · ${visible.length} shown` : ''}</summary>
        <div className="browser-profile-library__filters">
          <label>Observed status<select aria-label="Profile observed status" value={query.status ?? ''} onChange={event => change({ status: event.target.value as BrowserProfileQuery['status'] || undefined })}><option value="">Any status</option><option value="running">Observed running</option><option value="idle">Observed idle</option><option value="unknown">Unknown</option></select></label>
          <label>Tag<select aria-label="Profile tag filter" value={query.tag ?? ''} onChange={event => change({ tag: event.target.value || undefined })}><option value="">Any tag</option>{tags.map(tag => <option key={tag}>{tag}</option>)}{query.tag && !tags.includes(query.tag) ? <option>{query.tag}</option> : null}</select></label>
          <label>Folder<select aria-label="Profile folder filter" value={query.folderId === null ? ':unfiled' : query.folderId ?? ''} onChange={event => change({ folderId: event.target.value === ':unfiled' ? null : event.target.value || undefined })}><option value="">Any folder</option><option value=":unfiled">Unfiled</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}{query.folderId && !folders.some(folder => folder.id === query.folderId) ? <option value={query.folderId}>Unavailable folder</option> : null}</select></label>
          <label>Saved route<select aria-label="Profile route filter" value={query.route ?? ''} onChange={event => change({ route: event.target.value as BrowserProfileQuery['route'] || undefined })}><option value="">Any route</option><option value="system">System settings</option><option value="direct">Direct</option><option value="proxy">Proxy configured</option></select></label>
          <label>Last observed use<select aria-label="Profile last use filter" value={query.lastUsed ?? ''} onChange={event => change({ lastUsed: event.target.value as BrowserProfileQuery['lastUsed'] || undefined })}><option value="">Any time</option><option value="day">Last day</option><option value="week">Last week</option><option value="month">Last month</option><option value="unknown">Unknown</option></select></label>
          <label>Order<select aria-label="Profile order" value={query.sort ?? ''} onChange={event => change({ sort: event.target.value as BrowserProfileQuery['sort'] || undefined })}><option value="">Original order</option><option value="name">Name</option><option value="recent">Last observed use</option><option value="observed-time">Confirmed Browser time</option></select></label>
          <button className="small-button" onClick={() => { editingContext.current = {}; setQuery({}); setViewId(''); setViewRevision(null); setNow(Date.now()) }}>Clear filters</button>
        </div>
        <p className="settings-hint">Times and status reflect confirmed native observations. Missing history stays unknown.</p>
      </details>
      <details><summary>Save this view</summary><label>View name<input aria-label="Profile view name" value={label} onChange={event => { editingContext.current = {}; setLabel(event.target.value) }} /></label><div className="browser-profile-library__actions">
        <button className="small-button" disabled={busy || list.revision === null || !label.trim()} onClick={() => saveView()}>Save new</button>
        {selectedView ? <><button className="small-button" disabled={busy || viewRevision === null} onClick={() => saveView(selectedView.id)}>Update view</button><button className="small-button" onClick={() => applyView(viewId)}>Reload view</button><button className="small-button" disabled={busy || list.revision === null} onClick={() => deleteView(selectedView.id)}>Delete view</button></> : null}
      </div></details>
    </div>
    {scopeError ? <p className="browser-profiles-settings__service" role="status">{scopeError}</p> : null}
    <div className="browser-profile-library__actions"><button className="small-button" aria-pressed={selecting} onClick={() => setSelecting(!selecting)}>{selecting ? 'Done selecting' : 'Select Profiles'}</button>{selecting ? <button className="small-button" onClick={() => setSelected(current => new Set([...current, ...visible.map(profile => profile.id)]))}>Select displayed</button> : null}</div>
    <SettingsResourceLibrary label="Profiles" followFocus query={query.search ?? ''} onQuery={search => change({ search })} selectedId={selectedId} onSelect={onSelect} focusRequest={focusRequest}
      {...(selecting ? { selection: { ids: selected, onToggle: (id: string) => setSelected(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next }) } } : {})}
      items={scopeError !== null || (visible.length === 0 && (list.profiles === null || list.reading || list.error !== null)) ? null
        : visible.map(profile => ({ id: profile.id, name: profile.label, detail: detailLine(profile),
          mark: <ProfileMark profile={profile} assignment={assignment} />, status: profile.pinned || openCounts.get(profile.id) ? <span>{profile.pinned ? 'Pinned' : ''}{profile.pinned && openCounts.get(profile.id) ? ' · ' : ''}{openCounts.get(profile.id) ? `${openCounts.get(profile.id)} open` : ''}</span> : undefined }))} />
    {selected.size ? <section className="browser-profile-library__bulk" aria-label="Selected Profiles">
      <strong>{selected.size} selected{hiddenCount ? ` · ${hiddenCount} outside this view` : ''}</strong><button className="small-button" onClick={() => { setSelected(new Set()); setResults(null) }}>Clear selection</button>
      <details><summary>Review selected Profiles</summary><ul>{[...selected].map(id => <li key={id}>{profiles.find(profile => profile.id === id)?.label ?? 'Unavailable Profile'} <code>{id}</code></li>)}</ul></details>
      <label>Bulk change<select aria-label="Bulk Profile action" value={kind} disabled={busy} onChange={event => { setKind(event.target.value as BrowserProfileBulkAction['kind']); setValue('') }}><option value="pin">Pin</option><option value="move">Move to folder</option><option value="add-tag">Add tag</option><option value="remove-tag">Remove tag</option></select></label>
      {kind === 'pin' ? <label><input type="checkbox" checked={unpin} onChange={event => setUnpin(event.target.checked)} />Unpin instead</label> : kind === 'move' ? <label>Destination<select aria-label="Bulk destination folder" value={value} onChange={event => setValue(event.target.value)}><option value="">Unfiled</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.label}</option>)}</select></label> : <label>Tag<input aria-label="Bulk tag name" value={value} onChange={event => setValue(event.target.value)} /></label>}
      <button className="small-button" disabled={busy || ((kind === 'add-tag' || kind === 'remove-tag') && !value.trim())} onClick={bulk}>{busy ? 'Applying…' : `Apply to ${selected.size} selected`}</button>
      {proxies.length ? <details><summary>Assign a proxy</summary><label>Saved proxy<select aria-label="Proxy for selected Profiles" value={proxyId} onChange={event => setProxyId(event.target.value)}><option value="">Choose a proxy</option>{proxies.map(proxy => <option key={proxy.id} value={proxy.id}>{proxy.label}</option>)}</select></label><p className="settings-hint">The selected Profiles reconnect. Existing sign-ins remain scoped to their saved server.</p><button className="small-button" disabled={busy || !proxies.some(proxy => proxy.id === proxyId)} onClick={assignProxy}>Assign to {selected.size} selected</button></details> : null}
    </section> : null}
    {error ? <p role="status" className="browser-profiles-settings__service">{error}</p> : null}
    {results ? <section aria-label="Bulk Profile results" className="browser-profile-library__results" role="status"><strong>{results.filter(item => item.outcome === 'updated').length} updated · {results.filter(item => item.outcome === 'failed').length} failed</strong><details><summary>Individual results</summary><ul>{results.map(item => <li key={item.profileId}><strong>{profiles.find(profile => profile.id === item.profileId)?.label ?? 'Unavailable Profile'}</strong> <code>{item.profileId}</code> — {item.outcome === 'updated' ? 'Updated' : `${item.message} (${item.code})`}</li>)}</ul></details></section> : null}
    <BrowserProxyLibrary assets={list.proxies} active={active} />
  </div>
}
