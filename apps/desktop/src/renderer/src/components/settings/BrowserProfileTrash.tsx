import { SurfaceState } from '../SurfaceState'
import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { Button } from '@agentmux/client-ui/components/Button'
import type { BrowserProfileFolder, BrowserProfileTrashList } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { browserProfiles } from '../../lib/browser-profiles'

/** A transient view of the original metadata owner; hidden Settings do not read or subscribe. */
export function BrowserProfileTrash({ active, folders, onBack, onRestored }: {
  active: boolean; folders: readonly BrowserProfileFolder[]; onBack(): void; onRestored(id: string, label: string): void
}) {
  const [archive, setArchive] = useState<{ status: 'reading' | 'ready' | 'failed'; list: BrowserProfileTrashList | null }>({ status: 'reading', list: null })
  const { list } = archive
  const [error, setError] = useState<{ source: 'read' | 'restore' | 'purge'; message: string } | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm] = useState<{ entry: BrowserProfileTrashList['entries'][number]; purgeId: string; deleteAfter?: number; uncertain?: string } | null>(null)
  const [completed, setCompleted] = useState<Awaited<ReturnType<typeof api.browser.inspectProfilePurge>>>(null)
  const cancel = useRef<HTMLButtonElement>(null), confirmationTrigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { if (confirm) cancel.current?.focus() }, [confirm])
  const closeConfirmation = () => { setConfirm(null); if (confirmationTrigger.current?.isConnected) confirmationTrigger.current.focus() }
  const [days, setDays] = useState<Record<string, number>>({})
  const [folder, setFolder] = useState<Record<string, string>>({})
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!active) return
    let current = true, sequence = 0
    const read = async () => {
      const attempt = ++sequence
      setArchive(previous => ({ ...previous, status: 'reading' }))
      try {
        const result = await api.browser.readProfileTrash()
        if (current && attempt === sequence) {
          setArchive({ status: 'ready', list: result })
          setError(previous => previous?.source === 'read' ? null : previous)
        }
      } catch (cause) {
        if (current && attempt === sequence) {
          setArchive(previous => ({ ...previous, status: 'failed' }))
          setError(previous => previous?.source !== 'read' && previous ? previous : { source: 'read', message: presentError(cause) })
        }
      }
    }
    void read()
    const release = api.browser.onProfilesChanged(() => { void read() })
    return () => { current = false; release() }
  }, [active, retry])
  const restore = async (entry: NonNullable<BrowserProfileTrashList>['entries'][number]) => {
    setBusy(current => ({ ...current, [entry.id]: true })); setError(null)
    const chosen = folder[entry.id]
    try {
      const result = await api.browser.restoreProfile(entry.id, entry.revision, chosen === 'unfiled' ? null : chosen || undefined)
      await browserProfiles.refresh()
      // Keep the original editor and its drafts; opening the restored identity is an explicit action.
      onRestored(result.profile.id, result.profile.label)
      setRetry(value => value + 1)
    } catch (cause) { setError({ source: 'restore', message: presentError(cause) }) }
    finally { setBusy(current => { const next = { ...current }; delete next[entry.id]; return next }) }
  }
  const confirmDeletion = async () => {
    if (!confirm) return
    const original = confirm
    setBusy(current => ({ ...current, [original.entry.id]: true })); setError(null)
    try {
      if (original.deleteAfter === undefined) {
        const result = await api.browser.purgeProfile(original.entry.id, original.entry.revision, original.purgeId)
        if (result?.purge.status === 'deleted') setCompleted(result.purge)
      }
      else await api.browser.setProfileTrashRetention(original.entry.id, original.entry.revision, original.purgeId, original.deleteAfter)
      setConfirm(current => current?.purgeId === original.purgeId ? null : current); setRetry(value => value + 1)
    } catch (cause) { const message = presentError(cause); setError({ source: 'purge', message }); setConfirm(current => current?.purgeId === original.purgeId ? { ...current, uncertain: message } : current) }
    finally { setBusy(current => { const next = { ...current }; delete next[original.entry.id]; return next }) }
  }
  const keep = async (entry: BrowserProfileTrashList['entries'][number]) => {
    setBusy(current => ({ ...current, [entry.id]: true }))
    try { await api.browser.setProfileTrashRetention(entry.id, entry.revision, mintObjectId(), null); setRetry(value => value + 1) }
    catch (cause) { setError({ source: 'purge', message: presentError(cause) }) }
    finally { setBusy(current => { const next = { ...current }; delete next[entry.id]; return next }) }
  }
  const inspectOriginal = async () => {
    if (!confirm) return
    const original = confirm
    try {
      if (confirm.deleteAfter !== undefined) {
        const observed = await api.browser.readProfileTrash()
        if (!observed.entries.some(entry => entry.id === confirm.entry.id && entry.retention?.purgeId === confirm.purgeId && entry.retention.deleteAfter === confirm.deleteAfter)) return
      } else {
        const result = await api.browser.inspectProfilePurge(confirm.purgeId)
        if (!result) return
        if (result.status === 'deleted') setCompleted(result)
      }
      setConfirm(current => current?.purgeId === original.purgeId ? null : current); setError(null); setRetry(value => value + 1)
    } catch (cause) { setError({ source: 'purge', message: presentError(cause) }) }
  }
  const retentionText = (entry: BrowserProfileTrashList['entries'][number]) => {
    if (!entry.retention) return 'Kept until you choose to delete it.'
    const remaining = entry.retention.deleteAfter - Date.now()
    return Number.isFinite(remaining) ? remaining > 0 ? `${Math.ceil(remaining / 86_400_000)} days remaining · deletion approved for ${new Date(entry.retention.deleteAfter).toLocaleDateString()}` : 'Retention period ended · awaiting safe cleanup.' : 'Retention time is unknown · data is kept.'
  }
  return <section className="browser-profile-trash" aria-label="Recycled Profiles" hidden={!active}>
    <header><Button type="button" onClick={onBack}>All Profiles</Button><h3>Recycled Profiles</h3></header>
    <p>Original sign-ins, site data and saved settings stay with each Profile. Restore brings back the same identity. Recycling does not free disk space or create a separate backup.</p>
    {error && !(error.source === 'purge' && confirm?.uncertain) ? <p className="browser-profiles-settings__service" role="status">Couldn’t confirm this action. {error.message} <button type="button" disabled={false} onClick={() => { setError(null); setRetry(value => value + 1) }}>Retry</button></p> : null}
    {!list?.entries.length && archive.status !== 'ready' ? <p role="status">{archive.status === 'failed' ? 'The last confirmed data is kept.' : 'Reading recycled Profiles…'}</p> : null}
    {archive.status === 'ready' && list?.entries.length === 0 ? <SurfaceState layout="inline" title="No recycled Profiles." /> : null}
    {completed ? <aside className="browser-profiles-settings__service" role="status"><strong>Profile data and saved settings removed</strong><p>Credential cleanup: {completed.credentialCleanup ?? 'unknown'}. Site permission cleanup: {completed.permissionCleanup ?? 'unknown'}.</p><small>Action {completed.purgeId}</small>{completed.warning ? <p>{completed.warning}</p> : null}</aside> : null}
    {list?.entries.map(entry => <article className="browser-profile-trash__entry" key={entry.id}>
      <div><h4>{entry.profile.label}</h4><p>Recycled <time dateTime={new Date(entry.archivedAt).toISOString()}>{new Date(entry.archivedAt).toLocaleString()}</time></p><small>Profile {entry.profile.id}</small></div>
      {entry.profile.notes ? <p>{entry.profile.notes}</p> : null}
      <p className="browser-profile-trash__retention">{retentionText(entry)}</p>
      {entry.purge ? <aside className="browser-profiles-settings__service" role="status"><strong>{entry.purge.status === 'waiting-for-restart' ? 'Deletion requested' : entry.purge.status === 'failed' ? 'Cleanup failed · data retained' : entry.purge.status === 'unknown' ? 'Cleanup result is unknown' : 'Cleanup in progress'}</strong><p>{entry.purge.warning || 'This original deletion intent is kept. Completed or uncertain cleanup is not repeated by reading this list.'}</p><small>Action {entry.purge.purgeId}</small></aside> : null}
      {entry.profile.folderId && !folders.some(value => value.id === entry.profile.folderId) ? <p>The original folder was removed. Choose a folder or restore unfiled.</p> : null}
      <label>Restore to<select aria-label={`Restore folder for ${entry.profile.label}`} value={folder[entry.id] ?? ''} disabled={Boolean(busy[entry.id])} onChange={event => setFolder(current => ({ ...current, [entry.id]: event.target.value }))}>
        <option value="">Original folder</option><option value="unfiled">Unfiled</option>{folders.map(value => <option value={value.id} key={value.id}>{value.label}</option>)}
      </select></label>
      <Button type="button" variant="primary" disabled={Boolean(busy[entry.id])} onClick={() => void restore(entry)}>{busy[entry.id] ? 'Working…' : `Restore ${entry.profile.label}`}</Button>
      {!entry.purge ? <div className="browser-profile-trash__cleanup">
        <label>Retention<select aria-label={`Retention for ${entry.profile.label}`} value={days[entry.id] ?? 7} disabled={Boolean(busy[entry.id])} onChange={event => setDays(current => ({ ...current, [entry.id]: Number(event.target.value) }))}><option value={7}>7 days from approval</option><option value={30}>30 days from approval</option></select></label>
        <Button type="button" disabled={Boolean(busy[entry.id] || confirm && (busy[confirm.entry.id] || confirm.uncertain))} onClick={event => { confirmationTrigger.current = event.currentTarget; setConfirm({ entry, purgeId: mintObjectId(), deleteAfter: Date.now() + (days[entry.id] ?? 7) * 86_400_000 }) }}>Approve expiry</Button>
        {entry.retention ? <Button type="button" disabled={Boolean(busy[entry.id])} onClick={() => void keep(entry)}>Keep indefinitely</Button> : null}
        <Button type="button" variant="danger" disabled={Boolean(busy[entry.id] || confirm && (busy[confirm.entry.id] || confirm.uncertain))} onClick={event => { confirmationTrigger.current = event.currentTarget; setConfirm({ entry, purgeId: mintObjectId() }) }}>Delete permanently</Button>
      </div> : null}
    </article>)}
      {confirm ? <div className="browser-profile-editor__confirm" role="alertdialog" aria-label={confirm.uncertain ? `Check original action for ${confirm.entry.profile.label}` : `Permanently delete ${confirm.entry.profile.label}`}
        onKeyDown={event => { if (event.key === 'Escape' && !busy[confirm.entry.id]) { event.preventDefault(); event.stopPropagation(); closeConfirmation() } }}>
        <strong>{confirm.uncertain ? `Result not confirmed for ${confirm.entry.profile.label}` : confirm.deleteAfter === undefined ? `Delete ${confirm.entry.profile.label} permanently?` : `Approve deletion of ${confirm.entry.profile.label} after ${new Date(confirm.deleteAfter).toLocaleDateString()}?`}</strong>
        <p>{confirm.uncertain ? 'The original request may already have applied. Check this action before another deletion. Site data cannot be restored after cleanup finishes.' : 'This removes this Profile’s retained site data and saved settings. It cannot be undone after cleanup finishes. If its storage is still open, cleanup waits for a later App process.'}</p>
        <small>Action {confirm.purgeId}</small>
        <div><Button ref={cancel} type="button" disabled={Boolean(busy[confirm.entry.id])} onClick={closeConfirmation}>{confirm.uncertain ? 'Close confirmation' : 'Cancel'}</Button>{!confirm.uncertain ? <Button type="button" variant="danger" disabled={Boolean(busy[confirm.entry.id])} onClick={() => void confirmDeletion()}>{confirm.deleteAfter === undefined ? 'Confirm permanent deletion' : 'Confirm retention deadline'}</Button> : null}</div>
        {confirm.uncertain ? <p role="status">{confirm.uncertain} <Button type="button" variant="primary" onClick={() => void inspectOriginal()}>Check original action</Button></p> : null}
      </div> : null}
    {list?.legacyPendingDeletes.length ? <aside className="browser-profiles-settings__service" role="status"><strong>Earlier cleanup is unconfirmed</strong><p>These earlier deletions have no complete saved Profile record. Their remaining original data is kept. They are not listed as restorable Profiles; no automatic cleanup will run.</p><ul>{list.legacyPendingDeletes.map(id => <li key={id}>Profile {id}</li>)}</ul></aside> : null}
  </section>
}
