import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useShallow } from 'zustand/react/shallow'
import { createSpeakerResolver, speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { clampStep } from '@agentmux/client-ui/activity-step-summary'
import type { FocusContext } from '../lib/focus-context'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { agentDisplayName, firstPromptFromTimeline } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { getWindowOverlayHost } from './WindowOverlayHost'
import { usePathDisplay } from '../hooks/usePathDisplay'

// One transient reading surface, with no identity data or retained registry.
let dismissCurrentPreview: (() => void) | null = null

/** Mounted only inside the open preview; all input facts use the shared reader. */
function FocusContextInputs({ context }: { context: FocusContext }) {
  const control = useAppStore(state => {
    const session = state.sessions.find(session => session.id === context.id && session.hostId === context.hostId && session.control.run.runId === context.runId)
    return session?.kind === 'agent' && session.control.hostId === context.hostId && session.control.agentSessionId === context.id ? session.control : undefined
  })
  const reader = useSessionUserMessages(control)
  const ordered = reader.messages.every(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt))
  // Missing times retain the public source order; they cannot establish a cross-source chronology.
  const messages = (ordered ? [...reader.messages].sort((a, b) => a.recordedAt! - b.recordedAt!) : reader.messages).slice(-3)
  const names = useAppStore(useShallow(state => messages.map(message => {
    if (message.author.kind !== 'agent') return ''
    const id = message.author.agentSessionId
    const sender = state.sessions.find(session => session.id === id && session.kind === 'agent')
    return sender ? agentDisplayName({ userName: state.agentNames[id], firstPrompt: firstPromptFromTimeline(state.timelines[id]), fallbackLabel: sender.label, providerLabel: sender.providerId ?? 'Agent' }) : id
  })))
  const describe = createSpeakerResolver({ lookupAgent: id => {
    const index = messages.findIndex(message => message.author.kind === 'agent' && message.author.agentSessionId === id)
    return index >= 0 ? { label: names[index]! } : undefined
  } })
  const notice = !control || reader.error || reader.observationError ? 'Recent message reading unavailable'
    : reader.sourceChanged ? 'Message source changed' : reader.windowFrozen ? 'Reading window paused'
      : reader.windowIncomplete ? 'Reading window incomplete' : null
  return <section className="focus-context-hover__inputs" aria-label="Recent user messages">
    <h4>Recent user messages</h4>
    <small className="focus-context-hover__coverage">Current reading window{ordered ? '' : ' · Order unavailable'}</small>
    {messages.length ? <ol>{messages.map(message => <li key={message.id} data-hover-input-id={message.id} data-input-author={message.author.kind}>
      <div className="focus-context-hover__input-meta"><strong>{describe(speakerOfUserMessage(message)).name}</strong>
        <span>{message.source.kind === 'native' ? 'Native record' : 'Submission record'}</span>
        <time title="Record time, not a verified sender time">{message.recordedAt !== undefined && Number.isFinite(message.recordedAt)
          ? new Date(message.recordedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'Time unknown'}</time></div>
      <p>{message.content.trim() ? clampStep(message.content.trim().slice(0, 1000), 'head', 360) : 'Non-text input'}</p>
    </li>)}</ol> : <p className="focus-context-hover__coverage">{reader.loading ? 'Loading recent messages…' : 'No user messages in the available reading window.'}</p>}
    {notice ? <p className="focus-context-hover__notice" role="status" title={reader.error?.message ?? reader.observationError?.message}>
      {notice}. Open the Agent to read History.</p> : null}
  </section>
}

/** Intent reveals held card facts and one scoped, read-only input preview. */
export function useFocusContextHover(context: FocusContext, requested: boolean) {
  const active = useWorkbenchPresentationActive()
  const enabled = requested && active
  const displayPath = usePathDisplay()
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const departure = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restoringFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const id = useId()
  const scope = JSON.stringify([context.id, context.runId, context.name, context.state, context.detail,
    context.recap, context.workspacePath, context.originAddress])
  const close = useCallback((): void => {
    clearTimeout(intent.current); clearTimeout(departure.current)
    if (dismissCurrentPreview === close) dismissCurrentPreview = null
    setOpen(false)
  }, [])
  function keepOpen() { clearTimeout(departure.current) }
  function show() {
    clearTimeout(intent.current); keepOpen()
    // This guards a transient tooltip only, never the original Agent or card action.
    if (!enabled || !anchor.current?.isConnected || anchor.current.closest('[inert]') || document.visibilityState === 'hidden') return
    if (dismissCurrentPreview !== close) dismissCurrentPreview?.()
    dismissCurrentPreview = close
    setOpen(true)
  }
  function showSoon() { clearTimeout(intent.current); keepOpen(); if (enabled) intent.current = setTimeout(show, 180) }
  function hideSoon() { clearTimeout(intent.current); keepOpen(); departure.current = setTimeout(close, 160) }
  function suppressRestoredFocus() {
    restoringFocus.current = true
    // Radix restores its trigger synchronously after closeAutoFocus. A later
    // intentional focus or hover should still disclose the current card.
    queueMicrotask(() => { restoringFocus.current = false })
  }
  useLayoutEffect(() => { close() }, [scope, enabled, close])
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
        strategy: 'fixed', placement: 'bottom-start', middleware: [offset(8), flip({ padding: 10 }), shift({ padding: 10 })]
      })
      if (current) Object.assign(surface.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor.current, surface, () => { void update() })
    return () => { current = false; stop() }
  }, [open])
  useLayoutEffect(() => {
    if (!enabled) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
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
  const preview = open && host ? createPortal(<div ref={panel} id={id} className="focus-context-hover" role="tooltip"
    data-state="open" aria-label={`Full context for ${context.name}`} style={{ visibility: 'hidden' }}
    onPointerEnter={keepOpen} onPointerLeave={hideSoon}>
    <header><strong>{context.name}</strong><span>{context.stateLabel}</span></header>
    {!context.detailIsRecap ? <p className="focus-context-hover__activity">{context.detail}</p> : null}
    {context.recap ? <section className="focus-context-hover__recap"><small>{context.recap.source} · {context.recap.origin}</small><p>{context.recap.text}</p></section> : null}
    {context.kind === 'agent' ? <FocusContextInputs key={`${context.hostId}:${context.id}:${context.runId}`} context={context} /> : null}
    <footer><strong>{context.workspaceName}</strong><span>{displayPath(context.workspacePath, context.hostId)}</span>
      {context.originAddress ? <span>{context.originAddress}</span> : null}<code>{context.id}</code></footer>
  </div>, host) : null
  return { anchor, describedBy: open ? id : undefined, preview, close, suppressRestoredFocus,
    triggerEvents: { onPointerEnter: showSoon, onPointerLeave: hideSoon, onFocus: () => { if (!restoringFocus.current) show() }, onBlur: hideSoon, onPointerDown: close } }
}
