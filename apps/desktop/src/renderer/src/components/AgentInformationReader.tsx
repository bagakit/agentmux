import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import { formatSessionAddress } from '../lib/agent-address'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { COLLECTED_REPLY_TITLE } from '@agentmux/client-ui/conversation-sources'
import { useAgentBookmarkWindow } from '../lib/use-agent-bookmark-window'
import { useAgentBookmarkReading } from '../lib/agent-bookmark-reading'
import { agentBookmarks, type AgentBookmarkBounds } from '../lib/agent-bookmarks'
import { WorkbenchDocumentContext } from '../lib/workbench-document'
import { observeWorkbenchDocumentReturn, workbenchDocumentIdentity, useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'
import { DesktopClientUiProvider } from './DesktopClientUiProvider'
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
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
import { currentConversationSpeakerMetadata } from '../lib/conversation-sender-details'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { AgentInformationDetails, AgentInformationSummary, type AgentInformationTab } from './AgentInformationDetails'
import { FocusContextStateMark } from './FocusContextState'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { WorkbenchTabGlyph } from './WorkbenchTopology'
import { getWindowOverlayHost, markWindowOverlayDismissal, wasWindowOverlayDismissed } from './WindowOverlayHost'
import { getModalOverlayContainer, ModalAttachmentDismissal, MODAL_OVERLAY_SLOT_REMOVED } from '@agentmux/client-ui/components/Modal'

const DetailsIcon = semanticIconComponent('action.more')
const CloseIcon = semanticIconComponent('action.close')
const DragIcon = semanticIconComponent('action.drag')
const ResizeIcon = semanticIconComponent('layout.resize-window')
const ResetIcon = semanticIconComponent('action.reset-view')
const OpenIcon = semanticIconComponent('action.open-external')
const PinIcon = semanticIconComponent('action.pin')

function moveReadingHost(host: HTMLElement, destination: HTMLElement, before: Element | null = null) {
  const document = host.ownerDocument
  const selection = document.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const saved = range && host.contains(range.startContainer) && host.contains(range.endContainer)
    ? { range, start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset } : null
  const active = document.activeElement, focus = active && host.contains(active) ? active as HTMLElement : null
  if (host.isConnected && host.ownerDocument === destination.ownerDocument && typeof destination.moveBefore === 'function') destination.moveBefore(host, before)
  else destination.insertBefore(host, before)
  focus?.focus({ preventScroll: true })
  if (saved && document === destination.ownerDocument) {
    saved.range.setStart(saved.start, saved.startOffset); saved.range.setEnd(saved.end, saved.endOffset)
    selection?.removeAllRanges(); selection?.addRange(saved.range)
  }
}

function FocusContextStateSummary({ context }: { context: FocusContext }) {
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
    <span className="focus-context-hover__state-label"><FocusContextStateMark context={context} />{context.stateLabel}</span>
    <span className="focus-context-hover__state-time">{duration}</span>
  </span>
}


function ReadingCopy({ text, label, identity }: { text: string; label: string; identity: unknown }) {
  return <span className="agent-reading-copy" title={label} onPointerDown={event => { if (event.button === 0) event.preventDefault() }}>
    <ContentCopyButton text={text} label={label} identity={identity} onCopyError={error => useAppStore.getState().reportError(error)} />
  </span>
}

const HeldReading = memo(function HeldReading({ request, enabled, available, follow = false }: { request: PreviewRequest; enabled: boolean; available: boolean; follow?: boolean }) {
  const context = request.context
  const reply = context.recap, copyReply = request.pinned && reply && reply.source !== 'Last prompt'
  return <>
    {!context.recap && request.contentChanged ? <small className="agent-information-reader__change">Card content changed · Reading kept</small> : null}
    {context.recap ? <section className="focus-context-hover__recap">
      <small title={`${context.recap.source} · ${context.recap.origin}`}>
        {context.recap.source === 'Last reply observation' ? COLLECTED_REPLY_TITLE : context.recap.source === 'Last assistant message' ? 'Latest reply' : context.recap.source === 'Saved conversation excerpt' ? 'Saved excerpt' : 'Latest input'}
        {request.contentChanged ? <span>Card content changed · Reading kept</span> : (context.recap.reading?.truncated ?? true) ? <span>Excerpt</span> : null}
        {copyReply ? <ReadingCopy text={reply.reading?.text ?? reply.text} label={reply.source === 'Saved conversation excerpt' ? 'Copy saved excerpt' : reply.reading?.truncated === false ? 'Copy current reply' : 'Copy reply excerpt'} identity={JSON.stringify([context.runId, request.sourceKey])} /> : null}
      </small>
      <ReadingBody reading={context.recap.reading ?? { text: context.recap.text, truncated: true }} active={enabled} />
    </section> : !context.detailIsRecap && context.detailKind !== 'service' ? <p className="focus-context-hover__activity">{context.detail}</p> : null}
    {context.kind === 'agent' ? <AgentInputRecap request={request} enabled={enabled} available={available} follow={follow} /> : null}
  </>
})

/** From first peek onward this is the same window-owned tree, never a row's Portal. */
export function AgentInformationReader({ request: opening }: { request: PreviewRequest }) {
  const requestDocument = opening.anchor.ownerDocument
  const [document, setDocument] = useState(() => requestDocument)
  // A stable Portal container preserves this reading tree when its native shell returns.
  const [readingHost] = useState(() => {
    const host = requestDocument.createElement('div'); host.style.display = 'contents'; host.dataset.agentReadingHost = opening.id; return host
  })
  const window = document.defaultView!
  const visible = useWorkbenchDocumentVisibility(document)
  const request = useAgentBookmarkReading(opening, visible)
  const readingOrder = agentInformationPreview.getAll()
  // A durable reader leaves its source scope once. Later unpinning cannot silently
  // reattach the same reading tree to a modal that may already have closed.
  const detachedFromModal = useRef(Boolean(opening.pinned || opening.bookmark))
  if (request.pinned || request.bookmark) detachedFromModal.current = true
  const attachedToModal = visible && !detachedFromModal.current && opening.anchor.ownerDocument === document && getModalOverlayContainer(opening.anchor) !== null
  const context = request.context
  const informationSummaryId = useId()
  const panel = useRef<HTMLDivElement>(null), reading = useRef<HTMLDivElement>(null)
  const canDrag = Boolean(request.bookmark || request.session?.kind === 'agent')
  const bookmarkWindow = useAgentBookmarkWindow(request.bookmark, panel, reading, document, canDrag ? pinFromDrag : undefined)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const back = useRef<HTMLButtonElement>(null), returnToReading = useRef(false)
  const reflowAnchor = useRef<{ container: HTMLElement; anchor: ReturnType<typeof captureReadingAnchor> } | null>(null)
  const heldReadingSurface = useRef<HTMLElement | null>(null)
  const heldSelection = useRef<Range | null>(null), laterSelection = useRef(false)
  const [tab, setTab] = useState<AgentInformationTab | null>(null)
  const consumedFocus = useRef<object | undefined>(undefined)
  useLayoutEffect(() => {
    if (!visible || !opening.focusReading || consumedFocus.current === opening.focusReading) return
    consumedFocus.current = opening.focusReading
    const surface = tab ? back.current : reading.current?.querySelector<HTMLElement>('[data-agent-input-reading]') ?? reading.current
    surface?.focus({ preventScroll: true })
  }, [opening.focusReading, document, visible, tab])
  useEffect(() => { if (!visible) agentInformationPreview.dismiss(request.token) }, [visible, request.token])
  const transferredFocus = useRef<HTMLElement | null>(null)
  const transferredSelection = useRef<{ start: Node; startOffset: number; end: Node; endOffset: number } | null>(null)
  useLayoutEffect(() => {
    const modalSlot = !detachedFromModal.current && opening.anchor.ownerDocument === document
      ? getModalOverlayContainer(opening.anchor) : null
    const destination = modalSlot ?? getWindowOverlayHost(document)
    if (destination && readingHost.parentElement !== destination) moveReadingHost(readingHost, destination)
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
    const departed = (event: Event) => {
      if (event.target === modalSlot && !detachedFromModal.current) agentInformationPreview.dismiss(request.token)
    }
    modalSlot?.addEventListener(MODAL_OVERLAY_SLOT_REMOVED, departed)
    return () => modalSlot?.removeEventListener(MODAL_OVERLAY_SLOT_REMOVED, departed)
  }, [document, readingHost, opening.anchor, request.token, request.pinned, request.bookmark?.key])
  // Original reading intent owns front-to-back order only within this exact container.
  // A bookmark never acquires another global layer by accumulating more siblings.
  useLayoutEffect(() => {
    const destination = readingHost.parentElement
    if (!destination) return
    const requests = readingOrder, index = requests.findIndex(item => item.token === request.token)
    if (index < 0) return
    let before: HTMLElement | null = null
    for (let next = index + 1; next < requests.length; next += 1) {
      const candidate = document.getElementById(requests[next]!.id)?.parentElement
      if (candidate?.parentElement === destination && candidate.dataset.agentReadingHost === requests[next]!.id) { before = candidate; break }
    }
    let following = readingHost.nextElementSibling
    while (following && !following.hasAttribute('data-agent-reading-host')) following = following.nextElementSibling
    if (following !== before) moveReadingHost(readingHost, destination, before)
  }, [document, readingHost, request.token, readingOrder, request.pinned, request.bookmark?.key])
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
    detachedFromModal.current = true
    getWindowOverlayHost(destination)?.appendChild(readingHost)
    if (heldRange) {
      const rebound = destination.createRange(); rebound.setStart(heldRange.start, heldRange.startOffset); rebound.setEnd(heldRange.end, heldRange.endOffset)
      heldSelection.current = rebound
    }
    setDocument(destination)
  }), [document, readingHost])
  useLayoutEffect(() => () => { readingHost.remove() }, [readingHost])
  const lastVisibleSession = useRef(request.session)
  const session = useAppStore(state => !visible ? lastVisibleSession.current : request.bookmark ? request.session : state.sessions.find(session => session.id === context.id && session.hostId === context.hostId &&
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
  const [readingRequest, setReadingRequest] = useState(request)
  const currentReading = request.bookmark ? readingRequest : request
  const displayedReading = useMemo(() => request.bookmark ? { ...currentReading, pinned: true, bookmark: request.bookmark } : currentReading, [currentReading, request.bookmark])
  const changedReading = Boolean(request.bookmark && request.session && (readingRequest.context.runId !== request.context.runId || readingRequest.sourceKey !== request.sourceKey ||
    (readingRequest.context.recap?.reading?.text ?? readingRequest.context.recap?.text) !== (request.context.recap?.reading?.text ?? request.context.recap?.text) ||
    readingRequest.context.recap?.source !== request.context.recap?.source || !request.context.detailIsRecap && readingRequest.context.detail !== request.context.detail))
  const [readingProtected, setReadingProtected] = useState(false)
  function protectedReading() {
    const selection = document.getSelection()
    return Boolean(tab || reading.current?.querySelector('[data-agent-input-reading]') || (reading.current?.scrollTop ?? 0) > 1 ||
      selection && !selection.isCollapsed && reading.current?.contains(selection.anchorNode))
  }
  useLayoutEffect(() => {
    const protectedNow = protectedReading()
    if (protectedNow !== readingProtected) setReadingProtected(protectedNow)
    if (request.bookmark && !protectedNow && changedReading && visible && session) setReadingRequest(request)
  }, [request, changedReading, tab, visible, session, readingProtected])
  useEffect(() => {
    if (!request.bookmark) return
    const changed = () => setReadingProtected(protectedReading())
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [document, request.bookmark?.key, tab])
  const readingSameSource = Boolean(session && session.control.run.runId === currentReading.context.runId && (session.kind !== 'agent' || nativeBindingKey(session) === currentReading.sourceKey))
  const sameSource = Boolean(session)
  const currentContext = useMemo(() => visible && session
    ? { ...agentContextForSession(session, undefined, context.name, context.workspace, context.topicId), lastActivityAt: context.lastActivityAt } : context,
  [visible, session, context, observationNow])
  const observation = session?.kind === 'agent' ? observeAgentSession(session, Date.now()) : undefined
  const identityFacts = useAppStore(useShallow(state => ({ config: visible ? state.config : null,
    topics: visible ? state.scratchTopicSnapshots : undefined, icons: visible ? state.spaceObjectIcons : undefined,
    bindings: visible ? state.spaceZoneBindings : undefined })))
  // Resolve only the exact held execution; a scalar SID or the current display
  // Workspace cannot supply another Host's affiliation to this reader.
  const affiliation = useMemo(() => session?.kind === 'agent' && identityFacts.config
    ? currentConversationSpeakerMetadata(session.id, { sessions: [session], workspaces: identityFacts.config.workspaces,
      config: identityFacts.config, agentNames: {}, scratchTopicSnapshots: identityFacts.topics ?? {}, spaceObjectIcons: identityFacts.icons ?? {}, spaceZoneBindings: identityFacts.bindings ?? {} }) : undefined,
  [session?.id, session?.kind, session?.hostId, session?.workspacePath, identityFacts])
  const usage = session?.kind === 'agent' ? session.turnUsage : request.session?.kind === 'agent' ? request.session.turnUsage : undefined
  const sourceNotice = !sameSource ? 'Original Run or source is no longer confirmed. This reading is kept; new source data is not attached.'
    : request.bookmark && !readingSameSource ? 'Reading an earlier Run or source. Show latest to follow the current Agent.' : null
  const routineObservation = observation?.reason && currentContext.bucket === 'idle' && currentContext.processState === 'running' &&
    !currentContext.runUnobserved && currentContext.state !== 'disconnected'
  const service = !routineObservation && !currentContext.detailIsRecap && currentContext.detailKind === 'service' ? currentContext.detail : null
  const displayPath = usePathDisplay(), path = displayPath(context.workspacePath, context.hostId)
  const source = <>
    <h3>Status and source</h3><p>{currentContext.detail}</p>
    {affiliation?.mote ? <p>Mote · {affiliation.mote.name}</p> : affiliation?.project ? <p>Project · {affiliation.project.name}</p> : <p>Project or Mote affiliation is not confirmed. The Executor identity is retained.</p>}
    {currentContext.detail !== context.detail ? <p>At opening: {context.detail}</p> : null}
    <dl className="agent-information-reader__source">
      <div><dt>Host</dt><dd>{request.bookmark?.hostId ?? context.hostId}</dd></div><div><dt>Session</dt><dd>{request.control?.agentSessionId ?? request.bookmark?.agentSessionId ?? context.id}</dd></div>
      <div><dt>Run</dt><dd>{context.runId}</dd></div><div><dt>Project</dt><dd>{context.workspaceName}</dd></div>
      <div><dt>Directory</dt><dd>{path}</dd></div>{context.originAddress ? <div><dt>Origin</dt><dd>{context.originAddress}</dd></div> : null}
    </dl>
    {request.contentChanged ? <p>Original card content changed. Close and reopen its preview to read the latest observed text.</p> : null}
    <p>Text, positions and Goal links were captured for this preview. Status and usage follow the same confirmed Run and source.</p>
    <p>This preview contains the latest observed reply and recent inputs. Earlier records remain in the Agent’s History.</p>
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
    if (bookmarkWindow.isGesturing()) return
    departure.current = setTimeout(() => {
      if (panel.current?.contains(document.activeElement) || document.activeElement === request.anchor) return
      agentInformationPreview.dismiss(request.token)
    }, 160)
  }
  function rememberPinReading() {
    cancelDeparture()
    const container = reading.current?.querySelector<HTMLElement>('[data-agent-input-reading]') ?? reading.current
    reflowAnchor.current = container ? { container, anchor: captureReadingAnchor(container) } : null
  }
  function pinFromDrag(bounds: AgentBookmarkBounds) {
    const sourceSlot = readingHost.parentElement?.hasAttribute('data-overlay-modal-slot') ? readingHost.parentElement : null
    rememberPinReading()
    const promotion = agentInformationPreview.ensurePinned(request.token, bounds)
    if (!promotion) return
    return { key: promotion.key, cancel() {
      // Explicit undo returns only to this gesture's still-live source, never a later modal.
      if (promotion.created && sourceSlot?.isConnected && sourceSlot.ownerDocument === document && getModalOverlayContainer(opening.anchor) === sourceSlot) detachedFromModal.current = false
      promotion.cancel()
    } }
  }
  function togglePin() {
    rememberPinReading()
    const bounds = panel.current?.getBoundingClientRect()
    agentInformationPreview.pin(request.token, bounds && bounds.width > 0 && bounds.height > 0 ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : undefined)
  }
  useLayoutEffect(() => {
    if (reflowAnchor.current) restoreReadingAnchor(reflowAnchor.current.container, reflowAnchor.current.anchor)
    reflowAnchor.current = null
  }, [request.pinned])
  function showMetadata(next: AgentInformationTab) {
    cancelDeparture()
    if (!tab) {
      heldReadingSurface.current = reading.current?.querySelector<HTMLElement>('[data-agent-input-reading]') ?? reading.current
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
      const surface = heldReadingSurface.current?.isConnected ? heldReadingSurface.current : reading.current
      surface?.focus({ preventScroll: true })
      heldReadingSurface.current = null
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
      if (bookmarkWindow.isGesturing()) return
      const epoch = bookmarkWindow.positionEpoch()
      const canPosition = () => current && !bookmarkWindow.isGesturing() && bookmarkWindow.positionEpoch() === epoch
      const { x, y } = await computePosition(request.anchor, surface, {
        strategy: 'fixed', placement: 'right-start', middleware: [offset(8),
          flip({ padding: 10, fallbackPlacements: ['left-start', 'bottom-start', 'top-start'] }), shift({ padding: 10 }),
          size({ padding: 10, apply({ availableHeight, elements }) {
            // Preserve room for title/actions when every side is constrained; fit the body by scrolling.
            const height = Math.min(620, window.innerHeight - 20, Math.max(Math.min(160, window.innerHeight - 20), availableHeight))
            if (canPosition()) elements.floating.style.maxHeight = `${height}px`
          } }), shift({ padding: 10, crossAxis: true })]
      })
      if (canPosition()) {
        Object.assign(surface.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
        if (request.enterReading && document.activeElement === request.anchor && !request.anchor.closest('[inert]')) reading.current?.focus({ preventScroll: true })
      }
    }
    if (request.bookmark) return
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
  }, [request.token, request.pinned, request.bookmark?.bounds, document, visible])
  function escapeReading(event: KeyboardEvent) {
    if (event.defaultPrevented || wasWindowOverlayDismissed(event) || isImeOwnedKeyboardEvent(event)) return
    if (event.key.toLowerCase() === 'p' && !event.metaKey && !event.ctrlKey && !event.altKey && panel.current?.contains(document.activeElement) &&
      !(event.target && (event.target as Element).nodeType === 1 && (event.target as Element).closest('input, textarea, [contenteditable="true"]'))) { event.preventDefault(); togglePin(); return }
    if (event.key !== 'Escape') return
    if (!panel.current?.contains(document.activeElement) && panel.current?.contains(event.target as Node) !== true &&
      (document.activeElement !== request.anchor || agentInformationPreview.get()?.token !== request.token)) return
    if (request.pinned && !panel.current?.contains(document.activeElement)) return
    markWindowOverlayDismissal(event); event.preventDefault()
    if (tab) showReading()
    else close(true)
  }
  useEffect(() => {
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node)) agentInformationPreview.dismiss(request.token) }
    document.addEventListener('keydown', escapeReading)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', outside, true)
    const resize = () => agentInformationPreview.dismiss(request.token)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('keydown', escapeReading)
      document.removeEventListener('pointerdown', outside, true); window.removeEventListener('scroll', outside, true); window.removeEventListener('resize', resize)
    }
  }, [request, tab, document])
  return createPortal(<WorkbenchDocumentContext.Provider value={{ document, window: workbenchDocumentIdentity(document) }}><DesktopClientUiProvider document={document}><div ref={panel} id={request.id} className="focus-context-hover agent-information-reader" role="region"
    data-state="open" data-drag-to-pin={canDrag || undefined} data-pinned={request.pinned || undefined} data-bookmark-key={request.bookmark?.key} hidden={!visible} aria-label={`Full context for ${context.name}`} tabIndex={-1} style={{ visibility: 'hidden', zIndex: 'var(--layer-popover)' }}
    onPointerDownCapture={() => { if (request.bookmark) agentBookmarks.bringToFront(request.bookmark.key) }}
    onPointerEnter={cancelDeparture} onPointerLeave={leave} onFocus={() => { cancelDeparture(); if (request.bookmark) agentBookmarks.bringToFront(request.bookmark.key) }} onBlur={event => {
      if (event.relatedTarget && (event.relatedTarget as Node).nodeType && (panel.current?.contains(event.relatedTarget as Node) || event.relatedTarget === request.anchor)) return
      leave()
    }}>
    <header className="agent-information-reader__header" {...bookmarkWindow.header}>
      {canDrag ? <button type="button" data-bookmark-move className="agent-bookmark__move" aria-label={request.pinned ? "Move Agent bookmark" : "Drag to pin Agent bookmark"} title={request.pinned ? "Drag title to move · Arrow keys move · Shift+Arrow keys resize" : "Drag title to pin and move"} onKeyDown={bookmarkWindow.moveKey}><DragIcon size={14} aria-hidden="true" /></button> : null}
      <span className="agent-information-reader__identity">{visible ? <ConversationMessageAvatar speaker={{ role: 'agent', id: context.id }} name={context.name}
        executorId={context.executorId} providerId={context.providerId ?? undefined} project={affiliation?.project} mote={affiliation?.mote} size={32} /> : null}</span>
      <div className="agent-information-reader__heading"><small title={context.originAddress ?? path}>{context.workspaceName}</small><div className="agent-information-reader__name"><strong title={context.name}>{context.name}</strong>{request.pinned ? <ReadingCopy text={context.name} label="Copy Agent title" identity={request.bookmark?.key ?? request.token} /> : null}</div></div>
      <button type="button" className="agent-information-reader__status" title={currentContext.detail} aria-label={`${sameSource ? currentContext.stateLabel : 'Reading snapshot'} · Status and source`}
        onPointerDown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => showMetadata('source')}>
        {sameSource && visible ? <FocusContextStateSummary context={currentContext} /> : <span className="focus-context-hover__state">Reading snapshot</span>}
      </button>
      <button type="button" className="agent-information-reader__pin" aria-label={request.pinned ? 'Remove Agent bookmark' : 'Pin Agent bookmark'} aria-pressed={request.pinned} aria-keyshortcuts="P" onClick={togglePin} title={request.pinned ? 'Remove bookmark · P' : 'Pin Agent bookmark · P'}>
        <PinIcon size={13} aria-hidden="true" />
      </button>
    </header>
    {sourceNotice || service ? <div className="agent-information-reader__service" role={sourceNotice ? 'status' : undefined}>
      <p>{sourceNotice ?? service}</p><button type="button" onPointerDown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => showMetadata('source')}>Source</button>
    </div> : null}
    {changedReading ? <div className="agent-information-reader__update" role="status">New Agent content <button type="button" onClick={() => { setReadingRequest(request); setReadingProtected(false) }}>Show latest</button></div> : null}
    <div className="agent-information-reader__body">
      <div ref={reading} className="agent-information-reader__reading" tabIndex={0} aria-label="Original Agent content" onScroll={() => setReadingProtected(protectedReading())}
        style={tab ? { visibility: 'hidden' } : undefined} inert={tab !== null}>
        <HeldReading key={JSON.stringify([currentReading.context.runId, currentReading.sourceKey])} request={displayedReading} enabled={visible && readingSameSource && tab === null} available={visible && (Boolean(request.bookmark) || readingSameSource)} follow={Boolean(request.bookmark) && !readingProtected && !changedReading} />
      </div>
      {tab ? <div className="agent-information-reader__metadata">
        <div className="agent-information-reader__metadata-heading"><button ref={back} type="button" onClick={showReading} aria-label="Back to original content">←</button><h3>Agent information</h3></div>
        <AgentInformationDetails context={context} goalLinks={request.goalLinks} usage={usage} control={visible && sameSource ? request.control : undefined} tab={tab} onTab={setTab} source={source} />
      </div> : null}
    </div>
    <footer className="agent-information-reader__footer" onPointerDown={event => { if (event.button === 0) event.preventDefault() }}>
      <button type="button" className="agent-information-reader__facts" onClick={() => tab ? showReading() : showMetadata('usage')}
        title="Usage, Goals, messages and source" aria-label="Agent information: usage, Goals, message relationships and source" aria-expanded={tab !== null} aria-describedby={informationSummaryId}>
        <AgentInformationSummary descriptionId={informationSummaryId} usage={usage} goalLinks={request.goalLinks} /><DetailsIcon size={13} aria-hidden="true" />
      </button>
      {request.bookmark ? <ReadingCopy text={formatSessionAddress(request.bookmark.agentSessionId)} label="Copy Agent link" identity={request.bookmark.key} /> : null}
      {request.bookmark ? <button type="button" className="agent-bookmark__reset" onClick={bookmarkWindow.reset} title="Reset bookmark position and size" aria-label="Reset bookmark position and size"><ResetIcon size={13} aria-hidden="true" /></button> : null}

      <button type="button" className="agent-information-reader__open" aria-label="Open Agent" title="Open Agent" onClick={() => {
        const original = useAppStore.getState().sessions.find(session => session.id === context.id && session.hostId === context.hostId && session.control.run.runId === context.runId)
        if (original?.control.hostId === context.hostId && (context.kind !== 'agent' || original.kind === 'agent' && original.control.agentSessionId === request.control?.agentSessionId)) {
          request.openWorkface(); agentInformationPreview.dismiss(request.token)
        } else showMetadata('source')
      }}><OpenIcon size={13} aria-hidden="true" /></button>
      <button type="button" className="agent-information-reader__close" onClick={() => close(true)} aria-label="Close Agent reading" title="Close · Esc"><CloseIcon size={15} aria-hidden="true" /></button>
      {request.bookmark ? <button type="button" className="agent-bookmark__resize" aria-label="Resize Agent bookmark" title="Drag corner or use Arrow keys to resize" {...bookmarkWindow.resize}>
        <ResizeIcon size={14} aria-hidden="true" />
      </button> : null}
    </footer>
  </div><ModalAttachmentDismissal active={attachedToModal} targetRef={panel} onEscapeKeyDown={escapeReading} /></DesktopClientUiProvider></WorkbenchDocumentContext.Provider>, readingHost)
}
