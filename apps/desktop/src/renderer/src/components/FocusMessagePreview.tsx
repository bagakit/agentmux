import { useCallback, useId, useLayoutEffect, useRef } from 'react'
import type { AgentSessionHistoryResourceRequest } from '@agentmux/core'
import { autoUpdate, computePosition, offset, shift, size, type VirtualElement } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { describeConversationRecordSource, type ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { completedNativeReply } from '@agentmux/client-ui/conversation-files'
import type { FocusContext } from '../lib/focus-context'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import type { FocusDescribeSpeaker } from '../lib/conversation-sender-details'
import { WindowOverlayPortal } from './WindowOverlayHost'
import { api } from '../lib/api'
import { createFocusTimeFormatters, type FocusTimeFormatters } from '../lib/focus-timeline-ruler'

const ThemeConversationOutgoingIcon = semanticIconComponent('conversation.outgoing')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')


export type FocusMessageReader = {
  messages: readonly ConversationRecord[]; loading: boolean; coverage: string; error: string | null
  onMessage(message: ConversationRecord): void
  serviceNotice?: string | null
} & ({ selectionOnly: true } | {
  selectionOnly?: false
  contexts: readonly { id: string; name: string; workspaceName: string; details?: string }[]; contextId: string | null; canContinue: boolean
  onContext(id: string): void; onContinue(): void; onRefresh(): void
  sourceCoverage?: string; sourceError?: string | null; onMoreSources?: (() => void) | undefined; onRefreshSources?: () => void
  windowFrozen?: boolean
})

const readPastedImage = (path: string) => api.ui.readPastedImage(path)

/** One inspected recorded message. Current Context facts never become its historical author or Run. */
export function FocusMessagePreview({ message, sender, recipient, recipientName, workspaceRoot, lane, hierarchy, interactive, anchor, reader, describeSpeaker, timeFormatters, onSelect, onClose, onMouseEnter, onMouseLeave }: {
  describeSpeaker: FocusDescribeSpeaker
  message: ConversationRecord | undefined; sender: FocusContext | undefined; recipient: FocusContext | undefined
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
  const speaker = message?.speaker
  const reply = message?.kind === 'assistant-message'
  const system = message?.kind === 'system-message'
  const agent = speaker?.role === 'agent'
  const authorId = agent ? speaker.id : undefined
  const described = speaker ? describeSpeaker(speaker) : undefined
  const topic = sender?.topicId && lane ? hierarchy?.topics[lane.workspaceId]?.find(item => item.id === sender.topicId) : undefined
  const branch = sender?.workspace?.branch ?? hierarchy?.worktrees.find(item => item.hostId === sender?.hostId && item.path === sender.workspacePath)?.branch
  const project = lane?.projectWorkspaceId ? lane.labels[0] : sender?.workspace?.name
  const targetName = recipient?.name ?? recipientName ?? message?.agentSessionId ?? 'Context'
  const roleName = system ? 'System message' : speaker?.role === 'human' ? 'Human message' : agent ? reply ? 'Agent reply' : 'Agent input' : 'Prompt · Sender not recorded'
  const executionHostId = message?.executionHostId, agentSessionId = message?.agentSessionId
  const readHistoryResource = useCallback(async (input: AgentSessionHistoryResourceRequest) => {
    if (!executionHostId || !agentSessionId) throw new Error('The original conversation Host is unknown. Its recorded text remains readable; reopen its original source to read this resource.')
    return api.sessions.historyResource({ hostId: executionHostId, agentSessionId }, input)
  }, [executionHostId, agentSessionId])
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
    <header>{!interactive && speaker ? <ConversationSpeakerAvatar speaker={speaker} name={described!.name} mote={described?.mote} {...(described?.providerId ? { providerId: described.providerId } : {})} size={20} /> : <ThemeObjectConversationIcon size={14} aria-hidden="true" />}<strong>{interactive ? reader ? 'Conversation records' : targetName : described?.name ?? 'Input'}</strong>
      {!interactive ? <span className="recent-focus__author-kind">{roleName}</span> : null}
      {interactive ? <button type="button" className="icon-button" aria-label="Close message" onClick={onClose}><ThemeActionCloseIcon size={12} /></button> : null}</header>
    {reader ? <div className="recent-focus__input-reader">
      {!reader.selectionOnly ? <><label>Context <select aria-label="Conversation records Context" value={reader.contextId ?? ''} onChange={event => reader.onContext(event.target.value)}><option value="" disabled>Choose a Context</option>{reader.contexts.map(context => <option key={context.id} value={context.id} title={context.details}>{context.name} · {context.workspaceName}</option>)}</select></label>
      {reader.contexts.find(context => context.id === reader.contextId)?.details ? <details className="recent-focus__source-details"><summary>Source details</summary><p>{reader.contexts.find(context => context.id === reader.contextId)!.details}</p></details> : null}
      {reader.sourceCoverage ? <p className="recent-focus__input-coverage" role="status">{reader.sourceCoverage}</p> : null}
      {reader.sourceError ? <p className="recent-focus__input-error" role="status">{reader.sourceError} Existing records remain readable.</p> : null}
      {reader.onMoreSources || reader.sourceError ? <div className="recent-focus__input-actions">{reader.onMoreSources ? <button type="button" onClick={reader.onMoreSources}>Show more record sources</button> : null}{reader.sourceError && reader.onRefreshSources ? <button type="button" onClick={reader.onRefreshSources}>Retry record sources</button> : null}</div> : null}
      </> : null}
      <p role="status" className="recent-focus__input-coverage">{reader.loading ? 'Reading conversation records… ' : ''}{reader.coverage}</p>
      {reader.error ? <p role="status" className="recent-focus__input-error">{reader.error} Existing records and live input are preserved.</p> : null}
      {reader.serviceNotice ? <p role="status" className="recent-focus__input-coverage" data-input-observation-notice>{reader.serviceNotice}</p> : null}
      {!reader.selectionOnly ? <div className="recent-focus__input-actions"><button type="button" disabled={reader.loading || !reader.canContinue} onClick={reader.onContinue}>Read earlier records</button><button type="button" disabled={reader.loading} onClick={reader.onRefresh}>{reader.windowFrozen ? 'Read latest records' : 'Refresh source'}</button></div> : null}
      <div className="recent-focus__input-list" aria-label="Available conversation records">{reader.messages.map(item => {
        const itemSpeaker = item.speaker!
        const itemIdentity = describeSpeaker(itemSpeaker)
        const authorLabel = itemSpeaker.role === 'system' ? `System message from ${itemSpeaker.id}` : itemSpeaker.role === 'human' ? 'Human message' : itemSpeaker.role === 'agent' ? `${item.kind === 'assistant-message' ? 'Agent reply' : 'Agent input'} from ${itemIdentity.name} · Sender ${itemSpeaker.id}` : 'Input, sender not recorded'
        const excerpt = item.content || (item.kind === 'system-message' ? 'System message with resources' : 'Input with resources')
        return <button type="button" key={item.id} data-input-message-id={item.input?.id} data-input-source={item.input?.source.kind} data-conversation-record-id={item.id} data-record-kind={item.kind} data-record-source={item.source.kind} data-record-raw-id={item.rawId} data-message-author={itemSpeaker.role} aria-label={`${authorLabel}: ${excerpt}`} aria-pressed={message?.id === item.id} onClick={() => reader.onMessage(item)}>
          <ConversationSpeakerAvatar speaker={itemSpeaker} name={itemIdentity.name} mote={itemIdentity.mote} {...(itemIdentity.providerId ? { providerId: itemIdentity.providerId } : {})} size={12} /><span>{excerpt}</span><small title={describeConversationRecordSource(item).title}>{describeConversationRecordSource(item).caption} · {item.recordedAt === undefined || !Number.isFinite(item.recordedAt) ? 'Time unknown' : time.dateClock(item.recordedAt)}</small>
        </button>
      })}</div>
      {!reader.loading && reader.messages.length === 0 ? <p>No conversation records read in this view. Coverage may be incomplete.</p> : null}
    </div> : null}
    {message ? !interactive ? <>
      <p className="recent-focus__message-caption">{system ? 'System record in ' : reply ? 'Reply in ' : <><ThemeConversationOutgoingIcon size={11} role="img" aria-hidden="false" aria-label="To" /> </>}{targetName}</p>
      <p className="recent-focus__message-excerpt">{message.content.trim() || (resources.length ? resources.join(' · ') : system ? 'System message has no recorded text' : 'Input has no recorded text')}</p>
      <footer className="recent-focus__message-meta"><span title={describeConversationRecordSource(message).title}>{describeConversationRecordSource(message).caption}</span><time title="Record time, not a verified sender time">{message.recordedAt !== undefined && Number.isFinite(message.recordedAt) ? time.dateClock(message.recordedAt) : 'Record time unknown'}</time></footer>
      <span className="recent-focus__message-hint">Click or press Enter to keep reading</span>
    </> : <><p className="recent-focus__message-caption">{reply || system ? 'In' : 'To'} {targetName} · {roleName} · {describeConversationRecordSource(message).caption}{message.recordedAt === undefined || !Number.isFinite(message.recordedAt) ? ' · Record time unknown' : ''}</p>
    {agent ? <details className="recent-focus__sender-details"><summary>Sender Context · {sender?.name ?? 'Unavailable'}</summary><dl className="recent-focus__sender">
      <dt>Sender</dt><dd>{sender?.name ?? 'Context unavailable'}<small title={authorId}>{authorId}</small></dd>
      <dt>Current project</dt><dd>{project ?? 'Not recorded'}</dd>
      <dt>Current branch</dt><dd>{branch ?? 'Not recorded'}</dd>
      <dt>Current topic</dt><dd>{topic && !topic.readError ? topic.title || 'Untitled topic' : 'Not recorded'}</dd>
    </dl>{sender ? <p className="recent-focus__sender-work">Current: {sender.stateLabel} · {sender.detail}</p> : null}
      <p className="recent-focus__sender-run">Sender Run not recorded · Execution relationship unknown</p></details> : null}
    <div className="recent-focus__message-body" data-input-preview-id={message.input?.id} data-input-source={message.input?.source.kind} data-record-preview-id={message.id} data-record-source={message.source.kind}><ConversationMessage messageId={message.input?.id ?? message.id}
      speaker={speaker!} recordedIdentity
      describeSpeaker={describeSpeaker} {...(message.input ? { inputSource: message.input.source } : {})} conversationSessionId={message.agentSessionId}
      {...(message.original.kind === 'native' && message.source.kind === 'native' ? {
        nativeResourceRecord: { source: { providerId: message.source.providerId, nativeSessionId: message.source.nativeSessionId },
          recordId: message.rawId, ...(message.original.item.turnId === undefined ? {} : { turnId: message.original.item.turnId }) },
        readHistoryResource,
        ...(system ? { recordTitle: `${message.source.providerId} · ${message.original.item.title ?? 'System record'}` } : {})
      } : {})}
      {...(message.original.kind === 'native' && message.original.item.messagePhase ? { messagePhase: message.original.item.messagePhase } : {})}
      {...(message.original.kind === 'captured' ? { status: message.original.item.status } : completedNativeReply(message.original.item) ? { status: 'complete' } : {})}
      {...(message.executionHostId ? { executionHostId: message.executionHostId } : {})}
      name={described!.name} content={message.contentParts}
      {...(message.original.kind === 'native' && message.original.item.questionAnswers ? { questionAnswers: message.original.item.questionAnswers } : {})}
      {...(message.original.kind === 'native' && message.original.item.questionDiagnostic ? { questionDiagnostic: message.original.item.questionDiagnostic } : {})}
      timeFormatter={time.clock}
      {...(message.recordedAt === undefined || !Number.isFinite(message.recordedAt) ? {} : { createdAt: message.recordedAt })}
      workspaceRoot={recipient?.workspacePath ?? workspaceRoot ?? ''} readPastedImage={readPastedImage} /></div>
    {agent ? <button type="button" className="recent-focus__sender-link" disabled={!sender} onClick={() => navigate(sender)}>View sender<ThemeActionOpenExternalIcon size={12} aria-hidden="true" /></button> : null}
    <button type="button" disabled={!recipient} onClick={() => navigate(recipient)}>Return to Context</button></> : null}
  </div></WindowOverlayPortal>
}
