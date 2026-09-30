import { useId, useLayoutEffect, useRef } from 'react'
import { autoUpdate, computePosition, offset, shift, size, type VirtualElement } from '@floating-ui/dom'
import { ArrowUpRight, MessageSquare, X } from 'lucide-react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import type { FocusContext } from '../lib/focus-context'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { ConversationMessage } from './ConversationMessage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { speakerOfUserMessage, type DescribeSpeaker } from '../lib/conversation-speaker'
import { WindowOverlayPortal } from './WindowOverlayHost'
import { api } from '../lib/api'
import { createFocusTimeFormatters, type FocusTimeFormatters } from '../lib/focus-timeline-ruler'

export type FocusMessageReader = {
  contexts: readonly { id: string; name: string; workspaceName: string; details?: string }[]; contextId: string | null; messages: readonly AgentSessionUserMessage[]
  loading: boolean; coverage: string; error: string | null; canContinue: boolean
  onContext(id: string): void; onMessage(message: AgentSessionUserMessage): void
  onContinue(): void; onRefresh(): void
  sourceCoverage?: string; sourceError?: string | null; onMoreSources?: (() => void) | undefined; onRefreshSources?: () => void
  serviceNotice?: string | null; windowFrozen?: boolean
}
const readPastedImage = (path: string) => api.ui.readPastedImage(path)

/** One inspected Core input. Current Context facts never become its historical author or Run. */
export function FocusMessagePreview({ message, sender, recipient, recipientName, workspaceRoot, lane, hierarchy, interactive, anchor, reader, describeSpeaker, timeFormatters, onSelect, onClose, onMouseEnter, onMouseLeave }: {
  describeSpeaker: DescribeSpeaker
  message: AgentSessionUserMessage | undefined; sender: FocusContext | undefined; recipient: FocusContext | undefined
  lane: FocusProjectLane | undefined; hierarchy: FocusHierarchyFacts | undefined
  interactive: boolean; anchor: HTMLElement; reader?: FocusMessageReader; onSelect(id: string): void; onClose(): void
  recipientName?: string | undefined; workspaceRoot?: string | undefined
  onMouseEnter?(): void; onMouseLeave?(): void
  timeFormatters?: FocusTimeFormatters
}) {
  const time = timeFormatters ?? createFocusTimeFormatters('system')
  const element = useRef<HTMLDivElement>(null)
  const previewId = useId()
  const returnFocus = useRef(true)
  const insidePointer = useRef<PointerEvent | null>(null)
  const speaker = message ? speakerOfUserMessage(message) : undefined
  const agent = speaker?.role === 'agent'
  const authorId = agent ? speaker.id : undefined
  const described = speaker ? describeSpeaker(speaker) : undefined
  const topic = sender?.topicId && lane ? hierarchy?.topics[lane.workspaceId]?.find(item => item.id === sender.topicId) : undefined
  const branch = sender?.workspace?.branch ?? hierarchy?.worktrees.find(item => item.hostId === sender?.hostId && item.path === sender.workspacePath)?.branch
  const project = lane?.projectWorkspaceId ? lane.labels[0] : sender?.workspace?.name
  const targetName = recipient?.name ?? recipientName ?? message?.agentSessionId ?? 'Context'
  const roleName = speaker?.role === 'human' ? 'Human message' : agent ? 'Agent message' : 'Prompt · Sender not recorded'
  const resources = message?.contentParts.filter(part => part.kind !== 'text').map(part => part.kind === 'resource' ? `${part.label ?? part.reference}` : part.kind === 'tool-call' ? `Tool call · ${part.name}` : part.kind === 'tool-result' ? `Tool result${part.name ? ` · ${part.name}` : ''}` : 'Reasoning record') ?? []
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const surface = element.current
    if (!surface) return
    const priorDescription = anchor.getAttribute('aria-describedby')
    anchor.setAttribute('aria-describedby', previewId)
    returnFocus.current = true
    let disposed = false
    let positioned = false
    const header = anchor.closest('.recent-focus')!.querySelector<HTMLElement>('.recent-focus__header')!
    let markerBounds = anchor.getBoundingClientRect()
    const reference: VirtualElement = {
      contextElement: header,
      getBoundingClientRect() {
        if (anchor.isConnected) markerBounds = anchor.getBoundingClientRect()
        return new DOMRect(markerBounds.left, header.getBoundingClientRect().top, markerBounds.width, 0)
      }
    }
    const update = async () => {
      const { x, y } = await computePosition(reference, surface, {
        strategy: 'fixed', placement: 'top', middleware: [offset(6), shift({ padding: 8 }), size({ padding: 8,
          apply({ availableWidth, availableHeight }) {
            if (disposed) return
            surface.style.width = `${Math.max(0, Math.min(332, availableWidth))}px`
            surface.style.maxHeight = `${Math.max(0, Math.min(440, window.innerHeight * .6, availableHeight))}px`
          }
        })]
      })
      if (disposed) return
      Object.assign(surface.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      if (!positioned) {
        positioned = true
        if (interactive && (document.activeElement === previous || document.activeElement === document.body)) surface.focus()
      }
    }
    const stopPosition = autoUpdate(reference, surface, () => { void update() })
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose() } }
    const outside = (event: PointerEvent) => {
      // A nested image Portal remains inside this React subtree, though DOM.contains is false.
      if (insidePointer.current === event) { insidePointer.current = null; return }
      if (interactive && event.target instanceof Node && !surface.contains(event.target) && !(event.target instanceof Element && event.target.closest('.recent-focus__message'))) onClose()
    }
    document.addEventListener('keydown', dismiss)
    document.addEventListener('pointerdown', outside)
    return () => {
      disposed = true
      stopPosition()
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('pointerdown', outside)
      if (anchor.getAttribute('aria-describedby') === previewId) {
        if (priorDescription) anchor.setAttribute('aria-describedby', priorDescription)
        else anchor.removeAttribute('aria-describedby')
      }
      if (interactive && returnFocus.current && previous?.isConnected && surface?.contains(document.activeElement)) previous.focus()
    }
  }, [anchor, interactive, onClose, previewId])
  const navigate = (context: FocusContext | undefined) => {
    if (!context) return
    returnFocus.current = false
    onSelect(context.id)
    onClose()
  }
  return <WindowOverlayPortal layer={interactive ? 'popover' : 'tooltip'}><div ref={element} id={previewId} tabIndex={interactive ? -1 : undefined} className="recent-focus__message-preview" data-interactive={interactive} data-state="open"
    data-preview-message-id={message?.id} data-message-author={speaker?.role}
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onPointerDownCapture={event => { insidePointer.current = event.nativeEvent }} role={interactive ? 'dialog' : 'tooltip'} aria-label="Message">
    <header>{!interactive && speaker ? <ConversationSpeakerAvatar speaker={speaker} name={described!.name} {...(described?.providerId ? { providerId: described.providerId } : {})} size={20} /> : <MessageSquare size={14} aria-hidden="true" />}<strong>{interactive ? reader ? 'Input records' : targetName : described?.name ?? 'Input'}</strong>
      {!interactive ? <span className="recent-focus__author-kind">{roleName}</span> : null}
      {interactive ? <button type="button" className="icon-button" aria-label="Close message" onClick={onClose}><X size={12} /></button> : null}</header>
    {reader ? <div className="recent-focus__input-reader">
      <label>Context <select aria-label="Input records Context" value={reader.contextId ?? ''} onChange={event => reader.onContext(event.target.value)}><option value="" disabled>Choose a Context</option>{reader.contexts.map(context => <option key={context.id} value={context.id} title={context.details}>{context.name} · {context.workspaceName}</option>)}</select></label>
      {reader.contexts.find(context => context.id === reader.contextId)?.details ? <details className="recent-focus__source-details"><summary>Source details</summary><p>{reader.contexts.find(context => context.id === reader.contextId)!.details}</p></details> : null}
      {reader.sourceCoverage ? <p className="recent-focus__input-coverage" role="status">{reader.sourceCoverage}</p> : null}
      {reader.sourceError ? <p className="recent-focus__input-error" role="status">{reader.sourceError} Existing inputs remain readable.</p> : null}
      {reader.onMoreSources || reader.sourceError ? <div className="recent-focus__input-actions">{reader.onMoreSources ? <button type="button" onClick={reader.onMoreSources}>Show more input sources</button> : null}{reader.sourceError && reader.onRefreshSources ? <button type="button" onClick={reader.onRefreshSources}>Retry input sources</button> : null}</div> : null}
      <p role="status" className="recent-focus__input-coverage">{reader.loading ? 'Reading input records… ' : ''}{reader.coverage}</p>
      {reader.error ? <p role="status" className="recent-focus__input-error">{reader.error} Existing records and live input are preserved.</p> : null}
      {reader.serviceNotice ? <p role="status" className="recent-focus__input-coverage" data-input-observation-notice>{reader.serviceNotice}</p> : null}
      <div className="recent-focus__input-actions"><button type="button" disabled={reader.loading || !reader.canContinue} onClick={reader.onContinue}>Read earlier records</button><button type="button" disabled={reader.loading} onClick={reader.onRefresh}>{reader.windowFrozen ? 'Read latest records' : 'Refresh source'}</button></div>
      <div className="recent-focus__input-list" aria-label="Available input records">{reader.messages.map(item => {
        const itemSpeaker = speakerOfUserMessage(item)
        const itemIdentity = describeSpeaker(itemSpeaker)
        const authorLabel = itemSpeaker.role === 'human' ? 'Human message' : itemSpeaker.role === 'agent' ? `Agent message from ${itemIdentity.name}` : 'Input, sender not recorded'
        return <button type="button" key={item.id} data-input-message-id={item.id} data-input-source={item.source.kind} data-message-author={itemSpeaker.role} aria-label={`${authorLabel}: ${item.content || 'Input with resources'}`} aria-pressed={message?.id === item.id} onClick={() => reader.onMessage(item)}>
          <ConversationSpeakerAvatar speaker={itemSpeaker} name={itemIdentity.name} {...(itemIdentity.providerId ? { providerId: itemIdentity.providerId } : {})} size={12} /><span>{item.content || 'Input with resources'}</span><small>{item.source.kind === 'native' ? 'Native' : 'Submission'} · {item.recordedAt === undefined || !Number.isFinite(item.recordedAt) ? 'Time unknown' : time.dateClock(item.recordedAt)}</small>
        </button>
      })}</div>
      {!reader.loading && reader.messages.length === 0 ? <p>No input records read in this view. Coverage may be incomplete.</p> : null}
    </div> : null}
    {message ? !interactive ? <>
      <p className="recent-focus__message-caption">To {targetName}</p>
      <p className="recent-focus__message-excerpt">{message.content.trim() || (resources.length ? resources.join(' · ') : 'Input has no recorded text')}</p>
      <footer className="recent-focus__message-meta"><span>{message.source.kind === 'native' ? 'Native record' : 'Submission record'}</span><time title="Record time, not a verified sender time">{message.recordedAt !== undefined && Number.isFinite(message.recordedAt) ? time.dateClock(message.recordedAt) : 'Record time unknown'}</time></footer>
      <span className="recent-focus__message-hint">Click or press Enter to keep reading</span>
    </> : <><p className="recent-focus__message-caption">To {targetName} · {roleName} · {message.source.kind === 'native' ? 'Native record' : 'Submission record'}{message.recordedAt === undefined || !Number.isFinite(message.recordedAt) ? ' · Record time unknown' : ''}</p>
    {agent ? <details className="recent-focus__sender-details"><summary>Sender Context · {sender?.name ?? 'Unavailable'}</summary><dl className="recent-focus__sender">
      <dt>Sender</dt><dd>{sender?.name ?? 'Context unavailable'}<small title={authorId}>{authorId}</small></dd>
      <dt>Current project</dt><dd>{project ?? 'Not recorded'}</dd>
      <dt>Current branch</dt><dd>{branch ?? 'Not recorded'}</dd>
      <dt>Current topic</dt><dd>{topic && !topic.readError ? topic.title || 'Untitled topic' : 'Not recorded'}</dd>
    </dl>{sender ? <p className="recent-focus__sender-work">Current: {sender.stateLabel} · {sender.detail}</p> : null}
      <p className="recent-focus__sender-run">Sender Run not recorded · Execution relationship unknown</p></details> : null}
    <div className="recent-focus__message-body" data-input-preview-id={message.id} data-input-source={message.source.kind}><ConversationMessage messageId={message.id}
      speaker={speaker!}
      name={described!.name} content={message.contentParts}
      timeFormatter={time.clock}
      {...(message.recordedAt === undefined || !Number.isFinite(message.recordedAt) ? {} : { createdAt: message.recordedAt })}
      workspaceRoot={recipient?.workspacePath ?? workspaceRoot ?? ''} readPastedImage={readPastedImage} /></div>
    {agent ? <button type="button" className="recent-focus__sender-link" disabled={!sender} onClick={() => navigate(sender)}>View sender<ArrowUpRight size={12} aria-hidden="true" /></button> : null}
    <button type="button" disabled={!recipient} onClick={() => navigate(recipient)}>Return to Context</button></> : null}
  </div></WindowOverlayPortal>
}
