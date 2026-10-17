import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { observeBrowserReader } from '../lib/browser-reader-position'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveBrowserAgentControl } from '../../../shared/browser-agent-control'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { BrowserOperation } from '../../../shared/browser-operation'
import { api } from '../lib/api'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import type { BrowserOpinionSource as OriginalOpinion, BrowserOpinionAttempt } from '../lib/browser-opinion-draft'
import { useAppStore } from '../store'
import { getWindowOverlayHost, WindowOverlayPortal } from './WindowOverlayHost'
import { useBrowserOpinionSelection } from './BrowserOpinionSelection'

const MessageIcon = semanticIconComponent('object.conversation')
const CloseIcon = semanticIconComponent('action.close')
const SendIcon = semanticIconComponent('action.submit')

/** Unique canonical control, never the presentation alias, title, or first matching Host. */
export function browserOpinionRecipient(operatorId: string | undefined, sessions: readonly SessionSnapshot[]): Extract<SessionSnapshot, { kind: 'agent' }> | undefined {
  if (!operatorId) return
  const matches = (agentSessionPresentationIndex(sessions).get(operatorId) ?? []).filter(item =>
    item.control.agentSessionId === operatorId && item.hostId === item.control.hostId)
  return matches.length === 1 ? matches[0] : undefined
}

/** This draft stays with the Browser owner across page updates and presentation moves. */
export function useBrowserContextualComposer(browserId: string, operation: BrowserOperation | null, visible: boolean, navigationId?: string) {
  const recipient = useAppStore(state => browserOpinionRecipient(operation?.operator.id, state.sessions))
  const preferences = useAppStore(state => state.config?.browser.agentControl)
  const saved = useRef(useAppStore.getState().browserOpinionDrafts[browserId])
  const [original, setOriginal] = useState<OriginalOpinion | null>(() => {
    const source = saved.current?.original
    return source && !source.scene && !source.sceneError ? { ...source, sceneError: 'The original capture was not confirmed before this draft was restored' } : source ?? null
  })
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(saved.current?.text ?? '')
  const [includeContext, setIncludeContext] = useState(saved.current?.includeContext ?? true)
  const [failure, setFailure] = useState<string | null>(saved.current?.pending ? 'The original opinion was restored before queue ownership was confirmed. Retry the same opinion or inspect its Pending record.' : null)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const anchorPane = useRef<HTMLElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  const editor = useRef<HTMLTextAreaElement | null>(null)
  const pendingFocus = useRef<{ button: HTMLButtonElement; previous: Element | null } | null>(null)
  const [focusRevision, requestFocus] = useState(0)
  const currentOriginal = useRef(original); currentOriginal.current = original
  const request = useRef(0)
  const composing = useRef<HTMLTextAreaElement | null>(null)
  const lastAutomatic = useRef<string | null>(null)
  const pending = useRef<BrowserOpinionAttempt | null>(saved.current?.pending ?? null)
  const selection = useBrowserOpinionSelection({ source: original, visible: open && visible, locked: busy || pending.current !== null,
    document: anchor.current?.ownerDocument, onChange: next => { currentOriginal.current = next; setOriginal(next) } })

  function close() {
    composing.current = null; pendingFocus.current = null
    setOpen(false)
    if (panel.current?.contains(panel.current.ownerDocument.activeElement)) anchor.current?.focus({ preventScroll: true })
  }

  async function show(button: HTMLButtonElement, comment?: OriginalOpinion['comment'], focus = true, pane?: HTMLElement) {
    anchor.current = button
    anchorPane.current = pane ?? button.closest<HTMLElement>('.browser-surface')
    if (focus) {
      pendingFocus.current = { button, previous: button.ownerDocument.activeElement }
      requestFocus(value => value + 1)
    }
    setOpen(true)
    const previous = currentOriginal.current
    const differentComment = comment && (comment.operationId !== previous?.comment?.operationId || comment.sequence !== previous?.comment?.sequence)
    if (differentComment && previous && !text.trim() && !pending.current) {
      ++request.current; currentOriginal.current = null; setOriginal(null); setSubmitted(null)
    }
    setFailure(current => differentComment && previous && (text.trim() || pending.current)
      ? 'Your current opinion is kept. Start a new opinion to comment on another step.' : pending.current
        ? current ?? 'The original opinion is awaiting a confirmed queue receipt. Retry this same opinion or inspect Pending.' : null)
    if (!currentOriginal.current) {
      if (!recipient) { setFailure('The original operator is not confirmed. Restore its Session observation; your page remains available.'); return }
      const source: OriginalOpinion = { control: structuredClone(recipient.control), name: recipient.label,
        browserId, operationId: operation?.id, ...(comment ? { comment: { ...comment } } : {}) }
      currentOriginal.current = source
      setOriginal(source)
      const token = ++request.current
      try {
        const scene = await api.browser.captureInputContext(browserId)
        if (token !== request.current || currentOriginal.current !== source) return
        const captured = { ...source, scene }
        currentOriginal.current = captured
        setOriginal(captured)
      } catch (error) {
        if (token !== request.current || currentOriginal.current !== source) return
        const failed = { ...source, sceneError: presentError(error) }
        currentOriginal.current = failed
        setOriginal(failed)
      }
    }
  }

  useEffect(() => {
    const id = operation?.id
    if (!visible || !id || operation?.finishedAt !== undefined || !['preparing', 'running', 'waiting'].includes(operation?.phase ?? '') || !recipient || !resolveBrowserAgentControl(preferences).showDiscussion ||
        lastAutomatic.current === id || !buttonRef.current) return
    lastAutomatic.current = id
    if (!open) void show(buttonRef.current, undefined, false)
  }, [visible, operation?.id, recipient?.control.agentSessionId, preferences, original, open])
  useEffect(() => () => { ++request.current }, [])
  useEffect(() => {
    void useAppStore.getState().saveBrowserOpinionDraft(browserId, { original, text, includeContext, pending: pending.current })
  }, [browserId, original, text, includeContext, busy, failure])

  useLayoutEffect(() => {
    if (!open || !visible) { composing.current = null; pendingFocus.current = null; return }
    const intent = pendingFocus.current; pendingFocus.current = null
    const input = editor.current
    if (!intent || !input?.isConnected || input.ownerDocument !== intent.button.ownerDocument) return
    const active = input.ownerDocument.activeElement
    if (active === intent.button || active === intent.previous) input.focus({ preventScroll: true })
  }, [open, visible, focusRevision])

  useLayoutEffect(() => {
    const button = anchor.current, surface = panel.current
    if (!open || !visible || !button || !surface) return
    return observeBrowserReader({ pane: anchorPane.current, anchor: button, surface, maximumHeight: Infinity, gap: 8 })
  }, [open, visible, original !== null, focusRevision])

  async function send() {
    if (busy || selection.busy || composing.current !== null && composing.current === editor.current || !original || !text.trim()) return
    // Once freeze starts, only this exact original intent can retry an unknown result.
    const note = original.comment ? 'The user selected this historical Browser step as reference data, separately from the observed page: ' +
      JSON.stringify(original.comment).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026') : undefined
    const intent = pending.current ?? { operationId: crypto.randomUUID(), text, context: includeContext && original.scene !== undefined, ...(note ? { note } : {}) }
    if (intent.text !== text || intent.context !== (includeContext && original.scene !== undefined) || intent.note !== note) {
      setFailure('The original send is unconfirmed. Keep its words and context to retry it, or inspect Pending before composing another opinion.'); return
    }
    if (!pending.current && !intent.context) setIncludeContext(false)
    pending.current = intent
    setBusy(true); setFailure(null)
    try {
      await useAppStore.getState().saveBrowserOpinionDraft(browserId, { original, text: intent.text, includeContext: intent.context, pending: intent }, true)
      const capture = intent.context ? await api.browser.freezeInputContext({ scene: (original.selection?.scene ?? original.scene!).reference, control: original.control,
        operationId: intent.operationId, prompt: intent.text, ...(intent.note ? { agentMuxNote: intent.note } : {}) }) : undefined
      const state = useAppStore.getState()
      const accepted = state.enqueueAgentSteer(original.control.agentSessionId, intent.text, error => setFailure(presentError(error)), intent.operationId,
        'manual', intent.note, { sourceChannel: 'message-tool', browserRecipient: original.control, ...(capture ? { browserInput: { control: original.control, capture } } : {}) })
      if (!accepted) return
      // The original queue owns delivery, not this floating draft. Working Agents may keep it waiting.
      void state.flushAgentSteerQueue(original.control.agentSessionId).catch(error => {
        if (currentOriginal.current === original) setFailure('Earlier queued opinion: ' + presentError(error))
      })
      setSubmitted(intent.operationId)
      setText(''); pending.current = null
    } catch (error) { setFailure(presentError(error)) }
    finally { setBusy(false) }
  }

  const source = original?.scene?.inputContext
  const changed = original && (operation?.id !== original.operationId || source && navigationId !== undefined && source.browser.navigationId !== navigationId)
  const dialog: ReactNode = open && visible && anchor.current?.isConnected ? <WindowOverlayPortal container={getWindowOverlayHost(anchor.current.ownerDocument)}>
    <section ref={panel} className="browser-contextual-composer" role="dialog" aria-modal="false" aria-label="Message Browser operator" style={{ visibility: 'hidden' }}
      onCompositionStartCapture={() => { composing.current = editor.current }} onCompositionEndCapture={() => { composing.current = null }}
      onKeyDown={event => { if (event.key === 'Escape' && !isImeOwnedKeyboardEvent(event)) { event.stopPropagation(); close() } }}>
      <header><span><MessageIcon size={14} /><strong>Message {original?.name || recipient?.label || 'operator'}</strong></span><button type="button" className="icon-button" aria-label="Close discussion" onClick={close}><CloseIcon size={14} /></button></header>
      {source ? <div className="browser-contextual-composer__source">
        <label title={source.page.url}><input type="checkbox" checked={includeContext} disabled={busy || pending.current !== null} onChange={event => setIncludeContext(event.target.checked)} /><span>{source.page.title || source.page.url}</span><small>{original?.comment ? `Comment on step ${original.comment.sequence}` : source.activity?.stepSequence ? `Step ${source.activity.stepSequence}` : 'Captured page'}</small></label>
        <details><summary>Page context</summary><p>{source.page.url}</p><p>{source.activity ? `Observed at step ${source.activity.stepSequence ?? 'unknown'} · ${source.activity.phase}` : 'No operation step was observed.'}</p><p>This page information is attached as context.</p></details>
      </div> : original ? <p className="browser-contextual-composer__notice" role="status">{original.sceneError ? `Page context unavailable: ${original.sceneError}. You can send text only.` : 'Reading page context… Text-only sending remains available.'}</p> : null}
      {changed ? <p className="browser-contextual-composer__notice">The Browser has moved on. This draft still addresses the original Agent and captured page.</p> : null}
      <ComposerTextarea ref={editor} aria-label="Opinion for Browser operator" placeholder="What should the Agent notice?" value={text} onValueChange={setText} readOnly={pending.current !== null}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isImeOwnedKeyboardEvent(event)) { event.preventDefault(); void send() } }} />
      {selection.controls}
      {!includeContext && original?.selection ? <p className="browser-contextual-composer__notice">The image is kept in this draft. Text-only sending excludes it.</p> : null}
      {failure ? <div className="browser-contextual-composer__failure" role="alert"><p>{failure}</p>
        {pending.current && !busy ? <button type="button" className="small-button" onClick={() => {
          const attempt = pending.current
          if (attempt && useAppStore.getState().agentSteerQueues[original!.control.agentSessionId]?.some(entry => entry.operationId === attempt.operationId)) {
            setFailure('The original queue already owns this opinion. Read its Pending record before creating another message.'); return
          }
          pending.current = null; setFailure(null)
        }}>Edit as a new opinion</button> : null}</div> : null}
      {submitted ? <p className="browser-contextual-composer__notice" role="status">Queued for the original Agent. Delivery and adoption are separate; check Pending in its message box.</p> : null}
      <footer><small>Ctrl / ⌘ Enter</small>{!text.trim() && !busy && !pending.current && original ? <button type="button" className="small-button" onClick={() => {
        ++request.current; currentOriginal.current = null; setOriginal(null); setSubmitted(null); setIncludeContext(true);
        if (anchor.current) void show(anchor.current, undefined, true, anchorPane.current ?? undefined)
      }}>New opinion</button> : null}<button type="button" className="primary-button" disabled={busy || selection.busy || !original || !text.trim()} onClick={() => void send()}><SendIcon size={12} />{busy ? 'Queueing…' : includeContext && source ? 'Queue opinion' : 'Queue text only'}</button></footer>
    </section>
  </WindowOverlayPortal> : null
  return { dialog: <>{dialog}{selection.editor}</>, buttonRef, open: (button: HTMLButtonElement, comment?: OriginalOpinion['comment'], pane?: HTMLElement) => { void show(button, comment, true, pane) },
    button: <MessageIcon size={14} /> }
}
