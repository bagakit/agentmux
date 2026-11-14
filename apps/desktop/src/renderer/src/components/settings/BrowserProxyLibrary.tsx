import { submitProfileCreation, profileCreationObservationNotice } from '../../lib/browser-profile-creations'
import { normalizeBrowserProfileNetwork } from '../../../../shared/browser-profile-network'
import { useEffect, useRef, useState } from 'react'
import { parseBrowserProxyEdit, type BrowserProxyAsset } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { browserProxyDrafts, proxyDraftId, proxyDraftKey, type ProxyLibraryDraft } from '../../lib/browser-proxy-drafts'
import './browser-proxy-library.css'

const fromAsset = (asset?: BrowserProxyAsset): ProxyLibraryDraft => ({ assetId: asset?.id ?? null, baseRevision: asset?.revision ?? null, label: asset?.label ?? '', server: asset?.server ?? '', bypass: asset?.bypass?.join(', ') ?? '', notes: asset?.notes ?? '' })

export function BrowserProxyLibrary({ assets, active }: { assets: BrowserProxyAsset[] | undefined; active: boolean }) {
  const [value, setValue] = useState<ProxyLibraryDraft>(() => fromAsset()), current = useRef(value)
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null), [draftIssue, setDraftIssue] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false), [earlier, setEarlier] = useState(false)
  const interactions = useRef(0)
  const pendingDrafts = useRef(new Map<string, ProxyLibraryDraft>())
  const changed = useRef(false), loading = useRef<Promise<void> | null>(null)
  const asset = assets?.find(item => item.id === value.assetId)
  const put = (next: ProxyLibraryDraft) => { current.current = next; setValue(next) }
  const saveDraft = (next: ProxyLibraryDraft, retain?: ProxyLibraryDraft) => {
    try { browserProxyDrafts.write(next, retain) }
    catch (error) { setDraftIssue(presentError(error)) }
  }
  const checkpointDraft = () => {
    if (!loaded) return
    if (current.current.server.includes('@')) { setDraftIssue('The server draft contains a sign-in and has not been saved to disk. Remove it here and use the Profile sign-in fields.'); return }
    void browserProxyDrafts.checkpoint().then(() => setDraftIssue(null)).catch(error => setDraftIssue(presentError(error)))
  }
  const load = () => {
    if (loading.current) return
    if (loaded) {
      if (current.current.server.includes('@')) { setDraftIssue('The server draft contains a sign-in and has not been saved to disk. Remove it here and use the Profile sign-in fields.'); return }
      loading.current = browserProxyDrafts.checkpoint().then(() => setDraftIssue(null)).catch(error => setDraftIssue(presentError(error))).finally(() => { loading.current = null })
      return
    }
    loading.current = browserProxyDrafts.load().then(() => {
      setLoaded(true); setDraftIssue(null)
      for (const [id, pending] of pendingDrafts.current) saveDraft(pending, browserProxyDrafts.get(id)?.active ?? undefined)
      const original = browserProxyDrafts.get(proxyDraftId(current.current))
      if (!interactions.current && original?.active) put(original.active)
      else if (!changed.current && original?.active) {
        browserProxyDrafts.retainActive(proxyDraftId(current.current))
        void browserProxyDrafts.checkpoint().catch(error => setDraftIssue(presentError(error)))
      }
      setEarlier(Boolean(browserProxyDrafts.get(proxyDraftId(current.current))?.retained.length))
    }).catch(error => setDraftIssue(presentError(error))).finally(() => { loading.current = null })
  }
  useEffect(() => { if (active && !loaded) load() }, [active, loaded])
  const edit = (patch: Partial<ProxyLibraryDraft>) => {
    interactions.current += 1; changed.current = true
    const next = { ...current.current, ...patch }; pendingDrafts.current.set(proxyDraftId(next), next); put(next)
    if (loaded) saveDraft(next)
  }
  const choose = (id: string) => {
    interactions.current += 1
    const next = fromAsset(assets?.find(item => item.id === id)), held = loaded ? browserProxyDrafts.get(id || 'new') : undefined, pending = pendingDrafts.current.get(id || 'new')
    changed.current = Boolean(pending || held?.active); put(pending ?? held?.active ?? next); setEarlier(Boolean(held?.retained.length)); setIssue(null)
  }
  let input: ReturnType<typeof parseBrowserProxyEdit> | undefined
  let problem: string | undefined
  try {
    input = parseBrowserProxyEdit({ label: value.label, server: value.server, bypass: value.bypass.split(/[\s,]+/).filter(Boolean), notes: value.notes })
    normalizeBrowserProfileNetwork({ mode: 'proxy', server: input.server, ...(input.bypass ? { bypass: input.bypass } : {}) })
  }
  catch (error) { input = undefined; problem = presentError(error) }
  const submit = async () => {
    if (!input) return
    interactions.current += 1
    const submitted = structuredClone(current.current); setBusy(true); setIssue(null)
    try {
      const receipt = submitted.assetId === null ? await (async () => {
        const result = await submitProfileCreation({ operation: 'browser.profile.proxy.create', edit: input! })
        const observation = profileCreationObservationNotice(result.creation); if (observation) setIssue(observation)
        const snapshot = await api.browser.readProfiles()
        const proxy = snapshot.proxies?.find(value => value.id === result.creation.receipt!.createdId)
        if (!proxy) throw new Error('The original created proxy is now unavailable. Its creation receipt is retained.')
        return { proxy, revision: snapshot.revision }
      })() : await api.browser.saveProxy(input, submitted.assetId, submitted.baseRevision!)
      if (loaded) { try { browserProxyDrafts.clearSubmitted(submitted); void browserProxyDrafts.checkpoint().catch(error => setDraftIssue(presentError(error))) } catch (error) { setDraftIssue(presentError(error)) } }
      if (pendingDrafts.current.get(proxyDraftId(submitted)) && proxyDraftKey(pendingDrafts.current.get(proxyDraftId(submitted))!) === proxyDraftKey(submitted)) pendingDrafts.current.delete(proxyDraftId(submitted))
      if (proxyDraftKey(current.current) === proxyDraftKey(submitted)) { changed.current = false; put(fromAsset(receipt.proxy)); setEarlier(loaded && Boolean(browserProxyDrafts.get(receipt.proxy.id)?.retained.length)) }
      else if (submitted.assetId !== null && current.current.assetId === submitted.assetId) { const next = { ...current.current, baseRevision: receipt.proxy.revision }; put(next); pendingDrafts.current.set(proxyDraftId(next), next); if (loaded) saveDraft(next) }
    } catch (error) { setIssue(presentError(error)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    const editing = current.current
    if (!editing.assetId || !editing.baseRevision) { setIssue('Choose the original saved proxy version before removing it. Your draft is kept.'); return }
    const original = { id: editing.assetId, revision: editing.baseRevision }; setBusy(true); setIssue(null)
    try { await api.browser.deleteProxy(original.id, original.revision); if (current.current.assetId === original.id && !changed.current) put(fromAsset()) }
    catch (error) { setIssue(presentError(error)) }
    finally { setBusy(false) }
  }
  return <details className="browser-proxy-library">
    <summary>Proxy library <span>{assets?.length ?? '—'}</span></summary>
    <p className="settings-hint">Save a server once, then assign its exact version to selected Profiles. Sign-ins stay with each Profile.</p>
    <label>Saved proxy<select aria-label="Saved proxy asset" value={value.assetId ?? ''} onChange={event => choose(event.target.value)}><option value="">New proxy</option>{value.assetId && !asset ? <option value={value.assetId}>Unavailable saved proxy</option> : null}{assets?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <div className="browser-proxy-library__fields">
      <label>Name<input aria-label="Proxy asset name" value={value.label} maxLength={128} onBlur={checkpointDraft} onChange={event => edit({ label: event.target.value })} /></label>
      <label>Server<input aria-label="Proxy asset server" spellCheck={false} placeholder="http://host:port" value={value.server} onBlur={checkpointDraft} onChange={event => edit({ server: event.target.value })} /></label>
      <label>Don’t proxy<input aria-label="Proxy asset bypass" value={value.bypass} onBlur={checkpointDraft} onChange={event => edit({ bypass: event.target.value })} /></label>
      <label>Notes<textarea aria-label="Proxy asset notes" value={value.notes} maxLength={2000} onBlur={checkpointDraft} onChange={event => edit({ notes: event.target.value })} /></label>
    </div>
    {asset && value.baseRevision !== asset.revision ? <p role="status" className="settings-hint">A different version is in the current library snapshot. Your draft is kept. <button className="small-button" onClick={() => edit({ baseRevision: asset.revision })}>Use current version for this edit</button></p> : null}
    {problem && (value.label || value.server) ? <p role="status" className="browser-proxy-library__issue">{problem}</p> : null}
    <div className="browser-proxy-library__actions"><button className="primary-button" disabled={busy || !input} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save proxy'}</button>{asset ? <button className="small-button" disabled={busy} onClick={() => void remove()}>Remove unused proxy</button> : null}</div>
    <p className="settings-hint">Editing this asset keeps existing Profile routes. Reassign to apply its new version.</p>
    {assets !== undefined && value.assetId && !asset ? <p role="status" className="settings-hint">The original asset is unavailable. Your draft is kept. <button className="small-button" onClick={() => edit({ assetId: null, baseRevision: null })}>Use draft for a new proxy</button></p> : null}
    {issue ? <p role="status" className="browser-proxy-library__issue">{issue}</p> : null}
    {assets === undefined ? <p role="status" className="browser-proxy-library__issue">The proxy library has not been confirmed in this snapshot. Refresh Profiles; your input is kept.</p> : null}
    {draftIssue ? <p role="status" className="browser-proxy-library__issue">Draft storage: {draftIssue} <button className="small-button" onClick={load}>Retry draft storage</button></p> : null}
    {earlier && loaded ? <button className="small-button" onClick={() => { try { const restored = browserProxyDrafts.restore(proxyDraftId(current.current)); changed.current = true; pendingDrafts.current.set(proxyDraftId(restored), restored); put(restored); setEarlier(Boolean(browserProxyDrafts.get(proxyDraftId(restored))?.retained.length)); void browserProxyDrafts.checkpoint().catch(error => setDraftIssue(presentError(error))) } catch (error) { setDraftIssue(presentError(error)) } }}>Restore earlier draft</button> : null}
  </details>
}
