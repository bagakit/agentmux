import { useEffect, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserProfileFolder, BrowserProfileTrashList } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { browserProfiles } from '../../lib/browser-profiles'

/** A transient view of the original metadata owner; hidden Settings do not read or subscribe. */
export function BrowserProfileTrash({ active, folders, onBack, onRestored }: {
  active: boolean; folders: readonly BrowserProfileFolder[]; onBack(): void; onRestored(id: string, label: string): void
}) {
  const [list, setList] = useState<BrowserProfileTrashList | null>(null)
  const [error, setError] = useState<{ source: 'read' | 'restore'; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [folder, setFolder] = useState<Record<string, string>>({})
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    let current = true, sequence = 0
    const read = async () => {
      const attempt = ++sequence
      try { const result = await api.browser.readProfileTrash(); if (current && attempt === sequence) { setList(result); setError(previous => previous?.source === 'read' ? null : previous) } }
      catch (cause) { if (current && attempt === sequence) setError(previous => previous?.source === 'restore' ? previous : { source: 'read', message: presentError(cause) }) }
    }
    void read()
    const release = api.browser.onProfilesChanged(() => { void read() })
    return () => { current = false; release() }
  }, [active, retry])
  const restore = async (entry: NonNullable<BrowserProfileTrashList>['entries'][number]) => {
    setBusy(entry.id); setError(null)
    const chosen = folder[entry.id]
    try {
      const result = await api.browser.restoreProfile(entry.id, entry.revision, chosen === 'unfiled' ? null : chosen || undefined)
      await browserProfiles.refresh()
      // Keep the original editor and its drafts; opening the restored identity is an explicit action.
      onRestored(result.profile.id, result.profile.label)
      setRetry(value => value + 1)
    } catch (cause) { setError({ source: 'restore', message: presentError(cause) }) }
    finally { setBusy(null) }
  }
  return <section className="browser-profile-trash" aria-label="Recycled Profiles" hidden={!active}>
    <header><button type="button" className="small-button" onClick={onBack}>All Profiles</button><h3>Recycled Profiles</h3></header>
    <p>Original sign-ins, site data and saved settings stay with each Profile. Restore brings back the same identity. Recycling does not free disk space or create a separate backup.</p>
    {error ? <p className="browser-profiles-settings__service" role="status">Couldn’t confirm this action. {error.message} <button type="button" disabled={busy !== null} onClick={() => { setError(null); setRetry(value => value + 1) }}>Retry</button></p> : null}
    {!list ? <p role="status">{error ? 'The last confirmed data is kept.' : 'Reading recycled Profiles…'}</p> : null}
    {list?.entries.length === 0 ? <p>No recycled Profiles.</p> : null}
    {list?.entries.map(entry => <article className="browser-profile-trash__entry" key={entry.id}>
      <div><h4>{entry.profile.label}</h4><p>Recycled <time dateTime={new Date(entry.archivedAt).toISOString()}>{new Date(entry.archivedAt).toLocaleString()}</time></p><small>Profile {entry.profile.id}</small></div>
      {entry.profile.notes ? <p>{entry.profile.notes}</p> : null}
      {entry.profile.folderId && !folders.some(value => value.id === entry.profile.folderId) ? <p>The original folder was removed. Choose a folder or restore unfiled.</p> : null}
      <label>Restore to<select aria-label={`Restore folder for ${entry.profile.label}`} value={folder[entry.id] ?? ''} disabled={busy !== null} onChange={event => setFolder(current => ({ ...current, [entry.id]: event.target.value }))}>
        <option value="">Original folder</option><option value="unfiled">Unfiled</option>{folders.map(value => <option value={value.id} key={value.id}>{value.label}</option>)}
      </select></label>
      <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void restore(entry)}>{busy === entry.id ? 'Restoring…' : `Restore ${entry.profile.label}`}</button>
    </article>)}
    {list?.legacyPendingDeletes.length ? <aside className="browser-profiles-settings__service" role="status"><strong>Earlier cleanup is unconfirmed</strong><p>These earlier deletions have no complete saved Profile record. Their remaining original data is kept. They are not listed as restorable Profiles; no automatic cleanup will run.</p><ul>{list.legacyPendingDeletes.map(id => <li key={id}>Profile {id}</li>)}</ul></aside> : null}
  </section>
}
