import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { deriveObjectId } from '@agentmux/core/object-id'
import type { CapsuleEmbedInput } from '@agentmux/client-ui'
import type { CapsuleInspection } from '@agentmux/core/capsule'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { BrowserSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import { useWorkbenchBrowserPresentation, type WorkbenchPresentation } from '../lib/workbench-presentation'
import { useWorkbenchWindowDocument } from '../lib/workbench-document'
import { BrowserPresentationStage, useBrowserPresentationCapture, type BrowserStagePresentation } from './BrowserPresentationStage'
import { CapsuleInteractionChrome } from './CapsuleInteractionChrome'

const PageIcon = semanticIconComponent('object.browser')

/** A card owns its presentation only. Content, native document and human input keep their original owners. */
export function ConversationCapsule(input: CapsuleEmbedInput) {
  const owner = useWorkbenchBrowserPresentation()
  const windowDocument = useWorkbenchWindowDocument()
  const anchor = owner.projection?.presentationId ?? owner.reference?.regionId ?? windowDocument?.windowId
  const browserId = useMemo(() => input.presentationKey && anchor ? deriveObjectId('conversation-capsule', JSON.stringify([
    input.presentationKey, owner.surface, anchor
  ])) : null, [input.presentationKey, owner.surface, anchor])
  return browserId ? <CapsulePage key={browserId} {...input} browserId={browserId} owner={owner} />
    : <CapsuleReference {...input} />
}

function CapsuleReference({ uri, title }: CapsuleEmbedInput) {
  const [notice, setNotice] = useState('Page presentation location is unconfirmed. The original page reference is retained.')
  return <div className="conversation-capsule__reference"><strong>{title || 'Saved page'}</strong><code>{uri}</code><span role="status">{notice}</span>
    <button type="button" className="small-button" onClick={() => { void api.ui.openObjectLink(uri).catch(error => setNotice(presentError(error))) }}>Open in Browser</button></div>
}

function CapsulePage({ uri, capsuleId, title, visible, browserId, owner }: CapsuleEmbedInput & { browserId: string; owner: WorkbenchPresentation }) {
  const occurrenceId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState<CapsuleInspection | null>(null)
  const [browser, setBrowser] = useState<BrowserSnapshot | null>(null)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [toolbar, setToolbar] = useState<HTMLSpanElement | null>(null)
  const current = useRef<BrowserSnapshot | null>(null)
  const alive = useRef(true)
  const active = visible && !collapsed
  const currentActivity = useRef(active)
  currentActivity.current = active
  const release = useCallback(() => {
    // Reparenting one live occurrence is not the end of its native document.
    if (alive.current && currentActivity.current) return
    const held = current.current
    if (!held) return
    void api.browser.release(held.id, held.navigationId).then(receipt => {
      if (receipt.browserId !== held.id || receipt.navigationId !== held.navigationId) throw new Error('The original page release returned a different document. The page is retained.')
      if (alive.current && receipt.status === 'unknown') setNotice('Page resource release is unconfirmed. Its original Browser and saved page are retained; return here to reconnect.')
    }).catch(error => { if (alive.current) setNotice(`Page resources are retained. ${presentError(error)}`) })
  }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; release() } }, [release])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let restoredDocument = false
    setLoading(true); setNotice('')
    void (async () => {
      // The native owner's exact existing/released document wins over service observation.
      // A first embed has no cold Region, so an absent owner proceeds through inspect/create below.
      let retained: BrowserSnapshot | null = null
      try { retained = await api.browser.restore(browserId, { workspaceId: null, profileId: null, mode: 'normal', viewport: 'responsive' }) } catch { /* Acquisition below still addresses this same native identity. */ }
      if (retained) {
        if (retained.id !== browserId || retained.capsuleId !== capsuleId) throw new Error('The retained Browser belongs to another page. Its original document is kept.')
        restoredDocument = true
        current.current = retained
        if (cancelled) { release(); return }
        setBrowser(retained)
      }
      if (cancelled) return
      const original = await api.capsules.call('capsule.inspect', { capsuleId })
      if (cancelled) return
      if (original.record.capsuleId !== capsuleId) throw new Error('The original Capsule owner returned a different page. The reference is kept.')
      setPage(original)
      if (original.endpoint.status !== 'available') { setNotice(original.endpoint.issue.message); return }
      if (retained) return
      // Reuse the retained native identity after hidden/released/unknown outcomes. Never Close or mint a replacement.
      const result = await api.browser.create(browserId, original.endpoint.url, null, undefined, 'normal', 'responsive', capsuleId)
      if (result.id !== browserId || result.capsuleId !== capsuleId) throw new Error('The original Browser returned another page. The reference is kept.')
      current.current = result
      if (cancelled) { release(); return }
      setBrowser(result)
    })().catch(error => { if (!cancelled) setNotice(`${restoredDocument ? 'Page information refresh failed. The original page remains available.' : 'Page preview is unavailable.'} ${presentError(error)}`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, capsuleId, browserId, retry, release])
  useEffect(() => api.browser.onEvent(event => {
    if (event.type === 'updated' && event.browser.id === browserId) {
      current.current = event.browser; setBrowser(event.browser)
    } else if (event.type === 'unavailable' && event.id === browserId) setNotice(event.error)
    else if (event.type === 'closed' && event.id === browserId) {
      current.current = null; setBrowser(null); setNotice('This page presentation was closed. The saved Capsule and original reference remain; retry here to display it.')
    }
  }), [browserId])
  // The containing workface supplies its exact occurrence. Gallery cards belong to the original Renderer document,
  // not to a guessed focused Region or the Agent's execution cwd.
  const presentation = useMemo<BrowserStagePresentation>(() => ({
    occurrence: { presentationId: `capsule:${occurrenceId}`, location: owner.reference ?? { kind: 'inline' } },
    stageHostId: `capsule:${occurrenceId}`, visible: active, active: false, yieldToFocusRing: true, clipToScrollport: true,
    target: { hostId: `capsule:${occurrenceId}`, active: false, visible: active, ...(owner.reference ? { reference: owner.reference } : {}) }
  }), [occurrenceId, owner.reference, active])
  const open = () => { void api.ui.openObjectLink(uri).catch(error => setNotice(presentError(error))) }
  return <section className={`conversation-capsule${expanded ? ' conversation-capsule--expanded' : ''}`} aria-label={title || 'Capsule page'} data-capsule-id={capsuleId} data-conversation-keyframe={browser?.navigationId}>
    <header className="conversation-capsule__header"><PageIcon size={15} aria-hidden="true" /><strong>{title || page?.record.title || 'Saved page'}</strong>
      {page ? <span className="conversation-capsule__mode">{page.record.mode === 'injected' ? 'Injected' : 'Isolated'}</span> : null}
      <span className="conversation-capsule__actions">
        <button type="button" className="small-button" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>{collapsed ? 'Show page' : 'Hide'}</button>
        {!collapsed ? <button type="button" className="small-button" onClick={() => setExpanded(value => !value)} aria-pressed={expanded}>{expanded ? 'Compact' : 'Expand'}</button> : null}
        <button type="button" className="small-button" onClick={open}>Open in Browser</button>
      </span>
    </header>
    {!collapsed ? <>
      {notice ? <div className="conversation-capsule__notice" role="status"><span>{notice}</span><button type="button" className="small-button" onClick={() => setRetry(value => value + 1)}>Retry original page</button></div> : null}
      {active && browser ? <CapsuleNativePage browser={browser} presentation={presentation} release={release} />
        : <div className="conversation-capsule__placeholder" role={loading ? 'status' : undefined}>{loading ? 'Connecting saved page…' : !visible ? 'Page preview paused while outside the reading window' : 'The original page reference is kept below.'}</div>}
    </> : null}
    {browser?.capsuleId === capsuleId ? <div hidden={!active} inert={!active}><span className="conversation-capsule__questions" ref={setToolbar} /><CapsuleInteractionChrome browserId={browser.id} capsuleId={browser.capsuleId} active={browser.capsuleActive === true} visible={active} toolbarHost={toolbar} /></div> : null}
    <details className="conversation-capsule__source"><summary>Page reference</summary><code>{uri}</code>{browser ? <code>Browser {browser.id}</code> : null}</details>
  </section>
}

function CapsuleNativePage({ browser, presentation, release }: { browser: BrowserSnapshot; presentation: BrowserStagePresentation; release(): void }) {
  const media = useBrowserPresentationCapture(browser.id)
  const [selected, setSelected] = useState(false)
  return <BrowserPresentationStage browserId={browser.id} navigationId={browser.navigationId} presentation={presentation}
    inputSelected={selected} blocked={false} media={media} onInputSelected={() => setSelected(true)} onPresentationRemoved={release} />
}
