import { NativeSelect, TextInput } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserProfileExtension, BrowserProfileExtensionReview, BrowserProfileExtensionPending, BrowserProfileExtensionInputSource, BrowserProfileExtensionUpdateCheck } from '@agentmux/core/control'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import { browserProfiles } from '../../lib/browser-profiles'
import './settings-browser-profile-extensions.css'
const ExtensionIcon = semanticIconComponent('action.create')
const RefreshIcon = semanticIconComponent('action.refresh')

/** A view of the original Profile extension owner; only the pending human-readable review is local. */
export function BrowserProfileExtensions({ profile }: { profile: BrowserProfileSummary }) {
  const [open, setOpen] = useState(false), [entries, setEntries] = useState<BrowserProfileExtension[]>([]), [review, setReview] = useState<BrowserProfileExtensionReview | null>(null)
  const [online, setOnline] = useState(false), [onlineKind, setOnlineKind] = useState<'package-url' | 'update-manifest'>('package-url')
  const [onlineUrl, setOnlineUrl] = useState(''), [addonId, setAddonId] = useState('')
  const [onlineExtensionId, setOnlineExtensionId] = useState<string | undefined>()
  const [updates, setUpdates] = useState<Record<string, BrowserProfileExtensionUpdateCheck>>({})
  const [pending, setPending] = useState<BrowserProfileExtensionPending[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null)
  const revision = useRef(profile.revision), mounted = useRef(true), latest = useRef(profile)
  latest.current = profile
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refresh = async () => {
    const result = await api.browser.listProfileExtensions(profile.id)
    if (mounted.current && latest.current.id === result.profileId) {
      setEntries(result.extensions); setPending(result.pending); revision.current = result.profileRevision
      setUpdates(current => Object.fromEntries(Object.entries(current).filter(([id, check]) => check.profileRevision === result.profileRevision && !result.pending.some(intent => intent.extensionId === id) && result.extensions.some(entry => entry.id === id && entry.version === check.currentVersion))))
    }
  }
  useEffect(() => { if (open) void refresh().catch(cause => { if (mounted.current) setError(presentError(cause)) }) }, [open, profile.id, profile.revision])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null)
    try { await action() }
    catch (cause) { if (mounted.current) setError(presentError(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const choose = async (kind: 'directory' | 'package', extensionId?: string) => {
    const path = kind === 'directory' ? await api.ui.chooseDirectory() : (await api.ui.chooseFiles())?.[0]
    if (!path || !mounted.current) return
    const operationId = mintObjectId()
    const prepared = await api.browser.prepareProfileExtension(profile.id, revision.current, operationId, { kind: 'local', path }, extensionId)
    if (mounted.current && latest.current.id === prepared.profileId) setReview(prepared)
  }
  const prepareOnline = async () => {
    const source: BrowserProfileExtensionInputSource = onlineKind === 'package-url' ? { kind: onlineKind, url: onlineUrl.trim() } : { kind: onlineKind, url: onlineUrl.trim(), addonId: addonId.trim() }
    const prepared = await api.browser.prepareProfileExtension(profile.id, revision.current, mintObjectId(), source, onlineExtensionId)
    if (mounted.current && latest.current.id === prepared.profileId) { setReview(prepared); setOnline(false) }
  }
  const checkUpdate = async (extensionId: string) => {
    const check = await api.browser.checkProfileExtensionUpdate(profile.id, extensionId)
    if (mounted.current && latest.current.id === check.profileId) setUpdates(current => ({ ...current, [extensionId]: check }))
  }
  const prepareUpdate = async (check: BrowserProfileExtensionUpdateCheck) => {
    const prepared = await api.browser.prepareProfileExtension(profile.id, check.profileRevision, mintObjectId(), { kind: 'installed-update' }, check.extensionId)
    if (mounted.current && latest.current.id === prepared.profileId) setReview(prepared)
  }
  const apply = async () => {
    if (!review) return
    const result = await api.browser.applyProfileExtension(profile.id, review.expectedRevision, review.reviewId)
    if (!mounted.current) return
    if (result.outcome === 'cancelled') { setNotice('Nothing changed. The prepared package remains available for review.'); return }
    setReview(null); setNotice('Extension saved. Load status is shown with the installed item.'); await refresh(); await browserProfiles.refresh()
  }
  return <section className="browser-profile-editor__section browser-profile-extensions" aria-label="Extensions">
    <button type="button" className="browser-profile-extensions__heading" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span aria-hidden="true">{open ? '⌄' : '›'}</span><span className="browser-profile-extensions__title">Extensions</span>{open && entries.length ? <span>{entries.length}</span> : null}
    </button>
    {open ? <div className="browser-profile-extensions__body">
      <p className="browser-profile-editor__quiet">Approved packages run only in this Profile. Host support varies; loaded does not mean every Chrome API works.</p>
      <div className="browser-profile-extensions__actions">
        <button type="button" disabled={busy} onClick={() => void run(() => choose('package'))}><ExtensionIcon size={13} /> Add package…</button>
        <button type="button" disabled={busy} onClick={() => { setOnlineExtensionId(undefined); setOnline(value => !value) }} aria-expanded={online}>From URL…</button>
        <button type="button" disabled={busy} onClick={() => void run(() => choose('directory'))}>Unpacked directory…</button>
        <button type="button" disabled={busy} onClick={() => void run(refresh)} aria-label="Refresh extension load state"><RefreshIcon size={13} /></button>
      </div>
      {online ? <form className="browser-profile-extensions__online" aria-label="Prepare online extension" onSubmit={event => { event.preventDefault(); void run(prepareOnline) }}>
        {onlineExtensionId ? <strong>Update the selected extension</strong> : null}
        <label>Source<NativeSelect aria-label="Online extension source" disabled={busy} value={onlineKind} onChange={event => setOnlineKind(event.target.value as typeof onlineKind)}><option value="package-url">Package URL</option><option value="update-manifest">Update manifest</option></NativeSelect></label>
        <label>HTTPS address<TextInput type="url" autoComplete="off" spellCheck={false} required disabled={busy} value={onlineUrl} onChange={event => setOnlineUrl(event.target.value)} placeholder="https://…" /></label>
        {onlineKind === 'update-manifest' ? <label>Add-on ID<TextInput required autoComplete="off" spellCheck={false} disabled={busy} value={addonId} onChange={event => setAddonId(event.target.value)} /></label> : null}
        <p className="browser-profile-editor__quiet">Downloads use no website sign-in. Preparing a package does not install it.</p>
        <div className="browser-profile-extensions__actions"><button type="button" disabled={busy} onClick={() => setOnline(false)}>Cancel</button><button type="submit" disabled={busy || !onlineUrl.trim() || onlineKind === 'update-manifest' && !addonId.trim()}>Prepare for review</button></div>
      </form> : null}
      {pending.map(intent => <div key={intent.operationId} className="browser-profile-extensions__issue" role="status"><p>Extension {intent.kind} v{intent.version} remains unconfirmed. Original packages and Profile data are kept.</p><details><summary>Original operation</summary><code>{intent.operationId}</code><p>Inspect this operation before another action. It will not be replayed automatically.</p></details></div>)}
      {!entries.length && !review && !error ? <p className="browser-profile-editor__quiet">No managed extensions in this Profile.</p> : null}
      {entries.length ? <ul className="browser-profile-extensions__list">{entries.map(entry => <li key={entry.id}>
        <div className="browser-profile-extensions__identity"><strong>{entry.name}</strong><span>v{entry.version}</span><span data-state={entry.application.state}>{entry.application.state === 'loaded' ? 'Loaded' : entry.application.state === 'failed' ? 'Load failed' : 'Load unknown'}</span></div>
        <p className="browser-profile-editor__quiet">{entry.source.label}</p>
        {entry.application.reason ? <p className="browser-profile-extensions__issue">{entry.application.reason}</p> : null}
        <div className="browser-profile-extensions__actions">
          {entry.application.state !== 'loaded' ? <button type="button" disabled={busy} onClick={() => void run(async () => { await api.browser.loadProfileExtension(profile.id, entry.id); await refresh() })}>Load</button> : null}
          <button type="button" disabled={busy} onClick={() => void run(() => checkUpdate(entry.id))}>Check for updates</button>
          <button type="button" disabled={busy} onClick={() => { setOnlineExtensionId(entry.id); setOnlineKind('update-manifest'); setOnlineUrl(''); setAddonId(entry.nativeId); setOnline(true) }}>Choose update source…</button>
          <button type="button" disabled={busy} onClick={() => void run(() => choose('package', entry.id))}>Update package…</button>
          <button type="button" disabled={busy} onClick={() => void run(() => choose('directory', entry.id))}>Update directory…</button>
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            const result = await api.browser.removeProfileExtension(profile.id, revision.current, entry.id, mintObjectId())
            if (result.outcome === 'applied') { setNotice('Extension removed. Profile sign-ins and site data remain.'); await refresh(); await browserProfiles.refresh() }
          })}>Remove…</button>
        </div>
        <ExtensionUpdateStatus check={updates[entry.id]} busy={busy} onPrepare={check => void run(() => prepareUpdate(check))} />
        <details><summary>Source and permissions</summary><ExtensionScope item={entry} /></details>
      </li>)}</ul> : null}
      {review ? <div className="browser-profile-extensions__review" role="region" aria-label="Extension source and permission review">
        <strong>{review.previousVersion ? 'Review update' : 'Review installation'} · {review.name}</strong>
        <p>{review.previousVersion ? `v${review.previousVersion} → ` : ''}v{review.version} · {review.source.label}</p>
        <ExtensionScope item={review} />
        {review.previousVersion ? <p className="browser-profile-extensions__scope">{review.addedPermissions.length ? `Added scope: ${review.addedPermissions.join(' · ')}` : 'No added permission scope.'}</p> : null}
        <p className="browser-profile-editor__quiet">The host asks you to confirm these exact bytes and permissions. File access stays off.</p>
        <div className="browser-profile-extensions__actions"><button type="button" disabled={busy} onClick={() => setReview(null)}>Close review</button>
          <button type="button" className="browser-profile-extensions__primary" disabled={busy} onClick={() => void run(apply)}>{review.previousVersion ? 'Review and update…' : 'Review and install…'}</button></div>
      </div> : null}
      {notice ? <p className="browser-profile-extensions__notice" role="status">{notice}</p> : null}
      {error ? <p className="browser-profile-extensions__issue" role="alert">{error} <button type="button" disabled={busy} onClick={() => void run(refresh)}>Read current state</button></p> : null}
    </div> : null}
  </section>
}
function ExtensionUpdateStatus({ check, busy, onPrepare }: { check: BrowserProfileExtensionUpdateCheck | undefined; busy: boolean; onPrepare(check: BrowserProfileExtensionUpdateCheck): void }) {
  if (!check) return null
  return <div className="browser-profile-extensions__update" role="status" data-extension-update={check.status}>
    <p>{check.status === 'update-available' ? `Update available · v${check.currentVersion} → v${check.candidateVersion}` : check.status === 'current' ? 'No newer version reported by the original manifest.' : check.status === 'manual' ? 'Choose an update source' : 'Update check unavailable'}</p>
    {check.source ? <small>{check.source.origin} · {check.source.format === 'chromium-xml' ? 'Chromium update manifest' : 'WebExtensions update manifest'}</small> : null}
    {check.reason ? <small>{check.reason}</small> : null}
    {check.status === 'update-available' ? <div className="browser-profile-extensions__actions"><button type="button" disabled={busy} onClick={() => onPrepare(check)}>Prepare update for review</button></div> : null}
  </div>
}
function ExtensionScope({ item }: { item: Pick<BrowserProfileExtensionReview, 'source' | 'permissions' | 'sha256'> }) {
  const rows = [
    ...item.permissions.api.map(value => ['API', value]), ...item.permissions.hosts.map(value => ['Host', value]),
    ...item.permissions.contentScripts.map(value => ['Content', value]), ...item.permissions.optional.map(value => ['Optional', value])]
  return <div className="browser-profile-extensions__scope">
    <p>{item.source.signature === 'package-verified' ? 'Package signature verified. Publisher trust is not established.' : 'Package signature not verified.'}</p>
    {item.source.retrieval ? <p>Downloaded from {item.source.retrieval.origin}{item.source.retrieval.format ? ` · ${item.source.retrieval.format === 'chromium-xml' ? 'Chromium update manifest' : 'WebExtensions update manifest'}` : ''}</p> : null}
    {item.source.homepage ? <p>Homepage: {item.source.homepage}</p> : null}{item.source.updateUrl ? <p>Declared update source: {item.source.updateUrl}</p> : null}
    {rows.length ? <dl>{rows.map(([label, value], index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p>No declared extension permissions.</p>}
    <details><summary>Package identity</summary><code>{item.sha256}</code></details>
  </div>
}
