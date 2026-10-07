import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AgentInformationDetails } from './AgentInformationDetails'
import type { FocusGoalLinks } from '../lib/focus-goal-links'
import type { FocusContextIdentity } from '../lib/focus-context-identity'
import { WorkbenchTabGlyph, WorkbenchTopology } from './WorkbenchTopology'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { clampStep } from '@agentmux/client-ui/activity-step-summary'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import type { FocusContext } from '../lib/focus-context'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { useAppStore } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { getWindowOverlayHost } from './WindowOverlayHost'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { agentStateEnteredAt } from '../lib/agent-state-time'
import { elapsedShort } from '../lib/project-activity-row'
import { FocusContextStateMark } from './FocusContextState'

// One transient reading surface, with no identity data or retained registry.
let dismissCurrentPreview: (() => void) | null = null

/** Full held text stays readable; only bounded complete prose enters Markdown parsing. */
function ReadingBody({ reading }: { reading: { text: string; truncated: boolean } }) {
  const literal = reading.truncated || reading.text.length > 8000
  return <div className="focus-context-hover__prose" data-reading-format={reading.truncated ? 'excerpt' : literal ? 'plain' : 'markdown'}>
    {literal ? <p>{reading.text}</p> : <AgentMarkdown content={reading.text} readOnly />}
  </div>
}

/** Mounted only inside the open preview; all input facts use the shared reader. */
function FocusContextInputs({ context }: { context: FocusContext }) {
  const control = useAppStore(state => {
    const session = state.sessions.find(session => session.id === context.id && session.hostId === context.hostId && session.control.run.runId === context.runId)
    return session?.kind === 'agent' && session.control.hostId === context.hostId ? session.control : undefined
  })
  const reader = useSessionUserMessages(control)
  const ordered = reader.messages.every(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt))
  // Missing times retain the public source order; they cannot establish a cross-source chronology.
  const messages = (ordered ? [...reader.messages].sort((a, b) => a.recordedAt! - b.recordedAt!) : reader.messages).slice(-3)
  // Recorded authors carry a canonical SID, but no authoritative peer Host.
  // Keep that reference rather than assigning a global first-match display name.
  const describe = createSpeakerResolver()
  const notice = !control || reader.error || reader.observationError ? 'Recent message reading unavailable'
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

/** Intent reveals held card facts and one scoped, read-only input preview. */
export function useAgentInformationPreview(context: FocusContext, requested: boolean, identity?: FocusContextIdentity, goalLinks?: FocusGoalLinks) {
  const active = useWorkbenchPresentationActive()
  const enabled = requested && active
  const displayPath = usePathDisplay()
  const path = displayPath(context.workspacePath, context.hostId)
  const location = [context.workspaceName, path, context.originAddress, context.id].filter(Boolean).join('\n')
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const readingFocus = useRef(false)
  const restoringFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const id = useId()
  const close = useCallback((): void => {
    readingFocus.current = false
    clearTimeout(intent.current); clearTimeout(departure.current)
    if (dismissCurrentPreview === close) dismissCurrentPreview = null
    setOpen(false)
  }, [])
  function keepOpen() { clearTimeout(departure.current) }
  function show() {
    clearTimeout(intent.current); keepOpen()
    // This guards a transient tooltip only, never the original Agent or card action.
    if (!enabled || !anchor.current?.isConnected || anchor.current.closest('[inert]') || document.visibilityState === 'hidden') return false
    if (dismissCurrentPreview !== close) dismissCurrentPreview?.()
    dismissCurrentPreview = close
    setOpen(true)
    return true
  }
  function showSoon() { clearTimeout(intent.current); keepOpen(); if (enabled) intent.current = setTimeout(show, 180) }
  function hideSoon() {
    clearTimeout(intent.current); keepOpen()
    departure.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement) || anchor.current?.contains(document.activeElement)) return
      close()
    }, 160)
  }
  function suppressRestoredFocus() {
    restoringFocus.current = true
    // Radix restores its trigger synchronously after closeAutoFocus. A later
    // intentional focus or hover should still disclose the current card.
    queueMicrotask(() => { restoringFocus.current = false })
  }
  useLayoutEffect(() => { close() }, [context.id, context.hostId, context.runId, context.name, context.state, context.detail,
    context.recap?.text, context.recap?.source, context.recap?.origin, context.recap?.reading?.text,
    context.recap?.reading?.truncated, context.workspacePath, context.originAddress, enabled, close])
  useLayoutEffect(() => () => {
    clearTimeout(intent.current); clearTimeout(departure.current)
    if (dismissCurrentPreview === close) dismissCurrentPreview = null
  }, [close])
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return
    let current = true
    const surface = panel.current
    const update = async () => {
      const { x, y } = await computePosition(anchor.current!, surface, {
        strategy: 'fixed', placement: 'bottom-start', middleware: [offset(8), flip({ padding: 10 }), shift({ padding: 10, crossAxis: true })]
      })
      if (current) {
        Object.assign(surface.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
        if (readingFocus.current) {
          readingFocus.current = false
          if (document.activeElement === anchor.current && !anchor.current?.closest('[inert]')) surface.focus({ preventScroll: true })
        }
      }
    }
    const stop = autoUpdate(anchor.current, surface, () => { void update() })
    return () => { current = false; stop() }
  }, [open])
  useLayoutEffect(() => {
    if (!enabled) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const ownsFocus = panel.current?.contains(document.activeElement)
      close()
      if (ownsFocus && anchor.current?.isConnected && !anchor.current.closest('[inert]')) {
        event.preventDefault()
        suppressRestoredFocus(); anchor.current.focus({ preventScroll: true })
      }
    }
    const hide = () => { if (document.visibilityState === 'hidden') close() }
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close() }
    document.addEventListener('keydown', escape)
    document.addEventListener('visibilitychange', hide)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', escape)
      document.removeEventListener('visibilitychange', hide)
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', close)
    }
  }, [enabled, close])
  const host = open ? getWindowOverlayHost() : null
  const serviceVisible = !context.detailIsRecap && context.detailKind === 'service'
  const activitySupplement = !context.detailIsRecap && !serviceVisible && Boolean(context.recap)
  const preview = open && host ? createPortal(<div ref={panel} id={id} className="focus-context-hover" role="region"
    data-state="open" aria-label={`Full context for ${context.name}`} tabIndex={0} style={{ visibility: 'hidden' }}
    onPointerEnter={keepOpen} onPointerLeave={hideSoon} onFocus={keepOpen} onBlur={event => {
      if (event.relatedTarget instanceof Node && (panel.current?.contains(event.relatedTarget) || anchor.current?.contains(event.relatedTarget))) return
      hideSoon()
    }}>
    <header><strong title={context.name}>{context.name}</strong><FocusContextStateSummary context={context} explanationVisible={serviceVisible} /></header>
    {context.kind === 'agent' ? <AgentInformationDetails context={context} goalLinks={goalLinks} /> : null}
    {!context.detailIsRecap && !activitySupplement ? <p className="focus-context-hover__activity">{context.detail}</p> : null}
    {context.recap ? <section className="focus-context-hover__recap">
      <small title={`${context.recap.source} · ${context.recap.origin} · ${context.recap.text}`}>{context.recap.source === 'Last assistant message' ? 'Latest reply' : 'Latest input'}{(context.recap.reading?.truncated ?? true) ? ' · Excerpt' : ''}</small>
      <ReadingBody reading={context.recap.reading ?? { text: context.recap.text, truncated: true }} />
    </section> : null}
    {activitySupplement ? <details className="focus-context-hover__activity-details"><summary>Activity details</summary><p>{context.detail}</p></details> : null}
    {identity ? <section className="focus-context-hover__workbench" aria-label={`${identity.occurrenceCount} confirmed ${identity.occurrenceCount === 1 ? 'position' : 'positions'}`}>
      {identity.tabs.map(tab => <section key={tab.occurrenceKey ?? tab.tabId} data-focus-occurrence-key={tab.occurrenceKey}>
        <span className="focus-context-hover__position-glyph" title={tab.title}><WorkbenchTabGlyph tab={tab} /></span>
        <span className="focus-context-hover__position-copy" title={[tab.title, tab.locationLabel].filter(Boolean).join('\n')}>
          {tab.title !== context.name ? <strong>{tab.title}</strong> : null}
          <small className="focus-context-hover__position-label">{tab.locationLabel ?? 'Original position'} · {tab.regions.length} {tab.regions.length === 1 ? 'Region' : 'Regions'}</small>
        </span>
      </section>)}
    </section> : null}
    {context.kind === 'agent' ? <FocusContextInputs key={`${context.hostId}:${context.id}:${context.runId}`} context={context} /> : null}
    <footer title={location} aria-label={location}><strong>{context.workspaceName}</strong><span>{path}</span></footer>
  </div>, host) : null
  const position = identity?.tabs.some(tab => tab.regions.length > 1) ? <span className="focus-context__position"
    aria-label={`${identity.occurrenceCount} confirmed ${identity.occurrenceCount === 1 ? 'position' : 'positions'}`}
    onPointerEnter={close} onPointerLeave={event => {
      if (event.relatedTarget instanceof Node && anchor.current?.contains(event.relatedTarget)) showSoon()
    }}><WorkbenchTopology tabs={identity.tabs} interactive={false} enabled={enabled && !open} /></span> : undefined
  return { anchor, position, describedBy: open ? id : undefined, preview, close, suppressRestoredFocus,
    triggerEvents: { 'aria-keyshortcuts': enabled ? 'ArrowDown' : undefined, onPointerEnter: showSoon, onPointerLeave: hideSoon, onFocus: () => { if (!restoringFocus.current) show() }, onBlur: hideSoon, onPointerDown: close, onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ArrowDown' || !enabled) return
      if (panel.current?.isConnected && panel.current.style.visibility === 'visible') {
        event.preventDefault(); keepOpen(); panel.current.focus({ preventScroll: true })
      } else if (show()) { event.preventDefault(); readingFocus.current = true }
    } } }
}
