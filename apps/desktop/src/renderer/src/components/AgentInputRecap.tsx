import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { clampStep } from '@agentmux/client-ui/activity-step-summary'
import { type AgentInformationPreview as PreviewRequest } from '../lib/agent-information-preview'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { captureReadingAnchor, restoreReadingAnchor } from '../lib/reading-anchor'
import { AgentReadingBody, AgentReadingThumbnail } from './AgentReadingBody'
import { markWindowOverlayDismissal } from './WindowOverlayHost'

type InputReading = Pick<ReturnType<typeof useSessionUserMessages>, 'messages' | 'loading' | 'error' | 'observationError' | 'sourceChanged' | 'windowFrozen' | 'windowIncomplete'>
function inputReading(reader: ReturnType<typeof useSessionUserMessages>): InputReading {
  const ordered = reader.messages.every(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt))
  const messages = reader.messages.slice(-6)
  return { messages, loading: reader.loading, error: reader.error, observationError: reader.observationError,
    sourceChanged: reader.sourceChanged, windowFrozen: reader.windowFrozen, windowIncomplete: reader.windowIncomplete }
}

/** The original reader supplies facts; a pin retains only the presented inputs. */
export function AgentInputRecap({ request, enabled, available, follow = false }: { request: PreviewRequest; enabled: boolean; available: boolean; follow?: boolean }) {
  const [paused, setPaused] = useState(false), [frozen, setFrozen] = useState<InputReading | null>(null)
  const reader = useSessionUserMessages(paused || frozen && !enabled ? undefined : request.control, { enabled: enabled && !paused })
  const region = useRef<HTMLElement>(null), held = useRef<InputReading | null>(null)
  const reflow = useRef<{ container: HTMLElement; anchor: ReturnType<typeof captureReadingAnchor> } | null>(null)
  const current = inputReading(reader)
  useLayoutEffect(() => {
    if (enabled && (!request.pinned || follow) && !frozen) held.current = current
    if (request.pinned && !follow && !frozen) setFrozen(held.current ?? current)
  })
  useEffect(() => {
    if (!enabled || !frozen || request.bookmark || paused || reader.loading || !(reader.nativeHistoryPage || reader.error || reader.observationError)) return
    // Keep every already presented input. Only the original in-flight native batch
    // may fill unused slots; later captured requests cannot evict selected text.
    const ids = new Set(frozen.messages.map(message => message.id)), slots = Math.max(0, 6 - frozen.messages.length)
    const arrivals = slots ? reader.messages.filter(message => message.source.kind === 'native' && !ids.has(message.id)).slice(-slots) : []
    const messages = slots ? [...frozen.messages, ...arrivals.slice(-slots)] : frozen.messages
    if (messages !== frozen.messages) {
      const container = region.current?.querySelector<HTMLElement>('[data-agent-input-reading]') ?? region.current?.closest<HTMLElement>('.agent-information-reader__reading')
      if (container) reflow.current = { container, anchor: captureReadingAnchor(container) }
    }
    setFrozen({ ...current, messages }); setPaused(true)
  }, [enabled, frozen, paused, reader.loading, reader.nativeHistoryPage, reader.error, reader.observationError])
  useLayoutEffect(() => {
    if (reflow.current) { restoreReadingAnchor(reflow.current.container, reflow.current.anchor); reflow.current = null }
  }, [frozen])
  useEffect(() => { if (follow) { setFrozen(null); setPaused(false) } }, [follow])
  const [inspected, setInspected] = useState<InspectedInput | null>(null)
  const original = useRef<HTMLDivElement>(null)
  const returnToEntry = useRef<{ anchor: HTMLElement; focused: Element } | null>(null)
  function openInput(message: AgentSessionUserMessage, anchor: HTMLElement) {
    if (enabled) setInspected({ message, anchor })
  }
  function closeInput() {
    const focused = original.current?.ownerDocument.activeElement
    if (focused && original.current?.contains(focused) && inspected?.anchor.isConnected) returnToEntry.current = { anchor: inspected.anchor, focused }
    setInspected(null)
  }
  useLayoutEffect(() => {
    if (inspected || !returnToEntry.current) return
    const { anchor, focused } = returnToEntry.current, document = anchor.ownerDocument
    returnToEntry.current = null
    if (anchor.isConnected && (document.activeElement === focused || document.activeElement === document.body)) anchor.focus({ preventScroll: true })
  }, [inspected])
  useLayoutEffect(() => { if (!available) setInspected(null) }, [available])
  const snapshot = frozen ?? (enabled ? current : held.current ?? current)
  const ordered = snapshot.messages.every(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt))
  // Missing times retain the public source order; they cannot establish a cross-source chronology.
  const messages = snapshot.messages.slice(-6)
  const notice = !request.control || snapshot.error || snapshot.observationError ? 'Recent message reading unavailable'
    : snapshot.sourceChanged ? 'Message source changed' : snapshot.windowFrozen ? 'Reading window paused'
      : snapshot.windowIncomplete ? 'Reading window incomplete' : null
  return <section ref={region} className="focus-context-hover__inputs agent-input-recall" aria-label="Recent user messages"
    onKeyDown={event => {
      if (event.key === 'Escape' && inspected) { event.preventDefault(); event.stopPropagation(); markWindowOverlayDismissal(event.nativeEvent); closeInput() }
    }}>
    <h4>Recent inputs <small>Click or Enter to read</small></h4>
    {!ordered ? <small className="focus-context-hover__coverage">Current reading window · Order unavailable</small> : null}
    {messages.length ? <ol inert={Boolean(inspected)}>{messages.map(message => {
      const meta = inputPresentation(message)
      return <li key={message.id} data-hover-input-id={message.id} data-input-author={message.author.kind}>
        <div className="agent-input-recall__entry" role="button" tabIndex={0} aria-label={`Read original input by ${meta.author}`} aria-controls={request.id + '-input'}
          aria-expanded={inspected?.message.id === message.id} onClick={event => openInput(message, event.currentTarget)}
          onKeyDown={event => {
            if (['Enter', ' ', 'ArrowDown'].includes(event.key)) { event.preventDefault(); openInput(message, event.currentTarget) }
          }}>
          <div className="agent-input-recall__copy"><div className="focus-context-hover__input-meta"><strong>{meta.author}</strong>
            <time dateTime={meta.date?.toISOString()} title={meta.provenance} aria-label={`${meta.time} · ${meta.provenance}`}>{meta.time}</time></div>
            <p className="agent-input-recall__excerpt">{meta.reading.text}</p></div>
          <AgentReadingThumbnail reading={meta.reading} active={enabled && !inspected} control={request.control} sourceKey={request.sourceKey} input={message} />
        </div>
      </li>
    })}</ol> : <p className="focus-context-hover__coverage">{snapshot.loading ? enabled ? 'Loading recent messages…' : 'Reading paused' : notice ? 'Recorded inputs unavailable' : 'No inputs in the current reading window'}</p>}
    {notice ? <p className="focus-context-hover__notice">{notice} · Open the Agent to read History.</p> : null}
    {inspected ? <div ref={original} id={request.id + '-input'} className="agent-input-recall__inspection">
      <OriginalInput inspected={inspected} request={request} active={enabled} onClose={() => closeInput()} />
    </div> : null}
  </section>
}

/** One inspected original input shares the window reader's source and document. */
function OriginalInput({ inspected, request, active, onClose }: { inspected: InspectedInput; request: PreviewRequest; active: boolean; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (inspected.anchor.ownerDocument.activeElement === inspected.anchor || inspected.anchor.ownerDocument.activeElement === inspected.anchor.ownerDocument.body) body.current?.focus({ preventScroll: true })
  }, [inspected])
  const meta = inputPresentation(inspected.message)
  return <div className="agent-input-recall__original" role="region" aria-label="Complete original input">
    <header><button type="button" onClick={onClose} aria-label="Back to recent inputs">←</button>
      <div><strong>{meta.author}</strong><time dateTime={meta.date?.toISOString()} title={meta.provenance}>{meta.time}</time></div>
      <small>Original input</small></header>
    <div ref={body} data-agent-input-reading className="agent-input-recall__original-body" tabIndex={0} aria-label="Original input text and images">
      <AgentReadingBody reading={meta.reading} active={active} control={request.control} sourceKey={request.sourceKey} input={inspected.message} />
    </div>
  </div>
}

type InspectedInput = { message: AgentSessionUserMessage; anchor: HTMLElement }
function inputPresentation(message: AgentSessionUserMessage) {
  const raw = message.content.trim(), body = parseAgentMuxMessagePrefix(raw)?.body.trim() || raw
  const recorded = message.recordedAt !== undefined && Number.isFinite(message.recordedAt) ? new Date(message.recordedAt) : null
  const date = recorded && Number.isFinite(recorded.getTime()) ? recorded : null
  return { reading: { text: body || 'Non-text input', truncated: false }, date,
    author: createSpeakerResolver()(speakerOfUserMessage(message)).name,
    time: date ? date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Time unknown',
    provenance: `${message.source.kind === 'native' ? 'Native record' : 'Submission record'} · Current reading window · Record time, not a verified sender time · ${clampStep(raw.slice(0, 1000), 'head', 360)}` }
}
