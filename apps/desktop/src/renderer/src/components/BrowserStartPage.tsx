import { Globe2, Search, RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { BrowserInputHistoryEntry, BrowserInputHistoryTarget } from '../../../shared/browser-input-history'
import type { BrowserStartPageConfig } from '../../../shared/browser-start-page'
import { resolveBrowserInput } from '../../../shared/browser-address'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'

/** Generic renderer start page. Its caller supplies identity, input and navigation. */
export function BrowserStartPage({ config, historyTarget, historyRevision = 0, visible = true, onChooseHistory, children }: {
  config: BrowserStartPageConfig
  historyTarget: BrowserInputHistoryTarget | null
  visible?: boolean
  historyRevision?: number
  onChooseHistory(text: string): void
  children: ReactNode
}) {
  return <div className="browser-start-page" data-background={Boolean(config.backgroundImage)}>
    {config.backgroundImage ? <StartPageImage key={config.backgroundImage} src={config.backgroundImage} kind="background" /> : null}
    <div className="browser-start-page__content">
      {config.icon || config.title || config.subtitle ? <header className="browser-start-page__brand">
        {config.icon ? <StartPageImage key={config.icon} src={config.icon} kind="icon" /> : null}
        {config.title ? <h1>{config.title}</h1> : null}
        {config.subtitle ? <p>{config.subtitle}</p> : null}
      </header> : null}
      {children}
      {config.showHistory && visible ? <StartPageHistory historyTarget={historyTarget} revision={historyRevision} onChoose={onChooseHistory} /> : null}
    </div>
  </div>
}

function StartPageImage({ src, kind }: { src: string; kind: 'icon' | 'background' }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0)
  return <>
    <img key={attempt} className={`browser-start-page__${kind}`} src={src} alt="" hidden={failed} onError={() => setFailed(true)} />
    {failed ? <p className={`browser-start-page__image-notice browser-start-page__image-notice--${kind}`} role="status">
      {kind === 'icon' ? 'Icon' : 'Background image'} could not be loaded.
      <button type="button" onClick={() => { setFailed(false); setAttempt(value => value + 1) }}>Retry image</button>
    </p> : null}
  </>
}

function StartPageHistory({ historyTarget, revision, onChoose }: { historyTarget: BrowserInputHistoryTarget | null; revision: number; onChoose(text: string): void }) {
  const key = historyTarget?.kind === 'browser' ? JSON.stringify(['browser', historyTarget.browserId, historyTarget.profileId])
    : historyTarget ? JSON.stringify(['workspace', historyTarget.workspaceId]) : ''
  const [loaded, setLoaded] = useState<{ key: string; revision: number; entries: BrowserInputHistoryEntry[] } | null>(null)
  const [issue, setIssue] = useState<{ key: string; revision: number; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    if (historyTarget) void api.browser.listInputHistory(historyTarget).then(snapshot => {
      if (active) { setLoaded({ key, revision, entries: snapshot.entries }); setIssue(null) }
    }).catch(error => { if (active) setIssue({ key, revision, message: presentError(error) }) })
    return () => { active = false }
  }, [key, attempt, revision])
  const current = loaded?.key === key && loaded.revision === revision
  const entries = current ? loaded.entries.slice(0, 8) : []
  const failure = issue?.key === key && issue.revision === revision ? issue.message : null
  if (!historyTarget) return <p className="browser-start-page__notice" role="status">Recent input is unavailable until its Workspace and Profile are confirmed. You can still browse.</p>
  if (!failure && current && entries.length === 0) return null
  return <section className="browser-start-history" aria-label="Recent addresses and searches">
    <header><h2>Recent input</h2><span>Addresses &amp; searches</span></header>
    {failure ? <p className="browser-start-page__notice" role="status">Recent input could not be read: {failure}. You can still browse.
      <button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={12} /> Retry history</button></p>
      : !current ? <p className="browser-start-page__notice" role="status">Reading recent input…</p> : null}
    {entries.length ? <div className="browser-start-history__grid">{entries.map(entry => {
      const label = historyLabel(entry.text)
      const Icon = label.kind === 'address' ? Globe2 : Search
      const date = new Date(entry.submittedAt), validDate = Number.isFinite(date.getTime())
      return <button key={entry.text} type="button" className="browser-start-history__card" title={entry.text} aria-label={`Open recent input ${entry.text}`} onClick={() => onChoose(entry.text)}>
        <span className="browser-start-history__cover"><Icon size={24} /><span>{label.domain}</span></span>
        <span className="browser-start-history__details"><strong>{label.title}</strong>{validDate ? <time dateTime={date.toISOString()}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time> : null}</span>
      </button>
    })}</div> : null}
  </section>
}

function historyLabel(text: string): { kind: 'address' | 'search'; title: string; domain: string } {
  try {
    const resolved = resolveBrowserInput(text)
    if (resolved.kind === 'address') { const url = new URL(resolved.url); return { kind: 'address', title: text, domain: url.hostname || url.protocol } }
  } catch { return { kind: 'search', title: text, domain: 'Input' } }
  return { kind: 'search', title: text, domain: 'Search' }
}
