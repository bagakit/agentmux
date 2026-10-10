import { WorkbenchDocumentContext } from '../lib/workbench-document'
import { observeWorkbenchDocumentReturn, workbenchDocumentIdentity, useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'
import { DesktopClientUiProvider } from './DesktopClientUiProvider'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { AgentInputRecap } from './AgentInputRecap'
import { AgentReadingBody as ReadingBody } from './AgentReadingBody'
import { currentAgentSemanticStatus, msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import { nativeBindingKey } from '../../../shared/agent-native-source'
import { agentContextForSession, type FocusContext } from '../lib/focus-context'
import { type AgentInformationPreview as PreviewRequest, agentInformationPreview } from '../lib/agent-information-preview'
import { captureReadingAnchor, restoreReadingAnchor } from '../lib/reading-anchor'
import { useAppStore } from '../store'
import { agentStateEnteredAt } from '../lib/agent-state-time'
import { elapsedShort } from '../lib/project-activity-row'
import { observeAgentSession } from '../lib/agent-observation'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { AgentInformationDetails, AgentInformationSummary, type AgentInformationTab } from './AgentInformationDetails'
import { FocusContextStateMark } from './FocusContextState'
import { AgentAvatar } from './AgentAvatar'
import { WorkbenchTabGlyph, WorkbenchTopology } from './WorkbenchTopology'
import { getWindowOverlayHost, markWindowOverlayDismissal, wasWindowOverlayDismissed } from './WindowOverlayHost'

const InfoIcon = semanticIconComponent('status.info')
const CloseIcon = semanticIconComponent('action.close')
const OpenIcon = semanticIconComponent('action.open-external')
const PinIcon = semanticIconComponent('action.pin')

function FocusContextStateSummary({ context, explanationVisible }: { context: FocusContext; explanationVisible: boolean }) {
  const session = useAppStore(state => state.sessions.find(session => session.id === context.id && session.hostId === context.hostId && session.control.run.runId === context.runId))
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (context.stateEnteredAt === undefined && context.lastActivityAt === null) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [context.id, context.hostId, context.runId, context.stateEnteredAt, context.lastActivityAt])
  const confirmed = session ? agentStateEnteredAt(session, now) : undefined
  const enteredAt = confirmed !== undefined && confirmed === context.stateEnteredAt ? confirmed : undefined
  const lastActive = context.lastActivityAt !== null && Number.isFinite(context.lastActivityAt) && context.lastActivityAt >= 0 && context.lastActivityAt <= now ? context.lastActivityAt : undefined
  const time = enteredAt !== undefined ? elapsedShort(now - enteredAt)
    : lastActive !== undefined ? `Last active ${elapsedShort(now - lastActive)} ago` : 'Activity time unknown'
  const duration = enteredAt !== undefined && context.bucket === 'attention' ? `${context.state === 'error' ? 'For' : 'Waiting'} ${time}` : time
  return <span className="focus-context-hover__state" aria-label={`${context.stateLabel} · ${duration}`} data-state-time={enteredAt !== undefined ? 'duration' : lastActive !== undefined ? 'last-active' : 'unknown'}>
    <span className="focus-context-hover__state-label" title={context.stateLabel}><FocusContextStateMark context={context} />{!explanationVisible ? context.stateLabel : null}</span>
    <span className="focus-context-hover__state-time">{duration}</span>
  </span>
}


const HeldReading = memo(function HeldReading({ request, enabled, available }: { request: PreviewRequest; enabled: boolean; available: boolean }) {
  const context = request.context
  return <>
    {!context.recap && request.contentChanged ? <small className="agent-information-reader__change">Card content changed · Reading kept</small> : null}
    {context.recap ? <section className="focus-context-hover__recap">
      <small title={`${context.recap.source} · ${context.recap.origin}`}>
        {context.recap.source === 'Last assistant message' ? 'Latest reply' : 'Latest input'}
        <span>{request.contentChanged ? 'Card content changed · Reading kept' : (context.recap.reading?.truncated ?? true) ? 'Excerpt at opening' : 'Observed at opening'}</span>
      </small>
      <ReadingBody reading={context.recap.reading ?? { text: context.recap.text, truncated: true }} active={enabled} />
    </section> : !context.detailIsRecap && context.detailKind !== 'service' ? <p className="focus-context-hover__activity">{context.detail}</p> : null}
    {context.kind === 'agent' ? <AgentInputRecap request={request} enabled={enabled} available={available} /> : null}
    <p className="agent-information-reader__end">End of this reading window <span>Earlier records remain in History.</span></p>
  </>
})

/** From first peek onward this is the same window-owned tree, never a row's Portal. */
export function AgentInformationReader({ request }: { request: PreviewRequest }) {
  const [document, setDocument] = useState(() => request.anchor.ownerDocument)
  // A stable Portal container preserves this reading tree when its native shell returns.
  const [readingHost] = useState(() => { const host = request.anchor.ownerDocument.createElement('div'); host.style.display = 'contents'; return host })
  const window = document.defaultView!
  const context = request.context
  const panel = useRef<HTMLDivElement>(null), reading = useRef<HTMLDivElement>(null)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const back = useRef<HTMLButtonElement>(null), returnToReading = useRef(false)
  const reflowAnchor = useRef<ReturnType<typeof captureReadingAnchor>>(null)
  const heldSelection = useRef<Range | null>(null), laterSelection = useRef(false)
  const [tab, setTab] = useState<AgentInformationTab | null>(null)
  const visible = useWorkbenchDocumentVisibility(document)
  useEffect(() => { if (!visible) agentInformationPreview.dismiss(request.token) }, [visible, request.token])
  const transferredFocus = useRef<HTMLElement | null>(null)
  const transferredSelection = useRef<{ start: Node; startOffset: number; end: Node; endOffset: number } | null>(null)
  useLayoutEffect(() => {
    getWindowOverlayHost(document)?.appendChild(readingHost)
    const saved = transferredSelection.current
    transferredSelection.current = null
    transferredFocus.current?.focus({ preventScroll: true })
    transferredFocus.current = null
    if (saved) {
      if (panel.current?.contains(saved.start) && panel.current.contains(saved.end)) {
        const range = document.createRange(); range.setStart(saved.start, saved.startOffset); range.setEnd(saved.end, saved.endOffset)
        const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
      }
    }
  }, [document, readingHost])
  useLayoutEffect(() => observeWorkbenchDocumentReturn((source, destination) => {
    if (source !== document) return
    const selection = source.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const active = source.activeElement
    const focus = active && panel.current?.contains(active) ? active as HTMLElement : null
    transferredFocus.current = focus
    if (range && panel.current?.contains(range.startContainer) && panel.current.contains(range.endContainer)) transferredSelection.current = { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset }
    const held = heldSelection.current
    const heldRange = held && panel.current?.contains(held.startContainer) && panel.current.contains(held.endContainer)
      ? { start: held.startContainer, startOffset: held.startOffset, end: held.endContainer, endOffset: held.endOffset } : null
    // Move before the old native shell may close; React keeps the exact same Portal target.
    getWindowOverlayHost(destination)?.appendChild(readingHost)
    if (heldRange) {
      const rebound = destination.createRange(); rebound.setStart(heldRange.start, heldRange.startOffset); rebound.setEnd(heldRange.end, heldRange.endOffset)
      heldSelection.current = rebound
    }
    setDocument(destination)
  }), [document, readingHost])
  useLayoutEffect(() => () => { readingHost.remove() }, [readingHost])
  const lastVisibleSession = useRef(request.session)
  const session = useAppStore(state => !visible ? lastVisibleSession.current : state.sessions.find(session => session.id === context.id && session.hostId === context.hostId &&
    session.control.run.runId === context.runId && (context.kind !== 'agent' || session.kind === 'agent' &&
      session.control.hostId === request.control?.hostId && session.control.agentSessionId === request.control?.agentSessionId && nativeBindingKey(session) === request.sourceKey)))
  useLayoutEffect(() => { if (visible) lastVisibleSession.current = session }, [visible, session])
  const [observationNow, setObservationNow] = useState(Date.now)
  useEffect(() => {
    if (!visible || session?.kind !== 'agent') return
    const now = Date.now(), current = currentAgentSemanticStatus(session.semanticStatus) ?? session.status
    const delays = [session.status, current].map(status => msUntilSemanticStatusStale(status, now)).filter(delay => delay > 0)
    if (!delays.length) return
    const timer = setTimeout(() => setObservationNow(Date.now()), Math.min(...delays))
    return () => clearTimeout(timer)
  }, [visible, session, observationNow])
  const sameSource = Boolean(session)
  const currentContext = useMemo(() => visible && session
    ? { ...agentContextForSession(session, undefined, context.name, context.workspace, context.topicId), lastActivityAt: context.lastActivityAt } : context,
  [visible, session, context, observationNow])
  const observation = session?.kind === 'agent' ? observeAgentSession(session, Date.now()) : undefined
  const usage = session?.kind === 'agent' ? session.turnUsage : request.session?.kind === 'agent' ? request.session.turnUsage : undefined
  const sourceNotice = !sameSource ? 'Original Run or source is no longer confirmed. This reading is kept; new source data is not attached.' : null
  const service = observation?.reason && currentContext.bucket === 'idle' && currentContext.state !== 'disconnected' ? `${observation.reason === 'activity-stale' ? 'Work signal expired' : 'Current activity unconfirmed'} · Run ${observation.process}`
    : !currentContext.detailIsRecap && currentContext.detailKind === 'service' ? currentContext.detail : null
  const displayPath = usePathDisplay(), path = displayPath(context.workspacePath, context.hostId)
  const source = <>
    <h3>Status and source</h3><p>{currentContext.detail}</p>
    {currentContext.detail !== context.detail ? <p>At opening: {context.detail}</p> : null}
    <dl className="agent-information-reader__source">
      <div><dt>Host</dt><dd>{context.hostId}</dd></div><div><dt>Session</dt><dd>{request.control?.agentSessionId ?? context.id}</dd></div>
      <div><dt>Run</dt><dd>{context.runId}</dd></div><div><dt>Project</dt><dd>{context.workspaceName}</dd></div>
      <div><dt>Directory</dt><dd>{path}</dd></div>{context.originAddress ? <div><dt>Origin</dt><dd>{context.originAddress}</dd></div> : null}
    </dl>
    {request.contentChanged ? <p>Original card content changed. Close and reopen its preview to read the latest observed text.</p> : null}
    <p>Text, positions and Goal links were captured for this preview. Status and usage follow the same confirmed Run and source.</p>
    {request.identity ? <section className="focus-context-hover__workbench" aria-label={`${request.identity.occurrenceCount} confirmed ${request.identity.occurrenceCount === 1 ? 'position' : 'positions'}`}>
      {request.identity.tabs.map(position => <section key={position.occurrenceKey ?? position.tabId} data-focus-occurrence-key={position.occurrenceKey}>
        <span className="focus-context-hover__position-glyph"><WorkbenchTabGlyph tab={position} /></span>
        <span className="focus-context-hover__position-copy" title={[position.title, position.locationLabel].filter(Boolean).join('\n')}>{position.title !== context.name ? <strong>{position.title}</strong> : null}<small className="focus-context-hover__position-label">{position.locationLabel ?? 'Original position'} · {position.regions.length} {position.regions.length === 1 ? 'Region' : 'Regions'}</small></span>
      </section>)}
    </section> : null}
  </>
  function cancelDeparture() { clearTimeout(departure.current); request.keepOpen() }
  function close(restore = false) {
    cancelDeparture()
    const focused = document.activeElement
    agentInformationPreview.dismiss(request.token, true)
    if (restore && (focused === document.body || focused && panel.current?.contains(focused)) &&
      request.anchor.isConnected && !request.anchor.closest('[inert]')) request.restoreFocus()
  }
  function leave() {
    cancelDeparture()
    departure.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement) || document.activeElement === request.anchor) return
      agentInformationPreview.dismiss(request.token)
    }, 160)
  }
  function togglePin() {
    cancelDeparture()
    reflowAnchor.current = reading.current ? captureReadingAnchor(reading.current) : null
    agentInformationPreview.pin(request.token)
  }
  useLayoutEffect(() => {
    if (reading.current && reflowAnchor.current) restoreReadingAnchor(reading.current, reflowAnchor.current)
    reflowAnchor.current = null
  }, [request.pinned])
  function showMetadata(next: AgentInformationTab) {
    cancelDeparture()
    if (!tab) {
      laterSelection.current = false
      const selection = window.getSelection()
      heldSelection.current = selection?.rangeCount && !selection.isCollapsed && reading.current?.contains(selection.anchorNode) && reading.current.contains(selection.focusNode)
        ? selection.getRangeAt(0).cloneRange() : null
    }
    setTab(next)
  }
  function showReading() { returnToReading.current = true; setTab(null) }
  useLayoutEffect(() => {
    if (tab) back.current?.focus({ preventScroll: true })
    else if (returnToReading.current) {
      returnToReading.current = false
      const selection = window.getSelection(), saved = heldSelection.current
      const restore = !laterSelection.current && saved && reading.current?.contains(saved.startContainer) && reading.current.contains(saved.endContainer) &&
        (selection?.isCollapsed || reading.current.contains(selection?.anchorNode ?? null))
      reading.current?.focus({ preventScroll: true })
      if (restore && selection) { selection.removeAllRanges(); selection.addRange(saved) }
      heldSelection.current = null
    }
  }, [tab !== null, document])
  useEffect(() => {
    if (!tab) return
    const changed = () => {
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && !reading.current?.contains(selection.anchorNode)) laterSelection.current = true
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [tab !== null, document])
  useLayoutEffect(() => {
    const surface = panel.current
    if (!surface || !visible) return
    let current = true
    const update = async () => {
      const { x, y } = await computePosition(request.anchor, surface, {
        strategy: 'fixed', placement: 'bottom-start', middleware: [offset(8), flip({ padding: 10 }), shift({ padding: 10, crossAxis: true })]
      })
      if (current) {
        Object.assign(surface.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
        if (request.enterReading && document.activeElement === request.anchor && !request.anchor.closest('[inert]')) reading.current?.focus({ preventScroll: true })
      }
    }
    if (request.pinned || !request.anchor.isConnected || request.anchor.closest('[inert]')) {
      const contain = () => {
        const bounds = surface.getBoundingClientRect()
        Object.assign(surface.style, { left: `${Math.max(12, Math.min(bounds.left, window.innerWidth - bounds.width - 12))}px`,
          top: `${Math.max(12, Math.min(bounds.top, window.innerHeight - bounds.height - 12))}px`, visibility: 'visible' })
      }
      contain(); window.addEventListener('resize', contain)
      return () => { current = false; window.removeEventListener('resize', contain); cancelDeparture() }
    }
    const stop = autoUpdate(request.anchor, surface, () => { void update() })
    return () => { current = false; stop(); cancelDeparture() }
  }, [request.token, request.pinned, document, visible])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || wasWindowOverlayDismissed(event)) return
      if (event.key.toLowerCase() === 'p' && !event.metaKey && !event.ctrlKey && !event.altKey && panel.current?.contains(document.activeElement) &&
        !(event.target && (event.target as Element).nodeType === 1 && (event.target as Element).closest('input, textarea, [contenteditable="true"]'))) { event.preventDefault(); togglePin(); return }
      if (event.key !== 'Escape') return
      if (request.pinned && !panel.current?.contains(document.activeElement)) return
      markWindowOverlayDismissal(event); event.preventDefault()
      if (tab) showReading()
      else close(true)
    }
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node)) agentInformationPreview.dismiss(request.token) }
    document.addEventListener('keydown', escape)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', outside, true)
    const resize = () => agentInformationPreview.dismiss(request.token)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('keydown', escape)
      document.removeEventListener('pointerdown', outside, true); window.removeEventListener('scroll', outside, true); window.removeEventListener('resize', resize)
    }
  }, [request, tab, document])
  return createPortal(<WorkbenchDocumentContext.Provider value={{ document, window: workbenchDocumentIdentity(document) }}><DesktopClientUiProvider document={document}><div ref={panel} id={request.id} className="focus-context-hover agent-information-reader" role="region"
    data-state="open" data-pinned={request.pinned || undefined} hidden={!visible} aria-label={`Full context for ${context.name}`} tabIndex={-1} style={{ visibility: 'hidden' }}
    onPointerEnter={cancelDeparture} onPointerLeave={leave} onFocus={cancelDeparture} onBlur={event => {
      if (event.relatedTarget && (event.relatedTarget as Node).nodeType && (panel.current?.contains(event.relatedTarget as Node) || event.relatedTarget === request.anchor)) return
      leave()
    }}>
    <header className="agent-information-reader__header">
      <span className="agent-information-reader__identity">{request.identity?.tabs.length
        ? <WorkbenchTopology tabs={request.identity.tabs} interactive={false} enabled={false} />
        : <AgentAvatar executorId={context.executorId} label={context.name} state={currentContext.state} providerId={context.providerId ?? undefined} size={24} visible={false} />}</span>
      <div className="agent-information-reader__heading"><small title={context.originAddress ?? path}>{context.workspaceName}</small><strong title={context.name}>{context.name}</strong></div>
      {sameSource && visible ? <FocusContextStateSummary context={currentContext} explanationVisible={Boolean(service)} /> : <span className="focus-context-hover__state">Reading snapshot</span>}
    </header>
    {sourceNotice || service ? <div className="agent-information-reader__service" role={sourceNotice ? 'status' : undefined}>
      <InfoIcon size={13} aria-hidden="true" /><p>{sourceNotice ?? service}</p><button type="button" onPointerDown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => showMetadata('source')}>Source</button>
    </div> : null}
    <div className="agent-information-reader__body">
      <div ref={reading} className="agent-information-reader__reading" tabIndex={0} aria-label="Original Agent content"
        style={tab ? { visibility: 'hidden' } : undefined} inert={tab !== null}>
        <HeldReading request={request} enabled={visible && sameSource && tab === null} available={visible && sameSource} />
      </div>
      {tab ? <div className="agent-information-reader__metadata">
        <div className="agent-information-reader__metadata-heading"><button ref={back} type="button" onClick={showReading} aria-label="Back to original content">←</button><h3>Agent information</h3></div>
        <AgentInformationDetails context={context} goalLinks={request.goalLinks} usage={usage} control={visible && sameSource ? request.control : undefined} tab={tab} onTab={setTab} source={source} />
      </div> : null}
    </div>
    <footer className="agent-information-reader__footer" onPointerDown={event => { if (event.button === 0) event.preventDefault() }}>
      <button type="button" className="agent-information-reader__facts" onClick={() => tab ? showReading() : showMetadata('usage')}
        aria-label="Agent information: usage, Goals, message relationships and source" aria-expanded={tab !== null}>
        <InfoIcon size={14} aria-hidden="true" /><AgentInformationSummary usage={usage} goalLinks={request.goalLinks} />
      </button>
      <button type="button" className="agent-information-reader__pin" aria-pressed={request.pinned} aria-keyshortcuts="P" onClick={togglePin} title={request.pinned ? 'Release reading · P' : 'Keep this reading while you work · P'}>
        <PinIcon size={13} aria-hidden="true" />{request.pinned ? 'Pinned' : 'Pin'}
      </button>
      <button type="button" className="agent-information-reader__open" onClick={() => {
        const original = useAppStore.getState().sessions.find(session => session.id === context.id && session.hostId === context.hostId && session.control.run.runId === context.runId)
        if (original?.control.hostId === context.hostId && (context.kind !== 'agent' || original.kind === 'agent' && original.control.agentSessionId === request.control?.agentSessionId)) {
          request.openWorkface(); agentInformationPreview.dismiss(request.token)
        } else showMetadata('source')
      }}>Open Agent <OpenIcon size={13} aria-hidden="true" /></button>
      <button type="button" className="agent-information-reader__close" onClick={() => close(true)} aria-label="Close Agent reading" title="Close · Esc"><CloseIcon size={15} aria-hidden="true" /></button>
    </footer>
  </div></DesktopClientUiProvider></WorkbenchDocumentContext.Provider>, readingHost)
}
