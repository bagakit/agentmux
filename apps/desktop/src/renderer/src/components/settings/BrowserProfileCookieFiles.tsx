import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { assertBrowserProfileCookieFileTarget, parseBrowserProfileCookieFileResult, type BrowserProfileCookieFilePayload as Request, type BrowserProfileCookieFileReceipt as Receipt, type BrowserProfileCookieImportReview as Review, type BrowserProfileCookieScope as Scope, type BrowserProfileCookieFileItem as Item } from '@agentmux/core/control'
import { Button } from '@agentmux/client-ui/components/Button'
import type { BrowserProfileSummary, BrowserProfileSite } from '../../../../shared/contracts'
import { api } from '../../lib/api'
import './settings-browser-profile-cookie-files.css'

type Draft = { kind: 'import' | 'export'; scopeKind: '' | Scope['kind']; sites: string[]; fileName: string; destinationSelected: boolean; operationId?: string; review?: Review; dispatched?: boolean }
type Operation = { operationId: string; kind: Receipt['kind']; scope: Scope; receipt?: Receipt; unknown?: boolean; refused?: boolean; items?: Item[]; nextOffset?: number | null }
const sameScope = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind === 'profile' || b.kind === 'sites' && a.sites.length === b.sites.length && a.sites.every(site => b.sites.includes(site)))
const wrongScope = () => { throw Object.assign(new Error('The safe receipt changed the original Cookie scope.'), { code: 'CONTROL_PROTOCOL_ERROR' }) }
const scopeLabel = (scope: Scope) => scope.kind === 'profile' ? 'Entire Profile' : scope.sites.join(', ')
const issue = 'The original operation is unconfirmed. Check its original ID before another attempt. No action is repeated automatically.'
const receiptLabel = (receipt: Receipt) => receipt.status === 'pending' ? 'Original operation unconfirmed' : receipt.status === 'cancelled' ? 'Operation cancelled' : receipt.status === 'partial' ? 'Partially completed' : receipt.status === 'failed' ? 'Operation failed' : receipt.kind === 'import' ? 'Cookie import completed' : 'Cookie export completed'
function checked<T extends Request>(request: T, value: unknown) {
  const body = request.operation === 'browser.profile.cookie-file.prepare-import' ? { review: value } : request.operation === 'browser.profile.cookie-file.import' || request.operation === 'browser.profile.cookie-file.export' ? { receipt: value } : value
  const result = parseBrowserProfileCookieFileResult(request.operation, body)
  assertBrowserProfileCookieFileTarget(request, result)
  return result
}
/** Safe projections only. Cookie file bytes, names and values stay with the original Main owner. */
export function BrowserProfileCookieFiles({ profile, active = true }: { profile: BrowserProfileSummary; active?: boolean }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState<Draft | null>(null)
  const [sites, setSites] = useState<BrowserProfileSite[]>([]), [sitesError, setSitesError] = useState(false), [sitesReading, setSitesReading] = useState(false)
  const [operations, setOperations] = useState<Operation[]>([]), [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState<string | null>(null)
  const operationFacts = useRef(operations)
  operationFacts.current = operations
  const identity = useRef({ id: profile.id, generation: 0 }), mounted = useRef(true), readGeneration = useRef(0), cancelRef = useRef<HTMLButtonElement>(null), origin = useRef<HTMLElement | null>(null), destination = useRef<string | null>(null)
  if (identity.current.id !== profile.id) { identity.current = { id: profile.id, generation: identity.current.generation + 1 }; destination.current = null }
  const capture = () => ({ ...identity.current })
  const current = (target: ReturnType<typeof capture>) => mounted.current && target.id === identity.current.id && target.generation === identity.current.generation
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readGeneration.current++ } }, [])
  useEffect(() => { setDraft(null); setOperations([]); setSites([]); setSitesError(false); setSitesReading(false); setBusy(false); setReading(false); setError(null) }, [profile.id])
  useEffect(() => { if (draft) cancelRef.current?.focus() }, [draft?.kind, draft?.review?.reviewId])
  const remember = (operation: Operation) => setOperations(value => [operation, ...value.filter(item => item.operationId !== operation.operationId)])
  const read = async (operationId?: string, offset = 0) => {
    const target = capture(), ticket = ++readGeneration.current
    setReading(true)
    try {
      const request = { operation: 'browser.profile.cookie-file.inspect' as const, profileId: target.id, ...(operationId ? { operationId, offset, limit: 24 } : {}) }
      const result = checked(request, await api.browser.inspectProfileCookieFiles(target.id, operationId, operationId ? offset : undefined, operationId ? 24 : undefined))
      if (!current(target) || ticket !== readGeneration.current || result.operation !== request.operation) return
      for (const receipt of [...result.pending, ...result.recent, ...(result.receipt ? [result.receipt] : [])]) {
        const original = operationFacts.current.find(item => item.operationId === receipt.operationId)
        if (original && (original.kind !== receipt.kind || !sameScope(original.scope, receipt.scope))) wrongScope()
      }
      setOperations(value => {
        const known = new Map(value.map(item => [item.operationId, item]))
        for (const receipt of [...result.recent, ...result.pending]) known.set(receipt.operationId, { ...known.get(receipt.operationId), operationId: receipt.operationId, kind: receipt.kind, scope: receipt.scope, receipt, unknown: false, refused: false })
        if (operationId) {
          const old = known.get(operationId)
          if (result.receipt) known.set(operationId, { operationId, kind: result.receipt.kind, scope: result.receipt.scope, receipt: result.receipt, items: offset ? [...(old?.items ?? []), ...result.items] : result.items, nextOffset: result.nextOffset })
          else if (old) known.set(operationId, { ...old, unknown: true })
        }
        return [...known.values()]
      })
      if (operationId && result.receipt && result.receipt.status !== 'pending') setDraft(value => value?.operationId === operationId ? null : value)
      setError(null)
    } catch { if (current(target) && ticket === readGeneration.current) setError('Cookie operation receipts could not be read. Your choices and original IDs are kept. Read receipts again.') }
    finally { if (current(target) && ticket === readGeneration.current) setReading(false) }
  }
  useEffect(() => { if (open && active) void read(); return () => { readGeneration.current++ } }, [open, active, profile.id])
  const readSites = async () => {
    const target = capture(); setSitesReading(true)
    try { const value = await api.browser.listProfileSites(target.id); if (current(target)) { setSites(value); setSitesError(false) } }
    catch { if (current(target)) setSitesError(true) }
    finally { if (current(target)) setSitesReading(false) }
  }
  const begin = (kind: Draft['kind']) => { origin.current = document.activeElement as HTMLElement; destination.current = null; setError(null); setDraft({ kind, scopeKind: '', sites: [], fileName: 'cookies.json', destinationSelected: false }) }
  const close = () => { destination.current = null; setDraft(null); setError(null); if (origin.current?.isConnected) origin.current.focus() }
  const selectedScope = (): Scope | null => draft?.scopeKind === 'profile' ? { kind: 'profile' } : draft?.scopeKind === 'sites' && draft.sites.length ? { kind: 'sites', sites: [...draft.sites] } : null
  const failure = (cause: unknown, target: ReturnType<typeof capture>, operation: Operation) => {
    if (!current(target)) return
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'BROWSER_PROFILE_COOKIE_FILE_REFUSED') {
      remember({ ...operation, refused: true }); setError('This operation was not submitted. Keep or correct your scope, then select the file again.')
      setDraft(value => { if (value?.operationId !== operation.operationId) return value; const { operationId: _id, review: _review, dispatched: _dispatched, ...editable } = value; return editable })
    } else { remember({ ...operation, unknown: true }); setError(issue) }
  }
  const prepare = async () => {
    const scope = selectedScope(); if (!draft || draft.operationId || !scope) return
    const target = capture(); setBusy(true); setError(null)
    let operation: Operation | undefined
    try {
      const path = (await api.ui.chooseFiles())?.[0]
      if (!path || !current(target)) return
      const operationId = mintObjectId(); operation = { operationId, kind: 'import', scope }
      setDraft(value => value ? { ...value, operationId } : value)
      const request = { operation: 'browser.profile.cookie-file.prepare-import' as const, profileId: target.id, operationId, source: { kind: 'local' as const, path }, scope }
      const result = checked(request, await api.browser.prepareProfileCookieImport(target.id, operationId, request.source, scope))
      if (current(target) && result.operation === request.operation) setDraft(value => value?.operationId === operationId ? { ...value, review: result.review } : value)
    } catch (cause) { if (operation) failure(cause, target, operation); else if (current(target)) setError('File selection is unavailable. Your scope is kept; choose a file again.') }
    finally { if (current(target)) setBusy(false) }
  }
  const submit = async () => {
    const scope = selectedScope(); if (!draft || !scope || draft.dispatched) return
    if (draft.kind === 'import' && !draft.review) { await prepare(); return }
    if (draft.kind === 'export' && (!destination.current || !draft.fileName.trim() || /[\\/\u0000-\u001f]/u.test(draft.fileName) || draft.operationId)) return
    const target = capture(), operationId = draft.review?.reviewId ?? mintObjectId(), operation: Operation = { operationId, kind: draft.kind, scope }
    const request: Request = draft.kind === 'import' ? { operation: 'browser.profile.cookie-file.import', profileId: target.id, reviewId: operationId } : { operation: 'browser.profile.cookie-file.export', profileId: target.id, operationId, destination: { kind: 'local', path: `${destination.current}/${draft.fileName}` }, scope }
    setBusy(true); setError(null); setDraft(value => value ? { ...value, operationId, dispatched: true } : value); remember({ ...operation, unknown: true })
    try {
      const result = checked(request, request.operation === 'browser.profile.cookie-file.import' ? await api.browser.importProfileCookies(target.id, operationId) : await api.browser.exportProfileCookies(target.id, operationId, request.destination, scope))
      if (!current(target) || (result.operation !== 'browser.profile.cookie-file.import' && result.operation !== 'browser.profile.cookie-file.export')) return
      if (!sameScope(scope, result.receipt.scope)) wrongScope()
      remember({ ...operation, receipt: result.receipt }); if (result.receipt.status !== 'pending') close()
    } catch (cause) { failure(cause, target, operation) }
    finally { if (current(target)) setBusy(false) }
  }
  const cancel = async () => {
    if (!draft?.review || draft.dispatched) { close(); return }
    const target = capture(), review = draft.review; setBusy(true)
    try {
      const request = { operation: 'browser.profile.cookie-file.discard' as const, profileId: target.id, reviewId: review.reviewId }
      checked(request, await api.browser.discardProfileCookieImport(target.id, review.reviewId))
      if (current(target)) { close(); await read(review.reviewId) }
    } catch { if (current(target)) setError('The prepared import could not be released. Its original review ID is kept; read its receipt before another attempt.') }
    finally { if (current(target)) setBusy(false) }
  }
  const chooseDestination = async () => {
    const target = capture(), originalDraft = draft
    if (!originalDraft) return
    try { const path = await api.ui.chooseDirectory(); if (path && current(target)) { destination.current = path; setDraft(value => value === originalDraft ? { ...originalDraft, destinationSelected: true } : value) } }
    catch { if (current(target)) setError('Destination selection is unavailable. Your inputs are kept; choose a folder again.') }
  }
  const reveal = async (operationId: string) => {
    const target = capture()
    try { const request = { operation: 'browser.profile.cookie-file.reveal' as const, profileId: target.id, operationId }; const result = checked(request, await api.browser.revealProfileCookieFile(target.id, operationId)); if (current(target) && result.operation === request.operation) setError(result.revealed ? null : 'The original export location could not be revealed. Its receipt is kept.') }
    catch { if (current(target)) setError('The original export location could not be revealed. Read its receipt to check the file outcome.') }
  }
  const scope = selectedScope(), locked = !!draft?.operationId, formValid = !!scope && (draft?.kind === 'import' || draft?.destinationSelected && !!draft.fileName.trim() && !/[\\/\u0000-\u001f]/u.test(draft.fileName))
  const currentUnknown = !!draft?.operationId && operations.some(item => item.operationId === draft?.operationId && (item.unknown || item.receipt?.status === 'pending'))
  const formIssue = error ?? (currentUnknown ? issue : null)
  return <section className="browser-profile-editor__section profile-cookie-files" aria-label="Cookie file exchange">
    <button type="button" className="profile-cookie-files__heading" aria-expanded={open} onClick={() => setOpen(value => !value)}><span aria-hidden="true">{open ? '⌄' : '›'}</span> Cookie file exchange</button>
    {open ? <div className="profile-cookie-files__body">
      <p className="browser-profile-editor__quiet">Import or export a Cookie JSON file for {profile.label}. Files contain sensitive sign-in data. Site authentication is not verified.</p>
      <div className="profile-cookie-files__actions"><Button type="button" data-cookie-action="import" onClick={() => begin('import')} disabled={!!draft}>Import…</Button><Button type="button" data-cookie-action="export" onClick={() => begin('export')} disabled={!!draft}>Export…</Button><Button type="button" disabled={reading} onClick={() => void read()}>Read receipts</Button></div>
      {draft ? <form className="profile-cookie-files__draft" aria-label="Cookie file operation" onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); void cancel() } }}>
        <strong>{draft.kind === 'import' ? 'Import Cookies' : 'Export Cookies'}</strong>
        <label>Cookie scope<select aria-label="Cookie scope" value={draft.scopeKind} disabled={locked || busy} onChange={event => { const scopeKind = event.target.value as Draft['scopeKind']; setDraft({ ...draft, scopeKind }); if (scopeKind === 'sites') void readSites() }}><option value="">Choose a scope</option><option value="profile">Entire Profile</option><option value="sites">Selected sites</option></select></label>
        {draft.scopeKind === 'sites' ? <fieldset disabled={locked || busy}><legend>Sites with sign-ins</legend>{sites.map(site => <label key={site.site} className="profile-cookie-files__site"><input type="checkbox" checked={draft.sites.includes(site.site)} onChange={event => setDraft({ ...draft, sites: event.target.checked ? [...draft.sites, site.site] : draft.sites.filter(value => value !== site.site) })} /><span>{site.site}</span><small>{site.cookies} Cookies</small></label>)}{!sites.length ? <p className="browser-profile-editor__quiet">{sitesReading ? 'Reading site names…' : 'No site names have been read. Choose Entire Profile or read sites again.'}</p> : null}{sitesError ? <p className="profile-cookie-files__issue">Site names could not be read. Existing choices are kept; Entire Profile is available.</p> : null}<Button type="button" disabled={sitesReading} onClick={() => void readSites()}>Read sites again</Button></fieldset> : null}
        {draft.kind === 'export' ? <><label>New file name<input aria-label="Cookie export file name" value={draft.fileName} disabled={locked || busy} onChange={event => setDraft({ ...draft, fileName: event.target.value })} /></label><div className="profile-cookie-files__actions"><Button type="button" disabled={locked || busy} onClick={() => void chooseDestination()}>Choose destination folder…</Button><span className="browser-profile-editor__quiet">{draft.destinationSelected ? 'Destination selected. Existing files are kept.' : 'A new JSON file will be created.'}</span></div></> : null}
        {draft.review ? <div className="profile-cookie-files__review"><strong>File reviewed · {draft.review.total} entries</strong><p>{draft.review.valid} eligible · {draft.review.skipped} skipped</p><p>Scope: {scopeLabel(draft.review.scope)}</p><p className="browser-profile-editor__quiet">The native confirmation will show the exact source and Profile before any Cookies are applied.</p></div> : <p className="browser-profile-editor__quiet">{draft.kind === 'import' ? 'Choose a file to read a safe summary. You will confirm in the native dialog before import.' : 'The native confirmation will show the exact destination and Profile before export.'}</p>}
        {draft.operationId ? <p className="profile-cookie-files__original">Original ID <code>{draft.operationId}</code></p> : null}
        {formIssue ? <p role="alert" className="profile-cookie-files__issue">{formIssue}</p> : null}
        <div className="profile-cookie-files__actions"><Button type="button" ref={cancelRef} disabled={busy} onClick={() => void cancel()}>{draft.dispatched || draft.operationId && !draft.review ? 'Close form' : 'Cancel'}</Button><Button type="submit" variant="primary" data-cookie-submit disabled={busy || !formValid || !!draft.dispatched || locked && !draft.review}>{busy ? 'Waiting for owner…' : draft.review || draft.kind === 'export' ? 'Continue to native confirmation…' : 'Choose file and review…'}</Button></div>
      </form> : null}
      {!draft && error ? <p role="alert" className="profile-cookie-files__issue">{error}</p> : null}
      {reading ? <p role="status" className="browser-profile-editor__quiet">Reading original operation receipts…</p> : null}
      {operations.length ? <div className="profile-cookie-files__history" aria-label="Cookie file receipts">{operations.map(item => <div key={item.operationId} className={`profile-cookie-files__receipt${item.unknown || item.receipt?.status === 'pending' || item.refused ? ' profile-cookie-files__issue' : ''}`} role="status">
        <strong>{item.refused ? 'Operation not submitted' : item.unknown ? 'Original operation unconfirmed' : item.receipt ? receiptLabel(item.receipt) : 'Original operation unconfirmed'}</strong><code>{item.operationId}</code><p>{item.kind === 'import' ? 'Import' : 'Export'} · {scopeLabel(item.scope)}</p>
        {(item.unknown || item.receipt?.status === 'pending') && draft?.operationId !== item.operationId ? <p>{issue}</p> : null}
        {item.receipt ? <><p>{item.receipt.counts.total} total · {item.receipt.counts.applied} {item.kind === 'export' ? 'exported' : 'applied'} · {item.receipt.counts.skipped} skipped · {item.receipt.counts.rejected} rejected · {item.receipt.counts.unknown} unknown · {item.receipt.counts.notAttempted} not attempted</p>{item.kind === 'export' ? <p>{item.receipt.fileOutcome === 'written' ? 'Export file written.' : item.receipt.fileOutcome === 'not-written' ? 'Export file not written.' : 'Export file outcome unknown.'}</p> : null}{item.receipt.warning ? <p>{item.receipt.warning}</p> : null}</> : null}
        <div className="profile-cookie-files__actions"><Button type="button" data-cookie-check={item.operationId} disabled={reading} onClick={() => void read(item.operationId)}>Check original operation</Button>{item.receipt?.kind === 'export' && item.receipt.status !== 'cancelled' ? <Button type="button" onClick={() => void reveal(item.operationId)}>Reveal original export location</Button> : null}</div>
        {item.items?.length ? <details open><summary>Entry outcomes</summary><ol className="profile-cookie-files__items" start={item.items[0]!.index + 1}>{item.items.map(entry => <li key={entry.index}>Entry {entry.index + 1}: {entry.status}{entry.reason ? ` · ${entry.reason}` : ''}</li>)}</ol>{item.nextOffset != null ? <Button type="button" disabled={reading} onClick={() => void read(item.operationId, item.nextOffset!)}>Read more entry outcomes</Button> : null}</details> : null}
      </div>)}</div> : null}
    </div> : null}
  </section>
}
