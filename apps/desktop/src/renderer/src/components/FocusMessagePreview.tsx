import { useLayoutEffect, useRef } from 'react'
import { autoUpdate, computePosition, offset, shift, size } from '@floating-ui/dom'
import { ArrowUpRight, Bot, MessageSquare, X } from 'lucide-react'
import type { AgentSessionUserMessage } from '@agentmux/core'
import type { FocusContext } from '../lib/focus-context'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { ConversationMessage } from './ConversationMessage'
import { WindowOverlayPortal } from './WindowOverlayHost'
import { api } from '../lib/api'

export type FocusMessageReader = {
  contexts: readonly { id: string; name: string; workspaceName: string; details?: string }[]; contextId: string | null; messages: readonly AgentSessionUserMessage[]
  loading: boolean; coverage: string; error: string | null; canContinue: boolean
  onContext(id: string): void; onMessage(message: AgentSessionUserMessage): void
  onContinue(): void; onRefresh(): void
  sourceCoverage?: string; sourceError?: string | null; onMoreSources?: (() => void) | undefined; onRefreshSources?: () => void
}
const readPastedImage = (path: string) => api.ui.readPastedImage(path)

/** One inspected Core input. Current Context facts never become its historical author or Run. */
export function FocusMessagePreview({ message, sender, recipient, recipientName, workspaceRoot, lane, hierarchy, interactive, anchor, reader, onSelect, onClose }: {
  message: AgentSessionUserMessage | undefined; sender: FocusContext | undefined; recipient: FocusContext | undefined
  lane: FocusProjectLane | undefined; hierarchy: FocusHierarchyFacts | undefined
  interactive: boolean; anchor: HTMLElement; reader?: FocusMessageReader; onSelect(id: string): void; onClose(): void
  recipientName?: string | undefined; workspaceRoot?: string | undefined
}) {
  const element = useRef<HTMLDivElement>(null)
  const returnFocus = useRef(true)
  const insidePointer = useRef<PointerEvent | null>(null)
  const agent = message?.author.kind === 'agent'
  const authorId = message?.author.kind === 'agent' ? message.author.agentSessionId : undefined
  const topic = sender?.topicId && lane ? hierarchy?.topics[lane.workspaceId]?.find(item => item.id === sender.topicId) : undefined
  const branch = sender?.workspace?.branch ?? hierarchy?.worktrees.find(item => item.hostId === sender?.hostId && item.path === sender.workspacePath)?.branch
  const project = lane?.projectWorkspaceId ? lane.labels[0] : sender?.workspace?.name
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const surface = element.current
    if (!surface) return
    returnFocus.current = true
    let disposed = false
    let positioned = false
    const update = async () => {
      const { x, y } = await computePosition(anchor, surface, {
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
    const stopPosition = autoUpdate(anchor, surface, () => { void update() })
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
      if (interactive && returnFocus.current && previous?.isConnected && surface?.contains(document.activeElement)) previous.focus()
    }
  }, [anchor, interactive, onClose])
  const navigate = (context: FocusContext | undefined) => {
    if (!context) return
    returnFocus.current = false
    onSelect(context.id)
    onClose()
  }
  return <WindowOverlayPortal layer={interactive ? 'popover' : 'tooltip'}><div ref={element} tabIndex={interactive ? -1 : undefined} className="recent-focus__message-preview" data-interactive={interactive} data-state="open"
    onPointerDownCapture={event => { insidePointer.current = event.nativeEvent }} role={interactive ? 'dialog' : 'tooltip'} aria-label="Message">
    <header>{agent ? <Bot size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}<strong>{reader ? 'Input records' : agent ? sender?.name ?? 'Agent' : 'Prompt'}</strong>
      {message ? <time title="Record time, not a verified sender time">{message.recordedAt !== undefined && Number.isFinite(message.recordedAt) ? new Date(message.recordedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Record time unknown'}</time> : null}
      {interactive ? <button type="button" className="icon-button" aria-label="Close message" onClick={onClose}><X size={12} /></button> : null}</header>
    {reader ? <div className="recent-focus__input-reader">
      <label>Context <select aria-label="Input records Context" value={reader.contextId ?? ''} onChange={event => reader.onContext(event.target.value)}><option value="" disabled>Choose a Context</option>{reader.contexts.map(context => <option key={context.id} value={context.id} title={context.details}>{context.name} · {context.workspaceName}</option>)}</select></label>
      {reader.contexts.find(context => context.id === reader.contextId)?.details ? <details className="recent-focus__source-details"><summary>Source details</summary><p>{reader.contexts.find(context => context.id === reader.contextId)!.details}</p></details> : null}
      {reader.sourceCoverage ? <p className="recent-focus__input-coverage" role="status">{reader.sourceCoverage}</p> : null}
      {reader.sourceError ? <p className="recent-focus__input-error" role="status">{reader.sourceError} Existing inputs remain readable.</p> : null}
      {reader.onMoreSources || reader.sourceError ? <div className="recent-focus__input-actions">{reader.onMoreSources ? <button type="button" onClick={reader.onMoreSources}>Show more input sources</button> : null}{reader.sourceError && reader.onRefreshSources ? <button type="button" onClick={reader.onRefreshSources}>Retry input sources</button> : null}</div> : null}
      <p role="status" className="recent-focus__input-coverage">{reader.loading ? 'Reading input records… ' : ''}{reader.coverage}</p>
      {reader.error ? <p role="status" className="recent-focus__input-error">{reader.error} Existing records and live input are preserved.</p> : null}
      <div className="recent-focus__input-actions"><button type="button" disabled={reader.loading || !reader.canContinue} onClick={reader.onContinue}>Read earlier records</button><button type="button" disabled={reader.loading} onClick={reader.onRefresh}>Refresh source</button></div>
      <div className="recent-focus__input-list" aria-label="Available input records">{reader.messages.map(item => <button type="button" key={item.id} data-input-message-id={item.id} data-input-source={item.source.kind} aria-pressed={message?.id === item.id} onClick={() => reader.onMessage(item)}>
        {item.author.kind === 'agent' ? <Bot size={12} aria-hidden="true" /> : <MessageSquare size={12} aria-hidden="true" />}<span>{item.content || 'Input with resources'}</span><small>{item.source.kind === 'native' ? 'Native' : 'Submission'} · {item.recordedAt === undefined || !Number.isFinite(item.recordedAt) ? 'Time unknown' : new Date(item.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
      </button>)}</div>
      {!reader.loading && reader.messages.length === 0 ? <p>No input records read in this view. Coverage may be incomplete.</p> : null}
    </div> : null}
    {message ? <><p className="recent-focus__message-caption">{agent ? `Agent message · To ${recipient?.name ?? recipientName ?? message.agentSessionId}` : 'Prompt · Sender not recorded'} · {message.source.kind === 'native' ? 'Native record' : 'Submission record'}</p>
    {agent ? <><dl className="recent-focus__sender">
      <dt>Sender</dt><dd>{sender?.name ?? 'Context unavailable'}<small title={authorId}>{authorId}</small></dd>
      <dt>Current project</dt><dd>{project ?? 'Not recorded'}</dd>
      <dt>Current branch</dt><dd>{branch ?? 'Not recorded'}</dd>
      <dt>Current topic</dt><dd>{topic && !topic.readError ? topic.title || 'Untitled topic' : 'Not recorded'}</dd>
    </dl>{interactive && sender ? <p className="recent-focus__sender-work">Current: {sender.stateLabel} · {sender.detail}</p> : null}
      <p className="recent-focus__sender-run">Sender Run not recorded · Execution relationship unknown</p></> : null}
    <div className="recent-focus__message-body" data-input-preview-id={message.id} data-input-source={message.source.kind}><ConversationMessage messageId={message.id}
      {...(authorId ? { speaker: { role: 'agent' as const, id: authorId } } : {})}
      name={agent ? sender?.name ?? 'Agent' : 'Sender not recorded'} content={message.contentParts}
      {...(message.recordedAt === undefined || !Number.isFinite(message.recordedAt) ? {} : { createdAt: message.recordedAt })}
      workspaceRoot={recipient?.workspacePath ?? workspaceRoot ?? ''} readPastedImage={readPastedImage} /></div>
    {interactive && agent ? <button type="button" className="recent-focus__sender-link" disabled={!sender} onClick={() => navigate(sender)}>View sender<ArrowUpRight size={12} aria-hidden="true" /></button> : null}
    {interactive ? <button type="button" disabled={!recipient} onClick={() => navigate(recipient)}>Return to Context</button> : <span className="recent-focus__message-hint">Click or press Enter to view actions</span>}</> : null}
  </div></WindowOverlayPortal>
}
