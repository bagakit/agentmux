import { useLayoutEffect, useRef } from 'react'
import { ArrowUpRight, Bot, MessageSquare, X } from 'lucide-react'
import type { AgentTimelineItem } from '@agentmux/core/timeline'
import type { FocusContext } from '../lib/focus-context'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { useAppStore } from '../store'

/** One inspected captured record. Current Context facts never become its historical author or Run. */
export function FocusMessagePreview({ message, sender, recipient, lane, hierarchy, interactive, left, onSelect, onClose }: {
  message: AgentTimelineItem; sender: FocusContext | undefined; recipient: FocusContext | undefined
  lane: FocusProjectLane | undefined; hierarchy: FocusHierarchyFacts | undefined
  interactive: boolean; left: number; onSelect(id: string): void; onClose(): void
}) {
  const element = useRef<HTMLDivElement>(null)
  const returnFocus = useRef(true)
  const acquireOverlay = useAppStore(state => state.acquireNativeSurfaceOverlay)
  const releaseOverlay = useAppStore(state => state.releaseNativeSurfaceOverlay)
  const agent = message.authorAgentSessionId !== undefined
  const topic = sender?.topicId && lane ? hierarchy?.topics[lane.workspaceId]?.find(item => item.id === sender.topicId) : undefined
  const branch = sender?.workspace?.branch ?? hierarchy?.worktrees.find(item => item.hostId === sender?.hostId && item.path === sender.workspacePath)?.branch
  const project = lane?.projectWorkspaceId ? lane.labels[0] : sender?.workspace?.name
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const surface = element.current
    returnFocus.current = true
    acquireOverlay()
    if (interactive) element.current?.focus()
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }
    const outside = (event: PointerEvent) => { if (interactive && event.target instanceof Node && !element.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest('.recent-focus__message'))) onClose() }
    document.addEventListener('keydown', dismiss)
    document.addEventListener('pointerdown', outside)
    return () => {
      releaseOverlay()
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('pointerdown', outside)
      if (interactive && returnFocus.current && previous?.isConnected && surface?.contains(document.activeElement)) previous.focus()
    }
  }, [interactive, message.id, acquireOverlay, releaseOverlay, onClose])
  const navigate = (context: FocusContext | undefined) => {
    if (!context) return
    returnFocus.current = false
    onSelect(context.id)
    onClose()
  }
  return <div ref={element} tabIndex={interactive ? -1 : undefined} className="recent-focus__message-preview" data-interactive={interactive}
    style={{ left }} role={interactive ? 'dialog' : 'tooltip'} aria-label="Message">
    <header>{agent ? <Bot size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}<strong>{agent ? sender?.name ?? 'Agent' : 'Prompt'}</strong>
      <time>{new Date(message.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      {interactive ? <button type="button" className="icon-button" aria-label="Close message" onClick={onClose}><X size={12} /></button> : null}</header>
    <p className="recent-focus__message-caption">{agent ? `Agent message · To ${recipient?.name ?? message.agentSessionId}` : 'Prompt · Sender not recorded'}</p>
    {agent ? <><dl className="recent-focus__sender">
      <dt>Sender</dt><dd>{sender?.name ?? 'Context unavailable'}<small title={message.authorAgentSessionId}>{message.authorAgentSessionId}</small></dd>
      <dt>Current project</dt><dd>{project ?? 'Not recorded'}</dd>
      <dt>Current branch</dt><dd>{branch ?? 'Not recorded'}</dd>
      <dt>Current topic</dt><dd>{topic && !topic.readError ? topic.title || 'Untitled topic' : 'Not recorded'}</dd>
    </dl>{interactive && sender ? <p className="recent-focus__sender-work">Current: {sender.stateLabel} · {sender.detail}</p> : null}
      <p className="recent-focus__sender-run">Sender Run not recorded · Execution relationship unknown</p></> : null}
    <p className="recent-focus__message-body">{message.content ?? message.title}</p>
    {interactive && agent ? <button type="button" className="recent-focus__sender-link" disabled={!sender} onClick={() => navigate(sender)}>View sender<ArrowUpRight size={12} aria-hidden="true" /></button> : null}
    {interactive ? <button type="button" disabled={!recipient} onClick={() => navigate(recipient)}>Return to Context</button> : <span className="recent-focus__message-hint">Click or press Enter to view actions</span>}
  </div>
}
