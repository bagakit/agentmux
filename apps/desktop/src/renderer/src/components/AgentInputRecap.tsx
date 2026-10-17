import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { AgentSessionUserMessage } from '@agentmux/core'
import { retainConversationInputs } from '@agentmux/core/conversation'
import { resolveFocusRecentInputs } from '../../../shared/focus-preferences'
import { useAppStore } from '../store'
import { type AgentInformationPreview as PreviewRequest } from '../lib/agent-information-preview'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { captureReadingAnchor, restoreReadingAnchor } from '../lib/reading-anchor'
import { AgentReadingBody, AgentReadingThumbnail } from './AgentReadingBody'
import { markWindowOverlayDismissal } from './WindowOverlayHost'
import { AgentInputEntry, inputPresentation } from './AgentInputEntry'

type InputReading = Pick<ReturnType<typeof useSessionUserMessages>, 'messages' | 'loading' | 'error' | 'observationError' | 'sourceChanged' | 'windowFrozen' | 'windowIncomplete'>
function inputReading(reader: ReturnType<typeof useSessionUserMessages>, limit: number): InputReading {
  const messages = reader.messages.slice(-limit)
  return { messages, loading: reader.loading, error: reader.error, observationError: reader.observationError,
    sourceChanged: reader.sourceChanged, windowFrozen: reader.windowFrozen, windowIncomplete: reader.windowIncomplete }
}

/** The original reader supplies facts; a pin retains only the presented inputs. */
export function AgentInputRecap({ request, enabled, available, follow = false }: { request: PreviewRequest; enabled: boolean; available: boolean; follow?: boolean }) {
  const [limit] = useState(() => resolveFocusRecentInputs(useAppStore.getState().config?.focus?.recentInputs))
  const [paused, setPaused] = useState(false), [frozen, setFrozen] = useState<InputReading | null>(null)
  const reader = useSessionUserMessages(request.control, { enabled: enabled && !paused })
  const region = useRef<HTMLElement>(null), held = useRef<InputReading | null>(null)
  const reflow = useRef<{ container: HTMLElement; anchor: ReturnType<typeof captureReadingAnchor> } | null>(null)
  const current = inputReading(reader, limit)
  useLayoutEffect(() => {
    if (enabled && (!request.pinned || follow) && !frozen) held.current = current
    if (request.pinned && !follow && !frozen) setFrozen(held.current ?? current)
  })
  useEffect(() => {
    if (!enabled || !frozen || follow || paused || reader.loading || !(reader.nativeHistoryPage || reader.error || reader.observationError)) return
    // A protected bookmark keeps the presented cut, including its selected input.
    // Let the original batch settle, then park this same view until explicit follow.
    if (request.bookmark) { setPaused(true); return }
    // Keep every already presented input. Only the original in-flight native batch
    // may fill unused slots; later captured requests cannot evict selected text.
    const messages = retainConversationInputs(frozen.messages, reader.messages.filter(message => message.source.kind === 'native'), limit)
    if (messages.length !== frozen.messages.length) {
      const container = region.current?.querySelector<HTMLElement>('[data-agent-input-reading]') ?? region.current?.closest<HTMLElement>('.agent-information-reader__reading')
      if (container) reflow.current = { container, anchor: captureReadingAnchor(container) }
    }
    setFrozen({ ...current, messages }); setPaused(true)
  }, [enabled, frozen, follow, request.bookmark, paused, reader.loading, reader.nativeHistoryPage, reader.error, reader.observationError])
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
  const messages = snapshot.messages.slice(-limit)
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
        <AgentInputEntry presentation={meta} expanded={inspected?.message.id === message.id} controls={request.id + '-input'} onOpen={anchor => openInput(message, anchor)}>
          <AgentReadingThumbnail reading={meta.reading} active={enabled && !inspected} control={request.control} sourceKey={request.sourceKey} input={message} />
        </AgentInputEntry>
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
    <header><button type="button" onClick={onClose} aria-label="Back to recent inputs"><SemanticIcon name="navigation.back" size={13} /></button>
      <div><strong>{meta.author}</strong><time dateTime={meta.date?.toISOString()} title={meta.provenance}>{meta.time}</time></div>
      <small>Original input</small></header>
    <div ref={body} data-agent-input-reading className="agent-input-recall__original-body" tabIndex={0} aria-label="Original input text and images">
      <AgentReadingBody reading={meta.reading} active={active} control={request.control} sourceKey={request.sourceKey} input={inspected.message} />
    </div>
  </div>
}

type InspectedInput = { message: AgentSessionUserMessage; anchor: HTMLElement }
