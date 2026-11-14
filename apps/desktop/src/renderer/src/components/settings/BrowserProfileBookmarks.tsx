import { NativeSelect, TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { assertBrowserProfileBookmarkTarget, parseBrowserProfileBookmarkResult, type BrowserProfileBookmark, type BrowserProfileBookmarkFolder, type BrowserProfileBookmarkList, type BrowserProfileBookmarkPayload, type BrowserProfileBookmarkReceipt, type BrowserProfileBookmarkChange } from '@agentmux/core/control'
import type { AgentMuxBrowserTarget } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserProfileSummary } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import './settings-browser-profile-bookmarks.css'

type Draft = { kind: 'bookmark' | 'folder' | 'rename' | 'remove' | 'remove-folder' | 'move' | 'move-folder' | 'export'; revision: string; folderId: string | null; title: string; url: string; originalUrl?: string; id?: string; destination?: string; operationId?: string }
type Operation = { operationId: string; receipt?: BrowserProfileBookmarkReceipt; unknown?: boolean; refused?: string; kind?: BrowserProfileBookmarkReceipt['kind']; entryId?: string; browserId?: string }
/** Only a projection of the original Profile library and its durable operation receipts. */
export function BrowserProfileBookmarks({ profile, active = true }: { profile: BrowserProfileSummary; active?: boolean }) {
  const [open, setOpen] = useState(false), [folderId, setFolderId] = useState<string | null>(null)
  const [library, setLibrary] = useState<BrowserProfileBookmarkList | null>(null), [draft, setDraft] = useState<Draft | null>(null)
  const [targets, setTargets] = useState<AgentMuxBrowserTarget[]>([]), [browserId, setBrowserId] = useState(''), [targetError, setTargetError] = useState<string | null>(null)
  const [operations, setOperations] = useState<Operation[]>([]), [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState<string | null>(null)
  const mounted = useRef(true), generation = useRef(0), scope = useRef({ profileId: profile.id, folderId }), listRef = useRef<HTMLUListElement>(null), cancelRef = useRef<HTMLButtonElement>(null), originRef = useRef<HTMLElement | null>(null)
  scope.current = { profileId: profile.id, folderId }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  useEffect(() => { if (draft?.kind === 'remove' || draft?.kind === 'remove-folder') cancelRef.current?.focus() }, [draft?.kind])
  const closeDraft = () => { setDraft(null); if (originRef.current?.isConnected) originRef.current.focus() }
  const remember = (operation: Operation) => setOperations(current => [...current.filter(item => item.operationId !== operation.operationId), operation])
  const read = async (id = folderId, operationId?: string) => {
    const request = { operation: 'browser.profile.bookmark.ls' as const, profileId: profile.id, folderId: id, ...(operationId ? { operationId } : {}) }
    const ticket = ++generation.current
    setReading(true)
    try {
      const result = parseBrowserProfileBookmarkResult(request.operation, await api.browser.listProfileBookmarks(profile.id, id, operationId))
      assertBrowserProfileBookmarkTarget(request, result)
      if (!mounted.current || ticket !== generation.current || scope.current.profileId !== profile.id) return
      if (result.operation !== 'browser.profile.bookmark.ls') return
      setLibrary(result); setFolderId(id); setError(null)
      if (operationId) {
        remember({ operationId, ...(result.receipt ? { receipt: result.receipt } : { unknown: true }) })
        if (result.receipt?.status === 'completed') setDraft(value => value?.operationId === operationId ? null : value)
      }
    } catch (cause) { if (mounted.current && ticket === generation.current) setError(presentError(cause)) }
    finally { if (mounted.current && ticket === generation.current) setReading(false) }
  }
  const readTargets = async () => {
    try {
      const result = await api.browser.listTargets()
      if (!mounted.current) return
      setTargets(result.targets.filter(target => target.profile?.id === profile.id)); setTargetError(result.coverage === 'partial' ? result.warning ?? 'Browser discovery is incomplete. Existing choices are kept.' : null)
    } catch { if (mounted.current) setTargetError('Browser discovery is unavailable. Refresh Browsers to read the original targets again.') }
  }
  useEffect(() => {
    if (!open || !active) return
    void read(); void readTargets()
    return api.browser.onTargetsChanged(() => { void readTargets() })
  }, [open, active, profile.id])
  const current = library?.folderId === folderId ? library : null
  const perform = async (request: Exclude<BrowserProfileBookmarkPayload, { operation: 'browser.profile.bookmark.ls' }>, action: () => Promise<unknown>) => {
    setBusy(true); setError(null); remember({ operationId: request.operationId, unknown: true, kind: request.operation.split('.').at(-1) as BrowserProfileBookmarkReceipt['kind'], ...('bookmarkId' in request ? { entryId: request.bookmarkId, browserId: request.browserId } : {}) })
    try {
      const result = parseBrowserProfileBookmarkResult(request.operation, await action())
      assertBrowserProfileBookmarkTarget(request, result)
      if (!mounted.current || scope.current.profileId !== request.profileId || result.operation === 'browser.profile.bookmark.ls') return
      remember({ operationId: request.operationId, receipt: result.receipt })
      if (result.receipt.status === 'completed') setDraft(null)
      await read(scope.current.folderId)
    } catch (cause) {
      if (!mounted.current) return
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'BROWSER_PROFILE_BOOKMARK_REFUSED') {
        const reason = presentError(cause)
        remember({ operationId: request.operationId, refused: reason })
        setDraft(value => { if (value?.operationId !== request.operationId) return value; const { operationId: _submitted, ...editable } = value; return editable })
        setError(null)
      } else setError(`The original operation is unconfirmed. Check its receipt before repeating it. ${presentError(cause)}`)
    }
    finally { if (mounted.current) setBusy(false) }
  }
  const edit = (change: BrowserProfileBookmarkChange, revision: string) => {
    const operationId = mintObjectId()
    setDraft(value => value ? { ...value, operationId } : value)
    return perform({ operation: 'browser.profile.bookmark.edit', profileId: profile.id, expectedRevision: revision, operationId, change }, () => api.browser.editProfileBookmark(profile.id, revision, operationId, change))
  }
  const begin = (kind: Draft['kind'], entry?: BrowserProfileBookmark | BrowserProfileBookmarkFolder) => {
    if (!current) return
    originRef.current = document.activeElement as HTMLElement
    setDraft({ kind, revision: current.revision, folderId, title: entry ? 'title' in entry ? entry.title : entry.label : '', url: entry && 'url' in entry ? entry.url : '', ...(entry ? { id: entry.id } : {}), ...(entry && 'url' in entry ? { originalUrl: entry.url } : {}) })
  }
  const submit = async () => {
    if (!draft || draft.operationId) return
    if (draft.kind === 'export') {
      if (!draft.destination) return
      const operationId = mintObjectId(), destinationPath = `${draft.destination}/${draft.title}`
      setDraft(value => value ? { ...value, operationId } : value)
      await perform({ operation: 'browser.profile.bookmark.export', profileId: profile.id, folderId: draft.folderId, expectedRevision: draft.revision, operationId, destinationPath }, () => api.browser.exportProfileBookmarks(profile.id, draft.folderId, draft.revision, operationId, destinationPath)); return
    }
    const change: BrowserProfileBookmarkChange = draft.kind === 'bookmark' ? { kind: 'save', ...(draft.id ? { id: draft.id } : {}), folderId: draft.folderId, title: draft.title, ...(draft.url === draft.originalUrl ? {} : { url: draft.url }) }
      : draft.kind === 'folder' ? { kind: 'create-folder', parentId: draft.folderId, label: draft.title }
      : draft.kind === 'rename' ? { kind: 'rename-folder', id: draft.id!, label: draft.title }
      : draft.kind === 'move' ? { kind: 'save', id: draft.id!, folderId, title: draft.title }
      : draft.kind === 'move-folder' ? { kind: 'move-folder', id: draft.id!, parentId: folderId }
      : { kind: draft.kind === 'remove-folder' ? 'remove-folder' : 'remove', id: draft.id! }
    await edit(change, draft.revision)
  }
  const importFile = async () => {
    if (!current) return
    const revision = current.revision, originalFolder = folderId, originalProfile = profile.id
    const sourcePath = (await api.ui.chooseFiles())?.[0]
    if (!sourcePath || !mounted.current || scope.current.profileId !== originalProfile) return
    const operationId = mintObjectId()
    await perform({ operation: 'browser.profile.bookmark.import', profileId: originalProfile, folderId: originalFolder, expectedRevision: revision, operationId, sourcePath }, () => api.browser.importProfileBookmarks(originalProfile, originalFolder, revision, operationId, sourcePath))
  }
  const openBookmark = async (entry: BrowserProfileBookmark) => {
    if (!current) return
    if (!browserId) { setError('Choose this Profile’s Browser before opening a bookmark.'); return }
    const operationId = mintObjectId(), revision = current.revision, selectedBrowser = browserId
    await perform({ operation: 'browser.profile.bookmark.open', profileId: profile.id, bookmarkId: entry.id, browserId: selectedBrowser, expectedRevision: revision, operationId }, () => api.browser.openProfileBookmark(profile.id, entry.id, selectedBrowser, revision, operationId))
  }
  const keys = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const nodes = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-bookmark-entry]') ?? [])], index = nodes.indexOf(document.activeElement as HTMLButtonElement)
    if (!nodes.length) return
    event.preventDefault()
    nodes[event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + nodes.length) % nodes.length]?.focus()
  }
  const receipts: Operation[] = [...operations].reverse().concat((library?.pending ?? []).filter(item => !operations.some(op => op.operationId === item.operationId)).map(receipt => ({ operationId: receipt.operationId, receipt })))
  const unconfirmed = (kind: BrowserProfileBookmarkReceipt['kind'], entryId?: string, targetBrowserId?: string) => receipts.some(item => (item.unknown || item.receipt?.status === 'pending') && (item.receipt?.kind ?? item.kind) === kind && (entryId === undefined || (item.receipt?.entryId ?? item.entryId) === entryId) && (targetBrowserId === undefined || (item.receipt?.browserId ?? item.browserId) === targetBrowserId))
  const moving = draft?.kind === 'move' || draft?.kind === 'move-folder'
  const removing = draft?.kind === 'remove' || draft?.kind === 'remove-folder'
  const draftValid = !!draft && (moving || removing || (draft.title.trim() && (draft.kind !== 'bookmark' || draft.url.trim()) && (draft.kind !== 'export' || draft.destination && !/[\\/]/u.test(draft.title))))
  return <section className="browser-profile-editor__section profile-bookmarks" aria-label="Bookmarks">
    <button type="button" className="profile-bookmarks__heading" aria-expanded={open} onClick={() => setOpen(value => !value)}><span aria-hidden="true">{open ? '⌄' : '›'}</span> Bookmarks</button>
    {open ? <div className="profile-bookmarks__body">
      <p className="browser-profile-editor__quiet">Saved in {profile.label}. Workspace .webloc files stay in their original folders.</p>
      <nav className="profile-bookmarks__crumbs" aria-label="Bookmark folder"><button type="button" disabled={reading} onClick={() => void read(null)}>All bookmarks</button>{library?.ancestors.map(entry => <span key={entry.id}> / <button type="button" disabled={reading} onClick={() => void read(entry.id)}>{entry.label}</button></span>)}</nav>
      <div className="profile-bookmarks__actions"><button type="button" disabled={!current || busy} onClick={() => begin('bookmark')}>New bookmark</button><button type="button" disabled={!current || busy} onClick={() => begin('folder')}>New folder</button><button type="button" disabled={!current || busy} onClick={() => void importFile().catch(cause => setError(presentError(cause)))}>Import…</button><button type="button" disabled={!current || busy} onClick={() => { begin('export'); setDraft(value => value && { ...value, title: 'bookmarks.html' }) }}>Export…</button><button type="button" disabled={reading} onClick={() => void read()}>Refresh library</button></div>
      <div className="profile-bookmarks__browser"><label>Open in Browser<NativeSelect aria-label="Bookmark Browser" value={browserId} onChange={event => setBrowserId(event.target.value)}><option value="">Choose this Profile’s Browser</option>{browserId && !targets.some(target => target.id === browserId) ? <option value={browserId}>Previously selected · {browserId} · absent from latest list</option> : null}{targets.map(target => <option key={target.id} value={target.id}>{target.title || 'Browser'} · {target.id}</option>)}</NativeSelect></label><button type="button" onClick={() => void readTargets()}>Refresh Browsers</button></div>
      {!targets.length ? <p className="browser-profile-editor__quiet">Open a Browser from this Profile’s header, then refresh Browsers.</p> : null}
      {targetError ? <p className="profile-bookmarks__issue" role="status">{targetError}</p> : null}
      {reading ? <p role="status" className="browser-profile-editor__quiet">Reading this folder…</p> : null}
      {current ? <ul ref={listRef} className="profile-bookmarks__list" aria-label="Saved bookmarks and folders" onKeyDown={keys}>
        {current.folders.map(entry => <li key={entry.id}><button type="button" data-bookmark-entry className="profile-bookmarks__entry" onClick={() => void read(entry.id)}><span aria-hidden="true">▸</span><strong>{entry.label}</strong><span className="profile-bookmarks__meta">Folder</span></button><div className="profile-bookmarks__actions"><button type="button" disabled={busy} onClick={() => begin('rename', entry)}>Rename</button><button type="button" disabled={busy} onClick={() => begin('move-folder', entry)}>Move</button><button type="button" disabled={busy} onClick={() => begin('remove-folder', entry)}>Remove empty folder</button></div></li>)}
        {current.bookmarks.map(entry => <li key={entry.id}><button type="button" data-bookmark-entry className="profile-bookmarks__entry" disabled={busy || unconfirmed('open', entry.id, browserId)} onClick={() => void openBookmark(entry)} title={browserId ? 'Open bookmark in the selected Browser' : 'Choose a Browser above'}><strong>{entry.title}</strong><span className="profile-bookmarks__address">{entry.url}</span></button><div className="profile-bookmarks__actions"><button type="button" disabled={busy} onClick={() => begin('bookmark', entry)}>Edit</button><button type="button" disabled={busy} onClick={() => begin('move', entry)}>Move</button><button type="button" disabled={busy} onClick={() => begin('remove', entry)}>Remove</button></div></li>)}
        {!current.folders.length && !current.bookmarks.length ? <li className="browser-profile-editor__quiet">This folder is empty.</li> : null}
      </ul> : null}
      {draft ? <form className="profile-bookmarks__draft" aria-label="Bookmark edit" onKeyDown={event => { if (event.key === 'Escape' && !isImeOwnedKeyboardEvent(event) && !busy) { event.preventDefault(); closeDraft() } }} onSubmit={event => { event.preventDefault(); void submit() }}>
        <strong>{moving ? `Move “${draft.title}”` : removing ? `Remove “${draft.title}”?` : draft.kind === 'export' ? 'Export this folder' : draft.kind === 'folder' ? 'New folder' : draft.kind === 'rename' ? 'Rename folder' : draft.id ? 'Edit bookmark' : 'New bookmark'}</strong>
        {draft.operationId ? <p>Submitted as <code>{draft.operationId}</code>. Check this original operation below before another save.</p> : null}
        {moving ? <p>Browse to the destination above, then choose Move here. The original revision remains selected.</p> : removing ? <p>{draft.kind === 'remove-folder' ? 'Only an empty folder can be removed.' : 'The saved bookmark will be removed from this Profile.'}</p> : <>
          <label>{draft.kind === 'export' ? 'New file name' : 'Title'}<TextInput autoFocus disabled={!!draft.operationId} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
          {draft.kind === 'bookmark' ? <label>Address<TextInput aria-label="Bookmark address" disabled={!!draft.operationId} type="text" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} /></label> : null}
          {draft.kind === 'export' ? <><button type="button" onClick={() => void api.ui.chooseDirectory().then(path => { if (path && mounted.current) setDraft(value => value === draft ? { ...draft, destination: path } : value) }).catch(cause => { if (mounted.current) setError(presentError(cause)) })}>Choose destination folder…</button><span className="profile-bookmarks__meta">{draft.destination ? 'Destination selected. Existing files are kept.' : 'Choose a folder; a new HTML file will be created.'}</span></> : null}
        </>}
        <div className="profile-bookmarks__actions"><button type="button" ref={cancelRef} disabled={busy} onClick={closeDraft}>Cancel</button>{current && draft.revision !== current.revision && !draft.operationId ? <button type="button" onClick={() => setDraft({ ...draft, revision: current.revision })}>Use current library revision</button> : null}<button type="submit" className="profile-bookmarks__primary" disabled={busy || !draftValid || !!draft.operationId}>{moving ? 'Move here' : removing ? draft.kind === 'remove-folder' ? 'Remove empty folder' : 'Remove bookmark' : draft.kind === 'export' ? 'Export new file' : 'Save'}</button></div>
      </form> : null}
      {error ? <p className="profile-bookmarks__issue" role="alert">{error} <button type="button" disabled={reading} onClick={() => void read()}>Read current folder</button></p> : null}
      {receipts.map(item => <div key={item.operationId} className={`profile-bookmarks__receipt${item.unknown || item.receipt?.status === 'pending' ? ' profile-bookmarks__issue' : ''}`} role={item.refused ? 'alert' : 'status'}>
        <strong>{item.refused ? 'Operation not submitted' : item.unknown || item.receipt?.status === 'pending' ? 'Original operation unconfirmed' : item.receipt?.status === 'failed' ? 'Operation failed' : item.receipt?.kind === 'open' ? 'Open request sent' : 'Operation completed'}</strong>
        <code>{item.operationId}</code>{item.refused ? <p>{item.refused} Your inputs are available to correct and save.</p> : null}
        {item.unknown || item.receipt?.status === 'pending' ? <p>Check the original operation before repeating it. No action is replayed automatically.</p> : null}
        {item.receipt ? <><span className="profile-bookmarks__meta">{item.receipt.kind}{item.receipt.createdIds.length ? ` · ${item.receipt.createdIds.length} created` : ''}</span><details className="profile-bookmarks__meta"><summary>Original target and revision</summary><p>Profile: {profile.id}</p>{item.receipt.folderId !== undefined ? <p>Folder: {item.receipt.folderId ?? 'All bookmarks'}</p> : null}{item.receipt.entryId ? <p>Entry: {item.receipt.entryId}</p> : null}{item.receipt.browserId ? <p>Browser: {item.receipt.browserId}</p> : null}<p>Library revision: {item.receipt.expectedRevision}</p>{item.receipt.entryRevision ? <p>Entry revision: {item.receipt.entryRevision}</p> : null}</details>{item.receipt.conflicts.map(conflict => <p key={conflict.index}>Import entry {conflict.index + 1}: {conflict.reason}. Existing entries kept.</p>)}{item.receipt.warning ? <p>{item.receipt.warning}</p> : null}</> : null}
        {!item.refused ? <button type="button" disabled={reading} onClick={() => void read(folderId, item.operationId)}>Check original operation</button> : null}
      </div>)}
    </div> : null}
  </section>
}
