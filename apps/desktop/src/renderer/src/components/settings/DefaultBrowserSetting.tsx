import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserDefaultInspection } from '@agentmux/core'
import { api } from '../../lib/api'

function stateLabel(fact: BrowserDefaultInspection): string {
  switch (fact.outcome) {
    case 'default': return 'AgentMux is your default browser. Web links open in Survey.'
    case 'not-default': return 'Web links currently open in another app.'
    case 'partial': return 'AgentMux handles only some web links.'
    case 'unknown': return 'The current default browser could not be confirmed.'
    case 'unsupported': return 'System default browser integration is not available on this platform.'
  }
}

export function DefaultBrowserSetting({ active }: { active: boolean }) {
  const [fact, setFact] = useState<BrowserDefaultInspection | null>(null)
  const [error, setError] = useState<string | null>(null), [requested, setRequested] = useState(false)
  const [reading, setReading] = useState(false), [opening, setOpening] = useState(false)
  const generation = useRef(0), live = useRef(active), request = useRef(0), openingRef = useRef(false)
  const read = useCallback(async () => {
    const token = ++generation.current
    setReading(true); setError(null)
    try { const next = await api.ui.inspectDefaultBrowser(); if (live.current && generation.current === token) setFact(next) }
    catch (cause) { if (live.current && generation.current === token) { setFact(null); setError(cause instanceof Error ? cause.message : String(cause)) } }
    finally { if (live.current && generation.current === token) setReading(false) }
  }, [])
  useEffect(() => {
    live.current = active
    if (!active) return
    openingRef.current = false; setOpening(false)
    void read()
    const focus = () => { void read() }
    window.addEventListener('focus', focus)
    return () => { live.current = false; ++generation.current; ++request.current; window.removeEventListener('focus', focus) }
  }, [active, read])
  async function open(): Promise<void> {
    if (openingRef.current) return
    openingRef.current = true
    const token = ++request.current
    setOpening(true); setRequested(false); setError(null)
    try { await api.ui.openDefaultBrowserSettings(); if (live.current && request.current === token) setRequested(true) }
    catch (cause) { if (live.current && request.current === token) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (live.current && request.current === token) { openingRef.current = false; setOpening(false) } }
  }
  return <section className="settings-group">
    <header><span>Default browser</span><small>Survey</small></header>
    <p className="settings-group-note">Choose AgentMux in your system settings to open web links in Survey.</p>
    <p role="status">{fact ? stateLabel(fact) : reading ? 'Checking current default browser…' : 'Current default browser is unknown.'}</p>
    {fact?.protocols && fact.outcome !== 'default' ? <p className="settings-group-note">{(['http', 'https'] as const).map(scheme => {
      const protocol = fact.protocols![scheme]
      return `${scheme.toUpperCase()}: ${protocol.state === 'known' ? protocol.application.name : `Unknown (${protocol.cause.message})`}`
    }).join(' · ')}</p> : null}
    <div className="settings-workflows__inline-action">
      <button type="button" className="small-button" disabled={opening || fact?.outcome === 'unsupported'} onClick={() => void open()}>{opening ? 'Opening…' : 'Set as default browser…'}</button>
      <button type="button" className="small-button" disabled={reading} onClick={() => void read()}>Refresh status</button>
    </div>
    {requested ? <p className="settings-group-note" role="status">System Settings requested. In Desktop &amp; Dock → Default web browser, choose AgentMux. Refresh here to confirm your choice.</p> : null}
    {error ? <p className="settings-inline-error" role="alert">{error} Your settings and pages are kept.</p> : null}
  </section>
}
