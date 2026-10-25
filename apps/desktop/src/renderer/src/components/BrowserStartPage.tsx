import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { BrowserInputHistoryEntry, BrowserInputHistoryScope, BrowserInputHistoryTarget } from '../../../shared/browser-input-history'
import type { BrowserRecoveryPreview } from '../../../shared/browser-recovery-preview'
import type { BrowserStartPageConfig } from '../../../shared/browser-start-page'
import { resolveBrowserInput } from '../../../shared/browser-address'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { useAppStore } from '../store'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeActionSearchIcon = semanticIconComponent('action.search')


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
      {config.showHistory && visible ? <StartPageHistory key={JSON.stringify(historyTarget)} historyTarget={historyTarget} revision={historyRevision} onChoose={onChooseHistory} /> : null}
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
  const [loaded, setLoaded] = useState<{ key: string; revision: number; scope: BrowserInputHistoryScope; entries: BrowserInputHistoryEntry[]; previews: Map<string, string> } | null>(null)
  const [issue, setIssue] = useState<{ key: string; revision: number; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const gridId = useId()
  useEffect(() => {
    let active = true
    if (historyTarget) void api.browser.listInputHistory(historyTarget).then(snapshot => {
      if (active) {
        // One read of existing descriptions, only when this visible history is read. No discovery,
        // live subscription, navigation or page restoration just to decorate a history card.
        const candidates = new Map<string, Set<string>>()
        for (const tab of Object.values(useAppStore.getState().tabs)) for (const region of Object.values(tab.regions)) {
          if (region.kind !== 'browser' || region.mode === 'private' || snapshot.scope.profileId === null ||
            region.workspaceId !== snapshot.scope.workspaceId || region.profileId !== snapshot.scope.profileId) continue
          const ids = candidates.get(region.url) ?? new Set<string>()
          ids.add(region.browserId); candidates.set(region.url, ids)
        }
        const previews = new Map<string, string>()
        for (const entry of snapshot.entries) {
          const url = historyLabel(entry.text).url, ids = url ? candidates.get(url) : undefined
          // Multiple distinct pages can have the same URL: do not guess which appearance to use.
          if (ids?.size === 1) previews.set(entry.text, [...ids][0]!)
        }
        setLoaded({ key, revision, ...snapshot, previews }); setIssue(null)
      }
    }).catch(error => { if (active) setIssue({ key, revision, message: presentError(error) }) })
    return () => { active = false }
  }, [key, attempt, revision])
  const current = loaded?.key === key && loaded.revision === revision
  const entries = current ? loaded.entries.slice(0, expanded ? undefined : 12) : []
  const failure = issue?.key === key && issue.revision === revision ? issue.message : null
  if (!historyTarget) return <p className="browser-start-page__notice" role="status">Recent input is unavailable until its Workspace and Profile are confirmed. You can still browse.</p>
  if (!failure && current && entries.length === 0) return null
  return <section className="browser-start-history" aria-label="Recent addresses and searches">
    <header><div><h2>Pick up where you left off</h2><span>Recent addresses &amp; searches</span></div>
      {current ? <span>{entries.length} of {loaded.entries.length}</span> : null}</header>
    {failure ? <p className="browser-start-page__notice" role="status">Recent input could not be read: {failure}. You can still browse.
      <button type="button" onClick={() => setAttempt(value => value + 1)}><ThemeActionRefreshIcon size={12} /> Retry history</button></p>
      : !current ? <p className="browser-start-page__notice" role="status">Reading recent input…</p> : null}
    {entries.length && current ? <div id={gridId} className="browser-start-history__grid">{entries.map(entry =>
      <HistoryCard key={entry.text} entry={entry} scope={loaded.scope} browserId={loaded.previews.get(entry.text)} onChoose={onChoose} />
    )}</div> : null}
    {current && loaded.entries.length > 12 ? <button type="button" className="browser-start-history__more" aria-expanded={expanded} aria-controls={gridId}
      onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : `Show all ${loaded.entries.length}`}</button> : null}
  </section>
}

function HistoryCard({ entry, scope, browserId, onChoose }: { entry: BrowserInputHistoryEntry; scope: BrowserInputHistoryScope; browserId: string | undefined; onChoose(text: string): void }) {
  const label = historyLabel(entry.text), url = label.url
  const [preview, setPreview] = useState<BrowserRecoveryPreview | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let active = true
    setPreview(null); setUnavailable(false)
    if (browserId && scope.profileId && url) void api.browser.getRecoveryPreview(browserId).then(result => {
      if (!active) return
      if (result.status === 'available' && result.preview.scope.browserId === browserId && result.preview.url === url &&
        result.preview.scope.mode === 'normal' && result.preview.scope.workspaceId === scope.workspaceId && result.preview.scope.profileId === scope.profileId) setPreview(result.preview)
      else if (result.status !== 'missing') setUnavailable(true)
    }).catch(() => { if (active) setUnavailable(true) })
    return () => { active = false }
  }, [browserId, scope.workspaceId, scope.profileId, url])
  const date = new Date(entry.submittedAt), validDate = Number.isFinite(date.getTime())
  const Icon = label.kind === 'address' ? ThemeObjectBrowserIcon : ThemeActionSearchIcon
  const tone = [...label.domain].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5
  return <button type="button" className="browser-start-history__card" data-tone={tone} title={entry.text} aria-label={`Open recent input ${entry.text}`} onClick={() => onChoose(entry.text)}>
    <span className="browser-start-history__cover" data-preview={Boolean(preview)}>
      {preview ? <><img src={preview.image.dataUrl} alt="" loading="lazy" onError={() => { setPreview(null); setUnavailable(true) }} /><span className="browser-start-history__preview-label">Last viewed</span></>
        : <><span className="browser-start-history__monogram" aria-hidden="true">{label.kind === 'address' ? label.domain.replace(/^www\./, '').slice(0, 1).toUpperCase() : <ThemeActionSearchIcon size={30} />}</span><span className="browser-start-history__domain">{label.domain}</span></>}
    </span>
    <span className="browser-start-history__details"><strong>{preview?.title || label.title}</strong><span className="browser-start-history__meta"><Icon size={12} aria-hidden="true" /><span>{unavailable ? 'Preview unavailable' : label.kind === 'search' ? 'Search' : label.domain}</span>{validDate ? <time dateTime={date.toISOString()}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time> : null}</span></span>
  </button>
}

function historyLabel(text: string): { kind: 'address' | 'search'; title: string; domain: string; url?: string } {
  try {
    const resolved = resolveBrowserInput(text)
    if (resolved.kind === 'address') { const url = new URL(resolved.url); return { kind: 'address', title: text, domain: url.hostname || url.protocol, url: url.href } }
  } catch { return { kind: 'search', title: text, domain: 'Input' } }
  return { kind: 'search', title: text, domain: 'Search' }
}
