import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { clampStep } from '@agentmux/client-ui/activity-step-summary'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { nativeBindingKey } from '../../../shared/agent-native-source'
import { agentContextForSession, type FocusContext } from '../lib/focus-context'
import { type AgentInformationPreview as PreviewRequest, agentInformationPreview } from '../lib/agent-information-preview'
import { useSessionUserMessages } from '../lib/session-user-messages'
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

/** Full held text stays readable; only bounded complete prose enters Markdown parsing. */
function ReadingBody({ reading }: { reading: { text: string; truncated: boolean } }) {
  const literal = reading.truncated || reading.text.length > 8000
  return <div className="focus-context-hover__prose" data-reading-format={reading.truncated ? 'excerpt' : literal ? 'plain' : 'markdown'}>
    {literal ? <p>{reading.text}</p> : <AgentMarkdown content={reading.text} readOnly />}
  </div>
}

/** Mounted only inside the open preview; all input facts use the shared reader. */
function FocusContextInputs({ request, enabled }: { request: PreviewRequest; enabled: boolean }) {
  const reader = useSessionUserMessages(request.control, { enabled })
  const ordered = reader.messages.every(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt))
  // Missing times retain the public source order; they cannot establish a cross-source chronology.
  const messages = (ordered ? [...reader.messages].sort((a, b) => a.recordedAt! - b.recordedAt!) : reader.messages).slice(-3)
  // Recorded authors carry a canonical SID, but no authoritative peer Host.
  // Keep that reference rather than assigning a global first-match display name.
  const describe = createSpeakerResolver()
  const notice = !request.control || reader.error || reader.observationError ? 'Recent message reading unavailable'
    : reader.sourceChanged ? 'Message source changed' : reader.windowFrozen ? 'Reading window paused'
      : reader.windowIncomplete ? 'Reading window incomplete' : null
  return <section className="focus-context-hover__inputs" aria-label="Recent user messages">
    <h4>Recent inputs</h4>
    {!ordered ? <small className="focus-context-hover__coverage">Current reading window · Order unavailable</small> : null}
    {messages.length ? <ol>{messages.map(message => {
      const raw = message.content.trim()
      const body = parseAgentMuxMessagePrefix(raw)?.body.trim() || raw
      const reading = { text: body || 'Non-text input', truncated: false }
      const recorded = message.recordedAt !== undefined && Number.isFinite(message.recordedAt) ? new Date(message.recordedAt) : null
      const date = recorded && Number.isFinite(recorded.getTime()) ? recorded : null
      const time = date ? date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unknown'
      const provenance = `${message.source.kind === 'native' ? 'Native record' : 'Submission record'} · Current reading window · Record time, not a verified sender time · ${clampStep(raw.slice(0, 1000), 'head', 360)}`
      return <li key={message.id} data-hover-input-id={message.id} data-input-author={message.author.kind}>
      <div className="focus-context-hover__input-meta"><strong>{describe(speakerOfUserMessage(message)).name}</strong>
        <time dateTime={date?.toISOString()} title={provenance} aria-label={`${time} · ${provenance}`}>{time}</time></div>
      <ReadingBody reading={reading} />
      {reading.truncated ? <small className="focus-context-hover__coverage">Excerpt</small> : null}
    </li>})}</ol> : <p className="focus-context-hover__coverage">{reader.loading ? 'Loading recent messages…' : 'No user messages in the available reading window.'}</p>}
    {notice ? <p className="focus-context-hover__notice" role="status" title={reader.error?.message ?? reader.observationError?.message}>
      {notice}. Open the Agent to read History.</p> : null}
  </section>
}

/** The clock belongs only to this open header; held prose and input readers do not tick. */
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


const HeldReading = memo(function HeldReading({ request, enabled }: { request: PreviewRequest; enabled: boolean }) {
  const context = request.context
  return <>
    {context.recap ? <section className="focus-context-hover__recap">
      <small title={`${context.recap.source} · ${context.recap.origin}`}>
        {context.recap.source === 'Last assistant message' ? 'Latest reply' : 'Latest input'}
        <span>{(context.recap.reading?.truncated ?? true) ? 'Excerpt at opening' : 'Observed at opening'}</span>
      </small>
      <ReadingBody reading={context.recap.reading ?? { text: context.recap.text, truncated: true }} />
    </section> : !context.detailIsRecap && context.detailKind !== 'service' ? <p className="focus-context-hover__activity">{context.detail}</p> : null}
    {context.kind === 'agent' ? <FocusContextInputs request={request} enabled={enabled} /> : null}
    <p className="agent-information-reader__end">End of this reading window <span>Earlier records remain in History.</span></p>
  </>
})

/** From first peek onward this is the same window-owned tree, never a row's Portal. */
export function AgentInformationReader({ request }: { request: PreviewRequest }) {
  const context = request.context
  const panel = useRef<HTMLDivElement>(null), reading = useRef<HTMLDivElement>(null)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const back = useRef<HTMLButtonElement>(null), returnToReading = useRef(false)
  const [tab, setTab] = useState<AgentInformationTab | null>(null)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const session = useAppStore(state => state.sessions.find(session => session.id === context.id && session.hostId === context.hostId &&
    session.control.run.runId === context.runId && (context.kind !== 'agent' || session.kind === 'agent' &&
      session.control.hostId === request.control?.hostId && session.control.agentSessionId === request.control?.agentSessionId && nativeBindingKey(session) === request.sourceKey)))
  const sameSource = Boolean(session)
  const currentContext = session && session !== request.session ? { ...agentContextForSession(session, undefined, context.name, context.workspace, context.topicId), lastActivityAt: context.lastActivityAt } : context
  const observation = session?.kind === 'agent' ? observeAgentSession(session, Date.now()) : undefined
  const usage = session?.kind === 'agent' ? session.turnUsage : request.session?.kind === 'agent' ? request.session.turnUsage : undefined
  const sourceNotice = !sameSource ? 'Original Run or source is no longer confirmed. This reading is kept; new source data is not attached.' : null
  const service = observation?.reason && currentContext.bucket === 'idle' ? `${observation.reason === 'activity-stale' ? 'Work signal expired' : 'Current activity unconfirmed'} · Run ${observation.process}`
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
    if (restore && (focused === document.body || focused instanceof Node && panel.current?.contains(focused)) &&
      request.anchor.isConnected && !request.anchor.closest('[inert]')) request.restoreFocus()
  }
  function leave() {
    cancelDeparture()
    departure.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement) || document.activeElement === request.anchor) return
      agentInformationPreview.dismiss(request.token)
    }, 160)
  }
  function showMetadata(next: AgentInformationTab) { cancelDeparture(); setTab(next) }
  function showReading() { returnToReading.current = true; setTab(null) }
  useLayoutEffect(() => {
    if (tab) back.current?.focus({ preventScroll: true })
    else if (returnToReading.current) { returnToReading.current = false; reading.current?.focus({ preventScroll: true }) }
  }, [tab !== null])
  useLayoutEffect(() => {
    const surface = panel.current
    if (!surface) return
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
    const stop = autoUpdate(request.anchor, surface, () => { void update() })
    return () => { current = false; stop(); cancelDeparture() }
  }, [request.token])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || wasWindowOverlayDismissed(event)) return
      if (request.pinned && !panel.current?.contains(document.activeElement)) return
      markWindowOverlayDismissal(event); event.preventDefault()
      if (tab) showReading()
      else close(true)
    }
    const hide = () => { setVisible(document.visibilityState !== 'hidden'); if (document.visibilityState === 'hidden') agentInformationPreview.dismiss(request.token) }
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node)) agentInformationPreview.dismiss(request.token) }
    document.addEventListener('keydown', escape)
    document.addEventListener('visibilitychange', hide)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', outside, true)
    const resize = () => agentInformationPreview.dismiss(request.token)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('keydown', escape); document.removeEventListener('visibilitychange', hide)
      document.removeEventListener('pointerdown', outside, true); window.removeEventListener('scroll', outside, true); window.removeEventListener('resize', resize)
    }
  }, [request, tab])
  const host = getWindowOverlayHost()
  if (!host) return null
  return createPortal(<div ref={panel} id={request.id} className="focus-context-hover agent-information-reader" role="region"
    data-state="open" aria-label={`Full context for ${context.name}`} tabIndex={-1} style={{ visibility: 'hidden' }}
    onPointerEnter={cancelDeparture} onPointerLeave={leave} onFocus={cancelDeparture} onBlur={event => {
      if (event.relatedTarget instanceof Node && (panel.current?.contains(event.relatedTarget) || event.relatedTarget === request.anchor)) return
      leave()
    }}>
    <header className="agent-information-reader__header">
      <span className="agent-information-reader__identity">{request.identity?.tabs.length
        ? <WorkbenchTopology tabs={request.identity.tabs} interactive={false} enabled={false} />
        : <AgentAvatar executorId={context.executorId} label={context.name} state={currentContext.state} providerId={context.providerId ?? undefined} size={24} visible={false} />}</span>
      <div className="agent-information-reader__heading"><small title={context.originAddress ?? path}>{context.workspaceName}</small><strong title={context.name}>{context.name}</strong></div>
      {sameSource ? <FocusContextStateSummary context={currentContext} explanationVisible={Boolean(service)} /> : <span className="focus-context-hover__state">Reading snapshot</span>}
    </header>
    {sourceNotice || service ? <div className="agent-information-reader__service" role={sourceNotice ? 'status' : undefined}>
      <InfoIcon size={13} aria-hidden="true" /><p>{sourceNotice ?? service}</p><button type="button" onClick={() => showMetadata('source')}>Source</button>
    </div> : null}
    <div className="agent-information-reader__body">
      <div ref={reading} className="agent-information-reader__reading" tabIndex={0} aria-label="Original Agent content"
        style={tab ? { visibility: 'hidden' } : undefined} inert={tab !== null}>
        <HeldReading request={request} enabled={visible && sameSource} />
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
      <button type="button" className="agent-information-reader__open" onClick={() => {
        const original = useAppStore.getState().sessions.find(session => session.id === context.id && session.hostId === context.hostId && session.control.run.runId === context.runId)
        if (original?.control.hostId === context.hostId && (context.kind !== 'agent' || original.kind === 'agent' && original.control.agentSessionId === request.control?.agentSessionId)) {
          request.openWorkface(); agentInformationPreview.dismiss(request.token)
        } else showMetadata('source')
      }}>Open Agent <OpenIcon size={13} aria-hidden="true" /></button>
      <button type="button" className="agent-information-reader__close" onClick={() => close(true)} aria-label="Close Agent reading" title="Close · Esc"><CloseIcon size={15} aria-hidden="true" /></button>
    </footer>
  </div>, host)
}
